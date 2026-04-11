"""
Lobby matchmaking, timers, broadcasts, and state transitions.
"""

from __future__ import annotations

import asyncio
import json
import random
import secrets
import shutil
import time
from pathlib import Path
from typing import Any

from starlette.websockets import WebSocket

from ..auth import increment_wins_for_users
from ..database import SessionLocal
from ..models import User
from .lobby import (
    ALLOWED_SPICES,
    COOK_DURATION_MIN_OPTIONS,
    COOK_DURATION_S,
    LOBBY_RESULTS_TTL_S,
    SLIDESHOW_SEGMENT_S,
    UPLOAD_PHASE_S,
    VOTING_COLLECT_S,
    Lobby,
    LobbyState,
    Player,
    canonical_spice,
)


def _coerce_bool(v: Any, default: bool = True) -> bool:
    """JSON may send real bools; avoid ``bool("false")`` truthiness bugs."""
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    if isinstance(v, str):
        s = v.strip().lower()
        if s in ("0", "false", "no", "off", ""):
            return False
        if s in ("1", "true", "yes", "on"):
            return True
    return default


def _normalize_cook_duration_min(raw: Any) -> int | None:
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None
    if n in COOK_DURATION_MIN_OPTIONS:
        return n
    return None


def _user_wins_sync(user_id: int) -> int:
    db = SessionLocal()
    try:
        u = db.get(User, user_id)
        return int(u.wins) if u is not None else 0
    finally:
        db.close()


def _normalize_player_spices(data: dict[str, Any]) -> list[float] | None:
    """Parse ``spices`` list or legacy ``spice`` float; return sorted unique allowed values or None."""
    raw = data.get("spices")
    if raw is None and "spice" in data:
        raw = [data["spice"]]
    if not isinstance(raw, list) or len(raw) == 0:
        return None
    out: list[float] = []
    for x in raw:
        try:
            c = canonical_spice(float(x))
        except (TypeError, ValueError):
            return None
        if c is None:
            return None
        out.append(c)
    return sorted(set(out))


class LobbyManager:
    def __init__(self, uploads_root: Path) -> None:
        self.uploads_root = uploads_root
        self._lock = asyncio.Lock()
        self.lobbies: dict[str, Lobby] = {}
        self.player_lobby: dict[str, str] = {}
        self.player_ws: dict[str, WebSocket] = {}
        self.auth_user_id: dict[str, int] = {}
        self.auth_username: dict[str, str] = {}
        self._cook_tasks: dict[str, asyncio.Task[None]] = {}
        self._upload_tasks: dict[str, asyncio.Task[None]] = {}
        self._vote_tasks: dict[str, asyncio.Task[None]] = {}

    def register_auth_session(self, player_id: str, user_id: int, username: str) -> None:
        self.auth_user_id[player_id] = user_id
        self.auth_username[player_id] = username

    def pop_auth_session(self, player_id: str) -> None:
        self.auth_user_id.pop(player_id, None)
        self.auth_username.pop(player_id, None)

    def _session_user(self, player_id: str) -> tuple[int, str] | None:
        uid = self.auth_user_id.get(player_id)
        un = self.auth_username.get(player_id)
        if uid is None or un is None:
            return None
        return uid, un

    @staticmethod
    def _lobby_has_user_id(lobby: Lobby, user_id: int) -> bool:
        return any(p.user_id == user_id for p in lobby.players.values())

    def player_id_for_user_in_lobby(self, lobby_id: str, user_id: int) -> str | None:
        lobby = self.lobbies.get(lobby_id)
        if not lobby:
            return None
        for pid, p in lobby.players.items():
            if p.user_id == user_id:
                return pid
        return None

    def verify_player_belongs_to_user(self, lobby_id: str, player_id: str, user_id: int) -> bool:
        lobby = self.lobbies.get(lobby_id)
        if not lobby:
            return False
        p = lobby.players.get(player_id)
        return p is not None and p.user_id == user_id

    def get_lobby_kit_meta_for_user(self, lobby_id: str, user_id: int) -> dict[str, Any] | None:
        """Return ``seed`` / ``spice`` for clients that rebuild the kit locally."""
        lobby = self.lobbies.get(lobby_id)
        if not lobby or lobby.seed is None:
            return None
        if self.player_id_for_user_in_lobby(lobby_id, user_id) is None:
            return None
        if lobby.state not in (
            LobbyState.COOKING,
            LobbyState.UPLOAD,
            LobbyState.VOTING,
            LobbyState.RESULTS,
        ):
            return None
        return {"seed": lobby.seed, "spice": lobby.spice}

    def attach_ws(self, player_id: str, ws: WebSocket) -> None:
        self.player_ws[player_id] = ws

    def detach_ws(self, player_id: str) -> None:
        self.player_ws.pop(player_id, None)

    async def send_to(self, player_id: str, message: dict[str, Any]) -> None:
        ws = self.player_ws.get(player_id)
        if not ws:
            return
        try:
            await ws.send_text(json.dumps(message))
        except Exception:
            pass

    async def broadcast(self, lobby_id: str, message: dict[str, Any]) -> None:
        lobby = self.lobbies.get(lobby_id)
        if not lobby:
            return
        raw = json.dumps(message)
        for pid in lobby.players:
            ws = self.player_ws.get(pid)
            if not ws:
                continue
            try:
                await ws.send_text(raw)
            except Exception:
                pass

    @staticmethod
    def _normalize_lobby_code(code: str) -> str:
        """Strip spaces, hyphens, underscores; uppercase (lobby ids are hex)."""
        s = (code or "").strip().upper().replace(" ", "").replace("-", "").replace("_", "")
        return s

    def _resolve_lobby_key(self, code: str) -> str | None:
        """Match lobby dict key (exact id, case-insensitive, ignores separators)."""
        raw = self._normalize_lobby_code(code)
        if not raw:
            return None
        if raw in self.lobbies:
            return raw
        for k in self.lobbies:
            if self._normalize_lobby_code(k) == raw:
                return k
        return None

    def _new_lobby_id(self) -> str:
        for _ in range(20):
            lid = secrets.token_hex(3).upper()
            if lid not in self.lobbies:
                return lid
        return secrets.token_hex(4).upper()

    async def create_lobby(
        self, player_id: str, name: str, spices: list[float], is_public: bool
    ) -> None:
        """Create a new lobby; host is the first player."""
        if not spices:
            await self.send_to(
                player_id,
                {"type": "error", "message": "Select at least one heat level (0.25, 0.5, 0.85)."},
            )
            return
        sess = self._session_user(player_id)
        if sess is None:
            await self.send_to(player_id, {"type": "error", "message": "Not authenticated."})
            return
        user_id, display_name = sess
        wins = await asyncio.to_thread(_user_wins_sync, user_id)
        host_spice = sorted(spices)[0]
        async with self._lock:
            if player_id in self.player_lobby:
                await self.send_to(player_id, {"type": "error", "message": "Already in a lobby."})
                return
            lobby = Lobby(
                id=self._new_lobby_id(),
                spice=host_spice,
                is_public=is_public,
            )
            self.lobbies[lobby.id] = lobby
            lobby.players[player_id] = Player(
                id=player_id, name=display_name, user_id=user_id, wins=wins, ready=False
            )
            self.player_lobby[player_id] = lobby.id

        await self._emit_join_snapshots(lobby.id, player_id, display_name)

    async def join_lobby_by_code(self, player_id: str, name: str, code: str) -> None:
        """Join by lobby id / code (works for public and private)."""
        sess = self._session_user(player_id)
        if sess is None:
            await self.send_to(player_id, {"type": "error", "message": "Not authenticated."})
            return
        user_id, display_name = sess
        wins = await asyncio.to_thread(_user_wins_sync, user_id)
        async with self._lock:
            if player_id in self.player_lobby:
                await self.send_to(player_id, {"type": "error", "message": "Already in a lobby."})
                return
            key = self._resolve_lobby_key(code)
            if key is None:
                await self.send_to(
                    player_id,
                    {
                        "type": "error",
                        "message": "No lobby found for that code. Check the code and try again.",
                    },
                )
                return
            lobby = self.lobbies[key]
            if lobby.state != LobbyState.LOBBY:
                await self.send_to(
                    player_id,
                    {"type": "error", "message": "That match already started or ended."},
                )
                return
            if len(lobby.players) >= 5:
                await self.send_to(player_id, {"type": "error", "message": "Lobby is full."})
                return
            if self._lobby_has_user_id(lobby, user_id):
                await self.send_to(
                    player_id,
                    {"type": "error", "message": "You are already in this lobby."},
                )
                return
            lobby.players[player_id] = Player(
                id=player_id, name=display_name, user_id=user_id, wins=wins, ready=False
            )
            self.player_lobby[player_id] = lobby.id

        await self._emit_join_snapshots(lobby.id, player_id, display_name)

    async def join_lobby_public(self, player_id: str, name: str, lobby_id: str) -> None:
        """Join a listed public lobby from the browser (no code typed)."""
        sess = self._session_user(player_id)
        if sess is None:
            await self.send_to(player_id, {"type": "error", "message": "Not authenticated."})
            return
        user_id, display_name = sess
        wins = await asyncio.to_thread(_user_wins_sync, user_id)
        async with self._lock:
            if player_id in self.player_lobby:
                await self.send_to(player_id, {"type": "error", "message": "Already in a lobby."})
                return
            key = self._resolve_lobby_key(lobby_id)
            if key is None:
                await self.send_to(
                    player_id,
                    {"type": "error", "message": "That lobby is no longer available."},
                )
                return
            lobby = self.lobbies[key]
            if not lobby.is_public:
                await self.send_to(
                    player_id,
                    {
                        "type": "error",
                        "message": "That lobby is code-only. Enter its code on Join with code.",
                    },
                )
                return
            if lobby.state != LobbyState.LOBBY:
                await self.send_to(
                    player_id,
                    {"type": "error", "message": "That match already started or ended."},
                )
                return
            if len(lobby.players) >= 5:
                await self.send_to(player_id, {"type": "error", "message": "Lobby is full."})
                return
            if self._lobby_has_user_id(lobby, user_id):
                await self.send_to(
                    player_id,
                    {"type": "error", "message": "You are already in this lobby."},
                )
                return
            lobby.players[player_id] = Player(
                id=player_id, name=display_name, user_id=user_id, wins=wins, ready=False
            )
            self.player_lobby[player_id] = lobby.id

        await self._emit_join_snapshots(lobby.id, player_id, display_name)

    async def public_lobby_list(self) -> list[dict[str, Any]]:
        """Joinable public lobbies (pre-game, not full). Snapshot under lock."""
        async with self._lock:
            out: list[dict[str, Any]] = []
            for lid, L in self.lobbies.items():
                if L.state != LobbyState.LOBBY:
                    continue
                if not L.is_public:
                    continue
                if len(L.players) >= 5:
                    continue
                out.append(
                    {
                        "lobby_id": lid,
                        "spice": L.spice,
                        "player_count": len(L.players),
                        "max_players": 5,
                    }
                )
            return sorted(out, key=lambda x: x["lobby_id"])

    async def _emit_join_snapshots(self, lobby_id: str, player_id: str, name: str) -> None:
        await self.broadcast(
            lobby_id,
            {
                "type": "player_join",
                "player": {"id": player_id, "name": name, "ready": False},
                "lobby_id": lobby_id,
            },
        )
        await self.broadcast(
            lobby_id,
            {"type": "lobby_update", "lobby": self.lobbies[lobby_id].lobby_snapshot()},
        )

    async def set_cook_duration(self, player_id: str, raw_minutes: Any) -> None:
        norm = _normalize_cook_duration_min(raw_minutes)
        async with self._lock:
            lobby_id = self.player_lobby.get(player_id)
            if not lobby_id:
                return
            lobby = self.lobbies.get(lobby_id)
            if not lobby or lobby.state != LobbyState.LOBBY:
                await self.send_to(
                    player_id,
                    {"type": "error", "message": "You can only change duration before the match starts."},
                )
                return
            host_id = next(iter(lobby.players)) if lobby.players else None
            if host_id != player_id:
                await self.send_to(
                    player_id,
                    {"type": "error", "message": "Only the host can set cook duration."},
                )
                return
            if norm is None:
                await self.send_to(
                    player_id,
                    {
                        "type": "error",
                        "message": "Invalid duration. Use 5, 10, 15, or 20 minutes.",
                    },
                )
                return
            lobby.cook_duration_min = norm

        await self.broadcast(
            lobby_id,
            {"type": "lobby_update", "lobby": self.lobbies[lobby_id].lobby_snapshot()},
        )

    async def player_cook_finished(self, player_id: str) -> None:
        async with self._lock:
            lobby_id = self.player_lobby.get(player_id)
            if not lobby_id:
                return
            lobby = self.lobbies.get(lobby_id)
            if not lobby or lobby.state != LobbyState.COOKING:
                return
            if player_id not in lobby.players:
                return
            if player_id in lobby.cook_finished:
                return
            lobby.cook_finished.add(player_id)
            finished = sorted(lobby.cook_finished)
            n_players = len(lobby.players)

        await self.broadcast(
            lobby_id,
            {
                "type": "cook_finished_update",
                "finished_player_ids": finished,
                "player_count": n_players,
            },
        )

    async def player_ready(self, player_id: str) -> None:
        async with self._lock:
            lobby_id = self.player_lobby.get(player_id)
            if not lobby_id:
                return
            lobby = self.lobbies.get(lobby_id)
            if not lobby or lobby.state != LobbyState.LOBBY:
                return
            p = lobby.players.get(player_id)
            if not p:
                return
            p.ready = True

        await self.broadcast(
            lobby_id,
            {"type": "player_ready", "player_id": player_id, "ready": True},
        )
        await self.broadcast(
            lobby_id,
            {"type": "lobby_update", "lobby": self.lobbies[lobby_id].lobby_snapshot()},
        )
        await self._try_start_game(lobby_id)

    async def _try_start_game(self, lobby_id: str) -> None:
        async with self._lock:
            lobby = self.lobbies.get(lobby_id)
            if not lobby or lobby.state != LobbyState.LOBBY:
                return
            if len(lobby.players) < 2:
                return
            if not all(p.ready for p in lobby.players.values()):
                return
            seed = random.randint(0, 2**31 - 1)
            lobby.seed = seed
            lobby.sounds = None
            lobby.state = LobbyState.COOKING
            spice = lobby.spice
            lobby.cook_finished.clear()
            lobby.uploaded.clear()
            lobby.votes.clear()
            lobby.votes_unlock_at = None
            cook_min = lobby.cook_duration_min
            snap = lobby.lobby_snapshot()

        await self.broadcast(lobby_id, {"type": "lobby_update", "lobby": snap})
        await self.broadcast(
            lobby_id,
            {
                "type": "start_game",
                "lobby_id": lobby_id,
                "seed": seed,
                "spice": spice,
                "cook_duration_min": cook_min,
            },
        )

        if lobby_id in self._cook_tasks:
            self._cook_tasks[lobby_id].cancel()
        self._cook_tasks[lobby_id] = asyncio.create_task(self._cook_loop(lobby_id))

    async def _cook_loop(self, lobby_id: str) -> None:
        duration_s = COOK_DURATION_S
        async with self._lock:
            lobby = self.lobbies.get(lobby_id)
            if not lobby:
                return
            duration_s = max(60, min(20 * 60, int(lobby.cook_duration_min) * 60))

        early_all_done = False
        try:
            for remaining in range(duration_s, -1, -1):
                await self.broadcast(
                    lobby_id,
                    {
                        "type": "timer_update",
                        "phase": "cooking",
                        "remaining_s": remaining,
                    },
                )
                async with self._lock:
                    lobby = self.lobbies.get(lobby_id)
                    if not lobby or lobby.state != LobbyState.COOKING:
                        return
                    if (
                        len(lobby.players) > 0
                        and len(lobby.cook_finished) >= len(lobby.players)
                    ):
                        early_all_done = True
                        break
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            return
        finally:
            self._cook_tasks.pop(lobby_id, None)

        if early_all_done:
            await self.broadcast(
                lobby_id,
                {
                    "type": "timer_update",
                    "phase": "cooking",
                    "remaining_s": 0,
                },
            )

        async with self._lock:
            lobby = self.lobbies.get(lobby_id)
            if not lobby or lobby.state != LobbyState.COOKING:
                return
            lobby.state = LobbyState.UPLOAD

        await self.broadcast(lobby_id, {"type": "upload_phase_start", "lobby_id": lobby_id})

        if lobby_id in self._upload_tasks:
            self._upload_tasks[lobby_id].cancel()
        self._upload_tasks[lobby_id] = asyncio.create_task(self._upload_phase(lobby_id))

    async def _upload_phase(self, lobby_id: str) -> None:
        try:
            deadline = time.time() + UPLOAD_PHASE_S
            while time.time() < deadline:
                async with self._lock:
                    lobby = self.lobbies.get(lobby_id)
                    if not lobby or lobby.state != LobbyState.UPLOAD:
                        return
                    if len(lobby.uploaded) >= len(lobby.players):
                        break
                await asyncio.sleep(0.4)
            await asyncio.sleep(0.2)
            await self._begin_voting(lobby_id)
        except asyncio.CancelledError:
            return
        finally:
            self._upload_tasks.pop(lobby_id, None)

    async def record_upload(self, lobby_id: str, player_id: str) -> None:
        async with self._lock:
            lobby = self.lobbies.get(lobby_id)
            if not lobby or lobby.state != LobbyState.UPLOAD:
                return
            if player_id not in lobby.players:
                return
            lobby.uploaded.add(player_id)
        await self.broadcast(
            lobby_id,
            {"type": "beat_uploaded", "player_id": player_id},
        )

    async def _begin_voting(self, lobby_id: str) -> None:
        async with self._lock:
            lobby = self.lobbies.get(lobby_id)
            if not lobby:
                return
            if lobby.state != LobbyState.UPLOAD:
                return
            lobby.state = LobbyState.VOTING
            lobby.votes.clear()
            n = len(lobby.uploaded)
            unlock = time.time() + (0 if n == 0 else SLIDESHOW_SEGMENT_S * n)
            lobby.votes_unlock_at = unlock

        beats: list[dict[str, Any]] = []
        for owner_id in sorted(
            self.lobbies[lobby_id].uploaded,
            key=lambda x: x,
        ):
            p = self.lobbies[lobby_id].players.get(owner_id)
            nm = p.name if p else owner_id
            beats.append(
                {
                    "player_id": owner_id,
                    "name": nm,
                    "url": f"/beats/{lobby_id}/{owner_id}",
                }
            )

        await self.broadcast(
            lobby_id,
            {
                "type": "voting_start",
                "lobby_id": lobby_id,
                "beats": beats,
                "votes_unlock_at": self.lobbies[lobby_id].votes_unlock_at,
            },
        )

        if lobby_id in self._vote_tasks:
            self._vote_tasks[lobby_id].cancel()
        self._vote_tasks[lobby_id] = asyncio.create_task(self._vote_collection_loop(lobby_id))

    @staticmethod
    def _required_voters(lobby: Lobby, beat_owners: set[str]) -> set[str]:
        req: set[str] = set()
        for pid in lobby.players:
            if any(b != pid for b in beat_owners):
                req.add(pid)
        return req

    async def _vote_collection_loop(self, lobby_id: str) -> None:
        try:
            async with self._lock:
                lobby = self.lobbies.get(lobby_id)
                unlock = lobby.votes_unlock_at if lobby else 0.0
            if not unlock:
                unlock = time.time()
            while time.time() < unlock:
                await asyncio.sleep(0.2)

            deadline = unlock + VOTING_COLLECT_S
            while time.time() < deadline:
                async with self._lock:
                    lobby = self.lobbies.get(lobby_id)
                    if not lobby or lobby.state != LobbyState.VOTING:
                        return
                    beat_owners = set(lobby.uploaded)
                    req = self._required_voters(lobby, beat_owners)
                    if req.issubset(lobby.votes.keys()):
                        break
                await asyncio.sleep(0.3)

            await self._finalize_results(lobby_id)
        except asyncio.CancelledError:
            return
        finally:
            self._vote_tasks.pop(lobby_id, None)

    async def _finalize_results(self, lobby_id: str) -> None:
        async with self._lock:
            lobby = self.lobbies.get(lobby_id)
            if not lobby or lobby.state != LobbyState.VOTING:
                return
            lobby.state = LobbyState.RESULTS
            lobby.results_at = time.time()
            counts: dict[str, int] = {}
            for target in lobby.votes.values():
                counts[target] = counts.get(target, 0) + 1
            if not counts and lobby.uploaded:
                sole = next(iter(lobby.uploaded))
                winners = [sole]
            elif not counts:
                winners = []
            else:
                mx = max(counts.values())
                winners = [pid for pid, c in counts.items() if c == mx]

            def name_for(pid: str) -> str:
                pl = lobby.players.get(pid)
                return pl.name if pl else pid

            board = sorted(counts.items(), key=lambda x: (-x[1], name_for(x[0])))
            leaderboard = [{"player_id": pid, "name": name_for(pid), "votes": v} for pid, v in board]
            winner_names = [name_for(w) for w in winners]
            winner_user_ids = [
                lobby.players[w].user_id for w in winners if w in lobby.players
            ]

        await self.broadcast(
            lobby_id,
            {
                "type": "results",
                "lobby_id": lobby_id,
                "winners": winner_names,
                "winner_ids": winners,
                "leaderboard": leaderboard,
            },
        )

        if winner_user_ids:

            def _persist_wins() -> None:
                db = SessionLocal()
                try:
                    increment_wins_for_users(db, winner_user_ids)
                finally:
                    db.close()

            await asyncio.to_thread(_persist_wins)

        async with self._lock:
            lobby_after = self.lobbies.get(lobby_id)
            if lobby_after:
                for wid in winners:
                    pl = lobby_after.players.get(wid)
                    if pl is not None:
                        pl.wins += 1

    async def cast_vote(self, player_id: str, target_player_id: str) -> None:
        async with self._lock:
            lobby_id = self.player_lobby.get(player_id)
            if not lobby_id:
                await self.send_to(player_id, {"type": "error", "message": "Not in a lobby."})
                return
            lobby = self.lobbies.get(lobby_id)
            if not lobby or lobby.state != LobbyState.VOTING:
                await self.send_to(player_id, {"type": "error", "message": "Voting is not open."})
                return
            if lobby.votes_unlock_at and time.time() < lobby.votes_unlock_at:
                await self.send_to(
                    player_id,
                    {"type": "error", "message": "Votes unlock after the slideshow."},
                )
                return
            if target_player_id == player_id:
                await self.send_to(
                    player_id,
                    {"type": "error", "message": "Cannot vote for yourself."},
                )
                return
            if target_player_id not in lobby.uploaded:
                await self.send_to(player_id, {"type": "error", "message": "Invalid vote target."})
                return
            beat_owners = set(lobby.uploaded)
            if not any(b != player_id for b in beat_owners):
                await self.send_to(
                    player_id,
                    {"type": "error", "message": "No valid vote target for you."},
                )
                return
            lobby.votes[player_id] = target_player_id

        await self.broadcast(
            lobby_id,
            {
                "type": "vote_cast",
                "voter_id": player_id,
                "target_player_id": target_player_id,
            },
        )

        should_finalize = False
        async with self._lock:
            lobby = self.lobbies.get(lobby_id)
            if not lobby:
                return
            beat_owners = set(lobby.uploaded)
            req = self._required_voters(lobby, beat_owners)
            if req.issubset(lobby.votes.keys()):
                if lobby_id in self._vote_tasks:
                    self._vote_tasks[lobby_id].cancel()
                should_finalize = True
        if should_finalize:
            await self._finalize_results(lobby_id)

    async def disconnect(self, player_id: str) -> None:
        lobby_id: str | None = None
        left_count = 0
        lobby: Lobby | None = None
        async with self._lock:
            lobby_id = self.player_lobby.pop(player_id, None)
            self.detach_ws(player_id)
            if lobby_id:
                lobby = self.lobbies.get(lobby_id)
                if lobby:
                    lobby.players.pop(player_id, None)
                    lobby.cook_finished.discard(player_id)
                    left_count = len(lobby.players)
        self.pop_auth_session(player_id)

        if not lobby_id or not lobby:
            return

        await self.broadcast(
            lobby_id,
            {"type": "player_leave", "player_id": player_id},
        )

        if left_count == 0:
            await self._purge_lobby(lobby_id)
            return

        if left_count < 2 and lobby.state == LobbyState.LOBBY:
            await self._dissolve_lobby(lobby_id)
            return

        snap = None
        async with self._lock:
            lobby_rem = self.lobbies.get(lobby_id)
            if lobby_rem:
                snap = lobby_rem.lobby_snapshot()
        if snap is not None:
            await self.broadcast(lobby_id, {"type": "lobby_update", "lobby": snap})

    async def _dissolve_lobby(self, lobby_id: str) -> None:
        async with self._lock:
            lobby = self.lobbies.pop(lobby_id, None)
            if not lobby:
                return
            pids = list(lobby.players.keys())
            for pid in pids:
                self.player_lobby.pop(pid, None)

        for pid in pids:
            await self.send_to(
                pid,
                {"type": "lobby_dissolved", "reason": "not_enough_players"},
            )

        await self._purge_lobby(lobby_id, remove_dir=True)

    async def _purge_lobby(self, lobby_id: str, remove_dir: bool = True) -> None:
        t = self._cook_tasks.pop(lobby_id, None)
        if t:
            t.cancel()
        t = self._upload_tasks.pop(lobby_id, None)
        if t:
            t.cancel()
        t = self._vote_tasks.pop(lobby_id, None)
        if t:
            t.cancel()
        if remove_dir:
            d = self.uploads_root / lobby_id
            if d.is_dir():
                shutil.rmtree(d, ignore_errors=True)
        old: Lobby | None = None
        async with self._lock:
            old = self.lobbies.pop(lobby_id, None)
            if old:
                for pid in old.players:
                    self.player_lobby.pop(pid, None)
        if old:
            for pid in old.players:
                self.pop_auth_session(pid)

    def beat_file_path(self, lobby_id: str, owner_id: str) -> Path | None:
        lobby = self.lobbies.get(lobby_id)
        if not lobby or owner_id not in lobby.uploaded:
            return None
        base = self.uploads_root / lobby_id
        for ext in (".wav", ".mp3", ".WAV", ".MP3"):
            p = base / f"{owner_id}{ext}"
            if p.is_file():
                return p
        return None

    def can_access_beat(self, lobby_id: str, requester_id: str) -> bool:
        lobby = self.lobbies.get(lobby_id)
        if not lobby:
            return False
        return requester_id in lobby.players

    async def cleanup_stale(self) -> None:
        now = time.time()
        async with self._lock:
            to_drop: list[str] = []
            for lid, L in self.lobbies.items():
                if L.state == LobbyState.RESULTS and L.results_at:
                    if now - L.results_at > LOBBY_RESULTS_TTL_S:
                        to_drop.append(lid)
        for lid in to_drop:
            await self._purge_lobby(lid, remove_dir=True)

    async def handle_message(self, player_id: str, data: dict[str, Any]) -> None:
        t = data.get("type")
        if t == "create_lobby":
            spices = _normalize_player_spices(data)
            if spices is None:
                await self.send_to(
                    player_id,
                    {"type": "error", "message": "Invalid spices. Send spices: [0.25, 0.5, ...]."},
                )
                return
            is_public = _coerce_bool(data.get("is_public"), default=True)
            await self.create_lobby(player_id, str(data.get("name", "")), spices, is_public)
        elif t == "join_lobby":
            name = str(data.get("name", ""))
            code = data.get("lobby_code")
            lid = data.get("lobby_id")
            if code is not None and str(code).strip() != "":
                await self.join_lobby_by_code(player_id, name, str(code))
            elif lid is not None and str(lid).strip() != "":
                await self.join_lobby_public(player_id, name, str(lid))
            else:
                await self.send_to(
                    player_id,
                    {"type": "error", "message": "Send lobby_id (public list) or lobby_code."},
                )
        elif t == "player_join":
            # Legacy: treat as join_lobby
            code = data.get("lobby_code") or data.get("lobby_id")
            if code is not None and str(code).strip() != "":
                await self.join_lobby_by_code(player_id, str(data.get("name", "")), str(code))
            else:
                await self.send_to(
                    player_id,
                    {
                        "type": "error",
                        "message": "Use create_lobby or join_lobby with lobby_id / lobby_code.",
                    },
                )
        elif t == "player_ready":
            await self.player_ready(player_id)
        elif t == "set_cook_duration":
            await self.set_cook_duration(player_id, data.get("minutes"))
        elif t == "cook_finished":
            await self.player_cook_finished(player_id)
        elif t == "vote_cast":
            await self.cast_vote(player_id, str(data.get("target_player_id", "")))
        else:
            await self.send_to(player_id, {"type": "error", "message": f"Unknown message: {t}"})

"""
Lobby matchmaking, timers, broadcasts, and state transitions.
Most of the multiplayer brain lives here; lobby.py is mostly constants + datatypes.
"""

from __future__ import annotations

import asyncio
import json
import math
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
    MAX_LOBBY_PLAYERS,
    SLIDESHOW_SEGMENT_S,
    UPLOAD_PHASE_S,
    VOTING_COLLECT_S,
    Lobby,
    LobbyState,
    Player,
    canonical_spice,
)
from .mp_chat_text import chat_cooldown_elapsed, normalize_and_validate_mp_chat_text


def _coerce_bool(v: Any, default: bool = True) -> bool:
    """JSON may send real bools; avoid ``bool("false")`` truthiness bugs."""
    # (JS sometimes sends strings; bool("false") is True — learned the hard way)
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


def voting_beat_entries(lobby: Lobby, lobby_id: str) -> list[dict[str, Any]]:
    """Beats for slideshow + vote cards; names are neutral when ``anonymous_voting``."""
    owners = sorted(lobby.uploaded, key=lambda x: x)
    beats: list[dict[str, Any]] = []
    for i, owner_id in enumerate(owners):
        p = lobby.players.get(owner_id)
        if lobby.anonymous_voting:
            nm = f"Beat {i + 1}"
        else:
            nm = p.name if p else owner_id
        beats.append(
            {
                "player_id": owner_id,
                "name": nm,
                "url": f"/beats/{lobby_id}/{owner_id}",
            }
        )
    return beats


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


# Not raw Unicode over the wire — just keys; frontend paints the actual emoji
MP_CHAT_EMOJI_KEYS: frozenset[str] = frozenset({"wave", "fire", "heart", "skull", "hundred"})
# Legacy alias: same keys as mp_chat emoji.
LOBBY_EMOJI_KEYS: frozenset[str] = MP_CHAT_EMOJI_KEYS
# Reactions while listening to beats in the voting slideshow.
BEAT_REACTION_KEYS: frozenset[str] = frozenset({"fire", "thumbs_up", "thumbs_down", "hundred"})

_MP_CHAT_STATES: frozenset[LobbyState] = frozenset(
    {
        LobbyState.LOBBY,
        LobbyState.COOKING,
        LobbyState.UPLOAD,
        LobbyState.VOTING,
        LobbyState.RESULTS,
    },
)


class LobbyManager:
    def __init__(self, uploads_root: Path) -> None:
        self.uploads_root = uploads_root
        # One lock for all in-memory lobby mutations — keeps races boring
        self._lock = asyncio.Lock()
        self.lobbies: dict[str, Lobby] = {}
        # player_id -> lobby_id so we don't scan every lobby on every message
        self.player_lobby: dict[str, str] = {}
        self.player_ws: dict[str, WebSocket] = {}
        self.auth_user_id: dict[str, int] = {}
        self.auth_username: dict[str, str] = {}
        # Phase timers: cancel the old task when we restart a phase (rematch, etc.)
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
        now = time.time()
        out: dict[str, Any] = {
            "seed": lobby.seed,
            "spice": lobby.spice,
            "match_state": lobby.state.value,
        }
        if lobby.state == LobbyState.COOKING and lobby.cook_deadline_ts is not None:
            out["cook_remaining_s"] = max(
                0, int(math.ceil(lobby.cook_deadline_ts - now))
            )
        if lobby.state == LobbyState.UPLOAD and lobby.upload_deadline_ts is not None:
            out["upload_deadline_ts"] = lobby.upload_deadline_ts
        if lobby.state == LobbyState.VOTING:
            out["beats"] = voting_beat_entries(lobby, lobby_id)
            out["votes_unlock_at"] = lobby.votes_unlock_at
            if lobby.votes_unlock_at is not None:
                out["votes_close_at"] = float(lobby.votes_unlock_at) + float(VOTING_COLLECT_S)
        if lobby.state == LobbyState.RESULTS:
            payload, _ = self._results_ws_payload_and_winner_user_ids(lobby, lobby_id)
            out["results"] = payload
        return out

    @staticmethod
    def _results_ws_payload_and_winner_user_ids(
        lobby: Lobby, lobby_id: str
    ) -> tuple[dict[str, Any], list[int]]:
        """Build ``type: results`` message and DB winner user ids (``lobby.state`` is ``RESULTS``)."""
        counts: dict[str, int] = {}
        for target in lobby.votes.values():
            counts[target] = counts.get(target, 0) + 1
        # Nobody voted but there's exactly one upload — still show *someone* on the board
        if not counts and lobby.uploaded:
            sole = next(iter(lobby.uploaded))
            winners = [sole]
        elif not counts:
            winners = []
        else:
            mx = max(counts.values())
            winners = [pid for pid, c in counts.items() if c == mx]

        n_players = len(lobby.players)
        # 1v1: calling a "winner" felt wrong when it's basically a coin flip — show tie UI instead
        no_winner_two_players = n_players == 2
        if no_winner_two_players:
            winners = []

        owners_ordered = sorted(lobby.uploaded, key=lambda x: x)
        beat_index: dict[str, int] = {pid: i + 1 for i, pid in enumerate(owners_ordered)}

        def name_for(pid: str) -> str:
            pl = lobby.players.get(pid)
            return pl.name if pl else pid

        def results_display_name(pid: str) -> str:
            base = name_for(pid)
            if lobby.anonymous_voting and pid in beat_index:
                return f"{base} - Beat {beat_index[pid]}"
            return base

        board = sorted(counts.items(), key=lambda x: (-x[1], name_for(x[0])))
        leaderboard = [
            {"player_id": pid, "name": results_display_name(pid), "votes": v} for pid, v in board
        ]
        winner_names = [results_display_name(w) for w in winners]
        winner_user_ids = [lobby.players[w].user_id for w in winners if w in lobby.players]

        beats_out: list[dict[str, Any]] = []
        for owner_id in owners_ordered:
            pl = lobby.players.get(owner_id)
            nm = pl.name if pl else owner_id
            label = results_display_name(owner_id) if lobby.anonymous_voting else nm
            beats_out.append(
                {
                    "player_id": owner_id,
                    "name": label,
                    "url": f"/beats/{lobby_id}/{owner_id}",
                }
            )

        participants = [
            {"player_id": pid, "name": lobby.players[pid].name} for pid in lobby.players
        ]

        payload: dict[str, Any] = {
            "type": "results",
            "lobby_id": lobby_id,
            "winners": winner_names,
            "winner_ids": winners,
            "leaderboard": leaderboard,
            "beats": beats_out,
            "no_winner_two_players": no_winner_two_players,
            "participants": participants,
        }
        return payload, winner_user_ids

    def get_match_sync_for_user(self, lobby_id: str, user_id: int) -> dict[str, Any] | None:
        """HTTP recovery: current match phase + payloads matching WebSocket transitions."""
        # Tab refresh / flaky WS — same snapshot the socket would have pushed
        lobby = self.lobbies.get(lobby_id)
        if not lobby:
            return None
        if self.player_id_for_user_in_lobby(lobby_id, user_id) is None:
            return None
        now = time.time()
        st = lobby.state
        out: dict[str, Any] = {
            "match_state": st.value,
            "lobby_id": lobby_id,
        }
        if st == LobbyState.COOKING and lobby.cook_deadline_ts is not None:
            out["cook_remaining_s"] = max(0, int(math.ceil(lobby.cook_deadline_ts - now)))
        if st == LobbyState.UPLOAD and lobby.upload_deadline_ts is not None:
            out["upload_deadline_ts"] = lobby.upload_deadline_ts
        if st == LobbyState.VOTING:
            out["beats"] = voting_beat_entries(lobby, lobby_id)
            out["votes_unlock_at"] = lobby.votes_unlock_at
            if lobby.votes_unlock_at is not None:
                out["votes_close_at"] = float(lobby.votes_unlock_at) + float(VOTING_COLLECT_S)
        if st == LobbyState.RESULTS:
            payload, _ = self._results_ws_payload_and_winner_user_ids(lobby, lobby_id)
            out["results"] = payload
        snap = lobby.lobby_snapshot()
        for key in (
            "player_count",
            "cook_finished",
            "uploaded",
            "slideshow_completed",
            "votes",
            "players",
            "host_id",
            "state",
            "spice",
            "cook_duration_min",
            "max_players",
            "anonymous_voting",
        ):
            if key in snap:
                out[key] = snap[key]
        return out

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
            # Client vanished mid-send; nothing to recover server-side
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
                pass  # same deal — flaky tabs, phone sleep, whatever

    async def send_player_error(
        self,
        player_id: str,
        message: str,
        *,
        error_code: str | None = None,
    ) -> str:
        """Send ``type: error`` with a short ``error_ref`` for user bug reports."""
        ref = secrets.token_hex(4).upper()  # short id for "paste this in Discord" bug reports
        payload: dict[str, Any] = {
            "type": "error",
            "message": message,
            "error_ref": ref,
        }
        if error_code is not None:
            payload["error_code"] = error_code
        await self.send_to(player_id, payload)
        return ref

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
        # 6-char hex codes — retry a few times on collision (shouldn't happen often)
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
            await self.send_player_error(
                player_id,
                "Select at least one heat level (0.25, 0.5, 0.85).",
            )
            return
        sess = self._session_user(player_id)
        if sess is None:
            await self.send_player_error(player_id, "Not authenticated.")
            return
        user_id, display_name = sess
        wins = await asyncio.to_thread(_user_wins_sync, user_id)
        # Lowest heat in the selection wins — predictable for the room's "default" spice
        host_spice = sorted(spices)[0]
        async with self._lock:
            if player_id in self.player_lobby:
                await self.send_player_error(player_id, "Already in a lobby.")
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
            await self.send_player_error(player_id, "Not authenticated.")
            return
        user_id, display_name = sess
        wins = await asyncio.to_thread(_user_wins_sync, user_id)
        async with self._lock:
            if player_id in self.player_lobby:
                await self.send_player_error(player_id, "Already in a lobby.")
                return
            key = self._resolve_lobby_key(code)
            if key is None:
                await self.send_player_error(
                    player_id,
                    "No lobby found for that code. Check the code and try again.",
                )
                return
            lobby = self.lobbies[key]
            if lobby.state != LobbyState.LOBBY:
                await self.send_player_error(
                    player_id,
                    "That match already started or ended.",
                )
                return
            if len(lobby.players) >= MAX_LOBBY_PLAYERS:
                await self.send_player_error(player_id, "Lobby is full.")
                return
            if self._lobby_has_user_id(lobby, user_id):
                await self.send_player_error(
                    player_id,
                    "You are already in this lobby.",
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
            await self.send_player_error(player_id, "Not authenticated.")
            return
        user_id, display_name = sess
        wins = await asyncio.to_thread(_user_wins_sync, user_id)
        async with self._lock:
            if player_id in self.player_lobby:
                await self.send_player_error(player_id, "Already in a lobby.")
                return
            key = self._resolve_lobby_key(lobby_id)
            if key is None:
                await self.send_player_error(
                    player_id,
                    "That lobby is no longer available.",
                )
                return
            lobby = self.lobbies[key]
            if not lobby.is_public:
                await self.send_player_error(
                    player_id,
                    "That lobby is code-only. Enter its code on Join with code.",
                )
                return
            if lobby.state != LobbyState.LOBBY:
                await self.send_player_error(
                    player_id,
                    "That match already started or ended.",
                )
                return
            if len(lobby.players) >= MAX_LOBBY_PLAYERS:
                await self.send_player_error(player_id, "Lobby is full.")
                return
            if self._lobby_has_user_id(lobby, user_id):
                await self.send_player_error(
                    player_id,
                    "You are already in this lobby.",
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
                if len(L.players) >= MAX_LOBBY_PLAYERS:
                    continue
                out.append(
                    {
                        "lobby_id": lid,
                        "spice": L.spice,
                        "player_count": len(L.players),
                        "max_players": MAX_LOBBY_PLAYERS,
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
                await self.send_player_error(
                    player_id,
                    "You can only change duration before the match starts.",
                )
                return
            host_id = next(iter(lobby.players)) if lobby.players else None
            if host_id != player_id:
                await self.send_player_error(
                    player_id,
                    "Only the host can set cook duration.",
                )
                return
            if norm is None:
                await self.send_player_error(
                    player_id,
                    "Invalid duration. Use 5, 10, 15, 20, or 30 minutes.",
                )
                return
            lobby.cook_duration_min = norm

        await self.broadcast(
            lobby_id,
            {"type": "lobby_update", "lobby": self.lobbies[lobby_id].lobby_snapshot()},
        )

    async def set_anonymous_voting(self, player_id: str, raw_flag: Any) -> None:
        flag = _coerce_bool(raw_flag, default=False)
        async with self._lock:
            lobby_id = self.player_lobby.get(player_id)
            if not lobby_id:
                return
            lobby = self.lobbies.get(lobby_id)
            if not lobby or lobby.state != LobbyState.LOBBY:
                await self.send_player_error(
                    player_id,
                    "You can only change anonymous voting before the match starts.",
                )
                return
            host_id = next(iter(lobby.players)) if lobby.players else None
            if host_id != player_id:
                await self.send_player_error(
                    player_id,
                    "Only the host can set anonymous voting.",
                )
                return
            lobby.anonymous_voting = flag

        await self.broadcast(
            lobby_id,
            {"type": "lobby_update", "lobby": self.lobbies[lobby_id].lobby_snapshot()},
        )

    async def kick_player(self, host_id: str, raw_target: Any) -> None:
        """Host-only, pre-game: boot someone from the lobby (they see kicked_from_lobby, then we disconnect them)."""
        target_id = str(raw_target or "").strip()
        err: str | None = None
        err_code: str | None = None
        lobby_id_ok: str | None = None
        target_ok: str | None = None
        async with self._lock:
            if not target_id or target_id == host_id:
                err = "Can't kick yourself."
                err_code = "KICK_SELF"
            else:
                lobby_id = self.player_lobby.get(host_id)
                if not lobby_id:
                    err = "Not in a lobby."
                    err_code = "KICK_NOT_IN_LOBBY"
                else:
                    lobby = self.lobbies.get(lobby_id)
                    if not lobby or lobby.state != LobbyState.LOBBY:
                        err = "You can only kick players before the match starts."
                        err_code = "KICK_BAD_STATE"
                    else:
                        expected_host = next(iter(lobby.players)) if lobby.players else None
                        if expected_host != host_id:
                            err = "Only the host can kick."
                            err_code = "KICK_NOT_HOST"
                        elif target_id not in lobby.players:
                            err = "That player isn't in this lobby."
                            err_code = "KICK_NOT_FOUND"
                        elif self.player_lobby.get(target_id) != lobby_id:
                            err = "That player isn't in this lobby."
                            err_code = "KICK_NOT_FOUND"
                        else:
                            lobby_id_ok = lobby_id
                            target_ok = target_id
        if err:
            await self.send_player_error(host_id, err, error_code=err_code)
            return
        assert lobby_id_ok is not None and target_ok is not None
        # Tell them first, then run normal disconnect cleanup (votes, uploads, etc.)
        await self.send_to(target_ok, {"type": "kicked_from_lobby"})
        await self.disconnect(target_ok)

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
            seed = random.randint(0, 2**31 - 1)  # clients derive the same kit from this + spice
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
            duration_s = max(
                60, min(max(COOK_DURATION_MIN_OPTIONS) * 60, int(lobby.cook_duration_min) * 60)
            )
            lobby.cook_deadline_ts = time.time() + duration_s
            lobby.upload_deadline_ts = None

        early_all_done = False
        try:
            # Second-by-second tick; heavy but the UI wants a live countdown
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
            # Only clear the slot if *this* task is still the registered one (rematch may have replaced it)
            me = asyncio.current_task()
            t = self._cook_tasks.get(lobby_id)
            if t is me:
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

        upload_deadline_ts = time.time() + UPLOAD_PHASE_S
        async with self._lock:
            lobby = self.lobbies.get(lobby_id)
            if not lobby or lobby.state != LobbyState.COOKING:
                return
            # Cook phase done — flip state before clients start POSTing files
            lobby.state = LobbyState.UPLOAD
            lobby.cook_deadline_ts = None
            lobby.upload_deadline_ts = upload_deadline_ts

        await self.broadcast(
            lobby_id,
            {
                "type": "upload_phase_start",
                "lobby_id": lobby_id,
                "upload_deadline_ts": upload_deadline_ts,
            },
        )

        if lobby_id in self._upload_tasks:
            self._upload_tasks[lobby_id].cancel()
        self._upload_tasks[lobby_id] = asyncio.create_task(
            self._upload_phase(lobby_id, upload_deadline_ts)
        )

    async def _upload_phase(self, lobby_id: str, deadline_ts: float) -> None:
        try:
            # Poll until everyone uploaded or the clock runs out — not elegant, works
            while time.time() < deadline_ts:
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
            me = asyncio.current_task()
            t = self._upload_tasks.get(lobby_id)
            if t is me:
                self._upload_tasks.pop(lobby_id, None)

    async def record_upload(self, lobby_id: str, player_id: str) -> None:
        async with self._lock:
            lobby = self.lobbies.get(lobby_id)
            if not lobby or lobby.state != LobbyState.UPLOAD:
                return
            if player_id not in lobby.players:
                return
            lobby.uploaded.add(player_id)
            snap = lobby.lobby_snapshot()
        await self.broadcast(
            lobby_id,
            {"type": "beat_uploaded", "player_id": player_id},
        )
        await self.broadcast(lobby_id, {"type": "lobby_update", "lobby": snap})

    async def _begin_voting(self, lobby_id: str) -> None:
        async with self._lock:
            lobby = self.lobbies.get(lobby_id)
            if not lobby:
                return
            if lobby.state != LobbyState.UPLOAD:
                return
            lobby.state = LobbyState.VOTING
            lobby.votes.clear()
            lobby.slideshow_completed.clear()
            n = len(lobby.uploaded)
            # One segment per beat in the slideshow; n==0 is a weird empty edge case
            unlock = time.time() + (0 if n == 0 else SLIDESHOW_SEGMENT_S * n)
            lobby.votes_unlock_at = unlock

        beats = voting_beat_entries(self.lobbies[lobby_id], lobby_id)

        unlock_ts = self.lobbies[lobby_id].votes_unlock_at
        voting_msg: dict[str, Any] = {
            "type": "voting_start",
            "lobby_id": lobby_id,
            "beats": beats,
            "votes_unlock_at": unlock_ts,
        }
        if unlock_ts is not None:
            voting_msg["votes_close_at"] = float(unlock_ts) + float(VOTING_COLLECT_S)
        await self.broadcast(lobby_id, voting_msg)

        if lobby_id in self._vote_tasks:
            self._vote_tasks[lobby_id].cancel()
        self._vote_tasks[lobby_id] = asyncio.create_task(self._vote_collection_loop(lobby_id))

    @staticmethod
    def _required_voters(lobby: Lobby, beat_owners: set[str]) -> set[str]:
        # You only *must* vote if there's someone else's beat to pick — solo upload edge case
        req: set[str] = set()
        for pid in lobby.players:
            if any(b != pid for b in beat_owners):
                req.add(pid)
        return req

    @staticmethod
    def _all_players_finished_slideshow(lobby: Lobby) -> bool:
        """Every connected player has sent ``slideshow_complete``."""
        if not lobby.players:
            return True
        return len(lobby.slideshow_completed) >= len(lobby.players)

    async def _vote_collection_loop(self, lobby_id: str) -> None:
        try:
            # First wait out the slideshow (or until slideshow_complete bumps the unlock)
            while True:
                async with self._lock:
                    lobby = self.lobbies.get(lobby_id)
                    if not lobby or lobby.state != LobbyState.VOTING:
                        return
                    unlock = lobby.votes_unlock_at
                u = unlock if unlock else time.time()
                if time.time() >= u:
                    break
                await asyncio.sleep(0.2)

            async with self._lock:
                lobby = self.lobbies.get(lobby_id)
                if not lobby or lobby.state != LobbyState.VOTING:
                    return
                unlock = lobby.votes_unlock_at or time.time()
            deadline = unlock + VOTING_COLLECT_S
            # Then collect votes until deadline or everyone who *can* vote has voted
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
            me = asyncio.current_task()
            t = self._vote_tasks.get(lobby_id)
            if t is me:
                self._vote_tasks.pop(lobby_id, None)

    async def _finalize_results(self, lobby_id: str) -> None:
        winner_user_ids: list[int] = []
        payload: dict[str, Any] | None = None
        winners: list[str] = []
        async with self._lock:
            lobby = self.lobbies.get(lobby_id)
            if not lobby or lobby.state != LobbyState.VOTING:
                return
            lobby.state = LobbyState.RESULTS
            lobby.results_at = time.time()
            lobby.rematch_pending.clear()
            payload, winner_user_ids = self._results_ws_payload_and_winner_user_ids(lobby, lobby_id)
            winners = list(payload.get("winner_ids") or [])

        if payload is None:
            return

        await self.broadcast(lobby_id, payload)

        if winner_user_ids:
            # DB write off the event loop so we don't block broadcasts
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

    async def slideshow_complete(self, player_id: str) -> None:
        """Client finished playing all beats in the voting slideshow; allow their vote before max timer."""
        bump: tuple[str, float] | None = None
        async with self._lock:
            lobby_id = self.player_lobby.get(player_id)
            if not lobby_id:
                return
            lobby = self.lobbies.get(lobby_id)
            if not lobby or lobby.state != LobbyState.VOTING:
                return
            if player_id not in lobby.players:
                return
            lobby.slideshow_completed.add(player_id)
            if (
                self._all_players_finished_slideshow(lobby)
                and lobby.votes_unlock_at is not None
                and time.time() < lobby.votes_unlock_at
            ):
                # Fast-forward: whole room skipped ahead on the slideshow — no point waiting on the timer
                now = time.time()
                lobby.votes_unlock_at = now
                bump = (lobby_id, now)
        if bump is not None:
            lid, ts = bump
            await self.broadcast(
                lid,
                {
                    "type": "votes_timing",
                    "lobby_id": lid,
                    "votes_unlock_at": ts,
                    "votes_close_at": ts + float(VOTING_COLLECT_S),
                },
            )

    async def mp_chat(self, player_id: str, data: dict[str, Any]) -> None:
        text_raw = data.get("text")
        emoji_raw = data.get("emoji")
        text_nonempty = text_raw is not None and str(text_raw).strip() != ""
        emoji_nonempty = emoji_raw is not None and str(emoji_raw).strip() != ""

        if text_nonempty and emoji_nonempty:
            await self.send_player_error(player_id, "Send either text or emoji, not both.")
            return
        if not text_nonempty and not emoji_nonempty:
            await self.send_player_error(player_id, "Empty message.")
            return

        now = time.time()
        async with self._lock:
            lobby_id = self.player_lobby.get(player_id)
            if not lobby_id:
                return
            lobby = self.lobbies.get(lobby_id)
            if not lobby or lobby.state not in _MP_CHAT_STATES:
                await self.send_player_error(player_id, "Chat is not available right now.")
                return
            pl = lobby.players.get(player_id)
            if not pl:
                return
            last = lobby.chat_last_sent.get(player_id)
            if not chat_cooldown_elapsed(last, now):
                await self.send_player_error(
                    player_id,
                    "Wait before sending another message.",
                    error_code="MP_CHAT_COOLDOWN",
                )
                return

            if text_nonempty:
                normalized, err = normalize_and_validate_mp_chat_text(text_raw)
                if err or normalized is None:
                    await self.send_player_error(player_id, err or "Invalid message.")
                    return
                lobby.chat_last_sent[player_id] = now
                name = pl.name
                payload: dict[str, Any] = {
                    "type": "mp_chat",
                    "player_id": player_id,
                    "name": name,
                    "text": normalized,
                    "ts": int(now * 1000),
                }
            else:
                key = str(emoji_raw).strip()
                if key not in MP_CHAT_EMOJI_KEYS:
                    await self.send_player_error(player_id, "Invalid emoji.")
                    return
                lobby.chat_last_sent[player_id] = now
                name = pl.name
                payload = {
                    "type": "mp_chat",
                    "player_id": player_id,
                    "name": name,
                    "emoji": key,
                    "ts": int(now * 1000),
                }

        await self.broadcast(lobby_id, payload)

    async def lobby_emoji(self, player_id: str, emoji_key: str) -> None:
        """Legacy client message; same rules as ``mp_chat`` with emoji only."""
        await self.mp_chat(player_id, {"emoji": emoji_key})

    async def beat_reaction(self, player_id: str, target_player_id: str, reaction: str) -> None:
        r = str(reaction).strip()
        if r not in BEAT_REACTION_KEYS:
            await self.send_player_error(player_id, "Invalid reaction.")
            return
        tid = str(target_player_id).strip()
        if not tid:
            await self.send_player_error(player_id, "Missing beat target.")
            return
        async with self._lock:
            lobby_id = self.player_lobby.get(player_id)
            if not lobby_id:
                return
            lobby = self.lobbies.get(lobby_id)
            if not lobby or lobby.state != LobbyState.VOTING:
                await self.send_player_error(
                    player_id,
                    "Reactions are only available during the listening phase.",
                )
                return
            if player_id not in lobby.players or tid not in lobby.uploaded:
                await self.send_player_error(player_id, "Invalid reaction target.")
                return
            if tid == player_id:
                return
            pl = lobby.players.get(player_id)
            from_name = pl.name if pl else player_id
        await self.broadcast(
            lobby_id,
            {
                "type": "beat_reaction",
                "from_player_id": player_id,
                "from_name": from_name,
                "target_player_id": tid,
                "reaction": r,
            },
        )

    async def cast_vote(self, player_id: str, target_player_id: str) -> None:
        async with self._lock:
            lobby_id = self.player_lobby.get(player_id)
            if not lobby_id:
                await self.send_player_error(player_id, "Not in a lobby.")
                return
            lobby = self.lobbies.get(lobby_id)
            if not lobby or lobby.state != LobbyState.VOTING:
                await self.send_player_error(player_id, "Voting is not open.")
                return
            if lobby.votes_unlock_at and time.time() < lobby.votes_unlock_at:
                if player_id not in lobby.slideshow_completed:
                    await self.send_player_error(
                        player_id,
                        "Votes unlock after the slideshow.",
                    )
                    return
            if target_player_id == player_id:
                await self.send_player_error(
                    player_id,
                    "Cannot vote for yourself.",
                )
                return
            if target_player_id not in lobby.uploaded:
                await self.send_player_error(player_id, "Invalid vote target.")
                return
            beat_owners = set(lobby.uploaded)
            if not any(b != player_id for b in beat_owners):
                await self.send_player_error(
                    player_id,
                    "No valid vote target for you.",
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

        snap_after: dict[str, Any] | None = None
        async with self._lock:
            lobby_snap = self.lobbies.get(lobby_id)
            if lobby_snap:
                snap_after = lobby_snap.lobby_snapshot()
        if snap_after is not None:
            await self.broadcast(lobby_id, {"type": "lobby_update", "lobby": snap_after})

        should_finalize = False
        async with self._lock:
            lobby = self.lobbies.get(lobby_id)
            if not lobby:
                return
            beat_owners = set(lobby.uploaded)
            req = self._required_voters(lobby, beat_owners)
            if req.issubset(lobby.votes.keys()):
                # Last vote can end the round early — yank the background waiter so we don't double-finish
                if lobby_id in self._vote_tasks:
                    self._vote_tasks[lobby_id].cancel()
                should_finalize = True
        if should_finalize:
            await self._finalize_results(lobby_id)

    def _delete_lobby_upload_dir_only(self, lobby_id: str) -> None:
        """Cancel tasks and remove upload dir; does not pop lobby or auth (used after rematch migration)."""
        t = self._cook_tasks.pop(lobby_id, None)
        if t:
            t.cancel()
        t = self._upload_tasks.pop(lobby_id, None)
        if t:
            t.cancel()
        t = self._vote_tasks.pop(lobby_id, None)
        if t:
            t.cancel()
        d = self.uploads_root / lobby_id
        if d.is_dir():
            shutil.rmtree(d, ignore_errors=True)

    async def _rematch_to_new_lobby(self, old_id: str) -> None:
        new_id: str | None = None
        new_snap: dict[str, Any] | None = None
        async with self._lock:
            old = self.lobbies.get(old_id)
            if not old or old.state != LobbyState.RESULTS:
                return
            # Everyone still in the room must have hit rematch — partial consensus doesn't fly
            if set(old.players.keys()) != old.rematch_pending:
                return
            new_id = self._new_lobby_id()
            new_lobby = Lobby(
                id=new_id,
                spice=old.spice,
                is_public=old.is_public,
                cook_duration_min=old.cook_duration_min,
                anonymous_voting=old.anonymous_voting,
            )
            for pid, p in old.players.items():
                new_lobby.players[pid] = Player(
                    id=p.id,
                    name=p.name,
                    user_id=p.user_id,
                    wins=p.wins,
                    ready=False,
                )
                self.player_lobby[pid] = new_id
            self.lobbies[new_id] = new_lobby
            del self.lobbies[old_id]
            new_snap = new_lobby.lobby_snapshot()

        # Old match audio lives under old_id/ — nuke it after we've moved players to new_id
        self._delete_lobby_upload_dir_only(old_id)
        if new_id is not None and new_snap is not None:
            await self.broadcast(new_id, {"type": "lobby_update", "lobby": new_snap})

    async def rematch_vote(self, player_id: str) -> None:
        err: str | None = None
        lobby_id: str | None = None
        voted_ids: list[str] = []
        voter_name = ""
        voter_id = ""
        broadcast_vote = False
        all_voted = False
        async with self._lock:
            lid = self.player_lobby.get(player_id)
            if not lid:
                err = "Not in a lobby."
            else:
                lobby = self.lobbies.get(lid)
                if not lobby or lobby.state != LobbyState.RESULTS:
                    err = "Rematch is only available on the results screen."
                elif player_id not in lobby.players:
                    pass
                elif player_id in lobby.rematch_pending:
                    pass
                else:
                    lobby.rematch_pending.add(player_id)
                    lobby.rematch_pending.intersection_update(set(lobby.players.keys()))
                    lobby_id = lid
                    voted_ids = list(lobby.rematch_pending)
                    voter_name = lobby.players[player_id].name
                    voter_id = player_id
                    broadcast_vote = True
                    cur = set(lobby.players.keys())
                    # Need ≥2 players — solo "unanimous" rematch is not allowed.
                    all_voted = len(cur) >= 2 and cur == lobby.rematch_pending
        if err:
            await self.send_player_error(player_id, err)
            return
        if not broadcast_vote:
            return
        assert lobby_id is not None
        await self.broadcast(
            lobby_id,
            {
                "type": "rematch_vote_update",
                "voted_player_ids": voted_ids,
                "voter_id": voter_id,
                "name": voter_name,
            },
        )
        if all_voted:
            await self._rematch_to_new_lobby(lobby_id)

    async def disconnect(self, player_id: str) -> None:
        lobby_id: str | None = None
        left_count = 0
        left_name = ""
        state_after: LobbyState | None = None
        lobby: Lobby | None = None
        async with self._lock:
            lobby_id = self.player_lobby.pop(player_id, None)
            self.detach_ws(player_id)
            if lobby_id:
                lobby = self.lobbies.get(lobby_id)
                if lobby:
                    gone = lobby.players.pop(player_id, None)
                    if gone:
                        left_name = gone.name
                    lobby.rematch_pending.discard(player_id)
                    lobby.cook_finished.discard(player_id)
                    lobby.chat_last_sent.pop(player_id, None)
                    lobby.uploaded.discard(player_id)
                    lobby.votes.pop(player_id, None)
                    # If they left, anyone who voted for them needs a do-over
                    for vid in [k for k, tgt in lobby.votes.items() if tgt == player_id]:
                        lobby.votes.pop(vid, None)
                    lobby.slideshow_completed.discard(player_id)
                    left_count = len(lobby.players)
                    state_after = lobby.state
        self.pop_auth_session(player_id)

        if not lobby_id or not lobby or state_after is None:
            return

        # Don't leave orphan mp3s on disk if they bail mid-upload
        self._unlink_player_beat_upload(lobby_id, player_id)

        await self.broadcast(
            lobby_id,
            {
                "type": "player_leave",
                "player_id": player_id,
                "name": left_name,
            },
        )

        if state_after == LobbyState.RESULTS and left_count > 0:
            rematch_voted: list[str] = []
            do_rematch = False
            async with self._lock:
                lobby_res = self.lobbies.get(lobby_id)
                if lobby_res:
                    lobby_res.rematch_pending.intersection_update(set(lobby_res.players.keys()))
                    rematch_voted = sorted(lobby_res.rematch_pending)
                    cur_p = set(lobby_res.players.keys())
                    do_rematch = len(cur_p) >= 2 and cur_p == lobby_res.rematch_pending
            await self.broadcast(
                lobby_id,
                {
                    "type": "rematch_vote_update",
                    "voted_player_ids": rematch_voted,
                    "voter_id": "",
                    "name": "",
                },
            )
            if do_rematch:
                await self._rematch_to_new_lobby(lobby_id)

        if left_count == 0:
            await self._purge_lobby(lobby_id)
            return

        if left_count == 1 and state_after == LobbyState.RESULTS:
            await self._dissolve_results_solo_player(lobby_id)
            return

        # Pre-game: allow a single player to stay in the lobby (wait for others).
        # Mid-match: last player alone ends the match below.

        if (
            left_count == 1
            and state_after != LobbyState.LOBBY
            and state_after != LobbyState.RESULTS
        ):
            await self._end_match_only_player_left(lobby_id)
            return

        if state_after == LobbyState.COOKING:
            finished_ids: list[str] = []
            n_cook = 0
            async with self._lock:
                lobby_c = self.lobbies.get(lobby_id)
                if lobby_c:
                    finished_ids = sorted(lobby_c.cook_finished)
                    n_cook = len(lobby_c.players)
            await self.broadcast(
                lobby_id,
                {
                    "type": "cook_finished_update",
                    "finished_player_ids": finished_ids,
                    "player_count": n_cook,
                },
            )

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

    async def _dissolve_results_solo_player(self, lobby_id: str) -> None:
        """Results screen with one player left (others quit): no rematch — send to menu."""
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

    async def _end_match_only_player_left(self, lobby_id: str) -> None:
        """Last remaining player mid-match: notify client and tear down lobby."""
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
                {"type": "lobby_dissolved", "reason": "only_player_left"},
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

    def _unlink_player_beat_upload(self, lobby_id: str, player_id: str) -> None:
        # Filenames are {player_id}.mp3 — try common extensions, case variants
        base = self.uploads_root / lobby_id
        if not base.is_dir():
            return
        for ext in (".wav", ".mp3", ".WAV", ".MP3"):
            p = base / f"{player_id}{ext}"
            if p.is_file():
                try:
                    p.unlink()
                except OSError:
                    pass

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
        # Periodic sweeper — keeps abandoned results screens from piling up forever
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
        # WebSocket entry point — one big switch; keep payloads forgiving for older clients
        t = data.get("type")
        if t == "create_lobby":
            spices = _normalize_player_spices(data)
            if spices is None:
                await self.send_player_error(
                    player_id,
                    "Invalid spices. Send spices: [0.25, 0.5, ...].",
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
                await self.send_player_error(
                    player_id,
                    "Send lobby_id (public list) or lobby_code.",
                )
        elif t == "player_join":
            # Legacy: treat as join_lobby
            code = data.get("lobby_code") or data.get("lobby_id")
            if code is not None and str(code).strip() != "":
                await self.join_lobby_by_code(player_id, str(data.get("name", "")), str(code))
            else:
                await self.send_player_error(
                    player_id,
                    "Use create_lobby or join_lobby with lobby_id / lobby_code.",
                )
        elif t == "player_ready":
            await self.player_ready(player_id)
        elif t == "kick_player":
            await self.kick_player(player_id, data.get("target_player_id"))
        elif t == "set_cook_duration":
            await self.set_cook_duration(player_id, data.get("minutes"))
        elif t == "set_anonymous_voting":
            await self.set_anonymous_voting(player_id, data.get("anonymous_voting"))
        elif t == "cook_finished":
            await self.player_cook_finished(player_id)
        elif t == "rematch_vote":
            await self.rematch_vote(player_id)
        elif t == "vote_cast":
            await self.cast_vote(player_id, str(data.get("target_player_id", "")))
        elif t == "slideshow_complete":
            await self.slideshow_complete(player_id)
        elif t == "mp_chat":
            await self.mp_chat(player_id, data)
        elif t == "lobby_emoji":
            await self.lobby_emoji(player_id, str(data.get("emoji", "")))
        elif t == "beat_reaction":
            await self.beat_reaction(
                player_id,
                str(data.get("target_player_id", "")),
                str(data.get("reaction", "")),
            )
        else:
            label = repr(t) if t is not None else "None"
            if len(label) > 80:
                label = label[:77] + "..."
            await self.send_player_error(
                player_id,
                f"Unknown message type: {label}",
                error_code="UNKNOWN_MESSAGE_TYPE",
            )

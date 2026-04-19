"""Host kick from pre-game lobby."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from backend.multiplayer.lobby import Lobby, LobbyState, Player
from backend.multiplayer.manager import LobbyManager


def test_host_kick_sends_payload_and_removes_target(tmp_path: Path) -> None:
    async def run() -> None:
        mgr = LobbyManager(tmp_path)
        lid = "KICK01"
        host = "hostPlayerIdxx"
        target = "tgtPlayerIdxx"
        lobby = Lobby(id=lid, spice=0.5, is_public=True)
        lobby.state = LobbyState.LOBBY
        lobby.players[host] = Player(id=host, name="Host", user_id=1, wins=0, ready=False)
        lobby.players[target] = Player(id=target, name="Guest", user_id=2, wins=0, ready=False)
        mgr.lobbies[lid] = lobby
        mgr.player_lobby[host] = lid
        mgr.player_lobby[target] = lid

        sent: list[str] = []

        class FakeWS:
            async def send_text(self, raw: str) -> None:
                sent.append(raw)

        mgr.attach_ws(target, FakeWS())  # type: ignore[arg-type]

        await mgr.kick_player(host, target)

        assert mgr.player_lobby.get(target) is None
        assert target not in mgr.lobbies[lid].players
        assert host in mgr.lobbies[lid].players
        payloads = [json.loads(s) for s in sent]
        assert any(p.get("type") == "kicked_from_lobby" for p in payloads)

    asyncio.run(run())


def test_non_host_cannot_kick(tmp_path: Path) -> None:
    async def run() -> None:
        mgr = LobbyManager(tmp_path)
        lid = "KICK02"
        host = "hostIdxxxxxx"
        joiner = "joinIdxxxxxx"
        lobby = Lobby(id=lid, spice=0.5, is_public=True)
        lobby.state = LobbyState.LOBBY
        lobby.players[host] = Player(id=host, name="H", user_id=1, wins=0, ready=False)
        lobby.players[joiner] = Player(id=joiner, name="J", user_id=2, wins=0, ready=False)
        mgr.lobbies[lid] = lobby
        mgr.player_lobby[host] = lid
        mgr.player_lobby[joiner] = lid

        host_sent: list[str] = []

        class FakeWS:
            def __init__(self, bucket: list[str]) -> None:
                self._b = bucket

            async def send_text(self, raw: str) -> None:
                self._b.append(raw)

        mgr.attach_ws(joiner, FakeWS(host_sent))  # type: ignore[arg-type]

        await mgr.kick_player(joiner, host)

        assert joiner in mgr.lobbies[lid].players
        assert host in mgr.lobbies[lid].players
        err_payloads = [json.loads(s) for s in host_sent if "error" in s]
        assert any(
            p.get("type") == "error" and p.get("error_code") == "KICK_NOT_HOST"
            for p in err_payloads
        )

    asyncio.run(run())


def test_kick_unready_player_starts_when_remaining_all_ready(tmp_path: Path) -> None:
    """After removing a not-ready player, remaining ready players should start."""

    async def run() -> None:
        mgr = LobbyManager(tmp_path)
        lid = "KICK03"
        host = "hostKickReady"
        ready_p = "readyPlayerId"
        unready = "unreadyPlayerId"
        lobby = Lobby(id=lid, spice=0.5, is_public=True)
        lobby.state = LobbyState.LOBBY
        lobby.players[host] = Player(id=host, name="Host", user_id=1, wins=0, ready=True)
        lobby.players[ready_p] = Player(id=ready_p, name="R", user_id=2, wins=0, ready=True)
        lobby.players[unready] = Player(id=unready, name="U", user_id=3, wins=0, ready=False)
        mgr.lobbies[lid] = lobby
        mgr.player_lobby[host] = lid
        mgr.player_lobby[ready_p] = lid
        mgr.player_lobby[unready] = lid

        host_msgs: list[str] = []
        ready_msgs: list[str] = []

        class FakeWS:
            def __init__(self, bucket: list[str]) -> None:
                self._b = bucket

            async def send_text(self, raw: str) -> None:
                self._b.append(raw)

        mgr.attach_ws(host, FakeWS(host_msgs))  # type: ignore[arg-type]
        mgr.attach_ws(ready_p, FakeWS(ready_msgs))  # type: ignore[arg-type]
        mgr.attach_ws(unready, FakeWS([]))  # type: ignore[arg-type]

        await mgr.kick_player(host, unready)

        assert unready not in mgr.lobbies[lid].players
        assert mgr.lobbies[lid].state == LobbyState.COOKING
        combined = [json.loads(s) for s in host_msgs + ready_msgs]
        assert any(p.get("type") == "start_game" for p in combined)

    asyncio.run(run())

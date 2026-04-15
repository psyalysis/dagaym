"""WebSocket soft disconnect, resume_player_id, leave_lobby, grace expiry."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

from backend.multiplayer.lobby import Lobby, LobbyState, Player
from backend.multiplayer.manager import LobbyManager


def test_soft_disconnect_keeps_seat_and_match_sync(tmp_path) -> None:
    async def run() -> None:
        mgr = LobbyManager(tmp_path)
        lid = "AB12CD"
        p1 = "playerOneXxx"
        lobby = Lobby(id=lid, spice=0.5, is_public=True)
        lobby.state = LobbyState.COOKING
        lobby.players[p1] = Player(id=p1, name="A", user_id=10, wins=0)
        mgr.lobbies[lid] = lobby
        mgr.player_lobby[p1] = lid
        mgr.register_auth_session(p1, 10, "A")

        ws1 = MagicMock()
        ws1.close = AsyncMock()
        mgr.attach_ws(p1, ws1)  # type: ignore[arg-type]

        await mgr.detach_connection(p1, ws1)  # type: ignore[arg-type]

        assert p1 in lobby.players
        assert mgr.player_lobby.get(p1) == lid
        sync = mgr.get_match_sync_for_user(lid, 10)
        assert sync is not None
        assert sync["match_state"] == "cooking"

    asyncio.run(run())


def test_leave_lobby_hard_removes(tmp_path) -> None:
    async def run() -> None:
        mgr = LobbyManager(tmp_path)
        lid = "CD34EF"
        p1 = "playerLeave1"
        lobby = Lobby(id=lid, spice=0.25, is_public=True)
        lobby.players[p1] = Player(id=p1, name="A", user_id=11, wins=0)
        mgr.lobbies[lid] = lobby
        mgr.player_lobby[p1] = lid
        mgr.register_auth_session(p1, 11, "A")
        ws1 = MagicMock()
        mgr.attach_ws(p1, ws1)  # type: ignore[arg-type]

        await mgr.handle_message(p1, {"type": "leave_lobby"})

        assert p1 not in lobby.players
        assert mgr.player_lobby.get(p1) is None

    asyncio.run(run())


def test_grace_expiry_removes_player(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("backend.multiplayer.manager.MP_WS_GRACE_S", 0.05)

    async def run() -> None:
        mgr = LobbyManager(tmp_path)
        lid = "EF56GH"
        p1 = "playerGrace1"
        lobby = Lobby(id=lid, spice=0.5, is_public=True)
        lobby.state = LobbyState.LOBBY
        lobby.players[p1] = Player(id=p1, name="A", user_id=12, wins=0)
        mgr.lobbies[lid] = lobby
        mgr.player_lobby[p1] = lid
        mgr.register_auth_session(p1, 12, "A")
        ws1 = MagicMock()
        mgr.attach_ws(p1, ws1)  # type: ignore[arg-type]

        await mgr.detach_connection(p1, ws1)  # type: ignore[arg-type]
        await asyncio.sleep(0.2)

        assert p1 not in lobby.players

    asyncio.run(run())


def test_try_resume_replaces_old_socket(tmp_path) -> None:
    async def run() -> None:
        mgr = LobbyManager(tmp_path)
        lid = "GH78IJ"
        p1 = "playerResum1"
        lobby = Lobby(id=lid, spice=0.5, is_public=True)
        lobby.state = LobbyState.LOBBY
        lobby.players[p1] = Player(id=p1, name="A", user_id=13, wins=0)
        mgr.lobbies[lid] = lobby
        mgr.player_lobby[p1] = lid
        mgr.register_auth_session(p1, 13, "A")
        old_ws = MagicMock()
        old_ws.close = AsyncMock()
        mgr.attach_ws(p1, old_ws)  # type: ignore[arg-type]

        new_ws = MagicMock()
        ok, err = await mgr.try_resume_player(13, "A", p1, new_ws)  # type: ignore[arg-type]
        assert ok is True
        assert err is None
        assert mgr.player_ws.get(p1) is new_ws
        old_ws.close.assert_awaited_once()

    asyncio.run(run())


def test_try_resume_wrong_user(tmp_path) -> None:
    async def run() -> None:
        mgr = LobbyManager(tmp_path)
        lid = "IJ90KL"
        p1 = "playerResum2"
        lobby = Lobby(id=lid, spice=0.5, is_public=True)
        lobby.players[p1] = Player(id=p1, name="A", user_id=14, wins=0)
        mgr.lobbies[lid] = lobby
        mgr.player_lobby[p1] = lid
        new_ws = MagicMock()
        ok, err = await mgr.try_resume_player(99, "Evil", p1, new_ws)  # type: ignore[arg-type]
        assert ok is False
        assert err == "wrong_user"

    asyncio.run(run())

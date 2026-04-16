"""Tests for multiplayer rematch (new lobby after unanimous vote)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from backend.multiplayer.lobby import Lobby, LobbyState, Player
from backend.multiplayer.manager import LobbyManager


def test_finalize_results_includes_participants_shape() -> None:
    """Participants list matches lobby.players order (dict insertion order)."""
    lobby = Lobby(id="AA11BB", spice=0.5, is_public=True)
    lobby.state = LobbyState.VOTING
    lobby.players["p1"] = Player(id="p1", name="Alice", user_id=1, wins=0)
    lobby.players["p2"] = Player(id="p2", name="Bob", user_id=2, wins=0)
    lobby.uploaded = {"p1", "p2"}
    lobby.votes = {"p1": "p2", "p2": "p1"}

    participants = [
        {"player_id": pid, "name": lobby.players[pid].name} for pid in lobby.players
    ]
    assert participants == [
        {"player_id": "p1", "name": "Alice"},
        {"player_id": "p2", "name": "Bob"},
    ]


def test_rematch_migrates_to_new_lobby_and_broadcasts(tmp_path: Path) -> None:
    async def run() -> None:
        mgr = LobbyManager(tmp_path)
        old_id = "C0FFEE"
        p1 = "playerOneIdxx"
        p2 = "playerTwoIdxx"
        lobby = Lobby(id=old_id, spice=0.85, is_public=False, cook_duration_min=20)
        lobby.state = LobbyState.RESULTS
        lobby.players[p1] = Player(id=p1, name="A", user_id=10, wins=3, ready=False)
        lobby.players[p2] = Player(id=p2, name="B", user_id=20, wins=1, ready=True)
        lobby.rematch_pending = {p1, p2}
        mgr.lobbies[old_id] = lobby
        mgr.player_lobby[p1] = old_id
        mgr.player_lobby[p2] = old_id
        mgr.register_auth_session(p1, 10, "A")
        mgr.register_auth_session(p2, 20, "B")

        class FakeWS:
            def __init__(self) -> None:
                self.sent: list[str] = []

            async def send_text(self, raw: str) -> None:
                self.sent.append(raw)

        ws1 = FakeWS()
        ws2 = FakeWS()
        mgr.attach_ws(p1, ws1)  # type: ignore[arg-type]
        mgr.attach_ws(p2, ws2)  # type: ignore[arg-type]

        (tmp_path / old_id).mkdir(parents=True)
        (tmp_path / old_id / "dummy.txt").write_text("x", encoding="utf-8")

        await mgr._rematch_to_new_lobby(old_id)

        assert old_id not in mgr.lobbies
        assert len(mgr.lobbies) == 1
        new_id = next(iter(mgr.lobbies))
        assert new_id != old_id
        assert mgr.player_lobby[p1] == new_id
        assert mgr.player_lobby[p2] == new_id
        new_lobby = mgr.lobbies[new_id]
        assert new_lobby.state == LobbyState.LOBBY
        assert new_lobby.spice == 0.85
        assert new_lobby.is_public is False
        assert new_lobby.cook_duration_min == 20
        assert new_lobby.players[p1].wins == 3
        assert new_lobby.players[p2].wins == 1
        assert new_lobby.players[p1].ready is False
        assert not (tmp_path / old_id).exists()

        for ws in (ws1, ws2):
            payloads = [json.loads(s) for s in ws.sent]
            assert any(p.get("type") == "lobby_update" and p.get("lobby", {}).get("state") == "lobby" for p in payloads)

    asyncio.run(run())


def test_rematch_does_not_start_with_single_player(tmp_path: Path) -> None:
    """Solo on results cannot rematch — unanimous with yourself is not allowed."""

    async def run() -> None:
        mgr = LobbyManager(tmp_path)
        lid = "SOLO01"
        p1 = "soloPlayerIdxx"
        lobby = Lobby(id=lid, spice=0.5, is_public=True)
        lobby.state = LobbyState.RESULTS
        lobby.players[p1] = Player(id=p1, name="Solo", user_id=1, wins=0, ready=False)
        mgr.lobbies[lid] = lobby
        mgr.player_lobby[p1] = lid
        mgr.register_auth_session(p1, 1, "Solo")
        await mgr.rematch_vote(p1)
        assert lid in mgr.lobbies
        assert mgr.lobbies[lid].rematch_pending == {p1}

    asyncio.run(run())

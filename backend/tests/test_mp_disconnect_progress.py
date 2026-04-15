"""Disconnect cleanup, snapshot progress fields, and match_sync extras."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from backend.multiplayer.lobby import MAX_LOBBY_PLAYERS, Lobby, LobbyState, Player
from backend.multiplayer.manager import LobbyManager, voting_beat_entries


def test_results_payload_reveals_real_names_with_beat_slots_when_anonymous() -> None:
    lobby = Lobby(id="L1", spice=0.5, is_public=True)
    lobby.state = LobbyState.RESULTS
    lobby.anonymous_voting = True
    lobby.players["z"] = Player(id="z", name="Zed", user_id=1, wins=0)
    lobby.players["a"] = Player(id="a", name="Ann", user_id=2, wins=0)
    lobby.players["m"] = Player(id="m", name="Mia", user_id=3, wins=0)
    lobby.uploaded = {"z", "a", "m"}
    lobby.votes = {"a": "z", "m": "z"}
    payload, winner_uids = LobbyManager._results_ws_payload_and_winner_user_ids(lobby, "L1")
    assert winner_uids == [1]
    assert payload["winners"] == ["Zed - Beat 3"]
    by_id = {b["player_id"]: b["name"] for b in payload["beats"]}
    assert by_id["a"] == "Ann - Beat 1"
    assert by_id["z"] == "Zed - Beat 3"
    assert by_id["m"] == "Mia - Beat 2"
    names_by_pid = {row["player_id"]: row["name"] for row in payload["leaderboard"]}
    assert names_by_pid["z"] == "Zed - Beat 3"


def test_voting_beat_entries_anonymous_labels() -> None:
    lobby = Lobby(id="X1", spice=0.5, is_public=True)
    lobby.state = LobbyState.VOTING
    lobby.anonymous_voting = True
    lobby.players["z"] = Player(id="z", name="Zed", user_id=1, wins=0)
    lobby.players["a"] = Player(id="a", name="Ann", user_id=2, wins=0)
    lobby.uploaded = {"z", "a"}
    beats = voting_beat_entries(lobby, "X1")
    assert [b["player_id"] for b in beats] == ["a", "z"]
    assert [b["name"] for b in beats] == ["Beat 1", "Beat 2"]
    lobby.anonymous_voting = False
    beats2 = voting_beat_entries(lobby, "X1")
    assert [b["name"] for b in beats2] == ["Ann", "Zed"]


def test_lobby_snapshot_includes_progress_fields() -> None:
    lobby = Lobby(id="AB12CD", spice=0.5, is_public=True)
    lobby.state = LobbyState.VOTING
    lobby.players["x"] = Player(id="x", name="X", user_id=1, wins=0)
    lobby.players["y"] = Player(id="y", name="Y", user_id=2, wins=0)
    lobby.cook_finished = {"x"}
    lobby.uploaded = {"x", "y"}
    lobby.slideshow_completed = {"y"}
    lobby.votes = {"x": "y"}

    snap = lobby.lobby_snapshot()
    assert snap["player_count"] == 2
    assert snap["max_players"] == MAX_LOBBY_PLAYERS
    assert snap["anonymous_voting"] is False
    assert snap["cook_finished"] == ["x"]
    assert snap["uploaded"] == ["x", "y"]
    assert snap["slideshow_completed"] == ["y"]
    assert snap["votes"] == {"x": "y"}


def test_disconnect_prunes_uploaded_votes_slideshow(tmp_path: Path) -> None:
    async def run() -> None:
        mgr = LobbyManager(tmp_path)
        lid = "CAFEBEEF"
        p1, p2, p3 = "playerAaaa", "playerBbbb", "playerCccc"
        lobby = Lobby(id=lid, spice=0.25, is_public=True)
        lobby.state = LobbyState.VOTING
        lobby.players[p1] = Player(id=p1, name="A", user_id=10, wins=0)
        lobby.players[p2] = Player(id=p2, name="B", user_id=20, wins=0)
        lobby.players[p3] = Player(id=p3, name="C", user_id=30, wins=0)
        lobby.uploaded = {p1, p2, p3}
        lobby.votes = {p1: p2, p2: p1, p3: p1}
        lobby.slideshow_completed = {p1}
        mgr.lobbies[lid] = lobby
        mgr.player_lobby[p1] = lid
        mgr.player_lobby[p2] = lid
        mgr.player_lobby[p3] = lid

        class FakeWS:
            def __init__(self) -> None:
                self.sent: list[str] = []

            async def send_text(self, raw: str) -> None:
                self.sent.append(raw)

        ws2 = FakeWS()
        ws3 = FakeWS()
        mgr.attach_ws(p2, ws2)  # type: ignore[arg-type]
        mgr.attach_ws(p3, ws3)  # type: ignore[arg-type]

        await mgr.disconnect(p1)

        assert p1 not in lobby.players
        assert p1 not in lobby.uploaded
        assert p1 not in lobby.slideshow_completed
        assert p1 not in lobby.votes
        assert p2 not in lobby.votes
        assert lobby.votes == {}

        payloads = [json.loads(s) for s in ws2.sent]
        assert any(p.get("type") == "player_leave" for p in payloads)
        upd = [p for p in payloads if p.get("type") == "lobby_update"]
        assert upd
        inner = upd[-1]["lobby"]
        assert inner["player_count"] == 2
        assert set(inner["uploaded"]) == {p2, p3}

    asyncio.run(run())


def test_disconnect_cooking_rebroadcasts_cook_finished(tmp_path: Path) -> None:
    async def run() -> None:
        mgr = LobbyManager(tmp_path)
        lid = "DEADBEEF"
        p1, p2, p3 = "cookP1xxx", "cookP2xxx", "cookP3xxx"
        lobby = Lobby(id=lid, spice=0.5, is_public=True)
        lobby.state = LobbyState.COOKING
        lobby.players[p1] = Player(id=p1, name="A", user_id=1, wins=0)
        lobby.players[p2] = Player(id=p2, name="B", user_id=2, wins=0)
        lobby.players[p3] = Player(id=p3, name="C", user_id=3, wins=0)
        lobby.cook_finished = {p1, p2, p3}
        mgr.lobbies[lid] = lobby
        mgr.player_lobby[p1] = lid
        mgr.player_lobby[p2] = lid
        mgr.player_lobby[p3] = lid

        class FakeWS:
            def __init__(self) -> None:
                self.sent: list[str] = []

            async def send_text(self, raw: str) -> None:
                self.sent.append(raw)

        ws2 = FakeWS()
        mgr.attach_ws(p2, ws2)  # type: ignore[arg-type]

        await mgr.disconnect(p1)

        payloads = [json.loads(s) for s in ws2.sent]
        cook_upd = [p for p in payloads if p.get("type") == "cook_finished_update"]
        assert cook_upd
        assert cook_upd[-1]["player_count"] == 2
        assert set(cook_upd[-1]["finished_player_ids"]) == {p2, p3}

    asyncio.run(run())


def test_get_match_sync_includes_snapshot_progress(tmp_path: Path) -> None:
    mgr = LobbyManager(tmp_path)
    lid = "FEEDFACE"
    p1 = "soloPlayer"
    lobby = Lobby(id=lid, spice=0.85, is_public=False)
    lobby.state = LobbyState.UPLOAD
    lobby.players[p1] = Player(id=p1, name="Solo", user_id=99, wins=0)
    lobby.upload_deadline_ts = 1_700_000_000.0
    lobby.uploaded = {p1}
    mgr.lobbies[lid] = lobby
    mgr.player_lobby[p1] = lid

    sync = mgr.get_match_sync_for_user(lid, 99)
    assert sync is not None
    assert sync["player_count"] == 1
    assert sync["uploaded"] == [p1]
    assert sync["votes"] == {}
    assert sync["players"][0]["id"] == p1

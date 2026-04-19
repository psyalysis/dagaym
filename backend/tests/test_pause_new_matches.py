"""pause_new_matches: block new lobbies/joins while in-memory games continue."""

from __future__ import annotations

import asyncio
from unittest.mock import patch

from backend.multiplayer.manager import LobbyManager


def test_create_lobby_skipped_when_pause_flag(tmp_path) -> None:
    async def run() -> None:
        mgr = LobbyManager(tmp_path)
        p1 = "playerPause01"
        mgr.register_auth_session(p1, 1, "Host")
        with patch(
            "backend.multiplayer.manager.pause_new_matches_cached",
            return_value=True,
        ):
            await mgr.create_lobby(p1, "Host", [0.25, 0.5, 0.85], True, "trap")
        assert p1 not in mgr.player_lobby
        assert not mgr.lobbies

    asyncio.run(run())

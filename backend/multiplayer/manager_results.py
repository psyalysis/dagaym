"""
Building the big "results" WebSocket blob + which user_ids get a win in the DB.
Separated so voting/finalize code doesn't drown in dict shaping.
"""

from __future__ import annotations

from typing import Any

from .lobby import Lobby


def results_ws_payload_and_winner_user_ids(
    lobby: Lobby, lobby_id: str
) -> tuple[dict[str, Any], list[int], list[int]]:
    """type: results message body, plus account ids for 1st and 2nd place (state must already be RESULTS)."""
    counts: dict[str, int] = {}
    for target in lobby.votes.values():
        counts[target] = counts.get(target, 0) + 1
    # Edge case: zero votes but one person uploaded — still show them on the board so the screen isn't empty
    if not counts and lobby.uploaded:
        sole = next(iter(lobby.uploaded))
        winners = [sole]
    elif not counts:
        winners = []
    else:
        mx = max(counts.values())
        winners = [pid for pid, c in counts.items() if c == mx]

    # Second place: next highest vote count after winners
    second_place: list[str] = []
    if counts and winners:
        remaining = {pid: c for pid, c in counts.items() if pid not in winners}
        if remaining:
            mx2 = max(remaining.values())
            second_place = [pid for pid, c in remaining.items() if c == mx2]

    n_players = len(lobby.players)
    # 1v1 with no votes isn't really a "winner" — UI shows tie instead of crowning someone random
    no_winner_two_players = n_players == 2
    if no_winner_two_players:
        winners = []
        second_place = []

    def name_for(pid: str) -> str:
        pl = lobby.players.get(pid)
        return pl.name if pl else pid

    board = sorted(counts.items(), key=lambda x: (-x[1], name_for(x[0])))
    leaderboard = [{"player_id": pid, "name": name_for(pid), "votes": v} for pid, v in board]
    winner_names = [name_for(w) for w in winners]
    winner_user_ids = [lobby.players[w].user_id for w in winners if w in lobby.players]
    second_place_user_ids = [lobby.players[p].user_id for p in second_place if p in lobby.players]

    beats_out: list[dict[str, Any]] = []
    for owner_id in sorted(lobby.uploaded, key=lambda x: x):
        pl = lobby.players.get(owner_id)
        nm = pl.name if pl else owner_id
        beats_out.append(
            {
                "player_id": owner_id,
                "name": nm,
                "url": f"/beats/{lobby_id}/{owner_id}",
            }
        )

    participants = [{"player_id": pid, "name": lobby.players[pid].name} for pid in lobby.players]

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
    return payload, winner_user_ids, second_place_user_ids

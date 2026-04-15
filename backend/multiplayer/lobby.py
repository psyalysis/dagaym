"""
Lobby and player models; spice presets and game states.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from ..rank import rank_public_dict

# Match spec: three spice cards map to these generation intensities.
SPICE_MILD = 0.25
SPICE_MEDIUM = 0.5
SPICE_HOT = 0.85
ALLOWED_SPICES: frozenset[float] = frozenset({SPICE_MILD, SPICE_MEDIUM, SPICE_HOT})


def canonical_spice(value: float) -> float | None:
    """Map a float (e.g. from JSON) to the nearest allowed spice preset."""
    v = float(value)
    for a in (SPICE_MILD, SPICE_MEDIUM, SPICE_HOT):
        if abs(v - a) < 0.02:
            return a
    return None

COOK_DURATION_S = 600
# Host-selectable cook length (minutes); UI/backend clamp to these values.
COOK_DURATION_MIN_OPTIONS: tuple[int, ...] = (5, 10, 15, 20, 30)
DEFAULT_COOK_DURATION_MIN = 10
# Upload window after cook ends (2 minutes).
UPLOAD_PHASE_S = 120
# Seconds per beat in slideshow (1–45s playback) plus small pad before votes unlock.
SLIDESHOW_SEGMENT_S = 46
# Max time to collect votes after unlock.
VOTING_COLLECT_S = 30
# Lobbies in results older than this are purged (uploads deleted).
LOBBY_RESULTS_TTL_S = 3600

# After a WebSocket closes, keep the seat this long so the client can resume.
MP_WS_GRACE_S = 90.0

# Fixed lobby capacity (join cap + server browser).
MAX_LOBBY_PLAYERS = 10


class LobbyState(str, Enum):
    WAITING = "waiting"
    LOBBY = "lobby"
    GENERATING = "generating"
    COOKING = "cooking"
    UPLOAD = "upload"
    VOTING = "voting"
    RESULTS = "results"


@dataclass
class Player:
    id: str
    name: str
    user_id: int
    wins: int = 0
    ready: bool = False


@dataclass
class Lobby:
    id: str
    spice: float
    is_public: bool = True
    players: dict[str, Player] = field(default_factory=dict)
    state: LobbyState = LobbyState.LOBBY
    seed: int | None = None
    sounds: dict[str, str] | None = None
    votes: dict[str, str] = field(default_factory=dict)
    uploaded: set[str] = field(default_factory=set)
    slideshow_completed: set[str] = field(default_factory=set)
    votes_unlock_at: float | None = None
    created_at: float = field(default_factory=time.time)
    results_at: float | None = None
    cook_duration_min: int = DEFAULT_COOK_DURATION_MIN
    # When True, voting slideshow / vote cards use neutral labels (real names on results only).
    anonymous_voting: bool = False
    cook_finished: set[str] = field(default_factory=set)
    # Wall-clock unix seconds; set during COOKING / UPLOAD for HTTP + WS recovery.
    cook_deadline_ts: float | None = None
    upload_deadline_ts: float | None = None
    # player_id -> unix time of last mp_chat send (text or emoji)
    chat_last_sent: dict[str, float] = field(default_factory=dict)
    # RESULTS only: player_ids who voted to rematch
    rematch_pending: set[str] = field(default_factory=set)

    def lobby_snapshot(self) -> dict[str, Any]:
        host_id = next(iter(self.players)) if self.players else ""
        drumkit: dict[str, Any] = {}
        if self.seed is not None:
            drumkit["seed"] = self.seed
        if self.seed is not None and self.state in (
            LobbyState.COOKING,
            LobbyState.UPLOAD,
            LobbyState.VOTING,
            LobbyState.RESULTS,
        ):
            drumkit["has_kit"] = True
        return {
            "lobby_id": self.id,
            "spice": self.spice,
            "is_public": self.is_public,
            "state": self.state.value,
            "host_id": host_id,
            "cook_duration_min": self.cook_duration_min,
            "max_players": MAX_LOBBY_PLAYERS,
            "anonymous_voting": self.anonymous_voting,
            "players": [
                {
                    "id": p.id,
                    "name": p.name,
                    "ready": p.ready,
                    "rank": rank_public_dict(p.wins),
                }
                for p in self.players.values()
            ],
            "drumkit": drumkit,
            "votes": dict(self.votes),
            "player_count": len(self.players),
            "cook_finished": sorted(self.cook_finished),
            "uploaded": sorted(self.uploaded),
            "slideshow_completed": sorted(self.slideshow_completed),
        }

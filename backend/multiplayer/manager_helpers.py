"""
Small stuff pulled out of manager.py so the big file isn't 2 miles long.
JSON parsing quirks, emoji allowlists, and one sync DB read for win counts.
"""

from __future__ import annotations

from typing import Any

from ..database import SessionLocal
from ..models import User
from .lobby import COOK_DURATION_MIN_OPTIONS, LobbyState, canonical_spice


def coerce_bool(v: Any, default: bool = True) -> bool:
    """JSON might send the string "false" — in Python bool("false") is True, so we fix that here."""
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


def normalize_cook_duration_min(raw: Any) -> int | None:
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None
    if n in COOK_DURATION_MIN_OPTIONS:
        return n
    return None


def fetch_user_wins_sync(user_id: int) -> int:
    """Sync SessionLocal on purpose — called from async code via asyncio.to_thread. Don't block the loop!"""
    db = SessionLocal()
    try:
        u = db.get(User, user_id)
        return int(u.wins) if u is not None else 0
    finally:
        db.close()


def normalize_player_spices(data: dict[str, Any]) -> list[float] | None:
    """New clients send spices: []; ancient ones might still send spice: 0.5 — we accept both."""
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


# Wire format is string keys only — the UI maps these to actual emoji. Keeps payloads tiny :)
MP_CHAT_EMOJI_KEYS: frozenset[str] = frozenset({"wave", "fire", "heart", "skull", "hundred"})
LOBBY_EMOJI_KEYS: frozenset[str] = MP_CHAT_EMOJI_KEYS
BEAT_REACTION_KEYS: frozenset[str] = frozenset({"fire", "thumbs_up", "thumbs_down", "hundred"})

MP_CHAT_STATES: frozenset[LobbyState] = frozenset(
    {
        LobbyState.LOBBY,
        LobbyState.COOKING,
        LobbyState.UPLOAD,
        LobbyState.VOTING,
        LobbyState.RESULTS,
    },
)

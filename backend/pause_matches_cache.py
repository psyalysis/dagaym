"""
 Cache whether the games are paused every five seconds.
"""

from __future__ import annotations

import threading
import time

from .database import SessionLocal
from .models import SiteStats

_CACHE_TTL_S = 5.0
_lock = threading.Lock()
_cached_at = float("-inf")
_cached_value = False


def pause_new_matches_cached() -> bool:
    """Return whether new MP matches are paused; refresh from DB at most every 5 seconds."""
    global _cached_at, _cached_value
    now = time.monotonic()
    with _lock:
        if now - _cached_at < _CACHE_TTL_S:
            return _cached_value

    db = SessionLocal()
    try:
        row = db.get(SiteStats, 1)
        val = bool(row.pause_new_matches) if row else False
    finally:
        db.close()

    with _lock:
        _cached_value = val
        _cached_at = time.monotonic()
        return val

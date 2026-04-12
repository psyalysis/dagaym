"""
Sliding-window rate limits for WebSocket connections and messages.
"""

from __future__ import annotations

import time
from collections import deque


class SlidingWindowRateLimiter:
    """At most ``max_events`` timestamps per ``window_s`` per key."""

    __slots__ = ("_events", "max_events", "window_s")

    def __init__(self, max_events: int, window_s: float) -> None:
        self.max_events = max_events
        self.window_s = window_s
        self._events: dict[str, deque[float]] = {}

    def forget(self, key: str) -> None:
        self._events.pop(key, None)

    def check(self, key: str) -> bool:
        now = time.monotonic()
        dq = self._events.get(key)
        if dq is None:
            dq = deque()
            self._events[key] = dq
        while dq and now - dq[0] > self.window_s:
            dq.popleft()
        if len(dq) >= self.max_events:
            return False
        dq.append(now)
        return True

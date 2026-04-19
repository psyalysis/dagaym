"""
Global per-IP HTTP rate limiter — ASGI middleware.

Rejects with 429 + ``Retry-After`` when a single IP floods general endpoints.
Auth-heavy endpoints (/login, /register) already use their own stricter limiter
so they're excluded here to avoid double-counting.

Design goals for a refresh-storm:
- Cheap: O(1) per request via token-bucket, no allocations on hot path.
- Memory-bounded: evict cold IPs after 2× window to cap dict growth.
- Non-blocking: purely sync; runs before any async handler or DB work.
"""

from __future__ import annotations

import time
from typing import Any

# Defaults tuned so a single user refreshing every ~1s is fine, but 30+ req/s triggers 429.
_DEFAULT_RATE = 30  # requests per window
_DEFAULT_WINDOW_S = 10.0  # sliding window
_GC_INTERVAL_S = 60.0  # how often we purge cold IPs


class _Bucket:
    __slots__ = ("tokens", "last")

    def __init__(self, tokens: float, now: float) -> None:
        self.tokens = tokens
        self.last = now


class IPRateLimitMiddleware:
    """
    Pure ASGI middleware — injects before CORSMiddleware.

    Skipped for:
    - non-HTTP scopes (WebSocket, lifespan)
    - paths starting with ``/login``, ``/register`` (have own stricter limits)
    - health-check ``/health``
    """

    SKIP_PREFIXES = ("/login", "/register", "/health", "/ws")
    LIMIT_PREFIXES = (
        "/api/",
        "/generate",
        "/me",
        "/leaderboard",
        "/upload/beat/",
        "/beats/",
    )

    def __init__(
        self,
        app: Any,
        *,
        rate: int = _DEFAULT_RATE,
        window_s: float = _DEFAULT_WINDOW_S,
        trust_proxy_headers: bool = False,
    ) -> None:
        self.app = app
        self.rate = rate
        self.window_s = window_s
        self.trust_proxy_headers = trust_proxy_headers
        self._buckets: dict[str, _Bucket] = {}
        self._last_gc = 0.0

    # -- helpers ----------------------------------------------------------

    def _client_ip(self, scope: dict) -> str:
        client = scope.get("client")
        if client:
            return client[0]
        if self.trust_proxy_headers:
            for hdr_name, hdr_val in scope.get("headers", []):
                if hdr_name == b"x-forwarded-for":
                    return hdr_val.decode("latin-1").split(",")[0].strip()
        return "unknown"

    @classmethod
    def _should_limit(cls, path: str) -> bool:
        if any(path.startswith(p) for p in cls.SKIP_PREFIXES):
            return False
        return any(path.startswith(p) for p in cls.LIMIT_PREFIXES)

    def _gc_stale(self, now: float) -> None:
        if now - self._last_gc < _GC_INTERVAL_S:
            return
        self._last_gc = now
        cutoff = now - self.window_s * 2
        dead = [ip for ip, b in self._buckets.items() if b.last < cutoff]
        for ip in dead:
            del self._buckets[ip]

    def _allow(self, ip: str) -> tuple[bool, int]:
        """Token-bucket check. Returns (allowed, retry_after_seconds)."""
        now = time.monotonic()
        self._gc_stale(now)

        bucket = self._buckets.get(ip)
        if bucket is None:
            bucket = _Bucket(self.rate - 1, now)
            self._buckets[ip] = bucket
            return True, 0

        elapsed = now - bucket.last
        bucket.last = now
        # Refill tokens proportional to elapsed time
        bucket.tokens = min(self.rate, bucket.tokens + elapsed * (self.rate / self.window_s))

        if bucket.tokens >= 1.0:
            bucket.tokens -= 1.0
            return True, 0

        # How long until 1 token refills
        retry_after = max(1, int((1.0 - bucket.tokens) / (self.rate / self.window_s)) + 1)
        return False, retry_after

    # -- ASGI interface ---------------------------------------------------

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path: str = scope.get("path", "")
        if not self._should_limit(path):
            await self.app(scope, receive, send)
            return

        ip = self._client_ip(scope)
        allowed, retry_after = self._allow(ip)
        if allowed:
            await self.app(scope, receive, send)
            return

        # 429 Too Many Requests
        body = b'{"detail":"Too many requests. Please slow down."}'
        await send(
            {
                "type": "http.response.start",
                "status": 429,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"retry-after", str(retry_after).encode("ascii")),
                    (b"cache-control", b"no-store"),
                ],
            }
        )
        await send(
            {
                "type": "http.response.body",
                "body": body,
            }
        )

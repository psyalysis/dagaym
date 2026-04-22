"""
Beat Battle — Solo ``/generate``, multiplayer WebSocket, beat upload, static frontend.

Run from project root: ``uvicorn backend.main:app --reload --port 8000``
Then open http://127.0.0.1:8000/

Multiplayer WebSocket (``/ws``) behind a reverse proxy: idle proxies often drop
connections near 60s. Prefer native WS ping from uvicorn, e.g.
``uvicorn backend.main:app --host 0.0.0.0 --port 8000 --ws-ping-interval 25 --ws-ping-timeout 120``.
For nginx, raise ``proxy_read_timeout`` / ``proxy_send_timeout`` above the ping interval
(see ``proxy_http_version 1.1`` and ``Upgrade`` / ``Connection`` headers for WebSockets).
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import random
import secrets
import re
import shutil
import tempfile
import time as _time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import unquote
from typing import Annotated, Any
from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, ORJSONResponse, RedirectResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import desc, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth import (
    create_ws_ticket,
    get_current_user,
    invalidate_user_cache,
    login_user,
    register_user,
    reset_user_password_for_username,
)
from . import beats_r2
from .http_rate_limit import IPRateLimitMiddleware
from . import avatar_r2
from .beat_upload_trim import trim_beat_upload_to_ogg
from .database import SessionLocal, get_db, init_db
from .generator import generate_kit_light
from .kit_manifest import get_kit_manifest_cached, get_kit_manifest_for_genre
from .kit_payload import encode_paths_to_sounds
from .models import ProfileComment, SiteStats, Supporter, User, UserProfileIconOwnership
from .pause_matches_cache import pause_new_matches_cached
from .multiplayer import LobbyManager
from .multiplayer.lobby import LobbyState
from .multiplayer.ws import router as ws_router
from .multiplayer.ws_rate_limit import SlidingWindowRateLimiter
from .rank import rank_for_wins, rank_index_for_wins, rank_public_dict
from .schemas import (
    AdminPasswordResetRequest,
    AdminPasswordResetResponse,
    BeatUploadCapabilitiesResponse,
    BeatUploadCompleteRequest,
    BeatUploadCompleteResponse,
    BeatUploadPresignRequest,
    BeatUploadPresignResponse,
    LeaderboardEntry,
    LoginRequest,
    MeResponse,
    MpPauseStatusResponse,
    ProfileCommentCreate,
    ProfileCommentOut,
    ProfileResponse,
    ProfileUpdateBio,
    RankInfo,
    RegisterRequest,
    RegisterResponse,
    ShopCatalogItem,
    ShopPurchaseRequest,
    ShopPurchaseResponse,
    TokenResponse,
)
from .shop_catalog import catalog_public_list, emoji_for_icon_key
from .shop_purchase import purchase_profile_icon

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
UPLOADS_ROOT = _PROJECT_ROOT / "uploads"
FRONTEND_ROOT = _PROJECT_ROOT / "frontend"
_DATASET_ROOT = _PROJECT_ROOT / "dataset"
_CANONICAL_HOST = os.environ.get("COOKUP_CANONICAL_HOST", "beat-battle.net").strip().lower()


def _env_float(name: str, default: float, *, minimum: float | None = None) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    if minimum is not None:
        value = max(minimum, value)
    return value


def _env_int(name: str, default: int, *, minimum: int | None = None) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    if minimum is not None:
        value = max(minimum, value)
    return value


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def _resolve_dataset_media_file(rel: str) -> Path | None:
    """Try CDN-style relative paths and common ``dataset/`` mirror layouts."""
    rel = rel.replace("\\", "/").strip().lstrip("/")
    if not rel or ".." in rel.split("/"):
        return None
    root = _DATASET_ROOT.resolve()

    def try_file(rel_key: str) -> Path | None:
        p = (root / rel_key).resolve()
        try:
            p.relative_to(root)
        except ValueError:
            return None
        return p if p.is_file() else None

    alts = [rel]
    if rel.startswith("trap/synths"):
        alts.append(f"TrapRefined/{rel[len('trap/') :]}")
    elif rel.startswith("TrapRefined/synths"):
        alts.append(f"trap/{rel[len('TrapRefined/') :]}")
    if rel == "TrapRefined" or rel.startswith("TrapRefined/"):
        alts.append(f"beat-battle-assets/{rel}")
    if rel == "EDM" or rel.startswith("EDM/"):
        alts.append(f"beat-battle-assets/{rel}")
    if rel.startswith("beat-battle-assets/TrapRefined"):
        alts.append(rel.removeprefix("beat-battle-assets/"))
    if rel.startswith("beat-battle-assets/EDM/"):
        alts.append(rel.removeprefix("beat-battle-assets/"))

    seen: set[str] = set()
    for key in alts:
        if key in seen:
            continue
        seen.add(key)
        hit = try_file(key)
        if hit is not None:
            return hit
    return None


def _static_asset_build() -> str:
    """URL-safe token; bump via env BEAT_BATTLE_STATIC_BUILD on deploy."""
    raw = os.environ.get("BEAT_BATTLE_STATIC_BUILD", "1").strip() or "1"
    if re.fullmatch(r"[A-Za-z0-9._-]{1,64}", raw):
        return raw
    return "1"


STATIC_ASSET_BUILD = _static_asset_build()


def _index_html_response() -> HTMLResponse:
    path = FRONTEND_ROOT / "index.html"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="index.html not found.")
    body = path.read_text(encoding="utf-8").replace("__STATIC_BUILD__", STATIC_ASSET_BUILD)
    return HTMLResponse(content=body, headers={"Cache-Control": "no-cache"})


MAX_BEAT_BYTES = 30 * 1024 * 1024

# Must match the stored username exactly (case-sensitive); do not compare with .lower().
_ALLOWED_DEV_STATS_USERS = frozenset({"psyalysis", "polystalgia"})

_COMMENT_LIMIT = SlidingWindowRateLimiter(max_events=3, window_s=30.0)
_SHOP_PURCHASE_LIMIT = SlidingWindowRateLimiter(max_events=20, window_s=60.0)
_UPLOAD_TRANSCODE_MAX_CONCURRENCY = _env_int("COOKUP_UPLOAD_TRANSCODE_CONCURRENCY", 1, minimum=1)
_UPLOAD_TRANSCODE_WAIT_S = _env_float("COOKUP_UPLOAD_TRANSCODE_WAIT_S", 15.0, minimum=1.0)


def _shop_purchases_enabled() -> bool:
    v = os.environ.get("COOKUP_SHOP_PURCHASES_ENABLED", "").strip().lower()
    return v in ("1", "true", "yes")


def get_optional_user(
    creds: HTTPAuthorizationCredentials | None = Depends(HTTPBearer(auto_error=False)),
    db: Session = Depends(get_db),
) -> User | None:
    """Like get_current_user but returns None for unauthenticated requests."""
    if creds is None or creds.scheme.lower() != "bearer":
        return None
    try:
        from .auth import decode_token, get_user_by_id

        payload = decode_token(creds.credentials)
        if payload.get("typ") == "ws_ticket":
            return None
        uid = int(payload["sub"])
        return get_user_by_id(db, uid)
    except Exception:
        return None


def _require_dev_stats_user(user: User) -> None:
    if user.username not in _ALLOWED_DEV_STATS_USERS:
        raise HTTPException(status_code=403, detail="Not allowed.")


def _normalize_supporter_name(raw: str) -> str:
    s = raw.strip().lower()
    if not s:
        raise HTTPException(status_code=400, detail="Name required.")
    if len(s) > 64:
        raise HTTPException(status_code=400, detail="Name too long.")
    return s


# ---- Batched visit counter (avoids DB write per page refresh) ----
_visit_counter_pending: int = 0
_visit_counter_lock = asyncio.Lock()
_VISIT_FLUSH_INTERVAL_S = 30.0
_VISIT_FLUSH_THRESHOLD = 50
_visit_total_known: int = 0


async def _flush_visits() -> None:
    """Move pending in-memory count into the DB in one write."""
    global _visit_counter_pending, _visit_total_known
    async with _visit_counter_lock:
        if _visit_counter_pending <= 0:
            return
        batch = _visit_counter_pending
        _visit_counter_pending = 0

    def _do_flush() -> int:
        db = SessionLocal()
        try:
            row = db.get(SiteStats, 1)
            if row is None:
                row = SiteStats(id=1, total_visits=0)
                db.add(row)
                db.flush()
            row.total_visits += batch
            db.commit()
            return int(row.total_visits)
        finally:
            db.close()

    _visit_total_known = await asyncio.to_thread(_do_flush)


async def _increment_visit_batched() -> int:
    """Bump in-memory counter; auto-flush if threshold hit."""
    global _visit_counter_pending
    async with _visit_counter_lock:
        _visit_counter_pending += 1
        pending = _visit_counter_pending
    if pending >= _VISIT_FLUSH_THRESHOLD:
        await _flush_visits()
    # Return an approximate total without a DB read on every page boot.
    return _visit_total_known + pending


def _get_total_visits(db: Session) -> int:
    row = db.get(SiteStats, 1)
    return int(row.total_visits) if row is not None else 0


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _visit_total_known
    init_db()
    UPLOADS_ROOT.mkdir(parents=True, exist_ok=True)
    manager = LobbyManager(UPLOADS_ROOT)
    app.state.manager = manager
    app.state.upload_transcode_sem = asyncio.Semaphore(_UPLOAD_TRANSCODE_MAX_CONCURRENCY)
    db = next(get_db())
    try:
        _visit_total_known = _get_total_visits(db)
    finally:
        db.close()

    async def cleanup_loop() -> None:
        while True:
            await asyncio.sleep(120)
            await manager.cleanup_stale()

    async def visit_flush_loop() -> None:
        """Periodically flush batched visit counter to DB."""
        while True:
            await asyncio.sleep(_VISIT_FLUSH_INTERVAL_S)
            try:
                await _flush_visits()
            except Exception:
                pass

    task = asyncio.create_task(cleanup_loop())
    visit_task = asyncio.create_task(visit_flush_loop())
    await asyncio.to_thread(get_kit_manifest_cached)
    await asyncio.to_thread(get_kit_manifest_for_genre, "edm")
    yield
    # Flush remaining visits before shutdown
    try:
        await _flush_visits()
    except Exception:
        pass
    task.cancel()
    visit_task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    try:
        await visit_task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="Beat Battle", version="1.0.0", lifespan=lifespan)

_CORS_ORIGINS: list[str] = [
    "https://beat-battle.net",
    "https://www.beat-battle.net",
    "http://127.0.0.1:8000",
    "http://localhost:8000",
]
_extra_cors = os.environ.get("COOKUP_CORS_ORIGINS", "").strip()
if _extra_cors:
    _CORS_ORIGINS.extend(o.strip() for o in _extra_cors.split(",") if o.strip())

app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _static_cache_control(path: str) -> str | None:
    """Long cache for static media; JS revalidates so module graph stays fresh."""
    if path.startswith("/js/"):
        return "public, max-age=0, must-revalidate"
    if path.startswith("/sfx/") or path.startswith("/media/"):
        return "public, max-age=86400"
    if path.endswith((".css", ".woff2", ".svg", ".png", ".ico", ".webp", ".mp3", ".ogg")):
        return "public, max-age=86400"
    if path == "/" or path.endswith(".html"):
        return "no-cache"
    return None


class StaticCacheControlMiddleware:
    """Pure ASGI middleware — avoids BaseHTTPMiddleware's TaskGroup overhead."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        method = scope.get("method", "")
        path = scope.get("path", "")
        # Only inject on GET, skip API paths
        should_inject = method == "GET" and not path.startswith("/api/")
        cc = _static_cache_control(path) if should_inject else None

        if cc is None:
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start" and cc:
                headers = list(message.get("headers", []))
                headers.append((b"cache-control", cc.encode("latin-1")))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_wrapper)


class CanonicalHostMiddleware:
    """Redirect Render's public hostname to the canonical site host."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {k.lower(): v for k, v in scope.get("headers", [])}
        raw_host = headers.get(b"host", b"").decode("latin-1").strip().lower()
        if raw_host == "beatbattle.onrender.com" and _CANONICAL_HOST:
            path = scope.get("path", "/") or "/"
            qs = scope.get("query_string", b"")
            target = f"https://{_CANONICAL_HOST}{path}"
            if qs:
                target = f"{target}?{qs.decode('latin-1')}"
            await send(
                {
                    "type": "http.response.start",
                    "status": 307,
                    "headers": [
                        (b"location", target.encode("latin-1")),
                        (b"cache-control", b"no-store"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": b""})
            return

        await self.app(scope, receive, send)


class HealthcheckFastPathMiddleware:
    """Answer Render health checks without touching FastAPI routing or DB work."""

    def __init__(self, app):
        self.app = app
        self._body = b'{"status":"ok"}'

    async def __call__(self, scope, receive, send):
        if (
            scope["type"] == "http"
            and scope.get("path") == "/health"
            and scope.get("method") in ("GET", "HEAD")
        ):
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"cache-control", b"no-store"),
                    ],
                }
            )
            await send(
                {
                    "type": "http.response.body",
                    "body": b"" if scope.get("method") == "HEAD" else self._body,
                }
            )
            return
        await self.app(scope, receive, send)


app.add_middleware(StaticCacheControlMiddleware)
app.add_middleware(
    IPRateLimitMiddleware,
    rate=_env_int("COOKUP_HTTP_RATE_LIMIT_RATE", 90, minimum=1),
    window_s=_env_float("COOKUP_HTTP_RATE_LIMIT_WINDOW_S", 10.0, minimum=1.0),
    trust_proxy_headers=_env_bool("COOKUP_TRUST_PROXY_HEADERS", False),
)
app.add_middleware(HealthcheckFastPathMiddleware)
app.add_middleware(CanonicalHostMiddleware)

_AUTH_WINDOW_S = _env_float("COOKUP_AUTH_RATE_LIMIT_WINDOW_S", 60.0, minimum=1.0)
_LOGIN_USER_LIMIT = SlidingWindowRateLimiter(
    max_events=_env_int("COOKUP_LOGIN_USER_RATE", 10, minimum=1),
    window_s=_AUTH_WINDOW_S,
)
_LOGIN_IP_LIMIT = SlidingWindowRateLimiter(
    max_events=_env_int("COOKUP_LOGIN_IP_RATE", 30, minimum=1),
    window_s=_AUTH_WINDOW_S,
)
_REGISTER_USER_LIMIT = SlidingWindowRateLimiter(
    max_events=_env_int("COOKUP_REGISTER_USER_RATE", 5, minimum=1),
    window_s=_AUTH_WINDOW_S,
)
_REGISTER_IP_LIMIT = SlidingWindowRateLimiter(
    max_events=_env_int("COOKUP_REGISTER_IP_RATE", 15, minimum=1),
    window_s=_AUTH_WINDOW_S,
)
_ADMIN_RESET_LIMIT = SlidingWindowRateLimiter(max_events=5, window_s=3600.0)

_admin_log = logging.getLogger("cookup.admin")
_admin_bearer = HTTPBearer(auto_error=False)


def _is_loopback_ip(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_loopback
    except ValueError:
        return ip == "localhost"


def _retry_after_s(window_s: float) -> str:
    return str(max(1, int(window_s)))


def _require_admin_api_key(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_admin_bearer)],
) -> None:
    key = os.environ.get("COOKUP_ADMIN_API_KEY", "").strip()
    if not key:
        raise HTTPException(
            status_code=503,
            detail="Admin password reset is not configured (set COOKUP_ADMIN_API_KEY).",
        )
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Admin authentication required.")
    if not secrets.compare_digest(creds.credentials, key):
        raise HTTPException(status_code=403, detail="Invalid admin credentials.")

app.include_router(ws_router)


@app.get("/api/kit-manifest", response_class=ORJSONResponse)
def get_kit_manifest(genre: str = Query(default="trap")) -> ORJSONResponse:
    """Sorted dataset media paths per stem; client uses with :func:`pick_index` parity."""
    return ORJSONResponse(
        get_kit_manifest_for_genre(genre),
        headers={"Cache-Control": "public, max-age=3600"},
    )


class GenerateRequest(BaseModel):
    """POST /generate JSON body."""

    spice: float = Field(default=0.3, ge=0.0, le=1.0)
    seed: int | None = None


def _solo_generate_sync(seed: int, spice: float) -> dict[str, Any]:
    """Solo kit: random samples only (no heavy DSP); CPU-bound; run in a thread pool."""
    tmp = tempfile.mkdtemp(prefix="solo_kit_")
    try:
        paths = generate_kit_light(seed=seed, spice=spice, output_dir=Path(tmp))
        sounds = encode_paths_to_sounds(paths)
        return {"seed": seed, "sounds": sounds}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@app.post("/generate")
async def post_generate(body: GenerateRequest) -> dict[str, Any]:
    """Solo: synthesize a kit, return base64 OGG (dataset files as stored)."""
    seed = body.seed if body.seed is not None else random.randint(0, 2**31 - 1)
    return await asyncio.to_thread(_solo_generate_sync, seed, body.spice)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/mp-pause-status", response_model=MpPauseStatusResponse)
async def get_mp_pause_status() -> MpPauseStatusResponse:
    """When true, the server should not start or join new matches (5s server cache)."""
    paused = await asyncio.to_thread(pause_new_matches_cached)
    return MpPauseStatusResponse(pause_new_matches=paused)


@app.post("/api/stats/visit")
async def post_stats_visit() -> dict[str, int]:
    """Increment once per frontend boot (full page load).

    Writes are batched in memory and flushed periodically to avoid
    hammering the DB when users spam-refresh.
    """
    total = await _increment_visit_batched()
    return {"total_visits": total}


@app.get("/api/dev/site-stats")
async def get_dev_site_stats(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Live counters for owner accounts only (JWT)."""
    _require_dev_stats_user(user)
    manager: LobbyManager = request.app.state.manager
    return {
        "players_online": len(manager.player_ws),
        "servers_open": len(manager.lobbies),
        "total_visits": _get_total_visits(db),
    }


@app.get("/api/supporters")
def get_supporters(db: Session = Depends(get_db)) -> dict[str, Any]:
    """Public list of supporter display-name keys (lowercase); used for hearts in UI."""
    global _supporters_cache
    now = _time.time()
    if _supporters_cache is not None:
        exp, cached = _supporters_cache
        if now < exp:
            return cached
    try:
        rows = db.query(Supporter).order_by(Supporter.name_key).all()
        result = {"names": [r.name_key for r in rows]}
        _supporters_cache = (now + _SUPPORTERS_TTL_S, result)
        return result
    except Exception:
        if _supporters_cache is not None:
            _, cached = _supporters_cache
            return cached
        return {"names": []}


class SupporterAddBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)


@app.post("/api/dev/supporters")
def post_dev_supporter(
    body: SupporterAddBody,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_dev_stats_user(user)
    key = _normalize_supporter_name(body.name)
    db.add(Supporter(name_key=key))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Already exists.")
    _supporters_cache = None  # bust cache
    return {"ok": True, "name_key": key}


@app.delete("/api/dev/supporters")
def delete_dev_supporter(
    name: str = Query(..., min_length=1, max_length=64),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _require_dev_stats_user(user)
    key = _normalize_supporter_name(name)
    row = db.query(Supporter).filter(Supporter.name_key == key).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Not found.")
    db.delete(row)
    db.commit()
    _supporters_cache = None  # bust cache
    return {"ok": True}


@app.post("/register", response_model=RegisterResponse)
def post_register(
    request: Request, body: RegisterRequest, db: Session = Depends(get_db)
) -> RegisterResponse:
    ip = request.client.host if request.client else "unknown"
    username_key = body.username.strip().lower()
    if not _REGISTER_USER_LIMIT.check(f"reg_user:{username_key}"):
        raise HTTPException(
            status_code=429,
            detail="Too many registration attempts for this username. Try again later.",
            headers={"Retry-After": _retry_after_s(_AUTH_WINDOW_S)},
        )
    if not _is_loopback_ip(ip) and not _REGISTER_IP_LIMIT.check(f"reg_ip:{ip}"):
        raise HTTPException(
            status_code=429,
            detail="Too many registrations. Try again later.",
            headers={"Retry-After": _retry_after_s(_AUTH_WINDOW_S)},
        )
    return register_user(db, body)


@app.post("/login", response_model=TokenResponse)
def post_login(
    request: Request, body: LoginRequest, db: Session = Depends(get_db)
) -> TokenResponse:
    ip = request.client.host if request.client else "unknown"
    username_key = body.username.strip().lower()
    if not _LOGIN_USER_LIMIT.check(f"login_user:{username_key}"):
        raise HTTPException(
            status_code=429,
            detail="Too many login attempts for this username. Try again later.",
            headers={"Retry-After": _retry_after_s(_AUTH_WINDOW_S)},
        )
    if not _is_loopback_ip(ip) and not _LOGIN_IP_LIMIT.check(f"login_ip:{ip}"):
        raise HTTPException(
            status_code=429,
            detail="Too many login attempts. Try again later.",
            headers={"Retry-After": _retry_after_s(_AUTH_WINDOW_S)},
        )
    return login_user(db, body)


@app.post("/admin/reset-password", response_model=AdminPasswordResetResponse)
def post_admin_reset_password(
    request: Request,
    body: AdminPasswordResetRequest,
    db: Session = Depends(get_db),
    _admin: None = Depends(_require_admin_api_key),
) -> AdminPasswordResetResponse:
    """Manual password reset: ``Authorization: Bearer <COOKUP_ADMIN_API_KEY>``."""
    ip = request.client.host if request.client else "unknown"
    if not _ADMIN_RESET_LIMIT.check(f"admin_reset:{ip}"):
        raise HTTPException(
            status_code=429,
            detail="Too many admin reset attempts. Try again later.",
            headers={"Retry-After": "3600"},
        )
    user = reset_user_password_for_username(
        db, username=body.username, new_password=body.new_password
    )
    _admin_log.warning(
        "admin_password_reset user_id=%s username=%s ip=%s",
        user.id,
        user.username,
        ip,
    )
    return AdminPasswordResetResponse(user_id=user.id, username=user.username)


@app.post("/api/ws-ticket")
async def post_ws_ticket(user: User = Depends(get_current_user)) -> dict[str, str]:
    """Issue a short-lived, single-use ticket for WebSocket auth.

    The frontend calls this before opening a WS connection, then passes the
    ticket as ``?token=...`` instead of the long-lived JWT.  Even if the URL
    leaks in server/proxy logs the ticket is already expired (30 s) and
    single-use."""
    ticket = await create_ws_ticket(
        user.id, user.username, int(user.password_version or 0)
    )
    return {"ticket": ticket}


def _me_response_from_user(user: User, owned_profile_icon_keys: list[str]) -> MeResponse:
    r = rank_for_wins(user.wins)
    rank = (
        RankInfo(key=r["key"], abbrev=r["abbrev"], label=r["label"], color=r["color"])
        if r
        else None
    )
    return MeResponse(
        username=user.username,
        wins=user.wins,
        coins=user.coins,
        rank=rank,
        rank_index=rank_index_for_wins(user.wins),
        profile_icon_key=user.profile_icon_key,
        owned_profile_icon_keys=owned_profile_icon_keys,
    )


@app.get("/me", response_model=MeResponse)
def get_me(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> MeResponse:
    owned_rows = (
        db.query(UserProfileIconOwnership.icon_key)
        .filter(UserProfileIconOwnership.user_id == user.id)
        .order_by(UserProfileIconOwnership.icon_key)
        .all()
    )
    owned_keys = [row[0] for row in owned_rows]
    return _me_response_from_user(user, owned_keys)


@app.get("/api/shop/catalog", response_model=list[ShopCatalogItem])
def get_shop_catalog() -> list[ShopCatalogItem]:
    return [ShopCatalogItem(**item) for item in catalog_public_list()]


@app.post("/api/me/shop/purchase", response_model=ShopPurchaseResponse)
def post_shop_purchase(
    body: ShopPurchaseRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ShopPurchaseResponse:
    if not _shop_purchases_enabled():
        raise HTTPException(status_code=403, detail="Shop purchases are not available yet.")
    ip = request.client.host if request.client else "unknown"
    if not _SHOP_PURCHASE_LIMIT.check(f"shop:{user.id}:{ip}"):
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Try again later.",
        )
    new_coins, equipped = purchase_profile_icon(db, user.id, body.icon_key)
    owned_rows = (
        db.query(UserProfileIconOwnership.icon_key)
        .filter(UserProfileIconOwnership.user_id == user.id)
        .order_by(UserProfileIconOwnership.icon_key)
        .all()
    )
    owned_keys = [row[0] for row in owned_rows]
    return ShopPurchaseResponse(
        coins=new_coins,
        profile_icon_key=equipped,
        owned_profile_icon_keys=owned_keys,
    )


@app.get("/api/me/mp_reconnect_pending", response_class=ORJSONResponse)
def get_mp_reconnect_pending(
    request: Request,
    user: User = Depends(get_current_user),
) -> dict[str, Any] | None:
    """Soft-disconnect grace: same seat can resume until deadline (see MP_WS_GRACE_S)."""
    manager: LobbyManager = request.app.state.manager
    return manager.pending_reconnect_for_user(user.id)


@app.post("/api/me/mp_abandon_reconnect", response_class=ORJSONResponse)
async def post_mp_abandon_reconnect(
    request: Request,
    user: User = Depends(get_current_user),
) -> dict[str, bool]:
    """After Leave: clear any soft-disconnect grace so menu reconnect does not race."""
    manager: LobbyManager = request.app.state.manager
    await manager.abandon_reconnect_grace_for_user(user.id)
    return {"ok": True}


# ---- In-memory response caches (read-heavy, write-rare) ----
_leaderboard_cache: tuple[float, list[LeaderboardEntry]] | None = None
_LEADERBOARD_TTL_S = 30.0

_supporters_cache: tuple[float, dict[str, Any]] | None = None
_SUPPORTERS_TTL_S = _env_float("COOKUP_SUPPORTERS_CACHE_TTL_S", 600.0, minimum=30.0)

_lobbies_cache: tuple[float, list[dict[str, Any]]] | None = None
_LOBBIES_TTL_S = _env_float("COOKUP_LOBBIES_CACHE_TTL_S", 5.0, minimum=1.0)


@app.get("/leaderboard", response_model=list[LeaderboardEntry])
def get_leaderboard(db: Session = Depends(get_db)) -> list[LeaderboardEntry]:
    global _leaderboard_cache
    now = _time.time()
    if _leaderboard_cache is not None:
        exp, cached = _leaderboard_cache
        if now < exp:
            return cached
    rows = db.query(User).order_by(desc(User.wins), User.username).limit(50).all()
    out: list[LeaderboardEntry] = []
    for r in rows:
        pub = rank_public_dict(r.wins)
        rank = RankInfo(**pub) if pub else None
        out.append(
            LeaderboardEntry(
                username=r.username,
                wins=r.wins,
                rank=rank,
                rank_index=rank_index_for_wins(r.wins),
            )
        )
    _leaderboard_cache = (now + _LEADERBOARD_TTL_S, out)
    return out


@app.get("/api/lobbies")
async def list_public_lobbies(request: Request) -> ORJSONResponse:
    """Joinable public lobbies (pre-game, not full)."""
    global _lobbies_cache
    if await asyncio.to_thread(pause_new_matches_cached):
        return ORJSONResponse(
            content=[],
            headers={
                "Cache-Control": "private, no-store, no-cache, must-revalidate",
                "Pragma": "no-cache",
            },
        )
    now = _time.time()
    if _lobbies_cache is not None:
        exp, cached = _lobbies_cache
        if now < exp:
            return ORJSONResponse(
                content=cached,
                headers={
                    "Cache-Control": "private, no-store, no-cache, must-revalidate",
                    "Pragma": "no-cache",
                },
            )
    manager: LobbyManager = request.app.state.manager
    data = await manager.public_lobby_list()
    _lobbies_cache = (now + _LOBBIES_TTL_S, data)
    return ORJSONResponse(
        content=data,
        headers={
            "Cache-Control": "private, no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
        },
    )


@app.get("/api/lobbies/joinable/{lobby_id}")
async def check_public_lobby_joinable(lobby_id: str, request: Request) -> dict[str, Any]:
    """Preflight for server-browser join — same visibility as GET /api/lobbies (no extra leaks)."""
    raw = (lobby_id or "").strip()
    if len(raw) < 3 or len(raw) > 32:
        raise HTTPException(status_code=404, detail="Lobby not available.")
    if await asyncio.to_thread(pause_new_matches_cached):
        raise HTTPException(status_code=404, detail="Lobby not available.")
    manager: LobbyManager = request.app.state.manager
    if await manager.is_public_lobby_joinable(raw):
        return ORJSONResponse(
            content={"ok": True, "lobby_id": raw},
            headers={
                "Cache-Control": "private, no-store, no-cache, must-revalidate",
                "Pragma": "no-cache",
            },
        )
    raise HTTPException(status_code=404, detail="Lobby not available.")


@app.get(
    "/api/lobby/{lobby_id}/kit",
    response_class=ORJSONResponse,
)
async def get_lobby_kit(
    lobby_id: str,
    request: Request,
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Seed/spice for rebuilding the kit in the browser (no audio payload)."""
    manager: LobbyManager = request.app.state.manager
    meta = manager.get_lobby_kit_meta_for_user(lobby_id, user.id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Kit not available.")
    return meta


@app.get(
    "/api/lobby/{lobby_id}/match_sync",
    response_class=ORJSONResponse,
)
async def get_match_sync(
    lobby_id: str,
    request: Request,
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Current match phase for HTTP recovery when WebSocket messages are missed."""
    manager: LobbyManager = request.app.state.manager
    sync = manager.get_match_sync_for_user(lobby_id, user.id)
    if sync is None:
        raise HTTPException(status_code=404, detail="Match not available.")
    return sync


@app.get(
    "/api/upload/capabilities",
    response_class=ORJSONResponse,
)
async def beat_upload_capabilities() -> BeatUploadCapabilitiesResponse:
    return BeatUploadCapabilitiesResponse(**beats_r2.r2_capabilities())


@app.post(
    "/api/upload/presign",
    response_class=ORJSONResponse,
)
async def beat_upload_presign(
    body: BeatUploadPresignRequest,
    user: User = Depends(get_current_user),
) -> BeatUploadPresignResponse:
    beats_r2.require_r2_config()
    manager: LobbyManager = app.state.manager
    lid, pid = body.lobby_id, body.player_id
    if not manager.verify_player_belongs_to_user(lid, pid, user.id):
        raise HTTPException(status_code=403, detail="Not in this lobby.")
    lobby = manager.lobbies.get(lid)
    if not lobby or pid not in lobby.players:
        raise HTTPException(status_code=403, detail="Not in this lobby.")
    if lobby.state != LobbyState.UPLOAD:
        raise HTTPException(status_code=400, detail="Upload phase is not active.")

    upload_id = beats_r2.issue_upload_id()
    put_url = await asyncio.to_thread(
        beats_r2.generate_presigned_put,
        lobby_id=lid,
        player_id=pid,
        upload_id=upload_id,
        content_type=body.content_type,
    )
    return BeatUploadPresignResponse(
        upload_id=upload_id,
        put_url=put_url,
        required_headers={"Content-Type": body.content_type},
    )


@app.post(
    "/api/upload/complete",
    response_class=ORJSONResponse,
)
async def beat_upload_complete(
    body: BeatUploadCompleteRequest,
    user: User = Depends(get_current_user),
) -> BeatUploadCompleteResponse:
    from botocore.exceptions import ClientError

    beats_r2.require_r2_config()
    manager: LobbyManager = app.state.manager
    lid, pid, upload_id = body.lobby_id, body.player_id, body.upload_id

    idem = manager.r2_beat_idempotent_response(lid, pid, upload_id)
    if idem is not None:
        return BeatUploadCompleteResponse(
            ok=bool(idem["ok"]),
            ready=bool(idem["ready"]),
            idempotent=bool(idem["idempotent"]),
            accepted=True,
        )

    if not manager.verify_player_belongs_to_user(lid, pid, user.id):
        raise HTTPException(status_code=403, detail="Not in this lobby.")
    lobby = manager.lobbies.get(lid)
    if not lobby or pid not in lobby.players:
        raise HTTPException(status_code=403, detail="Not in this lobby.")
    if lobby.state != LobbyState.UPLOAD:
        raise HTTPException(status_code=400, detail="Upload phase is not active.")

    try:
        head = await asyncio.to_thread(beats_r2.head_staging_object, lid, pid, upload_id)
    except ClientError as e:
        code = (e.response.get("Error") or {}).get("Code", "")
        if code in ("404", "NoSuchKey", "NotFound"):
            raise HTTPException(status_code=400, detail="Staging object not found.") from e
        raise HTTPException(status_code=502, detail="R2 head_object failed.") from e

    cl = int(head.get("ContentLength") or 0)
    if cl != body.content_length:
        raise HTTPException(status_code=400, detail="content_length does not match object.")
    if cl > beats_r2.MAX_BEAT_BYTES or cl < 1:
        raise HTTPException(status_code=400, detail="Invalid object size.")

    etag_h = beats_r2.normalize_etag(head.get("ETag"))
    etag_b = beats_r2.normalize_etag(body.etag)
    if etag_h and etag_b and etag_h != etag_b:
        raise HTTPException(status_code=400, detail="ETag mismatch.")

    ct = (head.get("ContentType") or "").strip() or "application/octet-stream"

    stub_ready = beats_r2.r2_stub_ready_default_on()
    try:
        if stub_ready:
            await asyncio.to_thread(
                beats_r2.copy_staging_to_final,
                lid,
                pid,
                upload_id,
                ct,
            )
            await manager.record_upload(lid, pid)
            ready = True
        else:
            ready = False
    except ClientError as e:
        raise HTTPException(status_code=502, detail="R2 copy to final failed.") from e

    manager.r2_beat_register_complete(
        lid,
        pid,
        upload_id,
        etag=etag_b or etag_h,
        content_length=cl,
        sha256=body.sha256,
        ready=ready,
    )
    return BeatUploadCompleteResponse(ok=True, ready=ready, idempotent=False, accepted=True)


def _sniff_audio(buf: bytes) -> str | None:
    if len(buf) >= 4 and buf[:4] == b"OggS":
        return ".ogg"
    if len(buf) >= 12 and buf[:4] == b"RIFF" and buf[8:12] == b"WAVE":
        return ".wav"
    if len(buf) >= 3 and buf[:3] == b"ID3":
        return ".mp3"
    if len(buf) >= 2 and buf[0] == 0xFF and (buf[1] & 0xE0) == 0xE0:
        return ".mp3"
    return None


def _unlink_legacy_beat_formats(dest_dir: Path, player_id: str) -> None:
    """Remove WAV/MP3 artifacts so ``player_id.ogg`` is the sole canonical beat file."""
    for ext in (".wav", ".mp3", ".WAV", ".MP3"):
        p = dest_dir / f"{player_id}{ext}"
        if p.is_file():
            try:
                p.unlink()
            except OSError:
                pass


@app.post("/upload/beat/{lobby_id}")
async def upload_beat(
    lobby_id: str,
    player_id: str = Form(),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
) -> dict[str, bool]:
    manager: LobbyManager = app.state.manager
    upload_transcode_sem: asyncio.Semaphore = app.state.upload_transcode_sem
    if not manager.verify_player_belongs_to_user(lobby_id, player_id, user.id):
        raise HTTPException(status_code=403, detail="Not in this lobby.")
    lobby = manager.lobbies.get(lobby_id)
    if not lobby or player_id not in lobby.players:
        raise HTTPException(status_code=403, detail="Not in this lobby.")
    if lobby.state != LobbyState.UPLOAD:
        raise HTTPException(status_code=400, detail="Upload phase is not active.")

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in (".mp3", ".ogg"):
        raise HTTPException(status_code=400, detail="Only .mp3 or .ogg allowed.")

    dest_dir = UPLOADS_ROOT / lobby_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{player_id}.ogg"
    part = dest_dir / f"{player_id}{suffix}.part"

    total = 0
    first_chunk: bytes | None = None
    chunks: list[bytes] = []
    try:
        while True:
            chunk = await file.read(1024 * 512)
            if not chunk:
                break
            if first_chunk is None:
                first_chunk = chunk[:64]
            total += len(chunk)
            if total > MAX_BEAT_BYTES:
                raise HTTPException(status_code=400, detail="File too large (max 30MB).")
            chunks.append(chunk)

        if total == 0:
            raise HTTPException(status_code=400, detail="Empty file.")

        sniffed = _sniff_audio(first_chunk or b"")
        if sniffed and sniffed != suffix:
            raise HTTPException(status_code=400, detail="File content does not match extension.")

        def _write_to_disk() -> None:
            with part.open("wb") as out:
                for c in chunks:
                    out.write(c)

        await asyncio.to_thread(_write_to_disk)

        acquired = False
        try:
            try:
                await asyncio.wait_for(
                    upload_transcode_sem.acquire(), timeout=_UPLOAD_TRANSCODE_WAIT_S
                )
                acquired = True
            except TimeoutError as e:
                raise HTTPException(
                    status_code=503,
                    detail="Upload queue is full right now. Please try again in a moment.",
                    headers={"Retry-After": "10"},
                ) from e
            await asyncio.to_thread(
                trim_beat_upload_to_ogg,
                part,
                dest,
                source_suffix=suffix,
            )
        except HTTPException:
            raise
        except RuntimeError as e:
            dest.unlink(missing_ok=True)
            msg = str(e)
            if "ffmpeg not found" in msg:
                raise HTTPException(
                    status_code=503,
                    detail="Beat uploads require ffmpeg (libvorbis) on the server.",
                ) from e
            raise HTTPException(status_code=400, detail="Could not process audio file.") from e
        except Exception as e:
            dest.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="Could not process audio file.") from e
        finally:
            if acquired:
                upload_transcode_sem.release()
    except HTTPException:
        part.unlink(missing_ok=True)
        dest.unlink(missing_ok=True)
        raise

    _unlink_legacy_beat_formats(dest_dir, player_id)

    await manager.record_upload(lobby_id, player_id)
    return {"ok": True}


@app.get("/beats/{lobby_id}/{owner_id}", response_model=None)
async def get_beat(
    lobby_id: str,
    owner_id: str,
    requester: str = Query(..., description="Connecting player's id"),
    user: User = Depends(get_current_user),
) -> FileResponse | RedirectResponse:
    manager: LobbyManager = app.state.manager
    expected = manager.player_id_for_user_in_lobby(lobby_id, user.id)
    if expected is None or expected != requester:
        raise HTTPException(status_code=403, detail="Not allowed.")
    if not manager.can_access_beat(lobby_id, requester):
        raise HTTPException(status_code=403, detail="Not allowed.")
    path = manager.beat_file_path(lobby_id, owner_id)
    if path and path.is_file():
        sfx = path.suffix.lower()
        if sfx == ".mp3":
            mt = "audio/mpeg"
        elif sfx == ".ogg":
            mt = "audio/ogg"
        else:
            mt = "audio/wav"
        return FileResponse(path, media_type=mt, filename=path.name)
    lobby = manager.lobbies.get(lobby_id)
    if beats_r2.r2_capabilities()["r2_direct"] and lobby is not None and owner_id in lobby.uploaded:
        final_url = await asyncio.to_thread(beats_r2.public_final_url, lobby_id, owner_id)
        if not final_url:
            raise HTTPException(status_code=404, detail="Beat not found.")
        return RedirectResponse(
            url=final_url,
            status_code=302,
        )
    raise HTTPException(status_code=404, detail="Beat not found.")


# ---- Profile API ----


@app.get("/api/profile/{username}", response_model=ProfileResponse)
def get_profile(
    username: str,
    db: Session = Depends(get_db),
) -> ProfileResponse:
    user = db.query(User).filter(func.lower(User.username) == username.strip().lower()).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    r = rank_for_wins(user.wins)
    rank = (
        RankInfo(key=r["key"], abbrev=r["abbrev"], label=r["label"], color=r["color"])
        if r
        else None
    )
    comment_count = db.query(ProfileComment).filter(ProfileComment.profile_id == user.id).count()
    return ProfileResponse(
        username=user.username,
        wins=user.wins,
        coins=user.coins,
        games_played=user.games_played,
        rank=rank,
        rank_index=rank_index_for_wins(user.wins),
        bio=user.bio,
        avatar_url=user.avatar_url,
        profile_icon_key=user.profile_icon_key,
        profile_icon_emoji=emoji_for_icon_key(user.profile_icon_key),
        created_at=user.created_at.isoformat() + "Z",
        comment_count=comment_count,
    )


@app.get("/api/profile/{username}/comments", response_model=list[ProfileCommentOut])
def get_profile_comments(
    username: str,
    page: int = Query(1, ge=1),
    db: Session = Depends(get_db),
) -> list[ProfileCommentOut]:
    user = db.query(User).filter(func.lower(User.username) == username.strip().lower()).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    per_page = 50
    comments = (
        db.query(ProfileComment)
        .filter(ProfileComment.profile_id == user.id)
        .order_by(ProfileComment.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    out: list[ProfileCommentOut] = []
    for c in comments:
        author = db.get(User, c.author_id)
        if not author:
            continue
        ar = rank_for_wins(author.wins)
        a_rank = (
            RankInfo(key=ar["key"], abbrev=ar["abbrev"], label=ar["label"], color=ar["color"])
            if ar
            else None
        )
        out.append(
            ProfileCommentOut(
                id=c.id,
                author_username=author.username,
                author_rank=a_rank,
                author_avatar_url=author.avatar_url,
                content=c.content,
                created_at=c.created_at.isoformat() + "Z",
            )
        )
    return out


@app.post("/api/profile/{username}/comments", response_model=ProfileCommentOut)
def post_profile_comment(
    username: str,
    body: ProfileCommentCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProfileCommentOut:
    ip = request.client.host if request.client else "unknown"
    if not _COMMENT_LIMIT.check(f"comment:{user.id}:{ip}"):
        raise HTTPException(
            status_code=429,
            detail="Too many comments. Try again later.",
            headers={"Retry-After": "10"},
        )
    target = db.query(User).filter(func.lower(User.username) == username.strip().lower()).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found.")
    comment = ProfileComment(
        profile_id=target.id,
        author_id=user.id,
        content=body.content.strip(),
    )
    db.add(comment)
    db.commit()
    db.refresh(comment)
    ar = rank_for_wins(user.wins)
    a_rank = (
        RankInfo(key=ar["key"], abbrev=ar["abbrev"], label=ar["label"], color=ar["color"])
        if ar
        else None
    )
    return ProfileCommentOut(
        id=comment.id,
        author_username=user.username,
        author_rank=a_rank,
        author_avatar_url=user.avatar_url,
        content=comment.content,
        created_at=comment.created_at.isoformat() + "Z",
    )


@app.delete("/api/profile/comments/{comment_id}")
def delete_profile_comment(
    comment_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, bool]:
    comment = db.get(ProfileComment, comment_id)
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found.")
    # Author can delete own; devs can delete any
    if comment.author_id != user.id and user.username not in _ALLOWED_DEV_STATS_USERS:
        raise HTTPException(status_code=403, detail="Not allowed.")
    db.delete(comment)
    db.commit()
    return {"ok": True}


@app.patch("/api/me/profile")
def patch_my_profile(
    body: ProfileUpdateBio,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user.bio = body.bio.strip() if body.bio else None
    db.commit()
    invalidate_user_cache(user.id)
    return {"ok": True, "bio": user.bio}


@app.post("/api/me/avatar")
async def upload_avatar(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    ct = (file.content_type or "").strip().lower()
    if ct not in avatar_r2.ALLOWED_AVATAR_CONTENT_TYPES:
        raise HTTPException(
            status_code=400, detail="Only PNG, JPEG, WebP, or GIF images are allowed."
        )

    data = await file.read()
    if len(data) > avatar_r2.MAX_AVATAR_BYTES:
        raise HTTPException(status_code=400, detail="Avatar too large (max 2 MB).")
    if len(data) < 100:
        raise HTTPException(status_code=400, detail="File too small.")

    if not beats_r2.r2_capabilities()["r2_direct"]:
        raise HTTPException(status_code=503, detail="Avatar uploads require R2 configuration.")

    # Delete old avatar if exists
    if user.avatar_url:
        await asyncio.to_thread(avatar_r2.delete_avatar_from_r2, user.avatar_url)

    url = await asyncio.to_thread(avatar_r2.upload_avatar_to_r2, user.id, data, ct)
    user.avatar_url = url
    db.commit()
    invalidate_user_cache(user.id)
    return {"ok": True, "avatar_url": url}


# ---- Static / SPA serving ----

if _DATASET_ROOT.is_dir():

    @app.get("/media/dataset/{full_path:path}")
    async def _serve_dataset_media(full_path: str) -> FileResponse:
        path = _resolve_dataset_media_file(unquote(full_path))
        if path is None:
            raise HTTPException(404)
        return FileResponse(path)


if FRONTEND_ROOT.is_dir():

    @app.get("/")
    async def _serve_index() -> HTMLResponse:
        return _index_html_response()

    @app.get("/index.html")
    async def _serve_index_named() -> HTMLResponse:
        return _index_html_response()

    @app.get("/@{username:path}")
    async def _serve_profile_page(username: str) -> HTMLResponse:
        """SPA catch-all: serve index.html for /@username so frontend JS can route it."""
        return _index_html_response()

    app.mount("/", StaticFiles(directory=str(FRONTEND_ROOT), html=True), name="site")

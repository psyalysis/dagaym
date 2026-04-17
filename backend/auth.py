"""
Password hashing, JWT, registration, login, and auth dependencies.
"""

from __future__ import annotations

import hashlib
import os
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Annotated

import bcrypt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy import func
from sqlalchemy.orm import Session

from .database import SessionLocal, get_db
from .models import User
from .schemas import LoginRequest, RegisterRequest, RegisterResponse, TokenResponse

# Insecure default for local dev only — set COOKUP_JWT_SECRET in production.
SECRET_KEY = os.environ.get(
    "COOKUP_JWT_SECRET", "dev-insecure-change-me-cookup-jwt-secret"
)
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 7
_WS_TICKET_TTL_S = 30
# jti -> JWT exp (unix); only entries with exp >= now survive replay checks until pruned.
_ws_ticket_consumed: dict[str, float] = {}
_ws_ticket_lock = threading.Lock()
_MAX_WS_JTI_LEN = 128
_USER_CACHE_TTL_S = 45.0
_user_cache: dict[int, tuple[User, float]] = {}
_user_cache_lock = threading.Lock()

security = HTTPBearer(auto_error=False)


def _password_key_bytes(plain: str) -> bytes:
    """SHA-256 digest (32 bytes) — bcrypt input stays under 72-byte limit for any UTF-8 password."""
    return hashlib.sha256(plain.encode("utf-8")).digest()


def verify_password(plain: str, hashed: str) -> bool:
    h = hashed.encode("ascii")
    try:
        if bcrypt.checkpw(_password_key_bytes(plain), h):
            return True
    except ValueError:
        pass
    # Legacy: hashes created with passlib+bcrypt of raw UTF-8 (only possible if len <= 72 bytes).
    try:
        raw = plain.encode("utf-8")
        if len(raw) <= 72:
            return bcrypt.checkpw(raw, h)
    except ValueError:
        return False
    return False


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_password_key_bytes(password), bcrypt.gensalt()).decode(
        "ascii"
    )


def create_access_token(*, user_id: int, username: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)
    payload = {
        "sub": str(user_id),
        "username": username,
        "exp": expire,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])


def register_user(db: Session, body: RegisterRequest) -> RegisterResponse:
    existing = (
        db.query(User)
        .filter(func.lower(User.username) == body.username.lower())
        .first()
    )
    if existing:
        raise HTTPException(status_code=400, detail="Username already taken.")
    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        wins=0,
    )
    db.add(user)
    db.commit()
    return RegisterResponse(message="Registration successful.")


def login_user(db: Session, body: LoginRequest) -> TokenResponse:
    user = (
        db.query(User)
        .filter(func.lower(User.username) == body.username.lower())
        .first()
    )
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    token = create_access_token(user_id=user.id, username=user.username)
    return TokenResponse(token=token, username=user.username)


def get_user_by_id(db: Session, user_id: int) -> User | None:
    return db.get(User, user_id)


def _cached_user_get(user_id: int) -> User | None:
    now = time.monotonic()
    with _user_cache_lock:
        hit = _user_cache.get(user_id)
        if hit is None:
            return None
        user, exp = hit
        if exp <= now:
            _user_cache.pop(user_id, None)
            return None
        return user


def _cached_user_put(user: User) -> None:
    with _user_cache_lock:
        _user_cache[user.id] = (user, time.monotonic() + _USER_CACHE_TTL_S)


def invalidate_user_cache(*user_ids: int) -> None:
    """Drop cache entries after a write (win increment, profile change, etc.)."""
    with _user_cache_lock:
        for uid in user_ids:
            _user_cache.pop(uid, None)


def increment_wins_for_users(db: Session, user_ids: list[int]) -> None:
    seen: set[int] = set()
    for uid in user_ids:
        if uid in seen:
            continue
        seen.add(uid)
        u = db.get(User, uid)
        if u is not None:
            u.wins += 1
    db.commit()
    # Bust cache so subsequent /me or leaderboard reads see updated wins.
    invalidate_user_cache(*seen)


def get_current_user(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(security)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Not authenticated.")
    try:
        payload = decode_token(creds.credentials)
        if payload.get("typ") == "ws_ticket":
            raise HTTPException(status_code=401, detail="Invalid or expired token.")
        uid = int(payload["sub"])
    except (JWTError, KeyError, ValueError, TypeError):
        raise HTTPException(status_code=401, detail="Invalid or expired token.")
    cached = _cached_user_get(uid)
    if cached is not None:
        return db.merge(cached, load=False)

    user = get_user_by_id(db, uid)
    if user is None:
        raise HTTPException(status_code=401, detail="User not found.")
    _cached_user_put(user)
    return user


def _ws_prune_consumed_locked(now: float) -> None:
    """Drop consumed JTIs past JWT exp (with small skew). Caller must hold ``_ws_ticket_lock``."""
    cutoff = now - 30.0
    dead = [j for j, exp in _ws_ticket_consumed.items() if exp < cutoff]
    for j in dead:
        _ws_ticket_consumed.pop(j, None)


def try_validate_ws_token(
    token: str | None,
) -> tuple[tuple[int, str], None] | tuple[None, str]:
    """
    Validate JWT and that the user still exists (for WebSocket connect).
    On failure returns ``(None, reason)`` with a stable reason code for logging — never log the token.
    """
    if not token or not str(token).strip():
        return None, "missing_token"
    try:
        payload = decode_token(str(token).strip())
    except (JWTError, KeyError, ValueError, TypeError):
        return None, "jwt_invalid"
    if payload.get("typ") == "ws_ticket":
        return None, "ws_ticket_wrong_channel"
    try:
        uid = int(payload["sub"])
        un = str(payload["username"])
    except (KeyError, ValueError, TypeError):
        return None, "jwt_invalid"
    db = SessionLocal()
    try:
        user = db.get(User, uid)
        if user is None:
            return None, "user_not_found"
        if user.username != un:
            return None, "username_mismatch"
        _cached_user_put(user)
        return (uid, user.username), None
    finally:
        db.close()


def validate_ws_token(token: str | None) -> tuple[int, str] | None:
    """Validate JWT and that the user still exists (for WebSocket connect)."""
    ok, reason = try_validate_ws_token(token)
    if reason is not None:
        return None
    return ok


def create_ws_ticket(user_id: int, username: str) -> str:
    """Short-lived single-use JWT for ``/ws?token=`` (see ``redeem_ws_ticket``)."""
    jti = secrets.token_urlsafe(24)
    expire = datetime.now(timezone.utc) + timedelta(seconds=_WS_TICKET_TTL_S)
    payload = {
        "sub": str(user_id),
        "username": username,
        "exp": expire,
        "typ": "ws_ticket",
        "jti": jti,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def redeem_ws_ticket(token: str) -> tuple[int, str] | None:
    """
    If ``token`` is a valid unused ws ticket, mark ``jti`` consumed until JWT exp and return
    ``(user_id, username)``. Otherwise return None (caller may try long-lived JWT — but
    ``try_validate_ws_token`` rejects ``typ=ws_ticket`` so used tickets cannot authenticate twice).
    """
    raw = str(token or "").strip()
    if not raw:
        return None
    try:
        payload = jwt.decode(raw, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None
    if payload.get("typ") != "ws_ticket":
        return None
    jti = payload.get("jti")
    if not jti or not isinstance(jti, str) or len(jti) > _MAX_WS_JTI_LEN:
        return None
    exp = payload.get("exp")
    if exp is None:
        return None
    try:
        exp_f = float(exp)
    except (TypeError, ValueError):
        return None
    try:
        uid = int(payload["sub"])
        un = str(payload["username"])
    except (KeyError, TypeError, ValueError):
        return None
    now = time.time()
    with _ws_ticket_lock:
        _ws_prune_consumed_locked(now)
        if jti in _ws_ticket_consumed:
            return None
        _ws_ticket_consumed[jti] = exp_f
    db = SessionLocal()
    try:
        user = db.get(User, uid)
        if user is None or user.username != un:
            return None
        return uid, un
    finally:
        db.close()

"""
Pydantic schemas for auth and API responses.
"""

from __future__ import annotations

import re

from pydantic import BaseModel, Field, field_validator

MAX_BEAT_UPLOAD_BYTES = 30 * 1024 * 1024

USERNAME_PATTERN = re.compile(r"^[a-z0-9_]{3,20}$")


class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=20)
    password: str = Field(..., min_length=8, max_length=128)

    @field_validator("username")
    @classmethod
    def username_chars(cls, v: str) -> str:
        v = v.strip()
        if not USERNAME_PATTERN.match(v):
            raise ValueError(
                "Username must be 3–20 characters: lowercase letters, numbers, underscores only."
            )
        return v


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1)
    password: str

    @field_validator("username")
    @classmethod
    def username_strip(cls, v: str) -> str:
        # RegisterRequest normalizes with strip(); login must match so lookups succeed.
        s = v.strip()
        if not s:
            raise ValueError("Username required.")
        return s


class TokenResponse(BaseModel):
    token: str
    username: str


class RegisterResponse(BaseModel):
    message: str


class RankInfo(BaseModel):
    key: str
    abbrev: str
    label: str
    color: str


class LeaderboardEntry(BaseModel):
    username: str
    wins: int
    rank: RankInfo | None = None
    rank_index: int = 0


class MeResponse(BaseModel):
    username: str
    wins: int
    coins: int = 0
    rank: RankInfo | None = None
    rank_index: int = 0


MAX_BEAT_UPLOAD_BYTES = 30 * 1024 * 1024


class BeatUploadPresignRequest(BaseModel):
    lobby_id: str = Field(..., min_length=1, max_length=128)
    player_id: str = Field(..., min_length=1, max_length=128)
    content_type: str = Field(..., min_length=1, max_length=64)

    @field_validator("lobby_id", "player_id")
    @classmethod
    def strip_ws_ids(cls, v: str) -> str:
        s = v.strip()
        if not s:
            raise ValueError("must not be empty")
        return s

    @field_validator("content_type")
    @classmethod
    def content_type_allowlist(cls, v: str) -> str:
        s = v.strip()
        if s not in ("audio/mpeg", "audio/wav"):
            raise ValueError("content_type must be audio/mpeg or audio/wav")
        return s


class BeatUploadPresignResponse(BaseModel):
    upload_id: str
    put_url: str
    required_headers: dict[str, str]


class BeatUploadCompleteRequest(BaseModel):
    lobby_id: str = Field(..., min_length=1, max_length=128)
    player_id: str = Field(..., min_length=1, max_length=128)
    upload_id: str = Field(..., min_length=1, max_length=128)
    content_length: int = Field(..., ge=1, le=MAX_BEAT_UPLOAD_BYTES)
    etag: str = Field(..., min_length=1, max_length=256)
    sha256: str | None = Field(None, min_length=64, max_length=64)

    @field_validator("lobby_id", "player_id", "upload_id")
    @classmethod
    def strip_ws_upload(cls, v: str) -> str:
        s = v.strip()
        if not s:
            raise ValueError("must not be empty")
        return s

    @field_validator("sha256")
    @classmethod
    def sha256_hex(cls, v: str | None) -> str | None:
        if v is None:
            return None
        s = v.strip().lower()
        if len(s) != 64 or any(c not in "0123456789abcdef" for c in s):
            raise ValueError("sha256 must be 64 hex characters")
        return s


class BeatUploadCompleteResponse(BaseModel):
    ok: bool = True
    ready: bool = False
    idempotent: bool = False
    accepted: bool = True


class BeatUploadCapabilitiesResponse(BaseModel):
    r2_direct: bool


# ---- Profile ----


class ProfileResponse(BaseModel):
    username: str
    wins: int
    coins: int = 0
    games_played: int = 0
    rank: RankInfo | None = None
    rank_index: int = 0
    bio: str | None = None
    avatar_url: str | None = None
    created_at: str
    comment_count: int = 0


class ProfileCommentOut(BaseModel):
    id: int
    author_username: str
    author_rank: RankInfo | None = None
    author_avatar_url: str | None = None
    content: str
    created_at: str


class ProfileCommentCreate(BaseModel):
    content: str = Field(..., min_length=1, max_length=500)


class ProfileUpdateBio(BaseModel):
    bio: str = Field("", max_length=200)

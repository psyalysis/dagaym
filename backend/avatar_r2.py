"""R2 (S3-compatible) avatar upload helpers.

Avatars are stored under ``avatars/{user_id}/{uuid}.{ext}`` in the same R2
bucket used by beat uploads.  The public URL is returned so the client can
display it directly.
"""

from __future__ import annotations

import os
import uuid
from typing import Any

from .beats_r2 import _r2_config_errors, _s3, r2_capabilities


ALLOWED_AVATAR_CONTENT_TYPES = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
    }
)
MAX_AVATAR_BYTES = 2 * 1024 * 1024  # 2 MB


def avatar_key(user_id: int, filename: str) -> str:
    return f"avatars/{user_id}/{filename}"


def upload_avatar_to_r2(
    user_id: int,
    data: bytes,
    content_type: str,
) -> str:
    """Upload avatar bytes to R2 and return the public URL."""
    ext_map = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
    }
    ext = ext_map.get(content_type, "png")
    filename = f"{uuid.uuid4().hex}.{ext}"
    key = avatar_key(user_id, filename)
    bucket = os.environ["R2_BUCKET_NAME"].strip()
    client = _s3()
    client.put_object(
        Bucket=bucket,
        Key=key,
        Body=data,
        ContentType=content_type,
    )
    base = os.environ["R2_PUBLIC_BASE_URL"].strip().rstrip("/")
    return f"{base}/{key}"


def delete_avatar_from_r2(avatar_url: str) -> None:
    """Delete an avatar object from R2 by its public URL.  No-op if R2 not configured."""
    if not r2_capabilities()["r2_direct"]:
        return
    base = os.environ.get("R2_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if not base or not avatar_url.startswith(base):
        return
    key = avatar_url[len(base) + 1 :]  # strip base + leading /
    bucket = os.environ["R2_BUCKET_NAME"].strip()
    client = _s3()
    try:
        client.delete_object(Bucket=bucket, Key=key)
    except Exception:
        pass

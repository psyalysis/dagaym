"""R2 (S3-compatible) presigned PUT for beat staging keys."""

from __future__ import annotations

import os
import re
import uuid
from typing import Any

import boto3
from botocore.client import BaseClient
from botocore.exceptions import ClientError

# ADR: staging key layout
ALLOWED_BEAT_CONTENT_TYPES = frozenset({"audio/mpeg", "audio/ogg"})
MAX_BEAT_BYTES = 30 * 1024 * 1024
PRESIGN_EXPIRES_S = 900
_BEAT_EXT_BY_CONTENT_TYPE = {
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
}


def _truthy(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def r2_stub_ready_default_on() -> bool:
    """When True, complete handler copies staging→final and calls record_upload (milestone; real ADR uses worker)."""
    return _truthy("BEAT_UPLOAD_R2_STUB_READY", True)


def r2_capabilities() -> dict[str, Any]:
    ok, _ = _r2_config_errors()
    return {"r2_direct": ok}


def _r2_config_errors() -> tuple[bool, str]:
    required = (
        "R2_ACCOUNT_ID",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET_NAME",
        "R2_PUBLIC_BASE_URL",
    )
    missing = [k for k in required if not os.environ.get(k, "").strip()]
    if missing:
        return False, f"Missing env: {', '.join(missing)}"
    acct = os.environ["R2_ACCOUNT_ID"].strip()
    if not re.fullmatch(r"[0-9a-f]{32}", acct, flags=re.I):
        return False, "R2_ACCOUNT_ID must be 32 hex characters"
    return True, ""


def require_r2_config() -> None:
    from fastapi import HTTPException

    ok, msg = _r2_config_errors()
    if not ok:
        raise HTTPException(status_code=503, detail=f"R2 beat uploads not configured: {msg}")


def _s3() -> BaseClient:
    account = os.environ["R2_ACCOUNT_ID"].strip()
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"].strip(),
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"].strip(),
        region_name="auto",
    )


def staging_key(lobby_id: str, player_id: str, upload_id: str) -> str:
    return f"beats/{lobby_id}/staging/{player_id}/{upload_id}/source"


def final_prefix(lobby_id: str, player_id: str) -> str:
    return f"beats/{lobby_id}/final/{player_id}."


def beat_extension_for_content_type(content_type: str) -> str:
    ct = str(content_type or "").strip().lower()
    return _BEAT_EXT_BY_CONTENT_TYPE.get(ct, "ogg")


def final_key(lobby_id: str, player_id: str, content_type: str) -> str:
    return f"{final_prefix(lobby_id, player_id)}{beat_extension_for_content_type(content_type)}"


def normalize_etag(raw: str | None) -> str:
    if not raw:
        return ""
    s = str(raw).strip()
    if s.upper().startswith("W/"):
        s = s[2:].strip()
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        s = s[1:-1]
    return s


def issue_upload_id() -> str:
    return str(uuid.uuid4())


def generate_presigned_put(
    *,
    lobby_id: str,
    player_id: str,
    upload_id: str,
    content_type: str,
) -> str:
    bucket = os.environ["R2_BUCKET_NAME"].strip()
    key = staging_key(lobby_id, player_id, upload_id)
    client = _s3()
    return client.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": bucket,
            "Key": key,
            "ContentType": content_type,
        },
        ExpiresIn=PRESIGN_EXPIRES_S,
        HttpMethod="PUT",
    )


def head_staging_object(lobby_id: str, player_id: str, upload_id: str) -> dict[str, Any]:
    bucket = os.environ["R2_BUCKET_NAME"].strip()
    key = staging_key(lobby_id, player_id, upload_id)
    client = _s3()
    return client.head_object(Bucket=bucket, Key=key)


def copy_staging_to_final(lobby_id: str, player_id: str, upload_id: str, content_type: str) -> None:
    """Stub worker: same bytes at a correctly typed final key so browser playback works."""
    bucket = os.environ["R2_BUCKET_NAME"].strip()
    src = staging_key(lobby_id, player_id, upload_id)
    dst = final_key(lobby_id, player_id, content_type)
    client = _s3()
    client.copy_object(
        Bucket=bucket,
        Key=dst,
        CopySource={"Bucket": bucket, "Key": src},
        ContentType=content_type,
        MetadataDirective="REPLACE",
    )


def resolve_final_key(lobby_id: str, player_id: str) -> str | None:
    bucket = os.environ["R2_BUCKET_NAME"].strip()
    prefix = final_prefix(lobby_id, player_id)
    client = _s3()
    page = client.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=10)
    keys = [obj.get("Key") for obj in page.get("Contents") or () if isinstance(obj.get("Key"), str)]
    if not keys:
        return None
    preferred = (
        f"{prefix}ogg",
        f"{prefix}mp3",
        f"{prefix}wav",
    )
    for candidate in preferred:
        if candidate in keys:
            return candidate
    return sorted(keys)[0]


def public_final_url(lobby_id: str, player_id: str) -> str | None:
    base = os.environ["R2_PUBLIC_BASE_URL"].strip().rstrip("/")
    key = resolve_final_key(lobby_id, player_id)
    if not key:
        return None
    return f"{base}/{key}"


def _r2_safe_lobby_id(lobby_id: str) -> str | None:
    lid = lobby_id.strip()
    if not lid or "/" in lid or "\\" in lid or ".." in lid:
        return None
    return lid


def _r2_safe_player_id(player_id: str) -> str | None:
    pid = player_id.strip()
    if not pid or "/" in pid or "\\" in pid or ".." in pid:
        return None
    return pid


def _delete_keys_batch(client: BaseClient, bucket: str, keys: list[str]) -> None:
    if not keys:
        return
    for i in range(0, len(keys), 1000):
        chunk = keys[i : i + 1000]
        client.delete_objects(
            Bucket=bucket,
            Delete={"Objects": [{"Key": k} for k in chunk], "Quiet": True},
        )


def r2_delete_lobby_objects(lobby_id: str) -> None:
    """Delete every object under ``beats/{lobby_id}/`` (staging + final). No-op if R2 not configured."""
    if not r2_capabilities()["r2_direct"]:
        return
    lid = _r2_safe_lobby_id(lobby_id)
    if lid is None:
        return
    prefix = f"beats/{lid}/"
    bucket = os.environ["R2_BUCKET_NAME"].strip()
    client = _s3()
    keys: list[str] = []
    try:
        for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents") or ():
                k = obj.get("Key")
                if isinstance(k, str):
                    keys.append(k)
    except ClientError:
        return
    _delete_keys_batch(client, bucket, keys)


def r2_delete_player_beat_objects(lobby_id: str, player_id: str) -> None:
    """Delete ``final/{player}.ogg`` and ``staging/{player_id}/…`` for one seat (single disconnect)."""
    if not r2_capabilities()["r2_direct"]:
        return
    lid = _r2_safe_lobby_id(lobby_id)
    pid = _r2_safe_player_id(player_id)
    if lid is None or pid is None:
        return
    bucket = os.environ["R2_BUCKET_NAME"].strip()
    client = _s3()
    keys: list[str] = []
    final_prefix_value = final_prefix(lid, pid)
    try:
        for page in client.get_paginator("list_objects_v2").paginate(
            Bucket=bucket, Prefix=final_prefix_value
        ):
            for obj in page.get("Contents") or ():
                k = obj.get("Key")
                if isinstance(k, str) and k not in keys:
                    keys.append(k)
    except ClientError:
        pass
    staging_prefix = f"beats/{lid}/staging/{pid}/"
    try:
        for page in client.get_paginator("list_objects_v2").paginate(
            Bucket=bucket, Prefix=staging_prefix
        ):
            for obj in page.get("Contents") or ():
                k = obj.get("Key")
                if isinstance(k, str) and k not in keys:
                    keys.append(k)
    except ClientError:
        pass
    _delete_keys_batch(client, bucket, keys)

"""
Transcode uploaded beats (MP3/WAV) to trimmed OGG Vorbis for smaller storage and downloads.

Requires ffmpeg with libvorbis. Max length matches BEAT_MAX_PLAYBACK_S (frontend clip cap).
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from .multiplayer.lobby import BEAT_MAX_PLAYBACK_S

# Vorbis quality scale ~0–10; 5 is a common default (good size/quality for short clips).
_VORBIS_Q = 5


def trim_beat_upload_to_ogg(
    src: Path,
    dest_ogg: Path,
    *,
    source_suffix: str,
    max_sec: float | None = None,
) -> None:
    """
    Decode ``src`` (uploaded ``.mp3``, ``.wav``, or ``.ogg``), keep at most ``max_sec`` seconds of audio,
    encode as Vorbis, write ``dest_ogg``. Removes ``src`` when done (success or failure).

    ``dest_ogg`` must use a ``.ogg`` suffix.
    """
    dur = float(BEAT_MAX_PLAYBACK_S if max_sec is None else max_sec)
    if dur <= 0:
        raise ValueError("max_sec must be positive")

    if dest_ogg.suffix.lower() != ".ogg":
        raise ValueError("dest_ogg must end with .ogg")

    suf = source_suffix.lower()
    if suf not in (".mp3", ".wav", ".ogg"):
        raise ValueError(f"Unsupported source suffix: {source_suffix}")

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found on PATH (required to encode beats as OGG).")

    dest_ogg.parent.mkdir(parents=True, exist_ok=True)
    if dest_ogg.is_file():
        try:
            dest_ogg.unlink()
        except OSError:
            pass

    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(src),
        "-t",
        str(dur),
        "-vn",
        "-c:a",
        "libvorbis",
        "-q:a",
        str(_VORBIS_Q),
        str(dest_ogg),
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if r.returncode != 0 or not dest_ogg.is_file() or dest_ogg.stat().st_size == 0:
            err = (r.stderr or r.stdout or "").strip()
            hint = f" {err[:300]}" if err else ""
            raise RuntimeError(f"ffmpeg could not transcode to OGG.{hint}")
    finally:
        try:
            if src.is_file():
                src.unlink()
        except OSError:
            pass

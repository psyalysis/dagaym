"""
Build ``/api/kit-manifest`` payload: sorted WAV paths per logical kit key (matches client kit build).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .generator import DATASET_ROOT, CATEGORY_FOLDERS, _LIGHT_KIT_KEYS


def _wavs_sorted(d: Path) -> list[Path]:
    if not d.is_dir():
        return []
    return sorted(p for p in d.iterdir() if p.is_file() and p.suffix.lower() == ".wav")


def _dataset_dir(logical: str) -> Path:
    name = CATEGORY_FOLDERS[logical]
    p = DATASET_ROOT / name
    if p.is_dir():
        return p
    if logical == "open_hat" and (DATASET_ROOT / "open_hihats").is_dir():
        return DATASET_ROOT / "open_hihats"
    return p


def _rel_media_path(path: Path) -> str:
    """Path relative to ``dataset/`` using forward slashes."""
    rel = path.relative_to(DATASET_ROOT)
    return rel.as_posix()


def build_kit_manifest() -> dict[str, Any]:
    """
    Keys: logical stem → sorted list of relative paths under ``dataset/``.
    Order of keys follows ``_LIGHT_KIT_KEYS`` for documentation; clients use logical names.
    """
    out: dict[str, list[str]] = {}

    static_keys = [k for k in _LIGHT_KIT_KEYS if not k.startswith("synth")]
    for logical in static_keys:
        d = _dataset_dir(logical)
        wavs = _wavs_sorted(d)
        out[logical] = [_rel_media_path(p) for p in wavs]

    synth_dir = DATASET_ROOT / "synths"
    synth_wavs = _wavs_sorted(synth_dir)
    synth_rel = [_rel_media_path(p) for p in synth_wavs]

    for stem in ("synth1", "synth2", "synth3"):
        out[stem] = list(synth_rel)

    return {"version": 2, "sampleRate": 44100, "keys": out}

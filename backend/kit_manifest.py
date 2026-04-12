"""
Build ``/api/kit-manifest`` payload: sorted media paths per logical kit key (matches client kit build).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .audio_utils import list_dataset_samples_in_dir
from .generator import DATASET_ROOT, CATEGORY_FOLDERS, _LIGHT_KIT_KEYS


def _samples_sorted(d: Path) -> list[Path]:
    if not d.is_dir():
        return []
    try:
        return list_dataset_samples_in_dir(d)
    except ValueError:
        return []


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
        samples = _samples_sorted(d)
        out[logical] = [_rel_media_path(p) for p in samples]

    synth_dir = DATASET_ROOT / "synths"
    synth_samples = _samples_sorted(synth_dir)
    synth_rel = [_rel_media_path(p) for p in synth_samples]

    for stem in ("synth1", "synth2", "synth3"):
        out[stem] = list(synth_rel)

    return {"version": 4, "sampleRate": 44100, "keys": out}

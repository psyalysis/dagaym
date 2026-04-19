"""
Build ``/api/kit-manifest`` payload: sorted media paths per logical kit key (matches client kit build).

Trap — resolution order for :func:`get_kit_manifest_cached`:

1. ``KIT_MANIFEST_PATH`` — local JSON file (e.g. from ``misc/scripts/build_kit_manifest_refined.py``).
2. ``KIT_MANIFEST_URL`` — HTTP(S) JSON. If **unset**, uses production CDN
   ``kit-manifest-trap-refined.json`` only (no legacy manifest fallbacks).
   Set ``KIT_MANIFEST_URL=`` (empty) to skip remote and use disk.
3. Scan disk: ``dataset/TrapRefined/`` if present, else ``dataset/beat-battle-assets/TrapRefined/``,
   else ``dataset/beat-battle-assets/DRACO/TrapRefined/``, else ``dataset/trap/``.

EDM — :func:`get_kit_manifest_for_genre` with ``genre=edm`` uses ``KIT_MANIFEST_EDM_PATH`` / ``KIT_MANIFEST_EDM_URL``
(default CDN ``kit-manifest-edm-refined.json``), else scans ``dataset/EDM/<KIT_EDM_KEY>/`` (see
``backend.generator.KIT_EDM_KEYS``) or nested ``dataset/beat-battle-assets/EDM/``.
"""

from __future__ import annotations

import json
import os
import warnings
from functools import lru_cache
from pathlib import Path
from typing import Any

from .audio_utils import list_dataset_samples_in_dir
from .generator import (
    DATASET_ROOT,
    KIT_EDM_KEYS,
    _LIGHT_KIT_KEYS,
    _dataset_dir,
    trap_synth_samples_dir,
)

_PROJECT_ROOT = DATASET_ROOT.parent

_DEFAULT_KIT_MANIFEST_BASE = "https://assets.beat-battle.net"
_DEFAULT_KIT_MANIFEST_URLS: tuple[str, ...] = (
    f"{_DEFAULT_KIT_MANIFEST_BASE}/kit-manifest-trap-refined.json",
)


def _configured_kit_manifest_path() -> Path | None:
    raw = os.environ.get("KIT_MANIFEST_PATH", "").strip()
    if not raw:
        return None
    p = Path(raw)
    return p if p.is_absolute() else _PROJECT_ROOT / p


def _remote_kit_manifest_urls() -> list[str] | None:
    """Explicit ``KIT_MANIFEST_URL`` is a single URL; unset uses CDN ``kit-manifest-trap-refined.json`` only."""
    if "KIT_MANIFEST_URL" in os.environ:
        v = os.environ["KIT_MANIFEST_URL"].strip()
        return None if not v else [v]
    return list(_DEFAULT_KIT_MANIFEST_URLS)


# Production CDN historically used singular / short slot names; client and
# generator expect ``_LIGHT_KIT_KEYS`` (e.g. ``snares``, ``808s``).
_LEGACY_KIT_KEY_MAP: dict[str, str] = {
    "snare": "snares",
    "clap": "claps",
    "hihat": "hihats",
    "open_hat": "openhats",
    "808": "808s",
    "perc": "percs",
    "kick": "kicks",
    "vox": "Vox",
}


def _normalize_manifest_keys(data: dict[str, Any]) -> None:
    keys = data.get("keys")
    if not isinstance(keys, dict):
        return
    for old, new in _LEGACY_KIT_KEY_MAP.items():
        if new in keys:
            continue
        if old not in keys:
            continue
        v = keys[old]
        if isinstance(v, list):
            keys[new] = v


_TRAP_LEGACY_PREFIXES: tuple[str, ...] = (
    "beat-battle-assets/DRACO/TrapRefined",
    "beat-battle-assets/TrapRefined",
    "DRACO/TrapRefined",
)
_TRAP_CDN_ROOT = "TrapRefined"


def _normalize_one_trap_manifest_path(p: str) -> str:
    """One manifest media path → CDN-style ``TrapRefined/…`` where applicable."""
    root = _TRAP_CDN_ROOT
    for leg in _TRAP_LEGACY_PREFIXES:
        if p == leg or p.startswith(f"{leg}/"):
            tail = "" if p == leg else p[len(leg) + 1 :]
            return f"{root}/{tail}".replace("//", "/").rstrip("/") if tail else root
    if p == root or p.startswith(f"{root}/"):
        return p
    if p == "trap/synths" or p.startswith("trap/synths/"):
        tail = "" if p == "trap/synths" else p[len("trap/synths/") :]
        return f"{root}/synths/{tail}".replace("//", "/").rstrip("/") if tail else f"{root}/synths"
    return p


def _normalize_trap_refined_paths_in_keys(data: dict[str, Any]) -> None:
    keys = data.get("keys")
    if not isinstance(keys, dict):
        return
    for lst in keys.values():
        if not isinstance(lst, list):
            continue
        for i, p in enumerate(lst):
            if isinstance(p, str):
                lst[i] = _normalize_one_trap_manifest_path(p)


def _normalize_one_edm_manifest_path(p: str) -> str:
    if p.startswith("beat-battle-assets/EDM/"):
        return f"edm/{p[len('beat-battle-assets/EDM/') :]}".replace("//", "/").rstrip("/")
    if p.startswith("EDM/") and not p.startswith("edm/"):
        return f"edm/{p[4:]}".replace("//", "/").rstrip("/")
    if p == "EDM":
        return "edm"
    return p


def _normalize_edm_paths_in_keys(data: dict[str, Any]) -> None:
    keys = data.get("keys")
    if not isinstance(keys, dict):
        return
    for lst in keys.values():
        if not isinstance(lst, list):
            continue
        for i, p in enumerate(lst):
            if isinstance(p, str):
                q = _normalize_one_edm_manifest_path(p)
                if q != p:
                    lst[i] = q


def _validate_trap_manifest_payload(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict) or "keys" not in data:
        raise ValueError("Invalid kit manifest JSON: missing top-level 'keys'")
    keys = data["keys"]
    if not isinstance(keys, dict):
        raise ValueError("Invalid kit manifest JSON: 'keys' must be an object")
    _normalize_manifest_keys(data)
    _normalize_trap_refined_paths_in_keys(data)
    _normalize_edm_paths_in_keys(data)
    keys = data["keys"]
    for k in _LIGHT_KIT_KEYS:
        if k not in keys or not isinstance(keys[k], list):
            raise ValueError(f"Invalid kit manifest JSON: missing or non-array keys[{k!r}]")
    return data


def _validate_edm_manifest_payload(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict) or "keys" not in data:
        raise ValueError("Invalid EDM kit manifest JSON: missing top-level 'keys'")
    keys = data["keys"]
    if not isinstance(keys, dict):
        raise ValueError("Invalid EDM kit manifest JSON: 'keys' must be an object")
    _normalize_edm_paths_in_keys(data)
    keys = data["keys"]
    for k in KIT_EDM_KEYS:
        if k not in keys or not isinstance(keys[k], list):
            raise ValueError(f"Invalid EDM kit manifest JSON: missing or non-array keys[{k!r}]")
    return data


def _load_trap_kit_manifest_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return _validate_trap_manifest_payload(data)


def _load_edm_kit_manifest_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return _validate_edm_manifest_payload(data)


def _load_kit_manifest_from_url(url: str) -> dict[str, Any]:
    import urllib.error
    import urllib.request

    req = urllib.request.Request(
        url,
        headers={"User-Agent": "BeatBattleKitManifest/1.0"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        raw = resp.read()
    data = json.loads(raw.decode("utf-8"))
    return _validate_trap_manifest_payload(data)


def _load_edm_kit_manifest_from_url(url: str) -> dict[str, Any]:
    import urllib.error
    import urllib.request

    req = urllib.request.Request(
        url,
        headers={"User-Agent": "BeatBattleKitManifest/1.0"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        raw = resp.read()
    data = json.loads(raw.decode("utf-8"))
    return _validate_edm_manifest_payload(data)


def _samples_sorted(d: Path) -> list[Path]:
    if not d.is_dir():
        return []
    try:
        return list_dataset_samples_in_dir(d)
    except ValueError:
        return []


def _rel_media_path(path: Path) -> str:
    """Path relative to ``dataset/`` using forward slashes."""
    rel = path.relative_to(DATASET_ROOT)
    return rel.as_posix()


def build_kit_manifest() -> dict[str, Any]:
    """
    Keys: logical stem → sorted list of relative paths under ``dataset/``.
    Order of keys follows ``_LIGHT_KIT_KEYS`` (slot names match TrapRefined folder names, e.g. ``snares``, ``808s``).
    """
    out: dict[str, list[str]] = {}

    static_keys = [k for k in _LIGHT_KIT_KEYS if not k.startswith("synth")]
    for logical in static_keys:
        d = _dataset_dir(logical)
        samples = _samples_sorted(d)
        out[logical] = [_rel_media_path(p) for p in samples]

    synth_dir = trap_synth_samples_dir()
    synth_samples = _samples_sorted(synth_dir)
    synth_rel = [_rel_media_path(p) for p in synth_samples]

    for stem in ("synth1", "synth2", "synth3"):
        out[stem] = list(synth_rel)

    data: dict[str, Any] = {"version": 5, "sampleRate": 44100, "keys": out}
    _normalize_trap_refined_paths_in_keys(data)
    _normalize_edm_paths_in_keys(data)
    return data


# --- EDM (public CDN ``EDM/<subfolder>/``; logical paths ``edm/<subfolder>/`` in JSON) ---

_EDM_DATASET_ROOT_FLAT = DATASET_ROOT / "EDM"
_EDM_DATASET_ROOT_NESTED = DATASET_ROOT / "beat-battle-assets" / "EDM"
_EDM_DATASET_ROOT = (
    _EDM_DATASET_ROOT_FLAT
    if _EDM_DATASET_ROOT_FLAT.is_dir()
    else _EDM_DATASET_ROOT_NESTED
    if _EDM_DATASET_ROOT_NESTED.is_dir()
    else _EDM_DATASET_ROOT_FLAT
)

# R2 builder may warn instead of exit when these slots are empty (new packs should fill all).
EDM_MANIFEST_OPTIONAL_KEYS: frozenset[str] = frozenset()


def _configured_kit_manifest_edm_path() -> Path | None:
    raw = os.environ.get("KIT_MANIFEST_EDM_PATH", "").strip()
    if not raw:
        return None
    p = Path(raw)
    return p if p.is_absolute() else _PROJECT_ROOT / p


def _remote_kit_manifest_edm_url() -> str | None:
    if "KIT_MANIFEST_EDM_URL" in os.environ:
        v = os.environ["KIT_MANIFEST_EDM_URL"].strip()
        return v or None
    return "https://assets.beat-battle.net/kit-manifest-edm-refined.json"


def build_kit_manifest_edm() -> dict[str, Any]:
    """Scan ``dataset/EDM/<logical key>/``; emit ``edm/<Key>/…`` paths (matches R2 ``EDM/<Key>/``)."""
    out: dict[str, list[str]] = {}
    for key in KIT_EDM_KEYS:
        d = _EDM_DATASET_ROOT / key
        samples = _samples_sorted(d)
        out[key] = [f"edm/{key}/{p.name}" for p in samples]
    return {"version": 7, "sampleRate": 44100, "keys": out}


_DEFAULT_EDM_MANIFEST_PATH = _PROJECT_ROOT / "kit-manifest-edm-refined.json"


@lru_cache(maxsize=1)
def get_kit_manifest_edm_cached() -> dict[str, Any]:
    path = _configured_kit_manifest_edm_path()
    if path is not None and path.is_file():
        try:
            return _load_edm_kit_manifest_json(path)
        except (OSError, ValueError, json.JSONDecodeError) as e:
            warnings.warn(
                f"KIT_MANIFEST_EDM_PATH {path}: {e!r}; trying remote / disk.",
                stacklevel=2,
            )

    url = _remote_kit_manifest_edm_url()
    if url:
        try:
            return _load_edm_kit_manifest_from_url(url)
        except Exception as e:
            warnings.warn(
                f"KIT_MANIFEST_EDM_URL {url!r}: {e!r}; falling back to disk scan.",
                stacklevel=2,
            )

    if _DEFAULT_EDM_MANIFEST_PATH.is_file():
        try:
            return _load_edm_kit_manifest_json(_DEFAULT_EDM_MANIFEST_PATH)
        except (OSError, ValueError, json.JSONDecodeError) as e:
            warnings.warn(
                f"Default EDM manifest {_DEFAULT_EDM_MANIFEST_PATH}: {e!r}; disk scan.",
                stacklevel=2,
            )

    return build_kit_manifest_edm()


def get_kit_manifest_for_genre(genre: str | None) -> dict[str, Any]:
    """Trap (default) uses :func:`get_kit_manifest_cached`; ``edm`` uses EDM manifest."""
    g = str(genre or "trap").strip().lower()
    if g == "edm":
        return get_kit_manifest_edm_cached()
    return get_kit_manifest_cached()


@lru_cache(maxsize=1)
def get_kit_manifest_cached() -> dict[str, Any]:
    """Single in-memory snapshot (file → remote URL → disk)."""
    path = _configured_kit_manifest_path()
    if path is not None and path.is_file():
        try:
            return _load_trap_kit_manifest_json(path)
        except (OSError, ValueError, json.JSONDecodeError) as e:
            warnings.warn(
                f"KIT_MANIFEST_PATH {path}: {e!r}; trying remote / disk.",
                stacklevel=2,
            )

    urls = _remote_kit_manifest_urls()
    if urls:
        last_err: BaseException | None = None
        for url in urls:
            try:
                return _load_kit_manifest_from_url(url)
            except Exception as e:
                last_err = e
                continue
        warnings.warn(
            f"KIT_MANIFEST_URL(s) {urls!r}: {last_err!r}; falling back to disk scan.",
            stacklevel=2,
        )

    return build_kit_manifest()

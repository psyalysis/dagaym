"""
Load ``config.json``: ``default.duration_s``, ``normalize_peak``, and ``fade_out_amt``,
plus optional per-sound multipliers.

Effective output duration now follows ``duration_s * duration_multiplier`` per sound.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .audio_utils import SAMPLE_RATE

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent / "config.json"

_MULTIPLIER_KEYS = frozenset(
    {"duration_multiplier", "normalize_peak_multiplier", "fade_out_amt_multiplier"}
)

_DEFAULT_BASE_KEYS = frozenset({"duration_s", "normalize_peak", "fade_out_amt"})

SOUND_KEYS = (
    "snare",
    "clap",
    "hihat",
    "open_hat",
    "808",
    "perc",
    "fx",
    "vox",
    "synth1",
    "synth2",
    "synth3",
    "kick",
)


@dataclass(frozen=True)
class EffectiveSoundParams:
    """Resolved parameters for one kit slot."""

    target_samples: int
    normalize_peak: float
    fade_out_amt: float


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _load_raw(path: Path) -> dict[str, Any]:
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"Config not found: {path.resolve()}")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_kit_config(path: Path | None = None) -> dict[str, Any]:
    raw = _load_raw(path or DEFAULT_CONFIG_PATH)
    if "default" not in raw or not isinstance(raw["default"], dict):
        raise ValueError("config.json must contain a 'default' object")
    d = raw["default"]
    missing = _DEFAULT_BASE_KEYS - d.keys()
    if missing:
        raise ValueError(f"config default section missing keys: {sorted(missing)}")
    for k in SOUND_KEYS:
        if k in raw and raw[k] is not None:
            if not isinstance(raw[k], dict):
                raise ValueError(f"config[{k!r}] must be an object")
            bad = set(raw[k].keys()) - _MULTIPLIER_KEYS
            if bad:
                raise ValueError(f"config[{k!r}] has unknown keys: {sorted(bad)}")
    return raw


def resolve_sound(stem: str, raw: dict[str, Any]) -> EffectiveSoundParams:
    if stem not in SOUND_KEYS:
        raise ValueError(f"Unknown sound stem {stem!r}; expected one of {SOUND_KEYS}")

    base = raw["default"]
    mult = raw.get(stem) or {}

    def m(key: str) -> float:
        v = mult.get(key, 1.0)
        if not isinstance(v, (int, float)):
            raise TypeError(f"{stem}.{key} must be a number")
        return float(v)

    dur = float(base["duration_s"]) * m("duration_multiplier")
    if dur <= 0:
        raise ValueError(f"effective duration_s must be > 0 for {stem}")
    return EffectiveSoundParams(
        target_samples=max(1, int(round(SAMPLE_RATE * dur))),
        normalize_peak=_clamp01(float(base["normalize_peak"]) * m("normalize_peak_multiplier")),
        fade_out_amt=_clamp01(float(base["fade_out_amt"]) * m("fade_out_amt_multiplier")),
    )

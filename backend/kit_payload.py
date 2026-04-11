"""
Encode generated kit WAV paths to the same base64 payload shape as ``POST /generate``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from .audio_utils import SAMPLE_RATE, encode_audio_base64
from .generator import generate_kit_light

# Order returned to the web UI (matches generator / solo flow).
API_SOUND_KEYS: tuple[str, ...] = (
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


def encode_paths_to_sounds(paths: dict[str, Path]) -> dict[str, str]:
    sounds: dict[str, str] = {}
    for key in API_SOUND_KEYS:
        path = paths[key]
        data, sr = sf.read(str(path), always_2d=False)
        if int(sr) != int(SAMPLE_RATE):
            raise ValueError(f"Unexpected sample rate {sr} for {key}, expected {SAMPLE_RATE}")
        arr = np.asarray(data, dtype=np.float64)
        sounds[key] = encode_audio_base64(arr, sr=int(sr))
    return sounds


def kit_to_base64_payload(seed: int, spice: float, output_dir: Path) -> dict[str, Any]:
    """Generate under ``output_dir`` and return ``{seed, sounds}`` (light: random samples, no DSP)."""
    paths = generate_kit_light(seed=seed, spice=spice, output_dir=output_dir)
    sounds = encode_paths_to_sounds(paths)
    return {"seed": seed, "sounds": sounds}

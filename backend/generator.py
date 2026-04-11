"""
Build a trap-oriented drum kit from ``dataset/<category>/`` using a structured pipeline.

Processing order (per slot): load → optional layer → (perc reverse) → pitch → filter →
transient (snare) → soft saturation → optional extra distortion (perc/synth) → optional
reverb tail → optional stereo widen → trim to 1 s → normalize → quality check.

``spice`` scales how wide pitch/saturation ranges are and how often optional steps run;
subtle moves keep one-shots usable in trap, while higher spice explores more character.
"""

from __future__ import annotations

import random
from pathlib import Path

import numpy as np

from .audio_utils import (
    SAMPLE_RATE,
    apply_fade_out,
    apply_distortion_extra,
    apply_filter,
    fit_to_target_length,
    apply_pitch_shift,
    apply_reverb_tail_if_needed,
    apply_saturation,
    apply_time_stretch_optional,
    layer_samples,
    load_audio_file,
    list_category_wavs,
    load_random_sample,
    load_wav_light_mono,
    load_wav_light_stereo,
    normalize_audio,
    quality_check,
    save_audio,
    stereo_widen,
    transient_boost,
)
from .kit_config import DEFAULT_CONFIG_PATH, load_kit_config, resolve_sound
from .kit_rng import pick_index

# Project root is parent of ``backend/`` (``dataset/`` and ``generated/`` live there).
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATASET_ROOT = _PROJECT_ROOT / "dataset"
OUTPUT_DIR = _PROJECT_ROOT / "generated"

# Dataset folder (per spec) → logical name used in processing
CATEGORY_FOLDERS: dict[str, str] = {
    "snare": "snares",
    "clap": "claps",
    "hihat": "hihats",
    "open_hat": "openhats",
    "808": "808s",
    "perc": "percs",
    "fx": "fx",
    "vox": "Vox",
    "kick": "kicks",
}


def _dataset_dir(logical: str) -> Path:
    """Resolve dataset folder. Open hats live in ``openhats/``; ``open_hihats/`` is only a fallback."""
    name = CATEGORY_FOLDERS[logical]
    p = DATASET_ROOT / name
    if p.is_dir():
        return p
    if logical == "open_hat" and (DATASET_ROOT / "open_hihats").is_dir():
        return DATASET_ROOT / "open_hihats"
    return p

EXPECTED_KIT_WAVS = frozenset(
    {
        "snare.wav",
        "clap.wav",
        "hihat.wav",
        "open_hat.wav",
        "808.wav",
        "perc.wav",
        "fx.wav",
        "vox.wav",
        "synth1.wav",
        "synth2.wav",
        "synth3.wav",
        "kick.wav",
    }
)

MAX_GENERATION_ATTEMPTS = 24


def _layer_prob(spice: float) -> float:
    return float(np.clip(0.15 + float(spice) * 0.5, 0.0, 1.0))


def _maybe_layer_snare(
    primary: np.ndarray,
    rng: np.random.Generator,
    spice: float,
) -> np.ndarray:
    if rng.random() >= _layer_prob(spice):
        return primary
    d = DATASET_ROOT / "claps"
    if not d.is_dir():
        return primary
    try:
        other, _ = load_random_sample(d, rng)
    except ValueError:
        return primary
    return layer_samples(primary, other, rng)


def _maybe_layer_clap(
    primary: np.ndarray,
    rng: np.random.Generator,
    spice: float,
) -> np.ndarray:
    if rng.random() >= _layer_prob(spice):
        return primary
    use_snare = rng.random() < 0.5
    folder = "snares" if use_snare else "percs"
    d = DATASET_ROOT / folder
    if not d.is_dir():
        return primary
    try:
        other, _ = load_random_sample(d, rng)
    except ValueError:
        return primary
    return layer_samples(primary, other, rng)


def _maybe_layer_hihat(
    primary: np.ndarray,
    rng: np.random.Generator,
    spice: float,
) -> np.ndarray:
    if rng.random() >= _layer_prob(spice):
        return primary
    d = DATASET_ROOT / "hihats"
    if not d.is_dir():
        return primary
    try:
        other, _ = load_random_sample(d, rng)
    except ValueError:
        return primary
    return layer_samples(primary, other, rng)


def _maybe_layer_perc(
    primary: np.ndarray,
    rng: np.random.Generator,
    spice: float,
) -> np.ndarray:
    if rng.random() >= _layer_prob(spice) * 0.85:
        return primary
    d = DATASET_ROOT / "synths"
    if not d.is_dir():
        return primary
    try:
        other, _ = load_random_sample(d, rng)
    except ValueError:
        return primary
    return layer_samples(primary, other, rng)


def _maybe_layer_fx(
    primary: np.ndarray,
    rng: np.random.Generator,
    spice: float,
) -> np.ndarray:
    if rng.random() >= _layer_prob(spice):
        return primary
    d = DATASET_ROOT / "fx" if rng.random() < 0.55 else DATASET_ROOT / "synths"
    if not d.is_dir():
        return primary
    try:
        other, _ = load_random_sample(d, rng)
    except ValueError:
        return primary
    return layer_samples(primary, other, rng)


def _maybe_layer_vox(
    primary: np.ndarray,
    rng: np.random.Generator,
    spice: float,
) -> np.ndarray:
    if rng.random() >= _layer_prob(spice):
        return primary
    d = DATASET_ROOT / "Vox" if rng.random() < 0.6 else DATASET_ROOT / "synths"
    if not d.is_dir():
        return primary
    try:
        other, _ = load_random_sample(d, rng)
    except ValueError:
        return primary
    return layer_samples(primary, other, rng)


def _process_common_tail(
    y: np.ndarray,
    logical: str,
    spice: float,
    rng: np.random.Generator,
    *,
    stereo_allowed: bool,
) -> np.ndarray:
    """Reverb + optional stereo widening; input mono."""
    x = apply_reverb_tail_if_needed(y, SAMPLE_RATE, spice, rng, logical)
    if stereo_allowed and rng.random() < 0.35 + 0.45 * float(np.clip(spice, 0.0, 1.0)):
        return stereo_widen(x, spice, rng)
    return x


def generate_slot(
    logical: str,
    spice: float,
    rng: np.random.Generator,
    normalize_peak: float,
    fade_out_amt: float,
    target_samples: int,
    source_path: Path | None = None,
) -> np.ndarray:
    """
    One kit element. ``spice`` widens pitch/saturation ranges (see ``audio_utils``) and
    raises layering / effect probabilities—low values keep trap-friendly punch and clarity.

    Chains (after load + optional layer):
    - **808**: optional pitch (less likely at low spice) → lowpass → tanh → mono.
    - **Kick** (``dataset/kicks/``): optional pitch like 808 → band EQ → attack boost → tanh → mono.
    - **Snare**: optional snare+clap layer → pitch → bandpass → attack boost → tanh → optional tail.
    - **Clap**: optional snare/perc layer → pitch → bandpass → tanh → optional tail + stereo.
    - **Hihat**: optional double-hat layer → pitch → bright HP/LP → tanh → optional stereo.
    - **Open hat**: pitch → slightly lower HP than closed → tanh → tail + often stereo.
    - **Perc**: optional synth layer → optional reverse → pitch → bandpass → tanh → optional extra
      distortion → optional stereo.
    - **FX**: optional layer (fx or synth) → optional pitch/time stretch → wide bandpass → tanh →
      optional distortion → optional tail + stereo.
    - **Vox** (``dataset/Vox/``): optional layer (vox or synth) → optional reverse/time stretch →
      pitch → vocal-focused EQ → tanh → optional distortion → optional tail + stereo.

    Subtle EQ/saturation keeps samples usable as one-shots; spice expands *how far* each step can go,
    not random reordering of the pipeline.
    """
    s = float(np.clip(spice, 0.0, 1.0))
    if source_path is None:
        d = _dataset_dir(logical)
        y, sr = load_random_sample(d, rng)
    else:
        y, sr = load_audio_file(source_path)
    assert sr == SAMPLE_RATE

    # --- Step 2: optional layering (category rules) ---
    if logical == "snare":
        y = _maybe_layer_snare(y, rng, s)
    elif logical == "clap":
        y = _maybe_layer_clap(y, rng, s)
    elif logical == "hihat":
        y = _maybe_layer_hihat(y, rng, s)
    elif logical == "perc":
        y = _maybe_layer_perc(y, rng, s)
    elif logical == "fx":
        y = _maybe_layer_fx(y, rng, s)
    elif logical == "vox":
        y = _maybe_layer_vox(y, rng, s)

    # Perc: optional reverse (experimental; more likely when spice is high)
    if logical == "perc" and rng.random() < 0.08 + 0.42 * s:
        y = y[::-1].copy()

    # FX: optional reverse before pitch (risers / reverses)
    if logical == "fx" and rng.random() < 0.08 + 0.35 * s:
        y = y[::-1].copy()

    # Vox: rare reverse (chops / memes)
    if logical == "vox" and rng.random() < 0.06 + 0.28 * s:
        y = y[::-1].copy()

    # Synth: optional time stretch before pitch
    if logical == "synth":
        y = apply_time_stretch_optional(y, s, rng)

    if logical in ("fx", "vox"):
        y = apply_time_stretch_optional(y, s, rng)

    # --- Step 3: pitch (808 / kick often cleaner with no shift—probability scales with spice) ---
    if logical in ("808", "kick"):
        y = apply_pitch_shift(y, s, sr, rng, always=False)
    else:
        y = apply_pitch_shift(y, s, sr, rng, always=True)

    # --- Step 4: category filter ---
    y = apply_filter(y, logical, s, sr, rng)

    # Snare / kick: transient emphasis after EQ so filters don't dull the click
    if logical in ("snare", "kick"):
        y = transient_boost(y, s, rng)

    # --- Step 5: saturation (soft clip) ---
    y = apply_saturation(y, s)

    if logical in ("perc", "synth", "fx", "vox"):
        y = apply_distortion_extra(y, s, rng)

    # --- Tails / imaging ---
    if logical == "snare":
        y = apply_reverb_tail_if_needed(y, SAMPLE_RATE, s, rng, logical)
    elif logical == "clap":
        y = _process_common_tail(y, logical, s, rng, stereo_allowed=True)
    elif logical == "hihat":
        if rng.random() < 0.4 + 0.45 * s:
            y = stereo_widen(y, s, rng)
        else:
            y = y.astype(np.float64, copy=False)
    elif logical == "open_hat":
        y = apply_reverb_tail_if_needed(y, SAMPLE_RATE, s, rng, logical)
        if rng.random() < 0.55 + 0.25 * s:
            y = stereo_widen(y, s, rng)
        else:
            y = y.astype(np.float64, copy=False)
    elif logical == "perc":
        if rng.random() < 0.3 + 0.45 * s:
            y = stereo_widen(y, s, rng)
        else:
            y = y.astype(np.float64, copy=False)
    elif logical == "fx":
        y = apply_reverb_tail_if_needed(y, SAMPLE_RATE, s, rng, logical)
        if rng.random() < 0.35 + 0.45 * s:
            y = stereo_widen(y, s, rng)
        else:
            y = y.astype(np.float64, copy=False)
    elif logical == "vox":
        y = apply_reverb_tail_if_needed(y, SAMPLE_RATE, s, rng, logical)
        if rng.random() < 0.32 + 0.42 * s:
            y = stereo_widen(y, s, rng)
        else:
            y = y.astype(np.float64, copy=False)
    elif logical in ("808", "kick"):
        y = y.astype(np.float64, copy=False)
    elif logical == "synth":
        y = y.astype(np.float64, copy=False)

    y = fit_to_target_length(y, target_samples, rng, logical)
    y = apply_fade_out(y, fade_out_amt)
    y = normalize_audio(y, peak=normalize_peak)
    return y


def _generate_with_retries(
    logical: str,
    spice: float,
    base_rng: np.random.Generator,
    normalize_peak: float,
    fade_out_amt: float,
    target_samples: int,
    attempt_offset: int,
) -> np.ndarray:
    d = _dataset_dir(logical)
    sources = list_category_wavs(d)
    if not sources:
        raise ValueError(f"No .wav files in {d}.")

    # If one source fails MAX_GENERATION_ATTEMPTS, switch source and try again.
    start = int(base_rng.integers(0, len(sources)))
    ordered = sources[start:] + sources[:start]
    max_source_swaps = max(1, min(len(ordered), 8))

    for swap_idx, source_path in enumerate(ordered[:max_source_swaps]):
        for k in range(MAX_GENERATION_ATTEMPTS):
            sub = np.random.default_rng(
                int(base_rng.integers(0, 2**31))
                + attempt_offset * 7919
                + swap_idx * 13007
                + k * 104729
            )
            y = generate_slot(
                logical,
                spice,
                sub,
                normalize_peak,
                fade_out_amt,
                target_samples,
                source_path=source_path,
            )
            if quality_check(y, logical, SAMPLE_RATE):
                return y
    raise RuntimeError(
        f"Failed quality check for {logical} after "
        f"{MAX_GENERATION_ATTEMPTS} attempts across {max_source_swaps} source sample(s)"
    )


def _cleanup_stale_outputs(out_dir: Path) -> None:
    out_dir = Path(out_dir)
    if not out_dir.is_dir():
        return
    for p in out_dir.glob("*.wav"):
        if p.name not in EXPECTED_KIT_WAVS:
            p.unlink(missing_ok=True)


def generate_kit(
    seed: int,
    spice: float = 0.3,
    config_path: Path | None = None,
    output_dir: Path | None = None,
) -> dict[str, Path]:
    """
    Generate kit ``*.wav`` files under ``output_dir`` (default: project ``generated/``).

    ``spice`` in ``[0, 1]`` scales experimental ranges.
    ``synths/`` produces ``synth1.wav``, ``synth2.wav``, and short ``synth3.wav``.
    """
    random.seed(seed)
    rng = np.random.default_rng(seed)
    s = float(np.clip(spice, 0.0, 1.0))

    cfg = load_kit_config(config_path or DEFAULT_CONFIG_PATH)
    out_dir = Path(output_dir) if output_dir is not None else OUTPUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    _cleanup_stale_outputs(out_dir)

    out: dict[str, Path] = {}
    offset = 0

    static_order = ["snare", "clap", "hihat", "open_hat", "808", "perc", "fx", "vox", "kick"]
    for logical in static_order:
        p = resolve_sound(logical, cfg)
        y = _generate_with_retries(
            logical,
            s,
            rng,
            p.normalize_peak,
            p.fade_out_amt,
            p.target_samples,
            offset,
        )
        offset += 1
        path = out_dir / f"{logical}.wav"
        save_audio(y, path, SAMPLE_RATE)
        out[logical] = path.resolve()

    # --- Synths ---
    synth_dir = DATASET_ROOT / "synths"
    if not synth_dir.is_dir():
        raise FileNotFoundError(f"Category folder not found: {synth_dir}")

    wavs = sorted(p for p in synth_dir.iterdir() if p.is_file() and p.suffix.lower() == ".wav")
    if not wavs:
        raise ValueError(f"No .wav files in {synth_dir}.")

    if len(wavs) >= 3:
        idx = rng.choice(len(wavs), size=3, replace=False)
        chosen = [wavs[int(i)] for i in idx]
    elif len(wavs) == 2:
        idx = rng.choice(2, size=3, replace=True)
        chosen = [wavs[int(i)] for i in idx]
    else:
        chosen = [wavs[0], wavs[0], wavs[0]]

    for i, wav_path in enumerate(chosen, start=1):
        stem = f"synth{i}"
        p = resolve_sound(stem, cfg)
        synth_sources = [p for p in wavs if p != wav_path] or wavs
        synth_sources = [wav_path] + synth_sources
        max_source_swaps = max(1, min(len(synth_sources), 8))
        accepted = False
        for swap_idx, source_path in enumerate(synth_sources[:max_source_swaps]):
            for k in range(MAX_GENERATION_ATTEMPTS):
                sub = np.random.default_rng(
                    int(rng.integers(0, 2**31))
                    + offset * 9973
                    + swap_idx * 17011
                    + k * 131071
                )
                y, sr = load_audio_file(source_path)
                assert sr == SAMPLE_RATE
                y = apply_time_stretch_optional(y, s, sub)
                y = apply_pitch_shift(y, s, sr, sub, always=True)
                y = apply_filter(y, "synth", s, sr, sub)
                y = apply_saturation(y, s)
                y = apply_distortion_extra(y, s, sub)
                y = fit_to_target_length(y, p.target_samples, sub, "synth")
                y = apply_fade_out(y, p.fade_out_amt)
                y = normalize_audio(y, peak=p.normalize_peak)
                if quality_check(y, "synth", SAMPLE_RATE):
                    path = out_dir / f"{stem}.wav"
                    save_audio(y, path, SAMPLE_RATE)
                    out[stem] = path.resolve()
                    offset += 1
                    accepted = True
                    break
            if accepted:
                break
        if not accepted:
            raise RuntimeError(
                f"Failed quality check for {stem} after "
                f"{MAX_GENERATION_ATTEMPTS} attempts across {max_source_swaps} source sample(s)"
            )

    return out


# Order must match ``kit_payload.API_SOUND_KEYS`` (solo / multiplayer / UI).
_LIGHT_KIT_KEYS: tuple[str, ...] = (
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


def generate_light_stem(
    seed: int, slot_index: int, logical: str, out_dir: Path, spice: float = 0.3
) -> Path:
    """
    Pick one deterministic ``.wav`` for the slot (portable RNG + ``spice``), resample to 44.1 kHz, save.
    Stereo sources stay stereo; mono stays mono. No DSP chain.
    """
    s = float(np.clip(spice, 0.0, 1.0))
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if logical.startswith("synth"):
        synth_dir = DATASET_ROOT / "synths"
        if not synth_dir.is_dir():
            raise FileNotFoundError(f"Category folder not found: {synth_dir}")
        wavs = sorted(p for p in synth_dir.iterdir() if p.is_file() and p.suffix.lower() == ".wav")
        if not wavs:
            raise ValueError(f"No .wav files in {synth_dir}.")
        path_pick = wavs[pick_index(seed, slot_index, s, len(wavs))]
        y = load_wav_light_stereo(path_pick)
    else:
        d = _dataset_dir(logical)
        wavs = list_category_wavs(d)
        path_pick = wavs[pick_index(seed, slot_index, s, len(wavs))]
        y = load_wav_light_stereo(path_pick)

    dest = out_dir / f"{logical}.wav"
    save_audio(y, dest, SAMPLE_RATE)
    return dest.resolve()


def generate_kit_light(
    seed: int,
    spice: float = 0.3,
    output_dir: Path | None = None,
) -> dict[str, Path]:
    """
    Build a full kit by sampling the dataset only (no DSP chain).
    ``spice`` feeds :func:`pick_index` so kit selection varies with heat level.
    """
    s = float(np.clip(spice, 0.0, 1.0))
    out_dir = Path(output_dir) if output_dir is not None else OUTPUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    _cleanup_stale_outputs(out_dir)
    out: dict[str, Path] = {}
    for i, key in enumerate(_LIGHT_KIT_KEYS):
        out[key] = generate_light_stem(seed, i, key, out_dir, spice=s)
    return out

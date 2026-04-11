"""
Audio helpers for the trap-oriented drum kit generator.

Dataset folders (under ``dataset/``) include ``snares``, ``claps``, ``hihats``, ``openhats``,
``808s``, ``kicks``, ``percs``, ``fx``, ``Vox``, ``synths``.

Spice scales mutation *ranges* (not a single on/off): at 0.0, shifts and saturation stay
subtle so one-shots stay mix-ready; at 1.0, the same parameters allow wider pitch moves,
more saturation drive, and more optional effects—still through a structured chain so
results stay musically plausible rather than fully random chaos.

Output format: 44100 Hz, mono unless stereo widening is applied (then stereo WAV).
Target duration is per-sound from config (``duration_s * duration_multiplier``).
"""

from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy import signal

# --- Global audio format ---
SAMPLE_RATE = 44100


def _list_wav_files(category_dir: Path) -> list[Path]:
    paths: list[Path] = []
    for p in category_dir.iterdir():
        if p.is_file() and p.suffix.lower() == ".wav":
            paths.append(p)
    return sorted(paths)


def list_category_wavs(category_dir: Path) -> list[Path]:
    """List .wav sources for a category directory (sorted)."""
    if not category_dir.is_dir():
        raise FileNotFoundError(f"Category folder not found: {category_dir}")
    wavs = _list_wav_files(category_dir)
    if not wavs:
        raise ValueError(f"No .wav files in {category_dir}. Add at least one sample.")
    return wavs


def load_random_sample(category_dir: Path, rng: np.random.Generator) -> tuple[np.ndarray, int]:
    """
    Pick one random ``.wav`` from ``category_dir``, load as mono at ``SAMPLE_RATE``.

    Returns ``(y, sr)`` where ``y`` is 1-D float64 and ``sr`` is ``SAMPLE_RATE``.
    """
    if not category_dir.is_dir():
        raise FileNotFoundError(f"Category folder not found: {category_dir}")

    wavs = list_category_wavs(category_dir)

    path = wavs[int(rng.integers(0, len(wavs)))]
    y, sr = librosa.load(str(path), sr=SAMPLE_RATE, mono=True)
    return np.asarray(y, dtype=np.float64), int(sr)


def load_audio_file(path: Path) -> tuple[np.ndarray, int]:
    """Load a specific ``.wav`` as mono at ``SAMPLE_RATE``."""
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"Audio file not found: {path}")
    y, sr = librosa.load(str(path), sr=SAMPLE_RATE, mono=True)
    return np.asarray(y, dtype=np.float64), int(sr)


def load_wav_light_mono(path: Path) -> np.ndarray:
    """
    Load a ``.wav`` as mono float64 at ``SAMPLE_RATE`` using soundfile + linear resample.
    Much faster and lighter than ``librosa.load`` — use for light kit sampling only.
    """
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"Audio file not found: {path}")
    data, sr = sf.read(str(path), always_2d=True)
    if data.ndim == 2 and data.shape[1] > 1:
        y = np.mean(data.astype(np.float64, copy=False), axis=1)
    else:
        y = np.asarray(data, dtype=np.float64).reshape(-1)
    sr = int(sr)
    if sr == SAMPLE_RATE:
        return y
    n_src = len(y)
    if n_src == 0:
        return y
    duration = n_src / float(sr)
    n_new = max(1, int(round(duration * SAMPLE_RATE)))
    t_old = np.arange(n_src, dtype=np.float64) / float(sr)
    t_new = np.linspace(0.0, duration, n_new, endpoint=False)
    return np.interp(t_new, t_old, y).astype(np.float64)


def load_wav_light_stereo(path: Path) -> np.ndarray:
    """
    Load ``.wav`` at ``SAMPLE_RATE`` using soundfile + linear resample per channel.
    Returns shape ``(n,)`` for mono or ``(n, 2)`` for stereo (no downmix).
    """
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"Audio file not found: {path}")
    data, sr = sf.read(str(path), always_2d=True)
    x = np.asarray(data, dtype=np.float64)
    sr = int(sr)
    n_src, ch = int(x.shape[0]), int(x.shape[1])
    if sr == SAMPLE_RATE:
        y = x
    else:
        if n_src == 0:
            y = x
        else:
            duration = n_src / float(sr)
            n_new = max(1, int(round(duration * SAMPLE_RATE)))
            t_old = np.arange(n_src, dtype=np.float64) / float(sr)
            t_new = np.linspace(0.0, duration, n_new, endpoint=False)
            y = np.zeros((n_new, ch), dtype=np.float64)
            for c in range(ch):
                y[:, c] = np.interp(t_new, t_old, x[:, c])
    if ch == 1:
        return np.asarray(y[:, 0], dtype=np.float64)
    return y.astype(np.float64, copy=False)


def _to_mono(y: np.ndarray) -> np.ndarray:
    x = np.asarray(y, dtype=np.float64)
    if x.ndim == 2:
        return np.mean(x, axis=-1)
    return x.reshape(-1)


def align_length(a: np.ndarray, b: np.ndarray, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """Trim/pad two mono buffers to the same length."""
    a = _to_mono(a)
    b = _to_mono(b)
    n = max(a.shape[0], b.shape[0])
    if a.shape[0] > n:
        s = int(rng.integers(0, a.shape[0] - n + 1))
        a = a[s : s + n].copy()
    elif a.shape[0] < n:
        a = np.pad(a, (0, n - a.shape[0]))
    if b.shape[0] > n:
        s = int(rng.integers(0, b.shape[0] - n + 1))
        b = b[s : s + n].copy()
    elif b.shape[0] < n:
        b = np.pad(b, (0, n - b.shape[0]))
    return a.astype(np.float64), b.astype(np.float64)


def layer_samples(audio1: np.ndarray, audio2: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """
    Mix two buffers with a random primary/secondary balance (keeps transients from both
    audible without a fixed 50/50 blend).
    """
    a, b = align_length(audio1, audio2, rng)
    w = float(rng.uniform(0.55, 0.88))  # weight on primary
    out = w * a + (1.0 - w) * b
    return out.astype(np.float64, copy=False)


def semitone_range_half(spice: float) -> float:
    """Half-width in semitones: ±2 at spice 0, ±6 at spice 1 (linear in spice)."""
    s = float(np.clip(spice, 0.0, 1.0))
    return 2.0 + s * 4.0


def apply_pitch_shift(
    audio: np.ndarray,
    spice: float,
    sr: int,
    rng: np.random.Generator,
    *,
    always: bool = True,
) -> np.ndarray:
    """
    Subtle pitch shift; range scales with spice (see ``semitone_range_half``).
    """
    x = _to_mono(audio).astype(np.float64, copy=True)
    orig_len = x.shape[0]
    half = semitone_range_half(spice)
    if not always and rng.random() > 0.65 + 0.25 * float(np.clip(spice, 0.0, 1.0)):
        return x
    n_steps = float(rng.uniform(-half, half))
    if abs(n_steps) < 1e-6:
        return x
    # librosa STFT wants enough samples for default n_fft.
    min_len = 2048
    if orig_len < min_len:
        x = np.pad(x, (0, min_len - orig_len))
    y = librosa.effects.pitch_shift(x, sr=sr, n_steps=n_steps)
    y = np.asarray(y, dtype=np.float64)
    return y[:orig_len]


def _butter_filter(
    y: np.ndarray,
    sr: int,
    kind: str,
    cutoff_hz: float,
    order: int = 4,
) -> np.ndarray:
    x = _to_mono(y).astype(np.float64, copy=False)
    nyq = sr / 2.0
    wn = min(0.99, max(0.01, cutoff_hz / nyq))
    sos = signal.butter(order, wn, btype=kind, output="sos")
    y = signal.sosfiltfilt(sos, x)
    return np.nan_to_num(y, nan=0.0, posinf=0.0, neginf=0.0)


def apply_filter(
    audio: np.ndarray,
    category: str,
    spice: float,
    sr: int,
    rng: np.random.Generator,
) -> np.ndarray:
    """
    Category-specific EQ: 808 lowpass; hats/open bright; snare/clap mild band emphasis;
    perc/synth/fx/vox light shaping. Cutoffs move slightly with spice for variation without
    breaking the role of each sound in a trap kit.
    """
    s = float(np.clip(spice, 0.0, 1.0))
    x = _to_mono(audio).astype(np.float64, copy=True)
    cat = category.lower()

    if cat == "808":
        # Keep sub weight; roll off highs more when spice is low (tighter 808).
        cutoff = 3200.0 + s * 2200.0 + float(rng.uniform(-200.0, 200.0))
        x = _butter_filter(x, sr, "lowpass", cutoff)

    elif cat == "kick":
        # Sub + beater; keep lows, tame extreme subs and harsh top.
        hp = 35.0 + s * 90.0 + float(rng.uniform(-15.0, 15.0))
        lp = 12000.0 + s * 2500.0 + float(rng.uniform(-400.0, 400.0))
        x = _butter_filter(x, sr, "highpass", hp)
        x = _butter_filter(x, sr, "lowpass", lp)

    elif cat == "hihat":
        hp = 5500.0 + s * 1500.0 + float(rng.uniform(-400.0, 400.0))
        x = _butter_filter(x, sr, "highpass", hp)
        lp = min(16000.0, 12000.0 + s * 2000.0)
        x = _butter_filter(x, sr, "lowpass", lp)

    elif cat == "open_hat":
        # Slightly lower highpass than closed hat so the open tail still has air.
        hp = 4500.0 + s * 1200.0 + float(rng.uniform(-350.0, 350.0))
        x = _butter_filter(x, sr, "highpass", hp)
        lp = min(16000.0, 12000.0 + s * 2000.0)
        x = _butter_filter(x, sr, "lowpass", lp)

    elif cat == "snare":
        # Mid presence without harsh treble wash.
        hp = 180.0 + s * 120.0
        lp = 11000.0 + s * 2000.0
        x = _butter_filter(x, sr, "highpass", hp)
        x = _butter_filter(x, sr, "lowpass", lp)

    elif cat == "clap":
        hp = 400.0 + s * 300.0
        lp = 14000.0 + s * 1500.0
        x = _butter_filter(x, sr, "highpass", hp)
        x = _butter_filter(x, sr, "lowpass", lp)

    elif cat == "perc":
        hp = 80.0 + s * 200.0
        lp = 12000.0 + s * 2500.0
        x = _butter_filter(x, sr, "highpass", hp)
        x = _butter_filter(x, sr, "lowpass", lp)

    elif cat == "synth":
        hp = 60.0 + s * 100.0
        lp = 16000.0
        x = _butter_filter(x, sr, "highpass", hp)
        x = _butter_filter(x, sr, "lowpass", lp)

    elif cat == "fx":
        # Risers, impacts, sweeps: full-band with light mud cut.
        hp = 35.0 + s * 180.0 + float(rng.uniform(-30.0, 30.0))
        lp = 16000.0
        x = _butter_filter(x, sr, "highpass", hp)
        x = _butter_filter(x, sr, "lowpass", lp)

    elif cat == "vox":
        # Vocal one-shots: mid-forward, tame extreme subs and air.
        hp = 180.0 + s * 250.0 + float(rng.uniform(-40.0, 40.0))
        lp = 12500.0 + s * 2000.0
        x = _butter_filter(x, sr, "highpass", hp)
        x = _butter_filter(x, sr, "lowpass", lp)

    return x


def saturation_gain(spice: float) -> float:
    """Maps spice to input gain before ``tanh`` (soft clipping)."""
    s = float(np.clip(spice, 0.0, 1.0))
    return 1.0 + 0.05 + s * 0.4


def apply_saturation(audio: np.ndarray, spice: float) -> np.ndarray:
    """Soft saturation: ``tanh(audio * gain)``; gain scales with spice."""
    x = _to_mono(audio).astype(np.float64, copy=True)
    g = saturation_gain(spice)
    return np.tanh(x * g)


def apply_distortion_extra(audio: np.ndarray, spice: float, rng: np.random.Generator) -> np.ndarray:
    """Optional second, slightly harder stage for perc/synth/fx/vox when roll succeeds."""
    x = _to_mono(audio).astype(np.float64, copy=True)
    if rng.random() > 0.25 + 0.55 * float(np.clip(spice, 0.0, 1.0)):
        return x
    drive = 1.15 + float(rng.uniform(0.0, 0.35)) * (1.0 + spice)
    return np.tanh(x * drive)


def transient_boost(audio: np.ndarray, spice: float, rng: np.random.Generator) -> np.ndarray:
    """
    Emphasize the first ~1k samples for snare/clap attack so layered sources still punch
    in a trap mix.
    """
    x = _to_mono(audio).astype(np.float64, copy=True)
    n = min(1000, x.shape[0])
    if n <= 0:
        return x
    amt = 1.04 + float(rng.uniform(0.0, 0.06)) + spice * 0.12
    x[:n] *= amt
    return x


def stereo_widen(audio: np.ndarray, spice: float, rng: np.random.Generator) -> np.ndarray:
    """
    Mono → stereo with small L/R gain offset; width scales mildly with spice.
    Used for hats, open hats, claps, percs when the roll passes.
    """
    x = _to_mono(audio).astype(np.float64, copy=True)
    w = (0.02 + float(rng.uniform(0.0, 0.04))) * (1.0 + 0.5 * float(np.clip(spice, 0.0, 1.0)))
    if rng.random() < 0.5:
        w = -w
    left = x * (1.0 + w)
    right = x * (1.0 - w)
    return np.stack([left, right], axis=-1)


def _simple_reverb_tail_mono(
    y: np.ndarray,
    sr: int,
    rng: np.random.Generator,
    spice: float,
    wet: float,
) -> np.ndarray:
    """Short multi-tap decay—enough tail for texture, not a hall IR."""
    x = _to_mono(y).astype(np.float64, copy=True)
    delays = [int(0.022 * sr), int(0.031 * sr), int(0.043 * sr)]
    out = np.zeros_like(x)
    g = 0.42 + 0.25 * float(np.clip(spice, 0.0, 1.0))
    for i, d in enumerate(delays):
        if d >= x.shape[0]:
            continue
        shifted = np.pad(x, (d, 0))[: x.shape[0]]
        out += shifted * (g ** (i + 1)) * float(rng.uniform(0.85, 1.15))
    mix = wet * (0.08 + 0.12 * float(np.clip(spice, 0.0, 1.0)))
    return (1.0 - mix) * x + mix * out


def apply_reverb_tail_if_needed(
    audio: np.ndarray,
    sr: int,
    spice: float,
    rng: np.random.Generator,
    category: str,
) -> np.ndarray:
    """Small tail for snare, clap, open hat—probability increases with spice."""
    s = float(np.clip(spice, 0.0, 1.0))
    p = {"snare": 0.2, "clap": 0.25, "open_hat": 0.45, "fx": 0.32, "vox": 0.3}.get(
        category.lower(), 0.0
    )
    if p <= 0 or rng.random() > p + 0.35 * s:
        return _to_mono(audio).astype(np.float64, copy=True)
    wet = float(rng.uniform(0.35, 0.85))
    return _simple_reverb_tail_mono(audio, sr, rng, spice, wet)


def _tail_pad_mono(x: np.ndarray, pad_len: int) -> np.ndarray:
    """Pad a natural decay tail instead of hard zero-padding."""
    if pad_len <= 0:
        return x
    if x.size == 0:
        return np.zeros(pad_len, dtype=np.float64)
    last = float(x[-1])
    t = np.linspace(0.0, 1.0, pad_len, endpoint=True)
    tail = last * np.exp(-7.0 * t)
    return np.concatenate([x, tail], axis=0)


def fit_to_target_length(
    y: np.ndarray,
    target_samples: int,
    rng: np.random.Generator,
    category: str,
) -> np.ndarray:
    """
    Fit audio to ``target_samples``.

    Strategy:
    - if longer: random crop
    - if shorter: mild stretch for sustained categories, then decay-tail pad
    """
    target = max(1, int(target_samples))
    x = np.asarray(y, dtype=np.float64, copy=True)
    cat = category.lower()

    def _fit_channel(ch: np.ndarray) -> np.ndarray:
        z = ch.reshape(-1).astype(np.float64, copy=True)
        n = z.shape[0]
        if n > target:
            start = int(rng.integers(0, n - target + 1))
            return z[start : start + target].copy()

        if n < target and n > 0:
            ratio = target / n
            sustained = cat in ("808", "open_hat", "fx", "vox", "synth", "synth1", "synth2", "synth3")
            if sustained and ratio <= 1.35:
                # Small stretch sounds natural for sustained sounds.
                rate = float(np.clip(1.0 / ratio, 0.75, 1.15))
                z2 = z
                if z2.shape[0] < 2048:
                    z2 = np.pad(z2, (0, 2048 - z2.shape[0]))
                z = np.asarray(librosa.effects.time_stretch(z2, rate=rate), dtype=np.float64)
                if z.shape[0] > target:
                    z = z[:target]
                n = z.shape[0]

            if n < target:
                z = _tail_pad_mono(z, target - n)
            elif n > target:
                z = z[:target]
        return z

    if x.ndim == 2:
        left = _fit_channel(x[:, 0])
        right = _fit_channel(x[:, 1] if x.shape[1] > 1 else x[:, 0])
        m = min(left.shape[0], right.shape[0], target)
        x = np.stack([left[:m], right[:m]], axis=-1)
        return x
    return _fit_channel(x)


def apply_time_stretch_optional(
    audio: np.ndarray,
    spice: float,
    rng: np.random.Generator,
) -> np.ndarray:
    """Synth-only: slight time stretch, more likely at higher spice."""
    x = _to_mono(audio).astype(np.float64, copy=True)
    orig_len = x.shape[0]
    s = float(np.clip(spice, 0.0, 1.0))
    if rng.random() > 0.35 + 0.45 * s:
        return x
    rate = float(rng.uniform(0.92, 1.08)) + s * float(rng.uniform(-0.04, 0.04))
    rate = float(np.clip(rate, 0.85, 1.15))
    min_len = 2048
    if orig_len < min_len:
        x = np.pad(x, (0, min_len - orig_len))
    y = librosa.effects.time_stretch(x, rate=rate)
    y = np.asarray(y, dtype=np.float64)
    if y.shape[0] != orig_len and orig_len > 0:
        y = signal.resample(y, orig_len)
    return y[:orig_len]


def normalize_audio(y: np.ndarray, peak: float = 0.99) -> np.ndarray:
    """Peak-normalize; supports mono (N,) or stereo (N,2)."""
    x = np.asarray(y, dtype=np.float64, copy=True)
    x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    m = float(np.max(np.abs(x)))
    p = float(peak)
    if np.isfinite(m) and m > 0:
        x *= p / m
    return x


def apply_fade_out(audio: np.ndarray, fade_out_amt: float) -> np.ndarray:
    """
    Apply a linear fade-out envelope.

    ``fade_out_amt`` in [0,1]:
    - 0.0: no fade
    - 0.5: fade starts halfway through
    - 1.0: fade starts at sample 0
    """
    amt = float(np.clip(fade_out_amt, 0.0, 1.0))
    x = np.asarray(audio, dtype=np.float64, copy=True)
    if amt <= 0.0:
        return x

    n = x.shape[0]
    if n <= 1:
        return x

    fade_start = int(round((1.0 - amt) * (n - 1)))
    fade_start = max(0, min(n - 1, fade_start))
    tail_len = n - fade_start
    if tail_len <= 1:
        return x

    env = np.ones(n, dtype=np.float64)
    env[fade_start:] = np.linspace(1.0, 0.0, tail_len, endpoint=True)
    if x.ndim == 2:
        return x * env[:, None]
    return x * env


def rms_energy(y: np.ndarray) -> float:
    x = np.asarray(y, dtype=np.float64)
    if x.ndim == 2:
        x = np.mean(x, axis=-1)
    if x.size == 0:
        return 0.0
    x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    return float(np.sqrt(np.mean(np.square(x))))


def clipping_ratio(y: np.ndarray, thr: float = 0.99) -> float:
    x = np.asarray(y, dtype=np.float64)
    if x.ndim == 2:
        x = np.max(np.abs(x), axis=-1)
    n = x.size
    if n == 0:
        return 1.0
    return float(np.mean(np.abs(x) >= thr))


def _effective_duration_seconds(mono: np.ndarray, sr: int) -> float:
    """Estimate audible duration using an amplitude-envelope threshold."""
    if mono.size == 0:
        return 0.0
    env = np.abs(signal.hilbert(mono))
    m = float(np.max(env))
    if m <= 1e-12:
        return 0.0
    active = env > (0.08 * m)
    return float(np.count_nonzero(active) / max(1, sr))


def _tail_to_head_rms_ratio(mono: np.ndarray, sr: int) -> float:
    """
    Compare body energy to initial transient energy.
    Low ratios suggest a near-click that's too short to be usable as a hat.
    """
    n_head = max(1, int(round(0.02 * sr)))  # 20ms
    head = mono[:n_head]
    tail = mono[n_head:]
    head_rms = rms_energy(head)
    tail_rms = rms_energy(tail) if tail.size else 0.0
    return float(tail_rms / (head_rms + 1e-9))


def _spectral_flatness_mean(mono: np.ndarray) -> float:
    """Higher values are more noise-like / white-noise-like."""
    if mono.size == 0:
        return 1.0
    flat = librosa.feature.spectral_flatness(y=mono.astype(np.float32) + 1e-9)
    return float(np.mean(flat))


def _low_band_rms(mono: np.ndarray, sr: int) -> float:
    """RMS in 20-180Hz for 808 loudness sanity checks."""
    nyq = sr / 2.0
    lo = 20.0 / nyq
    hi = 180.0 / nyq
    lo = max(0.0005, min(0.99, lo))
    hi = max(lo + 1e-4, min(0.99, hi))
    sos = signal.butter(4, [lo, hi], btype="bandpass", output="sos")
    band = signal.sosfiltfilt(sos, mono)
    return rms_energy(band)


def _category_flatness_threshold(category: str) -> float:
    c = category.lower()
    if c == "hihat":
        return 0.86
    if c == "open_hat":
        return 0.82
    if c == "fx":
        return 0.75
    if c in ("snare", "clap", "perc", "vox", "kick", "synth", "synth1", "synth2", "synth3"):
        return 0.55
    if c == "808":
        return 0.35
    return 0.65


def quality_check(audio: np.ndarray, category: str, sr: int = SAMPLE_RATE) -> bool:
    """
    Category-aware reject rules for trap usability:
    - global: silence / tiny RMS / clipping
    - hats: minimum audible duration and body after transient
    - 808: low-band dominance and loudness sanity checks
    - all: spectral-flatness cap to catch white-noise-like outputs
    """
    x = np.asarray(audio, dtype=np.float64)
    mono = np.mean(x, axis=-1) if x.ndim == 2 else x.reshape(-1)
    if mono.size == 0:
        return False
    if not np.isfinite(mono).all():
        return False

    peak = float(np.max(np.abs(mono)))
    if peak < 1e-7:
        return False
    if rms_energy(mono) < 1.2e-5:
        return False
    if clipping_ratio(x, 0.99) > 0.08:
        return False

    cat = category.lower()

    if cat in ("hihat", "open_hat"):
        min_dur = 0.015 if cat == "hihat" else 0.07
        if _effective_duration_seconds(mono, sr) < min_dur:
            return False
        if _tail_to_head_rms_ratio(mono, sr) < 0.05:
            return False

    if cat == "808":
        full_rms = rms_energy(mono)
        low_rms = _low_band_rms(mono, sr)
        if full_rms > 0.45:
            return False
        if (low_rms / (full_rms + 1e-9)) > 0.985:
            return False
        crest = peak / (full_rms + 1e-9)
        if crest < 1.35:
            return False

    if _spectral_flatness_mean(mono) > _category_flatness_threshold(cat):
        return False

    return True


def encode_audio_base64(audio: np.ndarray, sr: int = SAMPLE_RATE) -> str:
    """
    Write float audio (mono ``(N,)`` or stereo ``(N,2)``) to an in-memory WAV at ``sr``,
    then return a base64 ASCII string. Matches on-disk ``save_audio`` format (PCM_16).
    """
    buf = BytesIO()
    x = np.asarray(audio, dtype=np.float32)
    sf.write(buf, x, int(sr), subtype="PCM_16", format="WAV")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def save_audio(y: np.ndarray, path: Path, sr: int = SAMPLE_RATE) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    x = np.asarray(y, dtype=np.float32)
    if x.ndim == 2:
        sf.write(str(path), x, sr, subtype="PCM_16")
    else:
        sf.write(str(path), x, sr, subtype="PCM_16")

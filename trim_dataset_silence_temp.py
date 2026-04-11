"""

Temporary one-off: trim silence and/or peak-normalize .wav files under dataset/<subfolder>/.



Dry-run by default. Pass --write to overwrite files in place.



- Trim: librosa.effects.trim on mono mix (--no-trim to skip, --end-only for tail only).

- Normalize: peak to (full scale minus --headroom-db), default 1 dB below 0 dBFS.



Usage (from repo root, backend venv):

  python trim_dataset_silence_temp.py

  python trim_dataset_silence_temp.py --write

  python trim_dataset_silence_temp.py --write --normalize

  python trim_dataset_silence_temp.py --write --no-trim --normalize

  python trim_dataset_silence_temp.py --write --normalize --headroom-db 1.5

  # Tighter trim for drums, gentler for pads/synths (higher top_db keeps quiet tails):

  python trim_dataset_silence_temp.py --write --normalize --headroom-db 1.5 --top-db 38 --only 808s snares claps hihats openhats percs

  python trim_dataset_silence_temp.py --write --normalize --headroom-db 1.5 --top-db 55 --only synths Vox fx

"""



from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path



import librosa

import numpy as np

import soundfile as sf



DATASET_ROOT = Path(__file__).resolve().parent / "dataset"

AUDIO_EXT = {".wav"}





def _collect_wavs(root: Path, only: frozenset[str] | None = None) -> list[Path]:
    out: list[Path] = []
    if not root.is_dir():
        return out
    only_lower = {name.lower() for name in only} if only else None
    for sub in sorted(root.iterdir()):
        if not sub.is_dir():
            continue
        if only_lower is not None and sub.name.lower() not in only_lower:
            continue
        for p in sorted(sub.iterdir()):
            if p.is_file() and p.suffix.lower() in AUDIO_EXT:
                out.append(p)
    return out





def _trim_bounds(mono: np.ndarray, top_db: float, end_only: bool) -> tuple[int, int]:

    _, idx = librosa.effects.trim(mono, top_db=top_db)

    start, end = int(idx[0]), int(idx[1])

    if end_only:

        start = 0

    return start, end





def _peak_normalize(data: np.ndarray, headroom_db: float) -> tuple[np.ndarray, float]:

    """Scale so max |sample| == 10**(-headroom_db/20). Returns (scaled, gain)."""

    peak = float(np.max(np.abs(data))) if data.size else 0.0

    if peak <= 1e-12:

        return data, 1.0

    target = 10 ** (-headroom_db / 20.0)

    gain = target / peak

    return data * gain, gain





def process_wav(

    path: Path,

    *,

    do_trim: bool,

    top_db: float,

    end_only: bool,

    do_normalize: bool,

    headroom_db: float,

) -> tuple[np.ndarray, int, int, float, int, int]:

    """

    Load, optionally trim, optionally peak-normalize.

    Returns (data, sr, subtype_raw, gain, n_frames_in, n_frames_out).

    subtype_raw is from sf.info before overwrite (for sf.write).

    """

    info = sf.info(path)

    data, sr = sf.read(path, always_2d=True, dtype="float64")

    n_in = data.shape[0]

    subtype = info.subtype



    if do_trim and n_in > 0:

        mono = np.mean(data, axis=1)

        start, end = _trim_bounds(mono, top_db, end_only)

        if end > start:

            data = data[start:end]



    n_out = data.shape[0]

    gain = 1.0

    if do_normalize and data.size > 0:

        data, gain = _peak_normalize(data, headroom_db)



    return data, sr, subtype, gain, n_in, n_out





def main() -> int:

    parser = argparse.ArgumentParser(description="Trim silence and/or normalize dataset .wav files.")

    parser.add_argument(

        "--dataset",

        type=Path,

        default=DATASET_ROOT,

        help="Dataset root (default: ./dataset)",

    )

    parser.add_argument(

        "--write",

        action="store_true",

        help="Overwrite files (default: dry-run, print only)",

    )

    parser.add_argument(

        "--no-trim",

        action="store_true",

        help="Do not trim silence",

    )

    parser.add_argument(

        "--top-db",

        type=float,

        default=40.0,

        help="librosa.effects.trim threshold in dB below reference (default: 40)",

    )

    parser.add_argument(

        "--end-only",

        action="store_true",

        help="Only trim trailing silence (keep from sample 0)",

    )

    parser.add_argument(

        "--normalize",

        action="store_true",

        help="Peak-normalize to below full scale (see --headroom-db)",

    )

    parser.add_argument(

        "--headroom-db",

        type=float,

        default=1.0,

        help="dB below 0 dBFS for peak after normalize (default: 1.0)",

    )

    parser.add_argument(
        "--only",
        nargs="+",
        metavar="SUBFOLDER",
        help="Only process these subfolders under dataset/ (repeatable names; case-insensitive on Windows)",
    )

    args = parser.parse_args()

    root: Path = args.dataset



    do_trim = not args.no_trim

    if not do_trim and not args.normalize:

        print("Nothing to do: pass --normalize or omit --no-trim.", file=sys.stderr)

        return 1



    only_set = frozenset(args.only) if args.only else None
    paths = _collect_wavs(root, only_set)

    if not paths:

        print(f"No .wav files found under subfolders of {root}", file=sys.stderr)

        return 1



    mode = "WRITE" if args.write else "DRY-RUN"

    trim_mode = "off" if not do_trim else ("end-only" if args.end_only else "both ends")

    norm_note = f", normalize headroom={args.headroom_db} dB" if args.normalize else ""

    scope = f", only={sorted(only_set)}" if only_set else ""

    print(f"{mode}: {len(paths)} file(s), top_db={args.top_db}, trim={trim_mode}{norm_note}{scope}\n")



    changed = 0

    for path in paths:

        data, sr, subtype, gain, n_in, n_out = process_wav(

            path,

            do_trim=do_trim,

            top_db=args.top_db,

            end_only=args.end_only,

            do_normalize=args.normalize,

            headroom_db=args.headroom_db,

        )

        rel = path.relative_to(root.parent) if path.is_relative_to(root.parent) else path



        trim_changed = do_trim and n_out < n_in

        norm_changed = args.normalize and not math.isclose(gain, 1.0, rel_tol=0.0, abs_tol=1e-5)

        if not trim_changed and not norm_changed:

            print(f"  skip (unchanged): {rel}")

            continue



        parts: list[str] = []

        if trim_changed:

            parts.append(f"{n_in / sr:.4f}s -> {n_out / sr:.4f}s")

        elif do_trim:

            parts.append(f"len {n_out} samples")

        if args.normalize:

            parts.append(f"gain {gain:.4f}")



        print(f"  update: {rel}  " + "  ".join(parts))



        if args.write:

            sf.write(path, data, sr, subtype=subtype)

        changed += 1



    action = "updated" if (do_trim or args.normalize) else "processed"

    print(

        f"\nDone. {changed} file(s) would be {action}."

        if not args.write

        else f"\nDone. {changed} file(s) {action}."

    )

    return 0





if __name__ == "__main__":

    raise SystemExit(main())



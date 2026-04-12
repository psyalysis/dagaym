#!/usr/bin/env python3
"""
Mirror ``dataset/`` into a new folder, converting every ``.wav`` to ``.mp3``.

Requires ``ffmpeg`` on PATH (same stack librosa uses for MP3).

Encoding: LAME VBR quality 2 (~170–210 kbps typical) — perceptually transparent
for one-shots without oversized files. Override with ``--abr 192`` for fixed
average bitrate (e.g. 192 kbps).

Usage (from repo root)::

    python scripts/build_dataset_mp3.py
    python scripts/build_dataset_mp3.py --out "dataset 2"
    python scripts/build_dataset_mp3.py --src dataset --out dataset2 --abr 192
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _ffmpeg_bin() -> str:
    return shutil.which("ffmpeg") or ""


def _convert_wav_to_mp3(src: Path, dst: Path, *, use_abr: int | None) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-y", "-i", str(src), "-map_metadata", "-1"]
    if use_abr is not None:
        cmd += ["-c:a", "libmp3lame", "-b:a", f"{use_abr}k"]
    else:
        cmd += ["-c:a", "libmp3lame", "-q:a", "2"]
    cmd.append(str(dst))
    r = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        check=False,
    )
    if r.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed for {src}: {r.stderr or r.stdout or r.returncode}"
        )


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument(
        "--src",
        type=Path,
        default=_PROJECT_ROOT / "dataset",
        help="Source dataset root (default: <repo>/dataset)",
    )
    p.add_argument(
        "--out",
        type=Path,
        default=_PROJECT_ROOT / "dataset2",
        help='Output root (default: <repo>/dataset2; use "dataset 2" if you want spaces)',
    )
    p.add_argument(
        "--abr",
        type=int,
        metavar="KBPS",
        default=None,
        help="If set, use libmp3lame -b:a KBPS instead of VBR -q:a 2",
    )
    args = p.parse_args()
    src_root = args.src.resolve()
    out_root = args.out.resolve()

    if not _ffmpeg_bin():
        print("ffmpeg not found on PATH; install ffmpeg and retry.", file=sys.stderr)
        return 1
    if not src_root.is_dir():
        print(f"Source not a directory: {src_root}", file=sys.stderr)
        return 1

    wavs = sorted(src_root.rglob("*.wav")) + sorted(src_root.rglob("*.WAV"))
    if not wavs:
        print(f"No .wav files under {src_root}", file=sys.stderr)
        return 1

    converted = 0
    for wav in wavs:
        rel = wav.relative_to(src_root)
        mp3 = out_root / rel.with_suffix(".mp3")
        try:
            _convert_wav_to_mp3(wav, mp3, use_abr=args.abr)
            converted += 1
            if converted % 50 == 0:
                print(f"  … {converted} files", flush=True)
        except Exception as e:
            print(f"ERROR {wav}: {e}", file=sys.stderr)
            return 1

    for path in src_root.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() == ".wav":
            continue
        rel = path.relative_to(src_root)
        dest = out_root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            shutil.copy2(path, dest)

    print(f"Converted {converted} WAV → MP3 under {out_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

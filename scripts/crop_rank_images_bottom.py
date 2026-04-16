"""
Temporary helper: remove the bottom N pixels from each PNG under frontend/imgs/ranks.

Usage (from repo root):
  python scripts/crop_rank_images_bottom.py
  python scripts/crop_rank_images_bottom.py --dry-run
  python scripts/crop_rank_images_bottom.py --pixels 5

Requires: pip install pillow
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RANK_DIR = REPO_ROOT / "frontend" / "imgs" / "ranks"


def main() -> None:
    p = argparse.ArgumentParser(description="Crop bottom edge off rank PNGs.")
    p.add_argument(
        "--dir",
        type=Path,
        default=DEFAULT_RANK_DIR,
        help=f"Directory of PNGs (default: {DEFAULT_RANK_DIR})",
    )
    p.add_argument(
        "--pixels",
        type=int,
        default=1,
        help="Number of pixels to remove from the bottom (default: 3)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print actions without writing files",
    )
    args = p.parse_args()
    px = args.pixels
    if px < 0:
        raise SystemExit("--pixels must be >= 0")

    d: Path = args.dir
    if not d.is_dir():
        raise SystemExit(f"Not a directory: {d}")

    paths = sorted(d.glob("*.png"))
    if not paths:
        print(f"No PNG files in {d}")
        return

    for path in paths:
        with Image.open(path) as im:
            w, h = im.size
            if h <= px:
                print(f"SKIP (too short {h}px): {path.name}")
                continue
            new_h = h - px
            cropped = im.crop((0, 0, w, new_h))

        if args.dry_run:
            print(f"would crop {path.name}: {w}x{h} -> {w}x{new_h}")
            continue

        cropped.save(path)
        print(f"cropped {path.name}: {w}x{h} -> {w}x{new_h}")


if __name__ == "__main__":
    main()

"""
CLI: generate a drum kit under ``generated/`` with seed and spice.

Usage from project root::

    python -m backend.cli --spice 0.3
    python -m backend.cli --seed 12345 --spice 0.5
"""

from __future__ import annotations

import argparse
import random

from .generator import generate_kit


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a trap-oriented drum kit from dataset/.")
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="Random seed (default: random integer).",
    )
    parser.add_argument(
        "--spice",
        type=float,
        default=0.3,
        help="Experimental amount in [0,1] (default: 0.3). 0=safe, 1=wild.",
    )
    args = parser.parse_args()

    seed = args.seed if args.seed is not None else random.randint(0, 2**31 - 1)
    spice = float(args.spice)
    spice = max(0.0, min(1.0, spice))

    kit = generate_kit(seed=seed, spice=spice)
    print(f"seed={seed} spice={spice}")
    for name, path in sorted(kit.items()):
        print(f"{name}: {path}")


if __name__ == "__main__":
    main()

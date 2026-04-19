"""Portable kit RNG: Python vs ``frontend/js/kitFromSeed.js``."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from backend.kit_rng import EDM_VARIANT_POOL, pick_edm_fourth_synth_key, pick_index

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "backend" / "tests" / "pick_parity_runner.mjs"

CASES: list[tuple[int, int, float, int]] = [
    (12345, 0, 0.25, 7),
    (9999, 10, 0.85, 3),
    (0, 0, 0.0, 100),
    (2**31 - 1, 5, 1.0, 12),
    (404040, 3, 0.5, 1),
    (7, 9, 0.25, 999),
    (88, 8, 0.5, 11),
]


@pytest.mark.parametrize("seed,slot,spice,n", CASES)
def test_pick_index_in_range(seed: int, slot: int, spice: float, n: int) -> None:
    i = pick_index(seed, slot, spice, n)
    assert 0 <= i < n


def test_pick_index_n_one() -> None:
    assert pick_index(1, 2, 0.3, 1) == 0


@pytest.mark.parametrize("seed", [0, 12345, 999999, 2**31 - 1])
@pytest.mark.parametrize("spice", [0.0, 0.3, 0.85, 1.0])
def test_pick_edm_fourth_is_one_of_pool(seed: int, spice: float) -> None:
    k = pick_edm_fourth_synth_key(seed, spice)
    assert k in EDM_VARIANT_POOL


@pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")
def test_pick_index_matches_js() -> None:
    proc = subprocess.run(
        ["node", str(RUNNER), json.dumps(CASES)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr + proc.stdout
    js_vals = json.loads(proc.stdout.strip())
    assert len(js_vals) == len(CASES)
    for (seed, slot, spice, n), ji in zip(CASES, js_vals):
        pi = pick_index(seed, slot, spice, n)
        assert pi == ji, (seed, slot, spice, n, pi, ji)


def test_fixture_manifest_pick_indices() -> None:
    """Golden paths: same n as list lengths; indices must land in-range."""
    fixture = ROOT / "backend" / "tests" / "fixtures" / "mini_kit_manifest.json"
    data = json.loads(fixture.read_text(encoding="utf-8"))
    keys_order = data["key_order"]
    lists_map = data["lists"]
    spice = float(data["spice"])
    seed = int(data["seed"])
    for slot, key in enumerate(keys_order):
        paths = lists_map[key]
        n = len(paths)
        idx = pick_index(seed, slot, spice, n)
        assert 0 <= idx < n
        assert paths[idx] == data["expected_pick"][key]

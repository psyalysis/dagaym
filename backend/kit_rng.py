"""
Portable deterministic RNG for kit sample selection (Python must match ``frontend/js/kitFromSeed.js``).
"""

from __future__ import annotations

import struct


def _float32_bits(x: float) -> int:
    return struct.unpack("<I", struct.pack("<f", float(x)))[0]


def _to_int32(n: int) -> int:
    n &= 0xFFFFFFFF
    if n >= 0x80000000:
        n -= 0x100000000
    return n


def _js_imul(a: int, b: int) -> int:
    """``Math.imul(a, b)`` as unsigned 32-bit (then mask)."""
    return (_to_int32(a) * _to_int32(b)) & 0xFFFFFFFF


def _mulberry32_u32(state: int) -> tuple[int, float]:
    """
    One mulberry32 step. Returns (new_state, float in [0, 1)).
    Matches JS: ``t = a += 0x6D2B79F5; t = imul(...); t ^= t + imul(...); return (t^t>>>14)/2**32``.
    """
    a = (state + 0x6D2B79F5) & 0xFFFFFFFF
    t = a
    t = _js_imul(t ^ (t >> 15), t | 1)
    t = (t ^ (t + _js_imul(t ^ (t >> 7), t | 61))) & 0xFFFFFFFF
    out = (t ^ (t >> 14)) & 0xFFFFFFFF
    return a, out / 4294967296.0


def pick_index(seed: int, slot_index: int, spice: float, n: int) -> int:
    """
    Deterministic index in ``[0, n)`` for kit slot selection.
    Must stay in sync with ``pickIndex`` in ``frontend/js/kitFromSeed.js``.
    """
    if n <= 0:
        raise ValueError("n must be positive")
    spice_bits = _float32_bits(spice)
    s0 = (
        seed ^ (slot_index * 1_000_003) ^ spice_bits ^ ((slot_index << 16) & 0xFFFFFFFF)
    ) & 0xFFFFFFFF
    _state, r = _mulberry32_u32(s0)
    idx = int(r * n)
    if idx >= n:
        idx = n - 1
    return idx


# EDM: fourth synth slot is one of three folders (matches ``pickEdmFourthSynthKey`` in JS).
EDM_VARIANT_PICK_SLOT = 0xED01
EDM_VARIANT_POOL: tuple[str, ...] = ("ArpSynths", "PadSynths", "SynthSynths")


def pick_edm_fourth_synth_key(seed: int, spice: float) -> str:
    i = pick_index(seed, EDM_VARIANT_PICK_SLOT, spice, len(EDM_VARIANT_POOL))
    return EDM_VARIANT_POOL[i]

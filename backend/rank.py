"""
Competitive ranks from total wins (highest qualifying tier wins).
"""

from __future__ import annotations

from typing import Any

# Ordered by wins_min ascending; rank_for_wins picks the highest tier where wins >= wins_min.
_RANK_ROWS: tuple[tuple[str, int, str, str, str], ...] = (
    ("copper_1", 1, "[CI]", "Copper 1", "#cd7f32"),
    ("copper_2", 3, "[CII]", "Copper 2", "#cd7f32"),
    ("copper_3", 5, "[CIII]", "Copper 3", "#cd7f32"),
    ("silver_1", 10, "[SI]", "Silver 1", "#c0c0c0"),
    ("silver_2", 15, "[SII]", "Silver 2", "#c0c0c0"),
    ("silver_3", 20, "[SIII]", "Silver 3", "#c0c0c0"),
    ("gold_1", 30, "[GI]", "Gold 1", "#d4af37"),
    ("gold_2", 40, "[GII]", "Gold 2", "#d4af37"),
    ("gold_3", 50, "[GIII]", "Gold 3", "#d4af37"),
)

_RANK_KEYS_ORDER: tuple[str, ...] = tuple(r[0] for r in _RANK_ROWS)


def rank_for_wins(wins: int) -> dict[str, Any] | None:
    """Return the highest rank dict for ``wins``, or ``None`` if below Copper 1."""
    if wins < 1:
        return None
    chosen = None
    for key, wmin, abbrev, label, color in _RANK_ROWS:
        if wins >= wmin:
            chosen = {
                "key": key,
                "abbrev": abbrev,
                "label": label,
                "color": color,
                "wins_required": wmin,
            }
    return chosen


def rank_index_for_wins(wins: int) -> int:
    """0 = unranked; 1..9 = tier index for API / client comparison."""
    r = rank_for_wins(wins)
    if r is None:
        return 0
    try:
        return _RANK_KEYS_ORDER.index(r["key"]) + 1
    except ValueError:
        return 0


def rank_public_dict(wins: int) -> dict[str, Any] | None:
    """Subset for JSON (lobby snapshots, etc.)."""
    r = rank_for_wins(wins)
    if r is None:
        return None
    return {"key": r["key"], "abbrev": r["abbrev"], "label": r["label"], "color": r["color"]}

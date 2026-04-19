"""Validation for multiplayer chat text (ASCII, length, URL heuristics)."""

from __future__ import annotations

import re

MP_CHAT_MAX_LEN = 300
MP_CHAT_COOLDOWN_S = 3.0

# ASCII chat only for now (URLs stripped separately).
_ASCII_PRINTABLE = re.compile(r"^[\x20-\x7e]*$")

_URL_SCHEMES = re.compile(r"(?:https?|ftp)://", re.I)
_WWW = re.compile(r"\bwww\.", re.I)
# Loose hostname.tld (common TLDs) — catches "example.com" and "foo.bar.org/path"
_HOST_TLD = re.compile(
    r"\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    r"\.(?:com|net|org|io|gg|co|dev|app|tv|me|ai|ly|uk|us|eu|de|fr|ca)\b",
    re.I,
)


def normalize_and_validate_mp_chat_text(raw: object) -> tuple[str | None, str | None]:
    """``(text, None)`` on success, else ``(None, reason)``. ``raw`` → ``str``, strip once."""
    if raw is None:
        return None, "Empty message."
    text = str(raw).strip()
    if not text:
        return None, "Empty message."
    if len(text) > MP_CHAT_MAX_LEN:
        return None, "Message too long."
    if not _ASCII_PRINTABLE.fullmatch(text):
        return None, "Only ASCII characters allowed."
    if _URL_SCHEMES.search(text) or _WWW.search(text) or _HOST_TLD.search(text):
        return None, "URLs are not allowed."
    return text, None


def chat_cooldown_elapsed(last_sent: float | None, now: float) -> bool:
    """True if the player may send again (no prior send or cooldown passed)."""
    if last_sent is None:
        return True
    return now - last_sent >= MP_CHAT_COOLDOWN_S

"""Tests for multiplayer chat text validation and cooldown helper."""

from __future__ import annotations

from backend.multiplayer.mp_chat_text import (
    chat_cooldown_elapsed,
    normalize_and_validate_mp_chat_text,
)


def test_ascii_ok() -> None:
    text, err = normalize_and_validate_mp_chat_text("hello world")
    assert err is None
    assert text == "hello world"


def test_strip_whitespace() -> None:
    text, err = normalize_and_validate_mp_chat_text("  hi  ")
    assert err is None
    assert text == "hi"


def test_unicode_rejected() -> None:
    text, err = normalize_and_validate_mp_chat_text("café")
    assert text is None
    assert err is not None


def test_newline_rejected() -> None:
    text, err = normalize_and_validate_mp_chat_text("a\nb")
    assert text is None


def test_url_http_rejected() -> None:
    text, err = normalize_and_validate_mp_chat_text("see https://evil.test")
    assert text is None


def test_url_ftp_rejected() -> None:
    text, err = normalize_and_validate_mp_chat_text("ftp://x.com")
    assert text is None


def test_www_rejected() -> None:
    text, err = normalize_and_validate_mp_chat_text("visit www.foo.com ok")
    assert text is None


def test_bare_domain_rejected() -> None:
    text, err = normalize_and_validate_mp_chat_text("check foo.bar.com today")
    assert text is None


def test_length_300_ok() -> None:
    s = "a" * 300
    text, err = normalize_and_validate_mp_chat_text(s)
    assert err is None
    assert text == s


def test_length_301_rejected() -> None:
    s = "a" * 301
    text, err = normalize_and_validate_mp_chat_text(s)
    assert text is None


def test_empty_rejected() -> None:
    text, err = normalize_and_validate_mp_chat_text("   ")
    assert text is None


def test_chat_cooldown_elapsed() -> None:
    assert chat_cooldown_elapsed(None, 100.0) is True
    assert chat_cooldown_elapsed(100.0, 103.0) is True
    assert chat_cooldown_elapsed(100.0, 102.9) is False

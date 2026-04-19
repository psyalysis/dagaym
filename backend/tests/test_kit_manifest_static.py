"""Optional static ``KIT_MANIFEST_PATH`` overrides disk scan."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.generator import KIT_EDM_KEYS, _LIGHT_KIT_KEYS
from backend import kit_manifest as km


def _minimal_manifest(keys_extra: dict | None = None) -> dict:
    keys: dict[str, list[str]] = {k: [] for k in _LIGHT_KIT_KEYS}
    if keys_extra:
        keys.update(keys_extra)
    return {"version": 5, "sampleRate": 44100, "keys": keys}


def _minimal_edm_manifest(keys_extra: dict | None = None) -> dict:
    keys: dict[str, list[str]] = {k: [] for k in KIT_EDM_KEYS}
    if keys_extra:
        keys.update(keys_extra)
    return {"version": 7, "sampleRate": 44100, "keys": keys}


@pytest.fixture(autouse=True)
def clear_manifest_cache():
    km.get_kit_manifest_cached.cache_clear()
    km.get_kit_manifest_edm_cached.cache_clear()
    yield
    km.get_kit_manifest_cached.cache_clear()
    km.get_kit_manifest_edm_cached.cache_clear()


def test_kit_manifest_path_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "kit-manifest.json"
    path.write_text(
        json.dumps(
            _minimal_manifest(
                {
                    "snares": ["trap/snares/x.ogg"],
                    "synth1": ["trap/synths/a.ogg"],
                    "synth2": ["trap/synths/a.ogg"],
                    "synth3": ["trap/synths/a.ogg"],
                },
            ),
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("KIT_MANIFEST_PATH", str(path))
    km.get_kit_manifest_cached.cache_clear()
    data = km.get_kit_manifest_cached()
    assert data["keys"]["snares"] == ["trap/snares/x.ogg"]
    syn = ["TrapRefined/synths/a.ogg"]
    assert data["keys"]["synth1"] == syn
    assert data["keys"]["synth2"] == syn
    assert data["keys"]["synth3"] == syn


def test_kit_manifest_invalid_json_falls_back(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    path = tmp_path / "bad.json"
    path.write_text("{not json", encoding="utf-8")
    monkeypatch.setenv("KIT_MANIFEST_PATH", str(path))
    km.get_kit_manifest_cached.cache_clear()
    # Should not raise; falls back to disk scan
    data = km.get_kit_manifest_cached()
    assert "keys" in data
    assert isinstance(data["keys"], dict)


def test_kit_manifest_edm_path_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "kit-manifest-edm.json"
    path.write_text(
        json.dumps(
            _minimal_edm_manifest(
                {
                    "Kicks": ["edm/Kicks/k.ogg"],
                    "Snares": ["edm/Snares/s.ogg"],
                    "ClosedHats": ["edm/ClosedHats/h.ogg"],
                },
            ),
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("KIT_MANIFEST_EDM_PATH", str(path))
    km.get_kit_manifest_edm_cached.cache_clear()
    data = km.get_kit_manifest_for_genre("edm")
    assert data["keys"]["Kicks"] == ["edm/Kicks/k.ogg"]
    assert data["keys"]["Snares"] == ["edm/Snares/s.ogg"]


def test_edm_disk_scan_emits_logical_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    edm_root = tmp_path / "EDM"
    (edm_root / "ImpactsRisers").mkdir(parents=True)
    (edm_root / "ImpactsRisers" / "f.ogg").write_bytes(b"\x00")
    (edm_root / "PadSynths").mkdir(parents=True)
    (edm_root / "PadSynths" / "p.ogg").write_bytes(b"\x00")
    monkeypatch.setattr(km, "_EDM_DATASET_ROOT", edm_root)
    monkeypatch.setenv("KIT_MANIFEST_EDM_URL", "")
    km.get_kit_manifest_edm_cached.cache_clear()
    data = km.build_kit_manifest_edm()
    assert data["keys"]["ImpactsRisers"] == ["edm/ImpactsRisers/f.ogg"]
    assert data["keys"]["PadSynths"] == ["edm/PadSynths/p.ogg"]
    assert data["keys"]["Kicks"] == []


def test_kit_manifest_legacy_cdn_keys_normalized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Production CDN uses ``snare`` / ``kick`` / …; normalize to slot names."""
    legacy = {
        "version": 6,
        "sampleRate": 44100,
        "keys": {
            "snare": ["beat-battle-assets/TrapRefined/snares/a.ogg"],
            "clap": ["trap/claps/b.ogg"],
            "hihat": ["trap/hihats/c.ogg"],
            "open_hat": ["trap/openhats/d.ogg"],
            "808": ["trap/808s/e.ogg"],
            "perc": ["trap/percs/f.ogg"],
            "fx": ["trap/fx/g.ogg"],
            "vox": ["trap/Vox/h.ogg"],
            "synth1": ["trap/synths/s.ogg"],
            "synth2": ["trap/synths/s.ogg"],
            "synth3": ["trap/synths/s.ogg"],
            "kick": ["trap/kicks/k.ogg"],
        },
    }
    path = tmp_path / "legacy.json"
    path.write_text(json.dumps(legacy), encoding="utf-8")
    monkeypatch.setenv("KIT_MANIFEST_PATH", str(path))
    monkeypatch.setenv("KIT_MANIFEST_URL", "")
    km.get_kit_manifest_cached.cache_clear()
    data = km.get_kit_manifest_cached()
    assert data["keys"]["snares"] == ["TrapRefined/snares/a.ogg"]
    assert data["keys"]["kicks"] == legacy["keys"]["kick"]
    assert data["keys"]["Vox"] == legacy["keys"]["vox"]


def test_get_kit_manifest_for_genre_defaults_trap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "trap-only.json"
    path.write_text(
        json.dumps(
            _minimal_manifest({"kicks": ["trap/kicks/a.ogg"]}),
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("KIT_MANIFEST_PATH", str(path))
    km.get_kit_manifest_cached.cache_clear()
    data = km.get_kit_manifest_for_genre(None)
    assert data["keys"]["kicks"] == ["trap/kicks/a.ogg"]

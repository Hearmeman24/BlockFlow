"""Cache schema v2 — full LoRA objects with path + size_mb.

Audit item A.3.1 (sgs-ui-h1c.1.9). Today the shared cache file at
config.COMFY_GEN_INFO_CACHE_PATH stores LoRAs as a flat list of filenames,
dropping the `path` and `size_mb` fields that `comfy-gen info` actually
returns. This blocks features like the LoRA page's disk-usage column
(sgs-ui-eqc.4).

The schema bumps to v2:
  {
    "version": 2,
    "samplers": [...],
    "schedulers": [...],
    "loras": [{"filename": "...", "path": "...", "size_mb": <float>}, ...],
    "fetched_at": <epoch>,
  }

Old v1 caches (no version key) are rejected on read so the next info
refresh repopulates with rich data. Backwards-compat for existing callers
is preserved by helper functions that project the full objects down to
filenames-only.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from fakes import comfy_gen as fakes  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "comfy_gen_block_cache_v2",
    ROOT / "custom_blocks" / "comfy_gen" / "backend.block.py",
)
mod = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = mod
_spec.loader.exec_module(mod)

from backend import config, lora_routes, settings_store  # noqa: E402


@pytest.fixture
def cache_path(tmp_path, monkeypatch):
    p = tmp_path / "comfy_gen_info_cache.json"
    monkeypatch.setattr(config, "COMFY_GEN_INFO_CACHE_PATH", p)
    # The module imported its own reference at load time; patch that too.
    monkeypatch.setattr(mod.config, "COMFY_GEN_INFO_CACHE_PATH", p)
    # Reset in-memory cache between tests.
    monkeypatch.setattr(mod, "_cache", {
        "samplers": [], "schedulers": [], "loras": [], "lora_details": [],
        "fetched_at": None,
    })
    monkeypatch.setattr(lora_routes, "_cache_lock", threading.Lock())
    return p


def _v2_payload() -> dict:
    return {
        "version": 2,
        "samplers": ["euler", "dpmpp_2m"],
        "schedulers": ["normal", "karras"],
        "loras": [
            {"filename": "a.safetensors", "path": "/runpod-volume/.../a.safetensors",
             "size_mb": 144.5},
            {"filename": "b.safetensors", "path": "/runpod-volume/.../b.safetensors",
             "size_mb": 72.0},
        ],
        "fetched_at": 1700000000.0,
    }


# ---- _read_cache_from_disk -------------------------------------------------

def test_read_v2_cache_populates_in_memory(cache_path):
    cache_path.write_text(json.dumps(_v2_payload()))
    mod._read_cache_from_disk()
    assert mod._cache["samplers"] == ["euler", "dpmpp_2m"]
    assert mod._cache["loras"] == ["a.safetensors", "b.safetensors"]
    assert mod._cache["lora_details"] == _v2_payload()["loras"]
    assert mod._cache["fetched_at"] == 1700000000.0


def test_read_v1_cache_drops_lora_data(cache_path):
    """v1 file (no version field, flat filename strings) must be rejected
    on read — forces a fresh `comfy-gen info` call to repopulate with
    full objects. Samplers/schedulers can still be loaded since their
    shape didn't change."""
    cache_path.write_text(json.dumps({
        "samplers": ["euler"],
        "schedulers": ["normal"],
        "loras": ["a.safetensors", "b.safetensors"],  # v1 flat-string shape
        "fetched_at": 1690000000.0,
    }))
    mod._read_cache_from_disk()
    assert mod._cache["samplers"] == ["euler"]
    assert mod._cache["loras"] == []
    assert mod._cache["lora_details"] == []


def test_read_missing_file_is_noop(cache_path):
    assert not cache_path.exists()
    mod._read_cache_from_disk()
    assert mod._cache["loras"] == []


# ---- _save_cache_to_disk ---------------------------------------------------

def test_save_writes_version_2_envelope(cache_path):
    mod._cache["samplers"] = ["euler"]
    mod._cache["schedulers"] = ["normal"]
    mod._cache["loras"] = ["a.safetensors"]
    mod._cache["lora_details"] = [
        {"filename": "a.safetensors", "path": "/runpod-volume/x/a.safetensors",
         "size_mb": 50.0},
    ]
    mod._cache["fetched_at"] = 1700000000.0
    mod._save_cache_to_disk()

    data = json.loads(cache_path.read_text())
    assert data["version"] == 2
    assert data["loras"] == [
        {"filename": "a.safetensors", "path": "/runpod-volume/x/a.safetensors",
         "size_mb": 50.0},
    ]
    assert data["fetched_at"] == 1700000000.0


def test_save_roundtrip(cache_path):
    """Write then read — in-memory state must match."""
    mod._cache["loras"] = ["a.safetensors"]
    mod._cache["lora_details"] = [
        {"filename": "a.safetensors", "path": "/p/a.safetensors", "size_mb": 1.0},
    ]
    mod._cache["fetched_at"] = 1700000000.0
    mod._save_cache_to_disk()

    mod._cache["loras"] = []
    mod._cache["lora_details"] = []
    mod._read_cache_from_disk()
    assert mod._cache["loras"] == ["a.safetensors"]
    assert mod._cache["lora_details"][0]["size_mb"] == 1.0


# ---- refresh path stores rich objects --------------------------------------

def test_refresh_stores_lora_objects_with_path_and_size(cache_path, monkeypatch):
    """When `comfy-gen info` returns rich lora objects, the cache stores
    the full shape — not just filenames."""
    info_payload = {
        "ok": True,
        "samplers": ["euler"],
        "schedulers": ["normal"],
        "loras": [
            {"filename": "x.safetensors", "path": "/runpod-volume/x.safetensors",
             "size_mb": 100.5},
            {"filename": "y.safetensors", "path": "/runpod-volume/y.safetensors",
             "size_mb": 200.0},
        ],
    }
    proc = fakes.make_proc(stdout=json.dumps(info_payload), returncode=0)
    monkeypatch.setattr(mod.subprocess, "Popen", lambda *a, **kw: proc)

    mod._run_refresh(["comfy-gen", "info"])

    # In-memory: rich objects available, filenames preserved for legacy consumers.
    assert mod._cache["loras"] == ["x.safetensors", "y.safetensors"]
    assert mod._cache["lora_details"][0]["size_mb"] == 100.5
    assert mod._cache["lora_details"][1]["path"] == "/runpod-volume/y.safetensors"

    # On disk: v2 envelope.
    data = json.loads(cache_path.read_text())
    assert data["version"] == 2
    assert data["loras"][0]["size_mb"] == 100.5


def test_refresh_passes_settings_runpod_config_to_comfy_gen(cache_path, monkeypatch, tmp_path):
    db_path = tmp_path / "settings.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    settings_store.set_credential("runpod_api_key", "rpa_refresh")
    settings_store.set_endpoint("comfygen", endpoint_id="ep_refresh", volume_id="vol")

    info_payload = {"ok": True, "samplers": [], "schedulers": [], "loras": []}
    captured: dict[str, object] = {}

    def fake_popen(args, **kwargs):
        captured["args"] = args
        captured["env"] = kwargs.get("env")
        captured["cfg"] = json.loads(
            (Path(captured["env"]["HOME"]) / ".comfy-gen" / "config.json").read_text(encoding="utf-8")
        )
        return fakes.make_proc(stdout=json.dumps(info_payload), returncode=0)

    monkeypatch.setattr(mod.subprocess, "Popen", fake_popen)

    mod._run_refresh(["comfy-gen", "info"])

    env = captured["env"]
    cfg = captured["cfg"]
    assert env["RUNPOD_API_KEY"] == "rpa_refresh"
    assert cfg["runpod_api_key"] == "rpa_refresh"
    assert cfg["endpoint_id"] == "ep_refresh"
    assert "rpa_refresh" not in captured["args"]


def test_download_models_passes_settings_runpod_config(cache_path, monkeypatch, tmp_path):
    db_path = tmp_path / "settings.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    settings_store.set_credential("runpod_api_key", "rpa_download_models")
    settings_store.set_endpoint("comfygen", endpoint_id="ep_download", volume_id="vol")

    captured: dict[str, object] = {}

    def fake_popen(args, **kwargs):
        captured["args"] = args
        captured["env"] = kwargs.get("env")
        captured["cfg"] = json.loads(
            (Path(captured["env"]["HOME"]) / ".comfy-gen" / "config.json").read_text(encoding="utf-8")
        )
        return fakes.make_proc(stdout=json.dumps({"ok": True, "files": ["x"]}), returncode=0)

    monkeypatch.setattr(mod.subprocess, "Popen", fake_popen)

    mod._run_download(["comfy-gen", "download", "--batch", "batch.json"])

    env = captured["env"]
    cfg = captured["cfg"]
    assert env["RUNPOD_API_KEY"] == "rpa_download_models"
    assert cfg["runpod_api_key"] == "rpa_download_models"
    assert cfg["endpoint_id"] == "ep_download"
    assert "rpa_download_models" not in captured["args"]


# ---- lora_routes file helpers ----------------------------------------------

def test_lora_routes_read_v1_returns_empty_for_loras(cache_path):
    cache_path.write_text(json.dumps({
        "loras": ["a.safetensors"],
        "fetched_at": 1690000000.0,
    }))
    names, _ = lora_routes._read_cached_loras()
    assert names == []


def test_lora_routes_read_v2_returns_filenames(cache_path):
    cache_path.write_text(json.dumps(_v2_payload()))
    names, fetched_at = lora_routes._read_cached_loras()
    assert names == ["a.safetensors", "b.safetensors"]
    assert fetched_at == 1700000000.0


def test_lora_routes_write_preserves_rich_metadata_for_known_files(cache_path):
    """When a flow updates the lora list with just filenames (e.g.,
    after a delete), rich metadata for surviving files must be preserved."""
    cache_path.write_text(json.dumps(_v2_payload()))

    # Simulate a delete: only "a.safetensors" remains.
    lora_routes._write_cached_loras(["a.safetensors"], fetched_at=time.time())

    data = json.loads(cache_path.read_text())
    assert data["version"] == 2
    assert len(data["loras"]) == 1
    assert data["loras"][0]["filename"] == "a.safetensors"
    # Rich metadata preserved for the survivor.
    assert data["loras"][0]["size_mb"] == 144.5


def test_lora_routes_write_stubs_unknown_files(cache_path):
    """A filename with no prior metadata gets a stub object (filename only)."""
    cache_path.write_text(json.dumps(_v2_payload()))

    lora_routes._write_cached_loras(
        ["a.safetensors", "c-new.safetensors"], fetched_at=time.time(),
    )
    data = json.loads(cache_path.read_text())
    by_name = {x["filename"]: x for x in data["loras"]}
    assert by_name["a.safetensors"]["size_mb"] == 144.5  # preserved
    assert by_name["c-new.safetensors"] == {"filename": "c-new.safetensors"}


def test_lora_routes_write_upgrades_v1_file(cache_path):
    """If the on-disk file is v1, a write produces a v2 file (with stub
    objects for the listed names since v1 has no rich data to preserve)."""
    cache_path.write_text(json.dumps({
        "loras": ["a.safetensors"],
        "fetched_at": 1690000000.0,
    }))
    lora_routes._write_cached_loras(["a.safetensors", "b.safetensors"])

    data = json.loads(cache_path.read_text())
    assert data["version"] == 2
    by_name = {x["filename"]: x for x in data["loras"]}
    assert by_name["a.safetensors"] == {"filename": "a.safetensors"}
    assert by_name["b.safetensors"] == {"filename": "b.safetensors"}

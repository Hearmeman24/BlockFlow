from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _make_executable(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    path.chmod(0o755)
    return path


def _load_resolver():
    try:
        from backend import comfy_gen_cli
    except ImportError:
        pytest.fail("backend.comfy_gen_cli helper is required")
    return comfy_gen_cli


def _load_comfy_gen_block():
    spec = importlib.util.spec_from_file_location(
        "comfy_gen_block_resolver_test",
        ROOT / "custom_blocks" / "comfy_gen" / "backend.block.py",
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_override_bin_wins_over_sidecar_and_path(monkeypatch, tmp_path):
    comfy_gen_cli = _load_resolver()
    override = _make_executable(tmp_path / "override" / "comfy-gen")
    sidecar = _make_executable(tmp_path / "sidecar" / "bin" / "comfy-gen")
    path_bin = _make_executable(tmp_path / "path" / "comfy-gen")

    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_BIN", str(override))
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))
    monkeypatch.setenv("PATH", str(path_bin.parent))

    resolved = comfy_gen_cli.resolve_comfy_gen()

    assert resolved.mode == "override"
    assert resolved.path == override
    assert resolved.command("info", "--json") == [str(override), "info", "--json"]


def test_sidecar_venv_is_used_when_cli_is_not_on_path(monkeypatch, tmp_path):
    comfy_gen_cli = _load_resolver()
    sidecar = _make_executable(tmp_path / "venv" / "bin" / "comfy-gen")

    monkeypatch.delenv("BLOCKFLOW_COMFY_GEN_BIN", raising=False)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))
    monkeypatch.setenv("PATH", os.devnull)

    resolved = comfy_gen_cli.resolve_comfy_gen()

    assert resolved.mode == "sidecar"
    assert resolved.path == sidecar


def test_windows_sidecar_venv_uses_scripts_exe(monkeypatch, tmp_path):
    comfy_gen_cli = _load_resolver()
    sidecar = _make_executable(tmp_path / "venv" / "Scripts" / "comfy-gen.exe")

    monkeypatch.delenv("BLOCKFLOW_COMFY_GEN_BIN", raising=False)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))
    monkeypatch.setenv("PATH", os.devnull)

    resolved = comfy_gen_cli.resolve_comfy_gen(platform="win32")

    assert resolved.mode == "sidecar"
    assert resolved.path == sidecar


def test_path_fallback_is_used_for_dev_mode(monkeypatch, tmp_path):
    comfy_gen_cli = _load_resolver()
    path_bin = _make_executable(tmp_path / "bin" / "comfy-gen")

    monkeypatch.delenv("BLOCKFLOW_COMFY_GEN_BIN", raising=False)
    monkeypatch.delenv("BLOCKFLOW_COMFY_GEN_VENV", raising=False)
    monkeypatch.setenv("PATH", str(path_bin.parent))

    resolved = comfy_gen_cli.resolve_comfy_gen()

    assert resolved.mode == "path"
    assert resolved.path == path_bin


def test_missing_binary_error_names_all_resolution_modes(monkeypatch):
    comfy_gen_cli = _load_resolver()

    monkeypatch.delenv("BLOCKFLOW_COMFY_GEN_BIN", raising=False)
    monkeypatch.delenv("BLOCKFLOW_COMFY_GEN_VENV", raising=False)
    monkeypatch.setenv("PATH", os.devnull)

    with pytest.raises(comfy_gen_cli.ComfyGenNotFound) as exc:
        comfy_gen_cli.resolve_comfy_gen()

    message = str(exc.value)
    assert "BLOCKFLOW_COMFY_GEN_BIN" in message
    assert "BLOCKFLOW_COMFY_GEN_VENV" in message
    assert "PATH" in message


def test_comfy_gen_health_reports_resolved_sidecar_mode(monkeypatch, tmp_path):
    mod = _load_comfy_gen_block()
    sidecar = _make_executable(tmp_path / "venv" / "bin" / "comfy-gen")
    monkeypatch.delenv("BLOCKFLOW_COMFY_GEN_BIN", raising=False)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))
    monkeypatch.setenv("PATH", os.devnull)

    captured: dict[str, object] = {}

    def fake_run(args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return type("RunResult", (), {"returncode": 0})()

    monkeypatch.setattr(mod.subprocess, "run", fake_run)

    response = mod.health_check()
    body = json.loads(response.body)

    assert body["ok"] is True
    assert body["mode"] == "sidecar"
    assert body["path"] == str(sidecar)
    assert captured["args"] == [str(sidecar), "--help"]

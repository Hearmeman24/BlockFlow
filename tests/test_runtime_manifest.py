from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import runtime_manifest  # noqa: E402


def _response(body: dict, status: int = 200) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status
    resp.text = json.dumps(body)
    resp.json = lambda: body
    return resp


def test_resolve_comfygen_image_uses_remote_manifest(monkeypatch, tmp_path):
    monkeypatch.setattr(runtime_manifest, "_CACHE_PATH", tmp_path / "runtime_manifest.json")
    runtime_manifest._cache_reset()
    body = {
        "manifest_version": 1,
        "comfygen_serverless": {
            "image": "hearmeman/comfyui-serverless:v25",
            "tag": "v25",
        },
    }
    get = MagicMock(return_value=_response(body))
    monkeypatch.setattr(runtime_manifest._cffi_requests, "get", get)

    assert runtime_manifest.resolve_comfygen_image() == "hearmeman/comfyui-serverless:v25"
    get.assert_called_once_with(runtime_manifest.RUNTIME_MANIFEST_URL, timeout=15)


def test_resolve_comfygen_image_falls_back_to_disk_cache_on_fetch_error(monkeypatch, tmp_path):
    cache_path = tmp_path / "runtime_manifest.json"
    monkeypatch.setattr(runtime_manifest, "_CACHE_PATH", cache_path)
    runtime_manifest._cache_reset()
    cache_path.write_text(json.dumps({
        "manifest_version": 1,
        "comfygen_serverless": {
            "image": "hearmeman/comfyui-serverless:v26",
            "tag": "v26",
        },
    }), encoding="utf-8")
    monkeypatch.setattr(
        runtime_manifest._cffi_requests,
        "get",
        MagicMock(side_effect=RuntimeError("offline")),
    )

    assert runtime_manifest.resolve_comfygen_image() == "hearmeman/comfyui-serverless:v26"


def test_resolve_comfygen_image_uses_fallback_for_invalid_remote_image(monkeypatch, tmp_path):
    monkeypatch.setattr(runtime_manifest, "_CACHE_PATH", tmp_path / "runtime_manifest.json")
    runtime_manifest._cache_reset()
    monkeypatch.setattr(runtime_manifest._cffi_requests, "get", MagicMock(return_value=_response({
        "manifest_version": 1,
        "comfygen_serverless": {
            "image": "docker.io/someone/else:latest",
            "tag": "latest",
        },
    })))

    assert runtime_manifest.resolve_comfygen_image() == runtime_manifest.FALLBACK_DOCKER_IMAGE


def test_resolve_comfygen_image_keeps_disk_cache_when_remote_is_invalid(monkeypatch, tmp_path):
    cache_path = tmp_path / "runtime_manifest.json"
    monkeypatch.setattr(runtime_manifest, "_CACHE_PATH", cache_path)
    runtime_manifest._cache_reset()
    cache_path.write_text(json.dumps({
        "manifest_version": 1,
        "comfygen_serverless": {
            "image": "hearmeman/comfyui-serverless:v25",
            "tag": "v25",
        },
    }), encoding="utf-8")
    monkeypatch.setattr(runtime_manifest._cffi_requests, "get", MagicMock(return_value=_response({
        "manifest_version": 1,
        "comfygen_serverless": {
            "image": "hearmeman/comfyui-serverless:latest",
            "tag": "latest",
        },
    })))

    assert runtime_manifest.resolve_comfygen_image() == "hearmeman/comfyui-serverless:v25"

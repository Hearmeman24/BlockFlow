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


def test_latest_comfygen_returns_tag_and_notes(monkeypatch, tmp_path):
    monkeypatch.setattr(runtime_manifest, "_CACHE_PATH", tmp_path / "m.json")
    runtime_manifest._cache_reset()
    body = {
        "manifest_version": 1,
        "comfygen_serverless": {
            "image": "hearmeman/comfyui-serverless:v25",
            "tag": "v25",
            "release_notes": "  faster sampler  ",
        },
    }
    monkeypatch.setattr(runtime_manifest._cffi_requests, "get", MagicMock(return_value=_response(body)))
    assert runtime_manifest.latest_comfygen() == {
        "image": "hearmeman/comfyui-serverless:v25",
        "tag": "v25",
        "release_notes": "faster sampler",
        "min_cuda_version": None,
    }


def test_latest_comfygen_derives_tag_and_null_notes(monkeypatch, tmp_path):
    monkeypatch.setattr(runtime_manifest, "_CACHE_PATH", tmp_path / "m.json")
    runtime_manifest._cache_reset()
    body = {
        "manifest_version": 1,
        "comfygen_serverless": {"image": "hearmeman/comfyui-serverless:v25"},
    }
    monkeypatch.setattr(runtime_manifest._cffi_requests, "get", MagicMock(return_value=_response(body)))
    out = runtime_manifest.latest_comfygen()
    assert out["tag"] == "v25"
    assert out["release_notes"] is None


def test_latest_comfygen_falls_back_to_image_constant(monkeypatch, tmp_path):
    monkeypatch.setattr(runtime_manifest, "_CACHE_PATH", tmp_path / "m.json")
    runtime_manifest._cache_reset()
    monkeypatch.setattr(runtime_manifest._cffi_requests, "get",
                        MagicMock(side_effect=RuntimeError("offline")))
    out = runtime_manifest.latest_comfygen()
    assert out["image"] == runtime_manifest.FALLBACK_DOCKER_IMAGE
    assert out["tag"] == "v24"


def test_latest_comfygen_ignores_malformed_tag_field(monkeypatch, tmp_path):
    # Regression (sgs-ui-cxs breaker HIGH): a non-vN `tag` field must NOT mask a
    # real update — the comparable tag comes from the validated image suffix.
    monkeypatch.setattr(runtime_manifest, "_CACHE_PATH", tmp_path / "m.json")
    runtime_manifest._cache_reset()
    body = {
        "manifest_version": 1,
        "comfygen_serverless": {
            "image": "hearmeman/comfyui-serverless:v25",
            "tag": "stable",
            "channel": "stable",
        },
    }
    monkeypatch.setattr(runtime_manifest._cffi_requests, "get", MagicMock(return_value=_response(body)))
    assert runtime_manifest.latest_comfygen()["tag"] == "v25"


def test_latest_comfygen_parses_min_cuda_version(monkeypatch, tmp_path):
    monkeypatch.setattr(runtime_manifest, "_CACHE_PATH", tmp_path / "m.json")
    runtime_manifest._cache_reset()
    body = {
        "manifest_version": 1,
        "comfygen_serverless": {"image": "hearmeman/comfyui-serverless:v27", "min_cuda_version": "13.0"},
    }
    monkeypatch.setattr(runtime_manifest._cffi_requests, "get", MagicMock(return_value=_response(body)))
    assert runtime_manifest.latest_comfygen()["min_cuda_version"] == "13.0"


def test_latest_comfygen_min_cuda_none_when_absent_or_invalid(monkeypatch, tmp_path):
    monkeypatch.setattr(runtime_manifest, "_CACHE_PATH", tmp_path / "m.json")
    for cuda in (None, "thirteen", "13", "", "١٣.٠"):  # last: Unicode digits must be rejected
        runtime_manifest._cache_reset()
        section = {"image": "hearmeman/comfyui-serverless:v27"}
        if cuda is not None:
            section["min_cuda_version"] = cuda
        body = {"manifest_version": 1, "comfygen_serverless": section}
        monkeypatch.setattr(runtime_manifest._cffi_requests, "get", MagicMock(return_value=_response(body)))
        assert runtime_manifest.latest_comfygen()["min_cuda_version"] is None, cuda

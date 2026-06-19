from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import runpod_api  # noqa: E402


def test_get_endpoint_image_resolves_template(monkeypatch):
    gets = []

    def fake_get(api_key, path):
        gets.append(path)
        if path == "/endpoints/ep1":
            return {"templateId": "tmpl9"}
        if path == "/templates/tmpl9":
            return {"imageName": "hearmeman/comfyui-serverless:v25"}
        raise AssertionError(path)

    monkeypatch.setattr(runpod_api, "_rest_get", fake_get)
    assert runpod_api.get_endpoint_image("k", "ep1") == "hearmeman/comfyui-serverless:v25"
    assert gets == ["/endpoints/ep1", "/templates/tmpl9"]


def test_get_endpoint_image_none_without_template(monkeypatch):
    monkeypatch.setattr(runpod_api, "_rest_get", lambda k, p: {})
    assert runpod_api.get_endpoint_image("k", "ep1") is None


def test_get_endpoint_image_none_without_imagename(monkeypatch):
    monkeypatch.setattr(runpod_api, "_rest_get",
                        lambda k, p: {"templateId": "t"} if "endpoints" in p else {})
    assert runpod_api.get_endpoint_image("k", "ep1") is None


def test_update_endpoint_image_patches_template(monkeypatch):
    monkeypatch.setattr(runpod_api, "_rest_get", lambda k, p: {"templateId": "tmpl9"})
    patches = {}
    monkeypatch.setattr(runpod_api, "_rest_patch",
                        lambda k, p, body: patches.update(path=p, body=body) or {"imageName": body["imageName"]})
    out = runpod_api.update_endpoint_image("k", "ep1", "hearmeman/comfyui-serverless:v25")
    assert patches == {"path": "/templates/tmpl9", "body": {"imageName": "hearmeman/comfyui-serverless:v25"}}
    assert out["imageName"] == "hearmeman/comfyui-serverless:v25"


def test_update_endpoint_image_raises_without_template(monkeypatch):
    monkeypatch.setattr(runpod_api, "_rest_get", lambda k, p: {})
    with pytest.raises(runpod_api.RunPodAPIError):
        runpod_api.update_endpoint_image("k", "ep1", "img:v25")

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import comfygen_update_routes, runpod_api, runtime_manifest, settings_store  # noqa: E402

LATEST = {"image": "hearmeman/comfyui-serverless:v25", "tag": "v25",
          "release_notes": "faster", "min_cuda_version": None}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(runtime_manifest, "latest_comfygen", lambda: dict(LATEST))
    app = FastAPI()
    app.include_router(comfygen_update_routes.router)
    return TestClient(app)


def _set_endpoint(monkeypatch, endpoint=None, api_key="key"):
    monkeypatch.setattr(settings_store, "get_endpoint", lambda t: endpoint)
    monkeypatch.setattr(settings_store, "get_credential", lambda n: api_key)


# --- status ---------------------------------------------------------------

def test_status_not_configured(client, monkeypatch):
    _set_endpoint(monkeypatch, endpoint=None)
    body = client.get("/api/comfygen/update-status").json()
    assert body == {"configured": False, "stale": False, "latest_tag": "v25"}


def test_status_stale_when_endpoint_behind(client, monkeypatch):
    _set_endpoint(monkeypatch, endpoint={"endpoint_id": "ep1"})
    monkeypatch.setattr(runpod_api, "get_endpoint_image",
                        lambda k, e: "hearmeman/comfyui-serverless:v24")
    body = client.get("/api/comfygen/update-status").json()
    assert body["stale"] is True
    assert body["current_tag"] == "v24"
    assert body["latest_tag"] == "v25"
    assert body["release_notes"] == "faster"


def test_status_not_stale_when_current(client, monkeypatch):
    _set_endpoint(monkeypatch, endpoint={"endpoint_id": "ep1"})
    monkeypatch.setattr(runpod_api, "get_endpoint_image",
                        lambda k, e: "hearmeman/comfyui-serverless:v25")
    assert client.get("/api/comfygen/update-status").json()["stale"] is False


def test_status_not_stale_when_endpoint_ahead(client, monkeypatch):
    _set_endpoint(monkeypatch, endpoint={"endpoint_id": "ep1"})
    monkeypatch.setattr(runpod_api, "get_endpoint_image",
                        lambda k, e: "hearmeman/comfyui-serverless:v26")
    assert client.get("/api/comfygen/update-status").json()["stale"] is False


def test_status_fails_closed_on_runpod_error(client, monkeypatch):
    _set_endpoint(monkeypatch, endpoint={"endpoint_id": "ep1"})

    def boom(k, e):
        raise runpod_api.RunPodAPIError("down")

    monkeypatch.setattr(runpod_api, "get_endpoint_image", boom)
    body = client.get("/api/comfygen/update-status").json()
    assert body["stale"] is False
    assert body["current_tag"] is None


def test_status_not_stale_without_api_key(client, monkeypatch):
    _set_endpoint(monkeypatch, endpoint={"endpoint_id": "ep1"}, api_key=None)
    assert client.get("/api/comfygen/update-status").json()["stale"] is False


def test_status_unparseable_current_tag_not_stale(client, monkeypatch):
    _set_endpoint(monkeypatch, endpoint={"endpoint_id": "ep1"})
    monkeypatch.setattr(runpod_api, "get_endpoint_image",
                        lambda k, e: "hearmeman/comfyui-serverless:latest")
    assert client.get("/api/comfygen/update-status").json()["stale"] is False


# --- update ---------------------------------------------------------------

def test_update_calls_runpod_with_latest_image(client, monkeypatch):
    _set_endpoint(monkeypatch, endpoint={"endpoint_id": "ep1"})
    calls = {}
    monkeypatch.setattr(runpod_api, "update_endpoint_image",
                        lambda k, e, img: calls.update(k=k, e=e, img=img) or {"ok": 1})
    body = client.post("/api/comfygen/update").json()
    assert calls == {"k": "key", "e": "ep1", "img": "hearmeman/comfyui-serverless:v25"}
    assert body["ok"] is True
    assert "v25" in body["message"] and "1 hour" in body["message"]


def test_update_patches_cuda_before_image_when_floor_present(client, monkeypatch):
    monkeypatch.setattr(runtime_manifest, "latest_comfygen",
                        lambda: {**LATEST, "min_cuda_version": "13.0"})
    _set_endpoint(monkeypatch, endpoint={"endpoint_id": "ep1"})
    order = []
    monkeypatch.setattr(runpod_api, "update_endpoint_cuda",
                        lambda k, e, c: order.append(("cuda", e, c)))
    monkeypatch.setattr(runpod_api, "update_endpoint_image",
                        lambda k, e, img: order.append(("image", e, img)))
    assert client.post("/api/comfygen/update").status_code == 200
    assert order == [
        ("cuda", "ep1", "13.0"),
        ("image", "ep1", "hearmeman/comfyui-serverless:v25"),
    ]


def test_update_skips_cuda_when_no_floor(client, monkeypatch):
    _set_endpoint(monkeypatch, endpoint={"endpoint_id": "ep1"})
    called = []
    monkeypatch.setattr(runpod_api, "update_endpoint_cuda",
                        lambda *a: called.append("cuda"))
    monkeypatch.setattr(runpod_api, "update_endpoint_image", lambda *a: called.append("image"))
    client.post("/api/comfygen/update")
    assert called == ["image"]  # LATEST has min_cuda_version=None


def test_update_aborts_image_when_cuda_patch_fails(client, monkeypatch):
    monkeypatch.setattr(runtime_manifest, "latest_comfygen",
                        lambda: {**LATEST, "min_cuda_version": "13.0"})
    _set_endpoint(monkeypatch, endpoint={"endpoint_id": "ep1"})
    image_called = []

    def cuda_boom(k, e, c):
        raise runpod_api.RunPodAPIError("cuda nope")

    monkeypatch.setattr(runpod_api, "update_endpoint_cuda", cuda_boom)
    monkeypatch.setattr(runpod_api, "update_endpoint_image",
                        lambda *a: image_called.append(1))
    assert client.post("/api/comfygen/update").status_code == 502
    assert image_called == []  # image NOT swapped on CUDA failure


def test_update_404_without_endpoint(client, monkeypatch):
    _set_endpoint(monkeypatch, endpoint=None)
    assert client.post("/api/comfygen/update").status_code == 404


def test_update_400_without_api_key(client, monkeypatch):
    _set_endpoint(monkeypatch, endpoint={"endpoint_id": "ep1"}, api_key=None)
    assert client.post("/api/comfygen/update").status_code == 400


def test_update_502_on_runpod_error(client, monkeypatch):
    _set_endpoint(monkeypatch, endpoint={"endpoint_id": "ep1"})

    def boom(k, e, img):
        raise runpod_api.RunPodAPIError("nope")

    monkeypatch.setattr(runpod_api, "update_endpoint_image", boom)
    assert client.post("/api/comfygen/update").status_code == 502

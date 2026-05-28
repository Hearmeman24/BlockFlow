"""Route tests for civitai_share backend: resolve-hashes and resolve-resource.

These power the HITL approval gate — the user sees resolved CivitAI model names
(not raw AutoV2 hex) before clicking Approve, and can paste a workflow URL to
credit a resource that has no detectable hash locally.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend import civitai_client  # noqa: E402


def _load_share_backend():
    """Sidecar files use the `backend.block.py` convention which isn't a
    valid module name, so we load via spec_from_file_location the same way
    backend.main.load_block_sidecars does in production."""
    path = ROOT / "custom_blocks" / "civitai_share" / "backend.block.py"
    spec = importlib.util.spec_from_file_location("civitai_share_backend_for_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


share_backend = _load_share_backend()


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(share_backend.router)
    return TestClient(app)


def _vm(
    version_id: int,
    model_id: int,
    name: str,
    model_name: str | None = None,
    model_type: str | None = None,
) -> civitai_client.CivitAIVersionMetadata:
    return civitai_client.CivitAIVersionMetadata(
        version_id=version_id,
        model_id=model_id,
        name=name,
        base_model="Flux.1 D",
        trigger_words=[],
        primary_file_name=f"{name}.safetensors",
        primary_file_size_kb=100.0,
        download_url=None,
        model_name=model_name,
        model_type=model_type,
    )


# ----- /resolve-hashes -----

def test_resolve_hashes_returns_one_entry_per_input(client, mocker):
    """Three hashes in → three rows out. Resolution order matches input order
    so the gate UI can render rows in the order the user expects. The `name`
    in the response is the human MODEL title (not the version name) so the
    UI shows 'WAN 2.2 SVI 4 Passes' rather than 'v1.0'."""
    mocker.patch.object(
        civitai_client, "fetch_version_by_hash",
        side_effect=[
            _vm(1, 10, "v1.0", model_name="First Model", model_type="Checkpoint"),
            _vm(2, 20, "v2.1", model_name="Second LoRA", model_type="LORA"),
            _vm(3, 30, "Base", model_name="Third Workflow", model_type="Workflows"),
        ],
    )
    body = {"hashes": [
        {"filename": "a.safetensors", "sha256": "a" * 64},
        {"filename": "b.safetensors", "sha256": "b" * 64},
        {"filename": "c.safetensors", "sha256": "c" * 64},
    ]}
    resp = client.post("/resolve-hashes", json=body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    rows = data["resolved"]
    assert [r["sha256"] for r in rows] == ["a" * 64, "b" * 64, "c" * 64]
    # `name` is the model title, with the version preserved separately
    # so the UI can render "First Model (v1.0)" if it wants.
    assert rows[0]["name"] == "First Model"
    assert rows[0]["versionName"] == "v1.0"
    assert rows[0]["type"] == "Checkpoint"
    assert rows[0]["modelVersionId"] == 1
    assert rows[0]["modelId"] == 10
    assert rows[1]["name"] == "Second LoRA"
    assert rows[1]["type"] == "LORA"
    assert rows[2]["name"] == "Third Workflow"
    assert rows[2]["type"] == "Workflows"


def test_resolve_hashes_falls_back_to_version_name_when_model_missing(client, mocker):
    """If model.name is absent (older payloads), don't render empty — fall
    back to the version name. Better to show 'v1' than nothing."""
    mocker.patch.object(
        civitai_client, "fetch_version_by_hash",
        return_value=_vm(1, 10, "v1", model_name=None, model_type=None),
    )
    resp = client.post(
        "/resolve-hashes",
        json={"hashes": [{"filename": "a.safetensors", "sha256": "a" * 64}]},
    )
    rows = resp.json()["resolved"]
    assert rows[0]["name"] == "v1"  # fell back to version name
    assert rows[0]["versionName"] == "v1"


def test_resolve_hashes_404_renders_as_unknown(client, mocker):
    """A LoRA that's not on CivitAI must NOT crash the batch — the row comes
    back with resolved=false so the gate renders 'Unknown — not on CivitAI'."""
    mocker.patch.object(
        civitai_client, "fetch_version_by_hash",
        side_effect=[_vm(1, 10, "real-lora"), None],
    )
    body = {"hashes": [
        {"filename": "real.safetensors", "sha256": "a" * 64},
        {"filename": "local-only.safetensors", "sha256": "b" * 64},
    ]}
    resp = client.post("/resolve-hashes", json=body)
    assert resp.status_code == 200
    rows = resp.json()["resolved"]
    assert rows[0]["resolved"] is True
    assert rows[0]["name"] == "real-lora"
    assert rows[1]["resolved"] is False
    assert rows[1]["filename"] == "local-only.safetensors"
    # 'modelVersionId' must NOT be present on unresolved rows — the share
    # endpoint uses presence to decide whether to include in meta.resources.
    assert "modelVersionId" not in rows[1]


def test_resolve_hashes_dedupes_repeats(client, mocker):
    """If the same hash appears twice (e.g. one LoRA used in two LoraLoaders
    with different strengths), we should only hit CivitAI once."""
    mock_fetch = mocker.patch.object(
        civitai_client, "fetch_version_by_hash",
        return_value=_vm(1, 10, "shared"),
    )
    body = {"hashes": [
        {"filename": "a.safetensors", "sha256": "a" * 64},
        {"filename": "a.safetensors", "sha256": "a" * 64},
    ]}
    resp = client.post("/resolve-hashes", json=body)
    assert resp.status_code == 200
    assert mock_fetch.call_count == 1
    # both rows still returned so per-input strength can attach later
    assert len(resp.json()["resolved"]) == 2


def test_resolve_hashes_empty_input(client):
    resp = client.post("/resolve-hashes", json={"hashes": []})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "resolved": []}


# ----- /resolve-resource -----

def test_resolve_resource_full_url(client, mocker):
    """Same model-title preference for /resolve-resource: the user pasting
    a model URL wants the title back, not the version label."""
    mocker.patch.object(
        civitai_client, "fetch_version_metadata",
        return_value=_vm(67890, 12345, "v1.0",
                         model_name="WAN 2.2 SVI 4 Passes",
                         model_type="Workflows"),
    )
    resp = client.post(
        "/resolve-resource",
        json={"input": "https://civitai.com/models/12345?modelVersionId=67890"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["resource"]["modelVersionId"] == 67890
    assert body["resource"]["modelId"] == 12345
    assert body["resource"]["name"] == "WAN 2.2 SVI 4 Passes"
    assert body["resource"]["versionName"] == "v1.0"
    assert body["resource"]["type"] == "Workflows"


def test_resolve_resource_model_only_url_uses_latest(client, mocker):
    """A bare /models/<id> URL should resolve to the latest version — the
    user's intent is 'credit this model', and they probably mean the head."""
    mocker.patch.object(
        civitai_client, "fetch_latest_version_for_model",
        return_value=_vm(999, 12345, "Some Model v3"),
    )
    resp = client.post(
        "/resolve-resource",
        json={"input": "https://civitai.com/models/12345"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["resource"]["modelVersionId"] == 999


def test_resolve_resource_bare_version_id(client, mocker):
    mocker.patch.object(
        civitai_client, "fetch_version_metadata",
        return_value=_vm(67890, 12345, "v2"),
    )
    resp = client.post("/resolve-resource", json={"input": "67890"})
    assert resp.status_code == 200
    assert resp.json()["resource"]["modelVersionId"] == 67890


def test_resolve_resource_invalid_input(client):
    resp = client.post("/resolve-resource", json={"input": "not a url"})
    assert resp.status_code == 200  # JSONResponse with ok=False, not HTTP error
    body = resp.json()
    assert body["ok"] is False
    assert "error" in body


def test_resolve_resource_empty_input(client):
    resp = client.post("/resolve-resource", json={"input": ""})
    assert resp.json()["ok"] is False


# ----- removed endpoints -----

def test_post_info_route_is_removed(client):
    """Edit Post mode was deleted. The route must 404 — not silently return
    a stale 'ok:false' shape that could re-enable a half-working UI."""
    resp = client.post("/post-info", json={"token": "x", "post_id": 1})
    assert resp.status_code == 404


def test_add_to_post_route_is_removed(client):
    resp = client.post("/add-to-post", json={"token": "x", "post_id": 1})
    assert resp.status_code == 404

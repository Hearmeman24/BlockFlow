"""Tests for the RunPod API client (sgs-ui-wisp-las.2 Stage A).

The client is a small wrapper over RunPod's GraphQL + REST endpoints. Per
the TDD doctrine, tests mock the HTTP BOUNDARY (curl_cffi.requests) and
exercise the client's URL/auth/body construction + response parsing.

Functions covered:
  - validate_api_key (GraphQL whoami via gpuTypes query)
  - list_gpu_types
  - create_network_volume / delete_network_volume
  - create_template / delete_template
  - create_endpoint / update_endpoint_workers / get_endpoint_health /
    delete_endpoint

The delete trio + update_endpoint_workers are the RunPod teardown sequence
researched earlier (drain → DELETE endpoint → deleteTemplate → DELETE volume).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import runpod_api  # noqa: E402

# === helpers ================================================================

def _resp(status: int, body: dict | str = "") -> MagicMock:
    """Build a fake curl_cffi response object."""
    m = MagicMock()
    m.status_code = status
    m.text = body if isinstance(body, str) else json.dumps(body)
    m.json = lambda: body if isinstance(body, dict) else json.loads(body) if body else {}
    return m


@pytest.fixture(autouse=True)
def reset_module(monkeypatch):
    """Each test gets a fresh patch context."""
    yield


# === validate_api_key =======================================================

def test_validate_api_key_returns_true_on_200_with_data(monkeypatch):
    post = MagicMock(return_value=_resp(200, {"data": {"gpuTypes": [{"id": "NVIDIA H100 80GB"}]}}))
    monkeypatch.setattr(runpod_api._cffi_requests, "post", post)

    assert runpod_api.validate_api_key("rpa_good") is True
    # Verify the HTTP boundary was called with the right shape
    post.assert_called_once()
    call = post.call_args
    assert call.args[0] == runpod_api.GRAPHQL_URL
    assert call.kwargs["headers"]["Authorization"] == "Bearer rpa_good"
    assert call.kwargs["headers"]["Content-Type"] == "application/json"
    assert "gpuTypes" in call.kwargs["json"]["query"]


def test_validate_api_key_returns_false_on_401(monkeypatch):
    post = MagicMock(return_value=_resp(401, "unauthorized"))
    monkeypatch.setattr(runpod_api._cffi_requests, "post", post)

    assert runpod_api.validate_api_key("rpa_bad") is False


def test_validate_api_key_returns_false_on_graphql_error(monkeypatch):
    post = MagicMock(return_value=_resp(200, {"errors": [{"message": "auth error"}]}))
    monkeypatch.setattr(runpod_api._cffi_requests, "post", post)

    assert runpod_api.validate_api_key("rpa_x") is False


def test_validate_api_key_returns_false_on_network_error(monkeypatch):
    post = MagicMock(side_effect=Exception("connection refused"))
    monkeypatch.setattr(runpod_api._cffi_requests, "post", post)

    assert runpod_api.validate_api_key("rpa_x") is False


# === list_gpu_types =========================================================

def test_list_gpu_types_returns_list(monkeypatch):
    gpus = [{"id": "NVIDIA H100 80GB"}, {"id": "NVIDIA RTX 5090"}]
    post = MagicMock(return_value=_resp(200, {"data": {"gpuTypes": gpus}}))
    monkeypatch.setattr(runpod_api._cffi_requests, "post", post)

    assert runpod_api.list_gpu_types("rpa_x") == gpus


def test_list_gpu_types_raises_on_http_error(monkeypatch):
    post = MagicMock(return_value=_resp(500, "internal error"))
    monkeypatch.setattr(runpod_api._cffi_requests, "post", post)

    with pytest.raises(runpod_api.RunPodAPIError, match="500"):
        runpod_api.list_gpu_types("rpa_x")


# === create_network_volume ==================================================

def test_create_network_volume_posts_to_rest(monkeypatch):
    post = MagicMock(return_value=_resp(200, {"id": "vol_abc", "name": "blockflow", "size": 200}))
    monkeypatch.setattr(runpod_api._cffi_requests, "post", post)

    result = runpod_api.create_network_volume("rpa_x", name="blockflow", size_gb=200, datacenter_id="EU-RO-1")

    assert result == {"id": "vol_abc", "name": "blockflow", "size": 200}
    call = post.call_args
    assert call.args[0] == f"{runpod_api.REST_BASE}/networkvolumes"
    assert call.kwargs["headers"]["Authorization"] == "Bearer rpa_x"
    assert call.kwargs["json"] == {"name": "blockflow", "size": 200, "dataCenterId": "EU-RO-1"}


def test_create_network_volume_raises_on_400(monkeypatch):
    post = MagicMock(return_value=_resp(400, "size too small"))
    monkeypatch.setattr(runpod_api._cffi_requests, "post", post)

    with pytest.raises(runpod_api.RunPodAPIError, match="400"):
        runpod_api.create_network_volume("rpa_x", name="x", size_gb=1, datacenter_id="X")


def test_get_network_volume_returns_metadata(monkeypatch):
    """sgs-ui-wisp-las.3 Stage B uses this for the install pre-check.
    RunPod returns total size in GB but no used-space field; the caller
    derives used from Settings."""
    body = {"id": "vol_abc", "name": "ComfyGen Vol", "dataCenterId": "EU-RO-1", "size": 200}
    get = MagicMock(return_value=_resp(200, body))
    monkeypatch.setattr(runpod_api._cffi_requests, "get", get)

    result = runpod_api.get_network_volume("rpa_x", "vol_abc")

    assert result == body
    call = get.call_args
    assert call.args[0] == f"{runpod_api.REST_BASE}/networkvolumes/vol_abc"
    assert call.kwargs["headers"]["Authorization"] == "Bearer rpa_x"


def test_get_network_volume_raises_on_404(monkeypatch):
    get = MagicMock(return_value=_resp(404, "not found"))
    monkeypatch.setattr(runpod_api._cffi_requests, "get", get)

    with pytest.raises(runpod_api.RunPodAPIError, match="404"):
        runpod_api.get_network_volume("rpa_x", "vol_missing")


# === create_template ========================================================

def test_create_template_calls_save_template_mutation(monkeypatch):
    template = {"id": "tmpl_abc", "name": "blockflow-comfygen", "imageName": "img"}
    post = MagicMock(return_value=_resp(200, {"data": {"saveTemplate": template}}))
    monkeypatch.setattr(runpod_api._cffi_requests, "post", post)

    env = {"AWS_ACCESS_KEY_ID": "AKIA", "S3_BUCKET": "my-bucket"}
    result = runpod_api.create_template(
        "rpa_x",
        name="blockflow-comfygen-test",
        image_name=runpod_api.BASE_DOCKER_IMAGE,
        env=env,
    )

    assert result == template
    call = post.call_args
    assert call.args[0] == runpod_api.GRAPHQL_URL
    body = call.kwargs["json"]
    assert "saveTemplate" in body["query"]
    # The mutation must embed the env vars
    assert "AWS_ACCESS_KEY_ID" in body["query"]
    assert "my-bucket" in body["query"]
    assert runpod_api.BASE_DOCKER_IMAGE == "hearmeman/comfyui-serverless:v24"
    assert "hearmeman/comfyui-serverless:v24" in body["query"]
    # Both volumeInGb and containerDiskInGb are required by RunPod's GraphQL
    # schema — live integration test caught the prior bug where one was missing.
    assert "volumeInGb" in body["query"]
    assert "containerDiskInGb" in body["query"]
    assert "isServerless: true" in body["query"]


def test_create_template_raises_on_graphql_error(monkeypatch):
    post = MagicMock(return_value=_resp(200, {"errors": [{"message": "duplicate name"}]}))
    monkeypatch.setattr(runpod_api._cffi_requests, "post", post)

    with pytest.raises(runpod_api.RunPodAPIError, match="duplicate name"):
        runpod_api.create_template("rpa_x", name="x", image_name="i", env={})


# === create_endpoint ========================================================

def test_create_endpoint_posts_to_rest_with_full_config(monkeypatch):
    ep = {"id": "ep_abc", "name": "blockflow-comfygen"}
    post = MagicMock(return_value=_resp(200, ep))
    monkeypatch.setattr(runpod_api._cffi_requests, "post", post)

    result = runpod_api.create_endpoint(
        "rpa_x",
        name="blockflow-comfygen",
        template_id="tmpl_abc",
        gpu_type_ids=["NVIDIA RTX 5090"],
        data_center_ids=["EU-RO-1"],
        network_volume_id="vol_xyz",
        workers_min=0,
        workers_max=3,
        idle_timeout=5,
        execution_timeout_ms=600000,
    )

    assert result == ep
    call = post.call_args
    assert call.args[0] == f"{runpod_api.REST_BASE}/endpoints"
    body = call.kwargs["json"]
    assert body["name"] == "blockflow-comfygen"
    assert body["templateId"] == "tmpl_abc"
    assert body["gpuTypeIds"] == ["NVIDIA RTX 5090"]
    assert body["dataCenterIds"] == ["EU-RO-1"]
    assert body["networkVolumeId"] == "vol_xyz"
    assert body["workersMin"] == 0
    assert body["workersMax"] == 3
    assert body["idleTimeout"] == 5
    assert body["executionTimeoutMs"] == 600000
    # ComfyGen audit: scaler type + value + CUDA constraint are all part of
    # the contract (RunPod's REST schema requires scalerValue with QUEUE_DELAY)
    assert body["scalerType"] == "QUEUE_DELAY"
    assert body["scalerValue"] == 4
    assert body["flashboot"] is True
    # CUDA floor (default) — no exact-version whitelist (sgs-ui-80r)
    assert body["minCudaVersion"] == "12.8"
    assert "allowedCudaVersions" not in body


def test_create_endpoint_uses_supplied_min_cuda(monkeypatch):
    post = MagicMock(return_value=_resp(200, {"id": "ep"}))
    monkeypatch.setattr(runpod_api._cffi_requests, "post", post)
    runpod_api.create_endpoint(
        "rpa_x", name="n", template_id="t", gpu_type_ids=["g"],
        network_volume_id="v", min_cuda_version="13.0",
    )
    assert post.call_args.kwargs["json"]["minCudaVersion"] == "13.0"


def test_update_endpoint_cuda_sets_floor_and_clears_whitelist(monkeypatch):
    patch = MagicMock(return_value=_resp(200, {"id": "ep"}))
    monkeypatch.setattr(runpod_api._cffi_requests, "patch", patch)
    runpod_api.update_endpoint_cuda("rpa_x", "ep1", "13.0")
    assert patch.call_args.args[0] == f"{runpod_api.REST_BASE}/endpoints/ep1"
    assert patch.call_args.kwargs["json"] == {"minCudaVersion": "13.0", "allowedCudaVersions": []}


def test_create_endpoint_raises_on_400(monkeypatch):
    post = MagicMock(return_value=_resp(400, "invalid template"))
    monkeypatch.setattr(runpod_api._cffi_requests, "post", post)

    with pytest.raises(runpod_api.RunPodAPIError, match="400"):
        runpod_api.create_endpoint(
            "rpa_x", name="x", template_id="t", gpu_type_ids=[], network_volume_id="v",
        )


# === get_endpoint_health ====================================================

def test_get_endpoint_health_uses_v2_api(monkeypatch):
    """RunPod's /v2/{id}/health is the worker-health endpoint (not REST /v1)."""
    health = {"workers": {"idle": 0, "ready": 1, "running": 0, "throttled": 0, "initializing": 0}}
    get = MagicMock(return_value=_resp(200, health))
    monkeypatch.setattr(runpod_api._cffi_requests, "get", get)

    result = runpod_api.get_endpoint_health("rpa_x", "ep_abc")

    assert result == health
    call = get.call_args
    assert call.args[0] == "https://api.runpod.ai/v2/ep_abc/health"
    assert call.kwargs["headers"]["Authorization"] == "Bearer rpa_x"


# === update_endpoint_workers ================================================

def test_update_endpoint_workers_patches_rest(monkeypatch):
    """Tear-down sequence step 1: set workersMin/Max=0 to drain."""
    patch = MagicMock(return_value=_resp(200, {"id": "ep_abc", "workersMin": 0, "workersMax": 0}))
    monkeypatch.setattr(runpod_api._cffi_requests, "patch", patch)

    runpod_api.update_endpoint_workers("rpa_x", "ep_abc", workers_min=0, workers_max=0)

    call = patch.call_args
    assert call.args[0] == f"{runpod_api.REST_BASE}/endpoints/ep_abc"
    assert call.kwargs["headers"]["Authorization"] == "Bearer rpa_x"
    assert call.kwargs["json"] == {"workersMin": 0, "workersMax": 0}


# === delete_endpoint ========================================================

def test_delete_endpoint_calls_rest_delete(monkeypatch):
    delete = MagicMock(return_value=_resp(200, {"deleted": True}))
    monkeypatch.setattr(runpod_api._cffi_requests, "delete", delete)

    runpod_api.delete_endpoint("rpa_x", "ep_abc")

    call = delete.call_args
    assert call.args[0] == f"{runpod_api.REST_BASE}/endpoints/ep_abc"
    assert call.kwargs["headers"]["Authorization"] == "Bearer rpa_x"


def test_delete_endpoint_raises_on_404(monkeypatch):
    delete = MagicMock(return_value=_resp(404, "not found"))
    monkeypatch.setattr(runpod_api._cffi_requests, "delete", delete)

    with pytest.raises(runpod_api.RunPodAPIError, match="404"):
        runpod_api.delete_endpoint("rpa_x", "ep_missing")


# === delete_template ========================================================

def test_delete_template_via_graphql_takes_template_name_not_id(monkeypatch):
    """Per the RunPod teardown research: deleteTemplate takes template NAME."""
    post = MagicMock(return_value=_resp(200, {"data": {"deleteTemplate": None}}))
    monkeypatch.setattr(runpod_api._cffi_requests, "post", post)

    runpod_api.delete_template("rpa_x", template_name="blockflow-comfygen-abc123")

    call = post.call_args
    assert call.args[0] == runpod_api.GRAPHQL_URL
    body = call.kwargs["json"]
    assert "deleteTemplate" in body["query"]
    assert "blockflow-comfygen-abc123" in body["query"]


def test_delete_template_raises_on_graphql_error(monkeypatch):
    post = MagicMock(return_value=_resp(200, {"errors": [{"message": "template in use"}]}))
    monkeypatch.setattr(runpod_api._cffi_requests, "post", post)

    with pytest.raises(runpod_api.RunPodAPIError, match="template in use"):
        runpod_api.delete_template("rpa_x", template_name="x")


# === delete_network_volume ==================================================

def test_delete_network_volume_calls_rest_delete(monkeypatch):
    delete = MagicMock(return_value=_resp(200, {"deleted": True}))
    monkeypatch.setattr(runpod_api._cffi_requests, "delete", delete)

    runpod_api.delete_network_volume("rpa_x", "vol_abc")

    call = delete.call_args
    assert call.args[0] == f"{runpod_api.REST_BASE}/networkvolumes/vol_abc"
    assert call.kwargs["headers"]["Authorization"] == "Bearer rpa_x"


def test_delete_network_volume_raises_on_409_when_attached(monkeypatch):
    """Volume can't be deleted while attached — RunPod returns a conflict error."""
    delete = MagicMock(return_value=_resp(409, "volume in use"))
    monkeypatch.setattr(runpod_api._cffi_requests, "delete", delete)

    with pytest.raises(runpod_api.RunPodAPIError, match="409"):
        runpod_api.delete_network_volume("rpa_x", "vol_attached")


# === auth-header consistency (cross-cutting regression) =====================

def test_all_calls_use_bearer_authorization_header(monkeypatch):
    """Regression guard: every HTTP call must use 'Authorization: Bearer <key>'.
    A bug here would silently break auth in production."""
    captured: list[dict] = []

    def capture(method: str):
        def f(url, **kwargs):
            captured.append({"method": method, "url": url, "headers": kwargs.get("headers", {})})
            return _resp(200, {"data": {}})
        return f

    monkeypatch.setattr(runpod_api._cffi_requests, "post", capture("post"))
    monkeypatch.setattr(runpod_api._cffi_requests, "get", capture("get"))
    monkeypatch.setattr(runpod_api._cffi_requests, "patch", capture("patch"))
    monkeypatch.setattr(runpod_api._cffi_requests, "delete", capture("delete"))

    runpod_api.list_gpu_types("rpa_test")
    runpod_api.get_endpoint_health("rpa_test", "ep_x")
    runpod_api.update_endpoint_workers("rpa_test", "ep_x", workers_min=0, workers_max=0)
    runpod_api.delete_endpoint("rpa_test", "ep_x")

    for call in captured:
        assert call["headers"].get("Authorization") == "Bearer rpa_test", (
            f"call {call['method']} {call['url']} missing/wrong Authorization header"
        )

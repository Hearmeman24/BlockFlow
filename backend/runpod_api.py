"""RunPod API client.

Wraps the GraphQL + REST endpoints needed by the setup wizard
(sgs-ui-wisp-las.2) and the Settings tear-down action
(sgs-ui-wisp-las.1 Stage 5.5).

Outbound HTTP uses curl_cffi.requests (consistent with backend/topaz_upscaler.py
and backend/settings_validators.py).

Errors raise `RunPodAPIError` with the upstream status + body excerpt so
callers can surface meaningful messages.
"""
from __future__ import annotations

from typing import Any

from curl_cffi import requests as _cffi_requests

GRAPHQL_URL = "https://api.runpod.io/graphql"
REST_BASE = "https://rest.runpod.io/v1"
V2_BASE = "https://api.runpod.ai/v2"

# ComfyGen-specific constants (will become per-endpoint-type constants once
# the trainer wizard is wired up).
BASE_TEMPLATE_ID = "bdy0gkebsg"
BASE_DOCKER_IMAGE = "hearmeman/comfyui-serverless:v17"
RUNTIME_REPO_URL = "https://github.com/Hearmeman24/remote-comfy-gen-handler.git"
# Docker image is CUDA 12.8.1 — only allow worker GPUs reporting compatible CUDA.
ALLOWED_CUDA_VERSIONS = ["12.9", "12.8"]

# UA matches ComfyGen's value because Cloudflare in front of RunPod blocks
# Python's default urllib UA. curl_cffi handles this differently but we keep
# an explicit UA for consistency + logging visibility.
USER_AGENT = "blockflow/0.1"

REQUEST_TIMEOUT = 30


class RunPodAPIError(RuntimeError):
    """Raised on any non-success response or network failure."""


# === low-level HTTP helpers (the boundary) ==================================

def _headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
    }


def _graphql(api_key: str, query: str) -> dict[str, Any]:
    try:
        resp = _cffi_requests.post(
            GRAPHQL_URL,
            headers=_headers(api_key),
            json={"query": query},
            timeout=REQUEST_TIMEOUT,
        )
    except Exception as exc:
        raise RunPodAPIError(f"network error: {exc}") from exc

    if resp.status_code != 200:
        raise RunPodAPIError(f"GraphQL HTTP {resp.status_code}: {resp.text[:800]}")

    body = resp.json()
    if "errors" in body:
        msg = body["errors"][0].get("message", "unknown GraphQL error")
        raise RunPodAPIError(f"GraphQL error: {msg}")
    return body.get("data", {}) or {}


def _rest_post(api_key: str, path: str, json_body: dict | None = None) -> dict[str, Any]:
    try:
        resp = _cffi_requests.post(
            f"{REST_BASE}{path}",
            headers=_headers(api_key),
            json=json_body or {},
            timeout=REQUEST_TIMEOUT,
        )
    except Exception as exc:
        raise RunPodAPIError(f"network error: {exc}") from exc

    if resp.status_code >= 400:
        raise RunPodAPIError(f"REST HTTP {resp.status_code} POST {path}: {resp.text[:800]}")
    return resp.json() if resp.text else {}


def _rest_patch(api_key: str, path: str, json_body: dict) -> dict[str, Any]:
    try:
        resp = _cffi_requests.patch(
            f"{REST_BASE}{path}",
            headers=_headers(api_key),
            json=json_body,
            timeout=REQUEST_TIMEOUT,
        )
    except Exception as exc:
        raise RunPodAPIError(f"network error: {exc}") from exc

    if resp.status_code >= 400:
        raise RunPodAPIError(f"REST HTTP {resp.status_code} PATCH {path}: {resp.text[:800]}")
    return resp.json() if resp.text else {}


def _rest_delete(api_key: str, path: str) -> dict[str, Any]:
    try:
        resp = _cffi_requests.delete(
            f"{REST_BASE}{path}",
            headers=_headers(api_key),
            timeout=REQUEST_TIMEOUT,
        )
    except Exception as exc:
        raise RunPodAPIError(f"network error: {exc}") from exc

    if resp.status_code >= 400:
        raise RunPodAPIError(f"REST HTTP {resp.status_code} DELETE {path}: {resp.text[:800]}")
    return resp.json() if resp.text else {}


# === pods (sgs-ui-c7n: installer-pod sweeper) ================================

def list_pods(api_key: str) -> list[dict[str, Any]]:
    """Return every pod visible to the given API key. Used by the
    installer-pod sweeper to find orphaned `comfygen-installer-*` pods
    after the BlockFlow process that spawned them is gone.

    Shape comes from RunPod REST `/v1/pods`: each entry has at least
    `id`, `name`, `createdAt` (RFC3339), plus other lifecycle fields
    the sweeper doesn't need.
    """
    data = _rest_get(api_key, "/pods")
    if isinstance(data, list):
        return data
    # Some accounts wrap in {"pods": [...]} — defensive.
    if isinstance(data, dict) and isinstance(data.get("pods"), list):
        return data["pods"]
    return []


def delete_pod(api_key: str, pod_id: str) -> bool:
    """DELETE one pod. Returns True if it's gone (success or already 404),
    False on any other error.

    HTTP 404 → idempotent success; the sweeper races with the CLI's own
    cleanup all the time, that's expected.
    """
    try:
        resp = _cffi_requests.delete(
            f"{REST_BASE}/pods/{pod_id}",
            headers=_headers(api_key),
            timeout=REQUEST_TIMEOUT,
        )
    except Exception as exc:
        raise RunPodAPIError(f"network error: {exc}") from exc

    if resp.status_code == 404:
        return True
    if resp.status_code >= 400:
        raise RunPodAPIError(
            f"REST HTTP {resp.status_code} DELETE /pods/{pod_id}: {resp.text[:800]}"
        )
    return True


def _rest_get(api_key: str, path: str) -> dict[str, Any]:
    try:
        resp = _cffi_requests.get(
            f"{REST_BASE}{path}",
            headers=_headers(api_key),
            timeout=REQUEST_TIMEOUT,
        )
    except Exception as exc:
        raise RunPodAPIError(f"network error: {exc}") from exc

    if resp.status_code >= 400:
        raise RunPodAPIError(f"REST HTTP {resp.status_code} GET {path}: {resp.text[:800]}")
    return resp.json() if resp.text else {}


# === API key + introspection ================================================

def validate_api_key(api_key: str) -> bool:
    """Return True if the key authenticates against the gpuTypes query."""
    try:
        data = _graphql(api_key, "query { gpuTypes { id } }")
    except RunPodAPIError:
        return False
    return bool(data.get("gpuTypes"))


def list_gpu_types(api_key: str) -> list[dict[str, Any]]:
    data = _graphql(api_key, "query { gpuTypes { id displayName memoryInGb } }")
    return data.get("gpuTypes", []) or []


def list_gpu_types_for_deploy(api_key: str) -> list[dict[str, Any]]:
    """Return GPU type metadata used by the ComfyGen deploy recommender."""
    data = _graphql(api_key, """
query {
  gpuTypes {
    id
    displayName
    manufacturer
    memoryInGb
    secureCloud
    communityCloud
    securePrice
    communityPrice
    maxGpuCount
    maxGpuCountSecureCloud
    maxGpuCountCommunityCloud
    minPodGpuCount
    lowestPrice(input: { gpuCount: 1, secureCloud: true }) {
      stockStatus
      uninterruptablePrice
      minimumBidPrice
      maxUnreservedGpuCount
      availableGpuCounts
    }
  }
}
""".strip())
    return data.get("gpuTypes", []) or []


def list_datacenters(api_key: str) -> list[dict[str, Any]]:
    """Return datacenter capability + GPU availability metadata."""
    data = _graphql(api_key, """
query {
  dataCenters {
    id
    name
    region
    storageSupport
    listed
    gpuAvailability {
      gpuTypeId
      gpuTypeDisplayName
      stockStatus
      available
    }
  }
}
""".strip())
    return data.get("dataCenters", []) or []


# === network volumes ========================================================

def create_network_volume(
    api_key: str,
    *,
    name: str,
    size_gb: int,
    datacenter_id: str,
) -> dict[str, Any]:
    return _rest_post(api_key, "/networkvolumes", {
        "name": name,
        "size": size_gb,
        "dataCenterId": datacenter_id,
    })


def delete_network_volume(api_key: str, volume_id: str) -> None:
    _rest_delete(api_key, f"/networkvolumes/{volume_id}")


def get_network_volume(api_key: str, volume_id: str) -> dict[str, Any]:
    """Return the network volume's metadata: id, name, dataCenterId, size (GB).

    Used by the preset installer's disk-space pre-check (sgs-ui-wisp-las.3).
    RunPod's API only exposes total volume size, not used space — the
    installer combines this with sum(installed_preset.disk_size_gb) from
    Settings to estimate free capacity."""
    return _rest_get(api_key, f"/networkvolumes/{volume_id}")


# === templates ==============================================================

def create_template(
    api_key: str,
    *,
    name: str,
    image_name: str,
    env: dict[str, str],
    docker_args: str = "",
    container_disk_in_gb: int = 5,
) -> dict[str, Any]:
    """Create a template via the GraphQL saveTemplate mutation.

    RunPod's REST endpoint for template creation is buggy (per ComfyGen audit);
    GraphQL is the working path. The mutation requires both `containerDiskInGb`
    (worker scratch space) and `volumeInGb` (legacy network-volume size for
    non-serverless pods — set to 0 since serverless attaches volumes at the
    endpoint level).
    """
    env_pairs = ", ".join(
        f'{{ key: "{_gql_escape(k)}", value: "{_gql_escape(v)}" }}' for k, v in env.items()
    )

    query = f"""
mutation {{
  saveTemplate(input: {{
    name: "{_gql_escape(name)}"
    imageName: "{_gql_escape(image_name)}"
    dockerArgs: "{_gql_escape(docker_args)}"
    containerDiskInGb: {container_disk_in_gb}
    volumeInGb: 0
    isServerless: true
    env: [{env_pairs}]
  }}) {{
    id
    name
    imageName
  }}
}}
""".strip()
    data = _graphql(api_key, query)
    return data.get("saveTemplate", {}) or {}


def delete_template(api_key: str, *, template_name: str) -> None:
    """Per RunPod teardown research: deleteTemplate takes the template NAME."""
    query = f'mutation {{ deleteTemplate(templateName: "{_gql_escape(template_name)}") }}'
    _graphql(api_key, query)


# === endpoints ==============================================================

def create_endpoint(
    api_key: str,
    *,
    name: str,
    template_id: str,
    gpu_type_ids: list[str],
    data_center_ids: list[str] | None = None,
    network_volume_id: str,
    workers_min: int = 0,
    workers_max: int = 3,
    idle_timeout: int = 5,
    execution_timeout_ms: int = 3600000,  # 1h — needed for preset installs
) -> dict[str, Any]:
    body = {
        "name": name,
        "templateId": template_id,
        "gpuTypeIds": gpu_type_ids,
        **({"dataCenterIds": data_center_ids} if data_center_ids else {}),
        "networkVolumeId": network_volume_id,
        "workersMin": workers_min,
        "workersMax": workers_max,
        "idleTimeout": idle_timeout,
        "executionTimeoutMs": execution_timeout_ms,
        "scalerType": "QUEUE_DELAY",
        "scalerValue": 4,
        "flashboot": True,
        "allowedCudaVersions": ALLOWED_CUDA_VERSIONS,
    }
    return _rest_post(api_key, "/endpoints", body)


def update_endpoint_workers(
    api_key: str,
    endpoint_id: str,
    *,
    workers_min: int,
    workers_max: int,
) -> dict[str, Any]:
    """Tear-down sequence step 1: drain workers to zero before DELETE."""
    return _rest_patch(api_key, f"/endpoints/{endpoint_id}", {
        "workersMin": workers_min,
        "workersMax": workers_max,
    })


def delete_endpoint(api_key: str, endpoint_id: str) -> None:
    _rest_delete(api_key, f"/endpoints/{endpoint_id}")


def get_endpoint_health(api_key: str, endpoint_id: str) -> dict[str, Any]:
    """Worker-health endpoint at /v2 (not REST /v1)."""
    try:
        resp = _cffi_requests.get(
            f"{V2_BASE}/{endpoint_id}/health",
            headers=_headers(api_key),
            timeout=REQUEST_TIMEOUT,
        )
    except Exception as exc:
        raise RunPodAPIError(f"network error: {exc}") from exc

    if resp.status_code >= 400:
        raise RunPodAPIError(f"v2 HTTP {resp.status_code}: {resp.text[:800]}")
    return resp.json()


# === helpers ================================================================

def _gql_escape(value: str) -> str:
    """Escape a string for inline GraphQL embedding (we build queries as strings
    to match ComfyGen's pattern). Only handles \\, ", \\n — sufficient for the
    env-var + name values we put in."""
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")

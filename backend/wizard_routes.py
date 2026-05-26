"""ComfyGen setup wizard backend (sgs-ui-wisp-las.2 Stage B).

Orchestrates the runpod_api client + Settings store to spin up a new
ComfyGen serverless endpoint, or attach an existing one. Each provisioning
attempt is all-or-nothing: on failure, any partially-created resources
(volume, template) are rolled back so we don't leave dangling RunPod
resources for the user to clean up manually.

The trainer wizard flow (.5) lives behind a separate stub route; deferred
until the trainer image is publishable.
"""
from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend import runpod_api, settings_store

router = APIRouter()

# === ComfyGen tier definitions (mirrors ComfyGen init.py TIERS) =============

TIERS: dict[str, dict[str, Any]] = {
    "budget": {
        "name": "Budget",
        "gpu_ids": ["NVIDIA GeForce RTX 5090"],
        "datacenter": "EU-RO-1",
        "label": "RTX 5090 (32GB)",
        "region": "Europe — Romania",
    },
    "recommended": {
        "name": "Recommended",
        # Multiple RTX PRO 6000 Blackwell variants widen the scheduling pool
        # (matches the user's working ComfyGen endpoint config). A100 SXM as
        # a fallback for capacity headroom.
        "gpu_ids": [
            "NVIDIA RTX PRO 6000 Blackwell Server Edition",
            "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
            "NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition",
            "NVIDIA A100-SXM4-80GB",
        ],
        "datacenter": "EUR-IS-1",
        "label": "RTX PRO 6000 / A100 SXM (96/80GB)",
        "region": "Europe — Iceland",
    },
    "performance": {
        "name": "Performance",
        "gpu_ids": ["NVIDIA H100 NVL", "NVIDIA H100 PCIe"],
        "datacenter": "US-KS-2",
        "label": "H100 NVL / H100 PCIe (94/80GB)",
        "region": "US — Kansas",
    },
}

# Required credentials must be present + non-empty.
REQUIRED_R2_CREDS: tuple[str, ...] = (
    "r2_access_key_id",
    "r2_secret_access_key",
    "r2_bucket",
)

# Optional credentials can be present with empty value (e.g. r2_endpoint_url
# is empty when targeting AWS S3 rather than Cloudflare R2 — the boto3 client
# falls back to its default AWS endpoint).
OPTIONAL_S3_CREDS: tuple[str, ...] = (
    "r2_endpoint_url",
    "r2_region",
)

DEFAULT_VOLUME_SIZE_GB = 200
DEFAULT_MAX_WORKERS = 3

# sgs-ui-5nn: preflight only treats a cached validation as 'valid' if recorded
# within the last 10 minutes. Older entries report status=stale and force the
# UI to refresh before unlocking the Set up button.
VALIDATION_TTL_SECONDS = 600

REQUIRED_VALIDATOR_SERVICES: tuple[str, ...] = ("runpod", "r2")
OPTIONAL_VALIDATOR_SERVICES: tuple[str, ...] = ("civitai",)


# === request bodies =========================================================

class ProvisionBody(BaseModel):
    tier: Literal["budget", "recommended", "performance"] = "budget"
    volume_size_gb: int = Field(DEFAULT_VOLUME_SIZE_GB, ge=10, le=10000)
    max_workers: int = Field(DEFAULT_MAX_WORKERS, ge=1, le=10)
    name: str | None = None


class AttachBody(BaseModel):
    endpoint_id: str = Field(..., min_length=1)
    volume_id: str | None = None


# === helpers ================================================================

def _required_creds_present() -> tuple[bool, list[str]]:
    """Returns (ready, missing_credentials)."""
    missing = []
    if not settings_store.get_credential("runpod_api_key"):
        missing.append("runpod_api_key")
    for r2_field in REQUIRED_R2_CREDS:
        if not settings_store.get_credential(r2_field):
            missing.append(r2_field)
    return (not missing, missing)


def _required_services_validated() -> tuple[bool, list[str]]:
    """sgs-ui-5nn: backend defense-in-depth gate. Returns (ok, problems).

    `problems` lists services that aren't currently usable: not yet validated,
    stale, or last-validated as failed. Empty list means all required services
    have status=valid within VALIDATION_TTL_SECONDS.

    This is what provision/attach refuse on — independent of UI gating so a
    direct curl can't bypass it.
    """
    problems: list[str] = []
    for svc in REQUIRED_VALIDATOR_SERVICES:
        status = _service_status(
            svc, missing_creds=_service_credentials_missing(svc)
        )["status"]
        if status != "valid":
            problems.append(f"{svc}:{status}")
    return (not problems, problems)


def _build_env_for_template() -> dict[str, str]:
    """Construct the env-var bundle that gets baked into the RunPod template."""
    env = {
        "RUNTIME_REPO_URL": runpod_api.RUNTIME_REPO_URL,
        "RUNTIME_REPO_REF": "main",
        # R2 creds (S3-compatible)
        "AWS_ACCESS_KEY_ID": settings_store.get_credential("r2_access_key_id") or "",
        "AWS_SECRET_ACCESS_KEY": settings_store.get_credential("r2_secret_access_key") or "",
        "S3_BUCKET": settings_store.get_credential("r2_bucket") or "",
        # Default 'auto' matches Cloudflare R2; AWS S3 users override via the
        # optional r2_region credential (e.g. 'eu-west-2').
        "S3_REGION": settings_store.get_credential("r2_region") or "auto",
        "S3_ENDPOINT_URL": settings_store.get_credential("r2_endpoint_url") or "",
    }
    # Optional CivitAI token if present
    civitai = settings_store.get_credential("civitai_api_key")
    if civitai:
        env["CIVITAI_TOKEN"] = civitai
    return env


def _short_id() -> str:
    return uuid.uuid4().hex[:8]


# === routes =================================================================

def _service_status(service: str, *, missing_creds: bool) -> dict[str, Any]:
    """Compute the gating status for a single validator service.

    Status values:
      - credentials_missing: the underlying credential(s) are empty in Settings.
      - unvalidated:         creds present but no validation has been recorded.
      - stale:               last validation older than VALIDATION_TTL_SECONDS.
      - invalid:             last validation ran and returned ok=False.
      - valid:               last validation ok=True and fresh.
    """
    if missing_creds:
        return {"status": "credentials_missing", "validated_at": None, "error": None}

    record = settings_store.get_credential_validation(service)
    if record is None:
        return {"status": "unvalidated", "validated_at": None, "error": None}

    if not record["ok"]:
        return {
            "status": "invalid",
            "validated_at": record["validated_at"],
            "error": record["error"],
        }

    # Check freshness against TTL.
    from datetime import datetime, timezone
    try:
        ts = datetime.fromisoformat(record["validated_at"])
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return {
            "status": "stale",
            "validated_at": record["validated_at"],
            "error": None,
        }
    age = (datetime.now(timezone.utc) - ts).total_seconds()
    if age > VALIDATION_TTL_SECONDS:
        return {"status": "stale", "validated_at": record["validated_at"], "error": None}
    return {"status": "valid", "validated_at": record["validated_at"], "error": None}


def _service_credentials_missing(service: str) -> bool:
    """Whether any underlying credential the validator depends on is empty.

    For r2 we mirror the existing `_required_creds_present` rule: r2_endpoint_url
    is OPTIONAL (empty means AWS S3 default), so its absence does NOT count
    as credentials_missing here.
    """
    if service == "runpod":
        return not settings_store.get_credential("runpod_api_key")
    if service == "r2":
        for field in REQUIRED_R2_CREDS:
            if not settings_store.get_credential(field):
                return True
        return False
    if service == "civitai":
        return not settings_store.get_credential("civitai_api_key")
    return False


@router.get("/api/wizard/comfygen/preflight")
def preflight() -> JSONResponse:
    """Aggregate gating state for the ComfyGen wizard.

    Backwards-compat: `ready` and `missing` keys retained. New: a `services`
    map giving per-validator status (valid / unvalidated / stale / invalid /
    credentials_missing). `ready=True` requires all REQUIRED services to be
    `valid`. Optional services (CivitAI) never gate `ready` but are surfaced
    for the wizard UI to render the yellow recommended banner.
    """
    _, missing = _required_creds_present()

    services: dict[str, dict[str, Any]] = {}
    for svc in REQUIRED_VALIDATOR_SERVICES:
        services[svc] = {
            **_service_status(svc, missing_creds=_service_credentials_missing(svc)),
            "required": True,
        }
    for svc in OPTIONAL_VALIDATOR_SERVICES:
        services[svc] = {
            **_service_status(svc, missing_creds=_service_credentials_missing(svc)),
            "required": False,
        }

    ready = all(
        services[svc]["status"] == "valid" for svc in REQUIRED_VALIDATOR_SERVICES
    )

    return JSONResponse({
        "ready": ready,
        "missing": missing,
        "services": services,
    })


@router.get("/api/wizard/comfygen/tiers")
def tiers() -> JSONResponse:
    return JSONResponse({
        "tiers": [{"id": tier_id, **spec} for tier_id, spec in TIERS.items()],
    })


@router.post("/api/wizard/comfygen/provision")
def provision(body: ProvisionBody) -> JSONResponse:
    if body.tier not in TIERS:
        raise HTTPException(status_code=400, detail=f"unknown tier '{body.tier}'; allowed: {list(TIERS)}")

    ready, missing = _required_creds_present()
    if not ready:
        raise HTTPException(
            status_code=400,
            detail=f"missing required credentials in Settings: {missing}",
        )

    # sgs-ui-5nn: backend defense-in-depth gate. Refuse to spawn RunPod
    # resources unless all required services have a fresh `valid` row.
    services_ok, problems = _required_services_validated()
    if not services_ok:
        raise HTTPException(
            status_code=400,
            detail=(
                f"credentials not validated within TTL: {problems} — "
                "open Settings → Credentials and re-validate before provisioning"
            ),
        )

    api_key = settings_store.get_credential("runpod_api_key")
    assert api_key  # ready=True guarantees it
    tier = TIERS[body.tier]

    suffix = _short_id()
    name = body.name or f"blockflow-comfygen-{suffix}"
    template_name = f"{name}-template-{suffix}"

    # Step 1: network volume
    try:
        volume = runpod_api.create_network_volume(
            api_key,
            name=name,
            size_gb=body.volume_size_gb,
            datacenter_id=tier["datacenter"],
        )
    except runpod_api.RunPodAPIError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    volume_id = volume["id"]

    # Step 2: template (rollback volume on failure)
    try:
        template = runpod_api.create_template(
            api_key,
            name=template_name,
            image_name=runpod_api.BASE_DOCKER_IMAGE,
            env=_build_env_for_template(),
        )
    except runpod_api.RunPodAPIError as exc:
        _safe_delete_volume(api_key, volume_id)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    template_id = template["id"]

    # Step 3: endpoint (rollback volume + template on failure)
    try:
        endpoint = runpod_api.create_endpoint(
            api_key,
            name=name,
            template_id=template_id,
            gpu_type_ids=tier["gpu_ids"],
            network_volume_id=volume_id,
            workers_min=0,
            workers_max=body.max_workers,
        )
    except runpod_api.RunPodAPIError as exc:
        _safe_delete_template(api_key, template_name)
        _safe_delete_volume(api_key, volume_id)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    endpoint_id = endpoint["id"]

    # Persist to Settings. template_name is required so future tear-down can
    # call deleteTemplate (which takes NAME not ID).
    settings_store.set_endpoint(
        "comfygen",
        endpoint_id=endpoint_id,
        volume_id=volume_id,
        template_id=template_id,
        template_name=template_name,
        gpu_tier=body.tier,
        volume_size_gb=body.volume_size_gb,
        max_workers=body.max_workers,
    )

    return JSONResponse({
        "endpoint_id": endpoint_id,
        "template_id": template_id,
        "template_name": template_name,
        "volume_id": volume_id,
        "name": name,
        "tier": body.tier,
        "status": "provisioning",
    })


@router.post("/api/wizard/comfygen/attach")
def attach(body: AttachBody) -> JSONResponse:
    api_key = settings_store.get_credential("runpod_api_key")
    if not api_key:
        raise HTTPException(status_code=400, detail="runpod_api_key not configured in Settings")

    # sgs-ui-5nn: attach gates on the same validation cache as provision —
    # specifically the R2 round-trip, which catches "attached endpoint uses
    # a different bucket than current Settings" failures before they bake
    # into the persisted endpoint row.
    services_ok, problems = _required_services_validated()
    if not services_ok:
        raise HTTPException(
            status_code=400,
            detail=(
                f"credentials not validated within TTL: {problems} — "
                "open Settings → Credentials and re-validate before attaching"
            ),
        )

    # Verify the endpoint is reachable + the API key has access to it.
    try:
        runpod_api.get_endpoint_health(api_key, body.endpoint_id)
    except runpod_api.RunPodAPIError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"could not reach endpoint {body.endpoint_id}: {exc}",
        ) from exc

    settings_store.set_endpoint(
        "comfygen",
        endpoint_id=body.endpoint_id,
        volume_id=body.volume_id,
    )

    ep = settings_store.get_endpoint("comfygen")
    return JSONResponse(ep)


@router.get("/api/wizard/comfygen/health/{endpoint_id}")
def health(endpoint_id: str) -> JSONResponse:
    api_key = settings_store.get_credential("runpod_api_key")
    if not api_key:
        raise HTTPException(status_code=400, detail="runpod_api_key not configured in Settings")
    try:
        result = runpod_api.get_endpoint_health(api_key, endpoint_id)
    except runpod_api.RunPodAPIError as exc:
        raise HTTPException(status_code=502, detail=f"upstream RunPod error: {exc}") from exc
    return JSONResponse(result)


@router.post("/api/wizard/comfygen/teardown")
def teardown() -> JSONResponse:
    """Tear down the user's ComfyGen endpoint + template + volume.

    Sequence (matches the .2 grilling research):
        1. drain workers (workers_min=0, workers_max=0)
        2. DELETE endpoint
        3. deleteTemplate by NAME (GraphQL)
        4. DELETE network volume

    Each step is best-effort: if an upstream resource is already gone
    (e.g. user deleted via the RunPod console), we log a warning and
    continue. If ALL upstream calls fail (RunPod outage), Settings is
    kept so the user can see what failed and retry.
    """
    api_key = settings_store.get_credential("runpod_api_key")
    if not api_key:
        raise HTTPException(status_code=400, detail="runpod_api_key not configured in Settings")

    ep = settings_store.get_endpoint("comfygen")
    if ep is None:
        raise HTTPException(status_code=404, detail="no ComfyGen endpoint configured to tear down")

    endpoint_id = ep["endpoint_id"]
    template_name = ep.get("template_name")
    volume_id = ep.get("volume_id")

    warnings: list[str] = []
    successes: list[str] = []

    # 1. Drain workers (idle them out)
    try:
        runpod_api.update_endpoint_workers(api_key, endpoint_id, workers_min=0, workers_max=0)
        successes.append("drain")
    except runpod_api.RunPodAPIError as exc:
        warnings.append(f"endpoint drain failed (already gone?): {exc}")

    # 2. Delete endpoint
    try:
        runpod_api.delete_endpoint(api_key, endpoint_id)
        successes.append("endpoint")
    except runpod_api.RunPodAPIError as exc:
        warnings.append(f"endpoint delete failed: {exc}")

    # 3. Delete template (requires NAME not ID)
    if template_name:
        try:
            runpod_api.delete_template(api_key, template_name=template_name)
            successes.append("template")
        except runpod_api.RunPodAPIError as exc:
            warnings.append(f"template delete failed: {exc}")
    else:
        warnings.append(
            "no template_name in Settings (likely a legacy endpoint provisioned before "
            "sgs-ui-wisp-las.2 Stage B.5) — skipping template cleanup. Delete it manually "
            "via the RunPod console if it's orphaned."
        )

    # 4. Delete volume
    if volume_id:
        try:
            runpod_api.delete_network_volume(api_key, volume_id)
            successes.append("volume")
        except runpod_api.RunPodAPIError as exc:
            warnings.append(f"volume delete failed: {exc}")

    # If NOTHING upstream worked, keep Settings so the user can retry.
    if not successes:
        raise HTTPException(
            status_code=502,
            detail=f"all RunPod cleanup steps failed: {warnings}",
        )

    # At least one resource was cleaned up — drop the Settings record so the
    # UI returns to "not configured" + the user can re-run the wizard.
    settings_store.delete_endpoint("comfygen")

    return JSONResponse({
        "ok": True,
        "deleted": {
            "endpoint_id": endpoint_id,
            "template_name": template_name,
            "volume_id": volume_id,
        },
        "successes": successes,
        "warnings": warnings,
    })


# === rollback helpers =======================================================

def _safe_delete_volume(api_key: str, volume_id: str) -> None:
    try:
        runpod_api.delete_network_volume(api_key, volume_id)
    except runpod_api.RunPodAPIError:
        # Best-effort cleanup; ignore failures (user can still manually delete
        # via RunPod console, and the original error gets surfaced to the user).
        pass


def _safe_delete_template(api_key: str, template_name: str) -> None:
    try:
        runpod_api.delete_template(api_key, template_name=template_name)
    except runpod_api.RunPodAPIError:
        pass

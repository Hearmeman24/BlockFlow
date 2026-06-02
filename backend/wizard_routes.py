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
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend import runpod_api, runtime_manifest, settings_store

router = APIRouter()

# === ComfyGen deploy recommendation tiers ===================================

DEPLOY_TIERS: list[dict[str, Any]] = [
    {
        "id": "minimum_viable",
        "name": "Minimum viable",
        "target_vram_gb": 32,
        "target_label": "32GB",
        "gpu_ids": [
            "NVIDIA RTX PRO 4500 Blackwell",
            "NVIDIA GeForce RTX 5090",
        ],
    },
    {
        "id": "starter",
        "name": "Starter",
        "target_vram_gb": 48,
        "target_label": "48GB",
        "gpu_ids": [
            "NVIDIA A40",
            "NVIDIA L40S",
            "NVIDIA L40",
            "NVIDIA RTX A6000",
            "NVIDIA RTX 6000 Ada Generation",
            "NVIDIA RTX PRO 5000 Blackwell",
        ],
    },
    {
        "id": "recommended",
        "name": "Recommended",
        "target_vram_gb": 80,
        "target_label": "80/96GB",
        "gpu_ids": [
            "NVIDIA H100 80GB HBM3",
            "NVIDIA A100-SXM4-80GB",
            "NVIDIA A100 80GB PCIe",
            "NVIDIA H100 PCIe",
            "NVIDIA RTX PRO 6000 Blackwell Server Edition",
            "NVIDIA H100 NVL",
            "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
            "NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition",
        ],
    },
    {
        "id": "best",
        "name": "Best",
        "target_vram_gb": 96,
        "target_label": "96/141GB",
        "gpu_ids": [
            "NVIDIA RTX PRO 6000 Blackwell Server Edition",
            "NVIDIA H100 NVL",
            "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
            "NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition",
            "NVIDIA H200",
            "NVIDIA H200 NVL",
        ],
    },
]

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

REQUIRED_VALIDATOR_SERVICES: tuple[str, ...] = ("runpod", "r2")
OPTIONAL_VALIDATOR_SERVICES: tuple[str, ...] = ("civitai",)

# sgs-ui-5nn Step 8: when the registry is unreachable and we can't pick a
# quickstart preset from it, fall back to this hardcoded id. Must exist as a
# valid preset in the public registry. Easily replaceable per release.
_QUICKSTART_FALLBACK_ID = "sdxl-turbo-quickstart"


# === request bodies =========================================================

class ProvisionBody(BaseModel):
    tier: str = Field(..., min_length=1)
    datacenter: str = Field(..., min_length=1)
    primary_gpu_id: str = Field(..., min_length=1)
    fallback_gpu_ids: list[str] = Field(default_factory=list, max_length=2)
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

    `problems` lists services that aren't currently usable: missing, not yet
    validated, or last-validated as failed. Empty list means all required
    services have status=valid.

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


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _stock_rank(stock: str | None) -> int:
    return {"High": 3, "Medium": 2, "Low": 1}.get(stock or "", 0)


def _gpu_price(gpu: dict[str, Any]) -> float | None:
    lowest = gpu.get("lowestPrice") or {}
    for key in ("uninterruptablePrice", "securePrice", "communityPrice"):
        value = lowest.get(key) if key in lowest else gpu.get(key)
        if isinstance(value, (int, float)) and value > 0:
            return float(value)
    return None


def _gpu_option(
    *,
    gpu: dict[str, Any],
    availability: dict[str, Any],
    primary_memory_gb: int | None = None,
    primary_price: float | None = None,
) -> dict[str, Any]:
    memory_gb = int(gpu.get("memoryInGb") or 0)
    price = _gpu_price(gpu)
    warnings: list[str] = []
    if primary_price is not None and price is not None and price > primary_price:
        warnings.append(f"Higher cost than primary (${price:.2f}/hr).")
    if primary_memory_gb is not None and memory_gb < primary_memory_gb:
        warnings.append("Less VRAM than primary; larger workflows may fail.")
    return {
        "gpu_type_id": gpu["id"],
        "display_name": gpu.get("displayName") or gpu["id"],
        "memory_gb": memory_gb,
        "price_per_hr": price,
        "stock": availability.get("stockStatus") or "unknown",
        "warnings": warnings,
    }


def _recommend_deploy_options(
    gpu_types: list[dict[str, Any]],
    datacenters: list[dict[str, Any]],
    *,
    checked_at: str | None = None,
    source: str = "live",
) -> list[dict[str, Any]]:
    """Build one-volume/same-region deploy recommendations.

    A recommendation is valid only when a listed datacenter supports network
    volumes and reports concrete same-region stock for at least one tier GPU.
    The route returns one tier group with concrete GPU+datacenter deployment
    options, rather than collapsing each tier to one winner.
    """
    checked_at = checked_at or _now_iso()
    gpu_by_id = {
        g["id"]: g
        for g in gpu_types
        if g.get("id")
        and (g.get("manufacturer") or "NVIDIA").upper() == "NVIDIA"
        and ((g.get("memoryInGb") or 0) >= 32 or "5090" in g.get("id", ""))
    }
    tier_options: list[dict[str, Any]] = []
    for tier in DEPLOY_TIERS:
        tier_gpu_ids = [gid for gid in tier["gpu_ids"] if gid in gpu_by_id]
        deployment_options: list[tuple[int, int, float, str, str, dict[str, Any]]] = []
        for dc in datacenters:
            if not dc.get("listed") or not dc.get("storageSupport"):
                continue
            available = [
                a for a in (dc.get("gpuAvailability") or [])
                if (
                    a.get("available")
                    and a.get("gpuTypeId") in tier_gpu_ids
                    and _stock_rank(a.get("stockStatus")) > 0
                )
            ]
            if not available:
                continue

            available_by_id = {a["gpuTypeId"]: a for a in available}
            for primary_availability in available:
                primary_id = primary_availability["gpuTypeId"]
                primary_gpu = gpu_by_id[primary_id]
                primary = _gpu_option(gpu=primary_gpu, availability=primary_availability)
                fallback_available = [
                    available_by_id[gid]
                    for gid in tier_gpu_ids
                    if gid in available_by_id and gid != primary_id
                ]
                fallback_available.sort(key=lambda a: (
                    -_stock_rank(a.get("stockStatus")),
                    tier_gpu_ids.index(a["gpuTypeId"]),
                    _gpu_price(gpu_by_id[a["gpuTypeId"]]) or 999.0,
                ))
                fallbacks = [
                    _gpu_option(
                        gpu=gpu_by_id[a["gpuTypeId"]],
                        availability=a,
                        primary_memory_gb=primary["memory_gb"],
                        primary_price=primary["price_per_hr"],
                    )
                    for a in fallback_available[:2]
                ]
                option = {
                    "id": f"{dc['id']}:{primary_id}",
                    "datacenter": dc["id"],
                    "region": dc.get("region") or dc.get("name") or dc["id"],
                    "label": f"{primary['display_name']} ({primary['memory_gb']}GB)",
                    "gpu_ids": [primary["gpu_type_id"]],
                    "primary": primary,
                    "fallback_candidates": fallbacks,
                    "reasons": [
                        f"{primary['memory_gb']}GB primary GPU in a network-volume datacenter.",
                        f"RunPod reports {primary['stock']} stock; availability is not guaranteed until a worker starts.",
                    ],
                    "warnings": [
                        "Optional fallback GPUs are not selected automatically.",
                        "RunPod tries selected GPUs in priority order.",
                    ],
                    "checked_at": checked_at,
                    "source": source,
                }
                deployment_options.append((
                    _stock_rank(primary_availability.get("stockStatus")),
                    -tier_gpu_ids.index(primary_id),
                    -(_gpu_price(primary_gpu) or 999.0),
                    dc["id"],
                    primary_id,
                    option,
                ))

        if not deployment_options:
            continue

        deployment_options.sort(key=lambda x: (x[0], x[1], x[2], x[3], x[4]), reverse=True)
        options = [option for *_meta, option in deployment_options]
        prices = [
            option["primary"]["price_per_hr"]
            for option in options
            if isinstance(option["primary"]["price_per_hr"], (int, float))
        ]
        tier_options.append({
            "id": tier["id"],
            "name": tier["name"],
            "target_vram_gb": tier["target_vram_gb"],
            "target_label": tier["target_label"],
            "deployment_options": options,
            "option_count": len(options),
            "gpu_family_count": len({option["primary"]["gpu_type_id"] for option in options}),
            "min_price_per_hr": min(prices) if prices else None,
            "checked_at": checked_at,
            "source": source,
        })
    return tier_options


# === routes =================================================================

def _service_status(service: str, *, missing_creds: bool) -> dict[str, Any]:
    """Compute the gating status for a single validator service.

    Status values:
      - credentials_missing: the underlying credential(s) are empty in Settings.
      - unvalidated:         creds present but no validation has been recorded.
      - invalid:             last validation ran and returned ok=False.
      - valid:               last validation ok=True.

    Successful validations remain valid until the underlying credential value is
    edited, deleted, or a later provider validation records ok=False.
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
    map giving per-validator status (valid / unvalidated / invalid /
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


@router.get("/api/wizard/comfygen/quickstart-preset")
def quickstart_preset() -> JSONResponse:
    """Step 8 picker: smallest non-CivitAI preset in the registry.

    Resolution order:
      1. Walk the manifest in ascending size order, return the first whose
         models[*].url doesn't reference civitai.com (`fallback=False`).
      2. If picker returned nothing (registry unreachable or every preset
         requires CivitAI): try the hardcoded fallback id against the
         manifest cache, return with `fallback=True`.
      3. If neither (registry fully down and fallback id not in any cache):
         return `{preset_id: fallback_id, fallback: True, preset_url: None}`
         so the UI can render "registry unreachable — try later".
      4. If the fallback id is deliberately set to a missing value (test
         monkeypatch): surface 502 — the wizard cannot offer Step 8.
    """
    from backend import preset_routes

    picked = preset_routes.pick_quickstart_preset()
    if picked is not None:
        return JSONResponse({**picked, "fallback": False})

    fallback_id = _QUICKSTART_FALLBACK_ID
    manifest = preset_routes._cache["manifest"] or preset_routes._load_disk_cache()
    if manifest:
        for entry in manifest.get("presets") or []:
            if entry.get("id") == fallback_id:
                return JSONResponse({
                    "preset_id": entry["id"],
                    "name": entry.get("name") or entry["id"],
                    "disk_size_estimate_gb": entry.get("disk_size_estimate_gb"),
                    "preset_url": entry.get("preset_url"),
                    "fallback": True,
                })
        # Manifest reached the cache but fallback id isn't in it. The wizard
        # cannot offer Step 8 — surface 502 so the UI disables it explicitly.
        raise HTTPException(
            status_code=502,
            detail=(
                f"no quickstart preset available — registry reachable but "
                f"every preset requires CivitAI and fallback id "
                f"'{fallback_id}' is not in the manifest"
            ),
        )

    # Manifest never reached us (registry fully down + no disk cache). Return
    # a bare stub so the UI can render 'registry unreachable — Browse manually'
    # rather than a hard error.
    return JSONResponse({
        "preset_id": fallback_id,
        "name": fallback_id,
        "disk_size_estimate_gb": None,
        "preset_url": None,
        "fallback": True,
    })


@router.get("/api/wizard/comfygen/tiers")
def tiers() -> JSONResponse:
    api_key = settings_store.get_credential("runpod_api_key")
    if not api_key:
        return JSONResponse({
            "source": "unavailable",
            "error": "runpod_api_key not configured",
            "tiers": [],
        })
    try:
        options = _recommend_deploy_options(
            runpod_api.list_gpu_types_for_deploy(api_key),
            runpod_api.list_datacenters(api_key),
        )
    except runpod_api.RunPodAPIError as exc:
        return JSONResponse({
            "source": "unavailable",
            "error": str(exc),
            "tiers": [],
        })
    if not options:
        return JSONResponse({
            "source": "unavailable",
            "error": "RunPod returned no storage-backed GPU availability",
            "tiers": [],
        })
    return JSONResponse({"source": "live", "tiers": options})


@router.post("/api/wizard/comfygen/provision")
def provision(body: ProvisionBody) -> JSONResponse:
    allowed_tiers = {tier["id"] for tier in DEPLOY_TIERS}
    if body.tier not in allowed_tiers:
        raise HTTPException(status_code=400, detail=f"unknown tier '{body.tier}'; allowed: {sorted(allowed_tiers)}")
    if len({body.primary_gpu_id, *body.fallback_gpu_ids}) != 1 + len(body.fallback_gpu_ids):
        raise HTTPException(status_code=400, detail="duplicate GPU ids are not allowed")

    ready, missing = _required_creds_present()
    if not ready:
        raise HTTPException(
            status_code=400,
            detail=f"missing required credentials in Settings: {missing}",
        )

    # sgs-ui-5nn: backend defense-in-depth gate. Refuse to spawn RunPod
    # resources unless all required services have a `valid` row.
    services_ok, problems = _required_services_validated()
    if not services_ok:
        raise HTTPException(
            status_code=400,
            detail=f"credentials not validated: {problems}",
        )

    api_key = settings_store.get_credential("runpod_api_key")
    assert api_key  # ready=True guarantees it
    suffix = _short_id()
    name = body.name or f"blockflow-comfygen-{suffix}"
    template_name = f"{name}-template-{suffix}"

    # Step 1: network volume
    try:
        volume = runpod_api.create_network_volume(
            api_key,
            name=name,
            size_gb=body.volume_size_gb,
            datacenter_id=body.datacenter,
        )
    except runpod_api.RunPodAPIError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    volume_id = volume["id"]

    # Step 2: template (rollback volume on failure)
    try:
        template = runpod_api.create_template(
            api_key,
            name=template_name,
            image_name=runtime_manifest.resolve_comfygen_image(),
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
            gpu_type_ids=[body.primary_gpu_id, *body.fallback_gpu_ids],
            data_center_ids=[body.datacenter],
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
            detail=f"credentials not validated: {problems}",
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

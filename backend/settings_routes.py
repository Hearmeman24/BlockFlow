"""HTTP routes for the settings store (sgs-ui-wisp-las.1 Stage 1).

Three URL spaces:
  - /api/settings/credentials   — API keys, R2 creds
  - /api/settings/endpoints     — ComfyGen + AIO trainer config
  - /api/settings/app-prefs     — output dir, retention policy, etc.

Validation endpoints (which call external services) are out of scope for
Stage 1 — those will live alongside these routes in Stage 1.5.
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from backend import settings_store, settings_validators

router = APIRouter()

ALLOWED_ENDPOINT_TYPES: frozenset[str] = frozenset({"comfygen", "aio_trainer"})


# === Pydantic request bodies ===============================================

class CredentialBody(BaseModel):
    value: str


class AppPrefBody(BaseModel):
    value: str


class EndpointBody(BaseModel):
    endpoint_id: str = Field(..., min_length=1)
    volume_id: str | None = None
    template_id: str | None = None
    gpu_tier: str | None = None
    volume_size_gb: int | None = None
    max_workers: int | None = None
    provisioned_at: str | None = None


# === credentials ============================================================

@router.get("/api/settings/credentials")
def list_credentials() -> JSONResponse:
    return JSONResponse({"credentials": settings_store.list_credentials()})


@router.get("/api/settings/credentials/{name}")
def get_credential(name: str) -> JSONResponse:
    value = settings_store.get_credential(name)
    if value is None:
        raise HTTPException(status_code=404, detail=f"credential not found: {name}")
    return JSONResponse({
        "name": name,
        "value": value,
        "updated_at": settings_store.get_credential_updated_at(name),
    })


@router.put("/api/settings/credentials/{name}")
def put_credential(name: str, body: CredentialBody) -> JSONResponse:
    settings_store.set_credential(name, body.value)
    return JSONResponse({"name": name, "saved": True})


@router.delete("/api/settings/credentials/{name}", status_code=204)
def delete_credential(name: str) -> Response:
    settings_store.delete_credential(name)
    return Response(status_code=204)


# === endpoints ==============================================================

@router.get("/api/settings/endpoints")
def list_endpoints() -> JSONResponse:
    types = settings_store.list_endpoints()
    endpoints = [settings_store.get_endpoint(t) for t in types]
    return JSONResponse({"endpoints": endpoints})


@router.get("/api/settings/endpoints/{type}")
def get_endpoint(type: str) -> JSONResponse:
    ep = settings_store.get_endpoint(type)
    if ep is None:
        raise HTTPException(status_code=404, detail=f"endpoint not configured: {type}")
    return JSONResponse(ep)


@router.put("/api/settings/endpoints/{type}")
def put_endpoint(type: str, body: EndpointBody) -> JSONResponse:
    if type not in ALLOWED_ENDPOINT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"unknown endpoint type '{type}'; allowed: {sorted(ALLOWED_ENDPOINT_TYPES)}",
        )
    settings_store.set_endpoint(type, **body.model_dump())
    return JSONResponse(settings_store.get_endpoint(type))


@router.delete("/api/settings/endpoints/{type}", status_code=204)
def delete_endpoint(type: str) -> Response:
    settings_store.delete_endpoint(type)
    return Response(status_code=204)


# === app_prefs ==============================================================

@router.get("/api/settings/app-prefs/{name}")
def get_app_pref(name: str, default: str | None = Query(default=None)) -> JSONResponse:
    return JSONResponse({"name": name, "value": settings_store.get_app_pref(name, default=default)})


def _validate_app_pref(name: str, value: str) -> None:
    """sgs-ui-se7: per-pref validation hooks. Today only output_dir is
    validated — caught before persistence so the UI shows the error
    inline instead of letting a bad path silently fall back to default
    on next launch. Empty string is allowed (means 'use default')."""
    if name != "output_dir" or value == "":
        return
    p = Path(value).expanduser()
    if not p.exists():
        raise HTTPException(status_code=400, detail=f"output_dir {value!r} does not exist")
    if not p.is_dir():
        raise HTTPException(status_code=400, detail=f"output_dir {value!r} is not a directory")
    if not os.access(p, os.W_OK):
        raise HTTPException(status_code=400, detail=f"output_dir {value!r} is not writable")


@router.put("/api/settings/app-prefs/{name}")
def put_app_pref(name: str, body: AppPrefBody) -> JSONResponse:
    _validate_app_pref(name, body.value)
    settings_store.set_app_pref(name, body.value)
    return JSONResponse({"name": name, "saved": True})


# === validation =============================================================

@router.post("/api/settings/validate/{service}")
def validate_service(service: str) -> JSONResponse:
    validator = settings_validators.VALIDATORS.get(service)
    if validator is None:
        raise HTTPException(
            status_code=404,
            detail=f"no validator available for service: {service}",
        )
    try:
        result = validator()
    except settings_validators.CredentialNotConfigured as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # sgs-ui-5nn: cache the verdict so the wizard preflight can read it
    # within the TTL window without re-running the live call.
    from datetime import datetime, timezone
    validated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    settings_store.set_credential_validation(
        service,
        {"ok": result["ok"], "error": result["error"], "validated_at": validated_at},
    )

    return JSONResponse({**result, "validated_at": validated_at})

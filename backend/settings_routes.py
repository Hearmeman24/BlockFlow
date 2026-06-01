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


# === shortcut prefs =========================================================
# Stores per-shortcut enable/disable flags in settings_app_prefs under the
# namespaced key "shortcut.<id>.enabled". The sentinel id "__master__" is the
# master enable/disable toggle. (sgs-ui-77x)

_SHORTCUT_PREFIX = "shortcut."
_SHORTCUT_SUFFIX = ".enabled"


def _read_shortcut_prefs() -> dict[str, bool]:
    out: dict[str, bool] = {}
    with settings_store._get_conn() as conn:
        rows = conn.execute(
            "SELECT name, value FROM settings_app_prefs WHERE name LIKE ?",
            (f"{_SHORTCUT_PREFIX}%{_SHORTCUT_SUFFIX}",),
        ).fetchall()
    for row in rows:
        name = row["name"]
        sid = name[len(_SHORTCUT_PREFIX) : -len(_SHORTCUT_SUFFIX)]
        out[sid] = row["value"] == "true"
    return out


@router.get("/api/settings/shortcuts")
def get_shortcut_prefs() -> dict[str, bool]:
    return _read_shortcut_prefs()


@router.put("/api/settings/shortcuts")
def put_shortcut_prefs(prefs: dict[str, bool]) -> dict[str, bool]:
    for sid, enabled in prefs.items():
        settings_store.set_app_pref(
            f"{_SHORTCUT_PREFIX}{sid}{_SHORTCUT_SUFFIX}",
            "true" if enabled else "false",
        )
    return _read_shortcut_prefs()


# === validation =============================================================

@router.get("/api/settings/validate/{service}")
def get_validation_status(service: str) -> JSONResponse:
    """Read the *cached* validation verdict for a service without running a
    live (slow/network) validation. Returns the gating status the Storage tab
    and others use to decide whether a feature is unlocked:
    credentials_missing | unvalidated | invalid | valid.
    """
    if service not in settings_validators.VALIDATORS:
        raise HTTPException(
            status_code=404,
            detail=f"no validator available for service: {service}",
        )
    return JSONResponse(settings_validators.service_status(service))


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

    # sgs-ui-5nn: cache the verdict so wizard preflight and Settings can read
    # it without re-running the live call. Credential edits clear this verdict.
    from datetime import datetime, timezone
    validated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    settings_store.set_credential_validation(
        service,
        {"ok": result["ok"], "error": result["error"], "validated_at": validated_at},
    )

    return JSONResponse({**result, "validated_at": validated_at})

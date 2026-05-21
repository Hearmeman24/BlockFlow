"""Validators for stored credentials.

Each validator reads its required credential(s) from the settings store, calls
the relevant external service, and returns `{ok, error, info}`. External calls
go through small helper functions (`_runpod_graphql_post`, `_make_r2_client`,
`_openrouter_auth_check`) — those are the mock points in tests.

Outbound HTTP uses `curl_cffi.requests` to match the existing pattern in
`backend/topaz_upscaler.py`. boto3 (already a runtime dep) is used for R2.

Validators raise `CredentialNotConfigured` when the prerequisite credentials
are absent; the route layer turns that into a 400. They return a result with
`ok=False` for legitimate validation failures (wrong key, bucket not found,
etc.) so the UI can distinguish "you forgot to fill this in" from "what you
filled in didn't work."
"""
from __future__ import annotations

from typing import Any, Callable, TypedDict

from curl_cffi import requests as _cffi_requests

from backend import settings_store


class ValidationResult(TypedDict):
    ok: bool
    error: str | None
    info: dict[str, Any] | None


class CredentialNotConfigured(Exception):
    """Raised when a validator's required credentials aren't set."""


class ValidationFailed(Exception):
    """Raised by boundary helpers on non-success external calls. Caught by
    each validator and turned into `{ok: False, error: ...}`."""


# === RunPod =================================================================

RUNPOD_GRAPHQL_URL = "https://api.runpod.io/graphql"


def _runpod_graphql_post(*, api_key: str, query: str) -> dict[str, Any]:
    """Boundary: HTTP POST to RunPod GraphQL. Mocked in tests."""
    try:
        resp = _cffi_requests.post(
            RUNPOD_GRAPHQL_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "User-Agent": "blockflow-settings/0.1",
            },
            json={"query": query},
            timeout=10,
        )
    except Exception as exc:
        raise ValidationFailed(f"network error: {exc}") from exc

    if resp.status_code != 200:
        raise ValidationFailed(f"HTTP {resp.status_code}: {resp.text[:200]}")
    try:
        body = resp.json()
    except Exception as exc:
        raise ValidationFailed(f"non-JSON response: {exc}") from exc

    if "errors" in body:
        raise ValidationFailed(f"GraphQL errors: {body['errors']}")
    return body


def validate_runpod() -> ValidationResult:
    api_key = settings_store.get_credential("runpod_api_key")
    if not api_key:
        raise CredentialNotConfigured("runpod_api_key not configured in Settings")

    try:
        body = _runpod_graphql_post(api_key=api_key, query="query { gpuTypes { id } }")
    except ValidationFailed as exc:
        return ValidationResult(ok=False, error=str(exc), info=None)

    gpu_count = len((body.get("data") or {}).get("gpuTypes") or [])
    return ValidationResult(ok=True, error=None, info={"gpu_types_visible": gpu_count})


# === R2 / S3 ================================================================

R2_FIELDS = ("r2_endpoint_url", "r2_access_key_id", "r2_secret_access_key", "r2_bucket")


def _make_r2_client(*, endpoint_url: str, access_key_id: str, secret_access_key: str):
    """Boundary: construct an S3-compatible boto3 client for R2. Mocked in tests."""
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name="auto",
    )


def validate_r2() -> ValidationResult:
    creds = {field: settings_store.get_credential(field) for field in R2_FIELDS}
    missing = sorted(field for field, value in creds.items() if not value)
    if missing:
        raise CredentialNotConfigured(
            f"R2 credentials incomplete; missing: {missing}"
        )

    client = _make_r2_client(
        endpoint_url=creds["r2_endpoint_url"],
        access_key_id=creds["r2_access_key_id"],
        secret_access_key=creds["r2_secret_access_key"],
    )
    try:
        listing = client.list_buckets()
    except ValidationFailed as exc:
        return ValidationResult(ok=False, error=str(exc), info=None)
    except Exception as exc:
        return ValidationResult(ok=False, error=f"{type(exc).__name__}: {exc}", info=None)

    expected_bucket = creds["r2_bucket"]
    bucket_names = [b.get("Name") for b in listing.get("Buckets", [])]
    if expected_bucket not in bucket_names:
        return ValidationResult(
            ok=False,
            error=f"bucket '{expected_bucket}' not found in account (visible: {bucket_names})",
            info=None,
        )

    return ValidationResult(ok=True, error=None, info={"buckets_visible": len(bucket_names)})


# === OpenRouter =============================================================

OPENROUTER_AUTH_URL = "https://openrouter.ai/api/v1/auth/key"


def _openrouter_auth_check(*, api_key: str) -> dict[str, Any]:
    """Boundary: GET OpenRouter's /auth/key. Mocked in tests."""
    try:
        resp = _cffi_requests.get(
            OPENROUTER_AUTH_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "User-Agent": "blockflow-settings/0.1",
            },
            timeout=10,
        )
    except Exception as exc:
        raise ValidationFailed(f"network error: {exc}") from exc

    if resp.status_code != 200:
        raise ValidationFailed(f"HTTP {resp.status_code}")
    try:
        return resp.json()
    except Exception as exc:
        raise ValidationFailed(f"non-JSON response: {exc}") from exc


def validate_openrouter() -> ValidationResult:
    api_key = settings_store.get_credential("openrouter_api_key")
    if not api_key:
        raise CredentialNotConfigured("openrouter_api_key not configured in Settings")

    try:
        body = _openrouter_auth_check(api_key=api_key)
    except ValidationFailed as exc:
        return ValidationResult(ok=False, error=str(exc), info=None)

    label = (body.get("data") or {}).get("label")
    return ValidationResult(ok=True, error=None, info={"label": label} if label else None)


# === Registry ===============================================================

VALIDATORS: dict[str, Callable[[], ValidationResult]] = {
    "runpod": validate_runpod,
    "r2": validate_r2,
    "openrouter": validate_openrouter,
}

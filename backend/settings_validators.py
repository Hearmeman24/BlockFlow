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


R2_ROUND_TRIP_KEY = "sgs-ui/.preflight-test"
R2_ROUND_TRIP_PAYLOAD = b"sgs-ui preflight round-trip test"


def _r2_fetch_presigned(url: str) -> bytes:
    """Boundary: GET a presigned URL. Mocked in tests."""
    try:
        resp = _cffi_requests.get(url, timeout=10)
    except Exception as exc:
        raise ValidationFailed(f"presigned GET network error: {exc}") from exc
    if resp.status_code != 200:
        raise ValidationFailed(f"presigned GET HTTP {resp.status_code}")
    return resp.content


def _stringify_boto_error(exc: Exception) -> str:
    msg = str(exc)
    if "AccessDenied" in msg or "NoSuchBucket" in msg or "Not Found" in msg or "404" in msg:
        return msg
    return f"{type(exc).__name__}: {msg}"


def validate_r2() -> ValidationResult:
    """Verify the R2/S3 credentials can reach the CONFIGURED bucket AND
    perform the same put/presigned-get/delete round-trip the worker runs.

    Order:
      1. head_bucket — catches bucket-name typos + bucket-level perms.
      2. put_object — verifies PutObject perm.
      3. presigned GET + content compare — verifies GetObject perm AND that
         presigned URLs resolve correctly (catches CF R2 host-config issues).
      4. delete_object — cleans up. Failure here is reported via info, NOT a
         hard failure: the round-trip itself succeeded.

    Deliberately does NOT call list_buckets() — R2 tokens scoped to one bucket
    lack ListBuckets perms.
    """
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
    bucket = creds["r2_bucket"]

    # 1. head_bucket
    try:
        client.head_bucket(Bucket=bucket)
    except ValidationFailed as exc:
        return ValidationResult(ok=False, error=str(exc), info=None)
    except Exception as exc:
        return ValidationResult(ok=False, error=_stringify_boto_error(exc), info=None)

    # 2. put_object
    try:
        client.put_object(Bucket=bucket, Key=R2_ROUND_TRIP_KEY, Body=R2_ROUND_TRIP_PAYLOAD)
    except Exception as exc:
        return ValidationResult(ok=False, error=_stringify_boto_error(exc), info=None)

    # 3. presigned GET + content compare
    cleanup_warning: str | None = None
    try:
        url = client.generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket, "Key": R2_ROUND_TRIP_KEY},
            ExpiresIn=60,
        )
    except Exception as exc:
        # Try to clean up the put before returning
        try:
            client.delete_object(Bucket=bucket, Key=R2_ROUND_TRIP_KEY)
        except Exception:
            pass
        return ValidationResult(ok=False, error=_stringify_boto_error(exc), info=None)

    fetched: bytes | None = None
    fetch_error: str | None = None
    try:
        fetched = _r2_fetch_presigned(url)
    except ValidationFailed as exc:
        fetch_error = str(exc)

    # 4. delete_object always attempted
    try:
        client.delete_object(Bucket=bucket, Key=R2_ROUND_TRIP_KEY)
    except Exception as exc:
        cleanup_warning = f"test object orphaned at {R2_ROUND_TRIP_KEY}: {_stringify_boto_error(exc)}"

    if fetch_error:
        return ValidationResult(ok=False, error=fetch_error, info=None)
    if fetched != R2_ROUND_TRIP_PAYLOAD:
        return ValidationResult(
            ok=False,
            error="round-trip content mismatch (presigned URL host config may be wrong)",
            info=None,
        )

    info: dict[str, Any] = {"bucket_reachable": bucket, "round_trip": "ok"}
    if cleanup_warning:
        info["cleanup_warning"] = cleanup_warning
    return ValidationResult(ok=True, error=None, info=info)


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


# === CivitAI ================================================================

CIVITAI_AUTH_URL = "https://civitai.com/api/v1/me"


def _civitai_auth_check(*, api_key: str) -> dict[str, Any]:
    """Boundary: GET CivitAI's /api/v1/me. Mocked in tests."""
    try:
        resp = _cffi_requests.get(
            CIVITAI_AUTH_URL,
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


def validate_civitai() -> ValidationResult:
    api_key = settings_store.get_credential("civitai_api_key")
    if not api_key:
        raise CredentialNotConfigured("civitai_api_key not configured in Settings")

    try:
        body = _civitai_auth_check(api_key=api_key)
    except ValidationFailed as exc:
        return ValidationResult(ok=False, error=str(exc), info=None)

    username = body.get("username") if isinstance(body, dict) else None
    return ValidationResult(
        ok=True,
        error=None,
        info={"username": username} if username else None,
    )


# === HuggingFace (sgs-ui-6px) ===============================================

HF_AUTH_URL = "https://huggingface.co/api/whoami-v2"


def _huggingface_auth_check(*, token: str) -> dict[str, Any]:
    """Boundary: GET HF's whoami-v2 endpoint. 200 → valid token; 401 →
    invalid; anything else is treated as transient. Mocked in tests."""
    try:
        resp = _cffi_requests.get(
            HF_AUTH_URL,
            headers={
                "Authorization": f"Bearer {token}",
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


def validate_huggingface() -> ValidationResult:
    token = settings_store.get_credential("hf_token")
    if not token:
        raise CredentialNotConfigured("hf_token not configured in Settings")

    try:
        body = _huggingface_auth_check(token=token)
    except ValidationFailed as exc:
        return ValidationResult(ok=False, error=str(exc), info=None)

    name = body.get("name") if isinstance(body, dict) else None
    return ValidationResult(
        ok=True,
        error=None,
        info={"username": name} if name else None,
    )


# === Registry ===============================================================

VALIDATORS: dict[str, Callable[[], ValidationResult]] = {
    "runpod": validate_runpod,
    "r2": validate_r2,
    "openrouter": validate_openrouter,
    "civitai": validate_civitai,
    "huggingface": validate_huggingface,
}

# Maps validator service name → the credential names it depends on. Used by
# the store to invalidate cached validation when the underlying credential
# changes.
VALIDATOR_CREDENTIALS: dict[str, tuple[str, ...]] = {
    "runpod": ("runpod_api_key",),
    "r2": R2_FIELDS,
    "openrouter": ("openrouter_api_key",),
    "civitai": ("civitai_api_key",),
    "huggingface": ("hf_token",),
}

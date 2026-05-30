"""Remote asset upload provider selection for loader blocks."""

from __future__ import annotations

import hashlib
import json
import time
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path

from backend import settings_store

ASSET_STORAGE_MODE_PREF = "asset_storage_mode"
ASSET_STORAGE_MODES = {"local_only", "tmpfiles", "r2_signed"}
DEFAULT_ASSET_STORAGE_MODE = "tmpfiles"
DEFAULT_PRESIGNED_TTL_SECONDS = 6 * 60 * 60
TMPFILES_UPLOAD_URL = "https://tmpfiles.org/api/v1/upload"
R2_FIELDS = ("r2_endpoint_url", "r2_access_key_id", "r2_secret_access_key", "r2_bucket")


class RemoteAssetUploadDisabled(RuntimeError):
    """Raised when the user has chosen not to create externally fetchable URLs."""


def get_asset_storage_mode() -> str:
    value = settings_store.get_app_pref(ASSET_STORAGE_MODE_PREF)
    return value if value in ASSET_STORAGE_MODES else DEFAULT_ASSET_STORAGE_MODE


def _make_r2_client(*, endpoint_url: str, access_key_id: str, secret_access_key: str):
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name="auto",
    )


def _safe_name(filename: str) -> str:
    name = Path(filename or "asset").name.strip() or "asset"
    return "".join(ch if ch.isalnum() or ch in {".", "-", "_"} else "-" for ch in name)


def _upload_to_tmpfiles(data: bytes, filename: str, content_type: str) -> str:
    boundary = "----TmpFilesBoundary9876543210"
    safe_name = _safe_name(filename)
    parts = [
        f"--{boundary}".encode(),
        f'Content-Disposition: form-data; name="file"; filename="{safe_name}"'.encode(),
        f"Content-Type: {content_type}".encode(),
        b"",
        data,
        f"--{boundary}--".encode(),
    ]
    multipart_body = b"\r\n".join(parts)

    req = urllib.request.Request(
        TMPFILES_UPLOAD_URL,
        data=multipart_body,
        method="POST",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(multipart_body)),
            "User-Agent": "Mozilla/5.0 (compatible; SGS-UI/1.0)",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        resp_data = json.loads(resp.read().decode("utf-8"))

    url = resp_data.get("data", {}).get("url", "")
    if not url:
        raise RuntimeError(f"tmpfiles upload failed: {resp_data}")
    if "tmpfiles.org/" in url and "/dl/" not in url:
        url = url.replace("tmpfiles.org/", "tmpfiles.org/dl/", 1)
    return url


def _r2_credentials() -> dict[str, str]:
    creds = {field: settings_store.get_credential(field) or "" for field in R2_FIELDS}
    missing = sorted(field for field, value in creds.items() if not value)
    if missing:
        raise RuntimeError(f"R2 credentials incomplete; missing: {missing}")
    return creds


def _upload_to_r2_signed(
    data: bytes,
    *,
    filename: str,
    content_type: str,
    media_kind: str,
) -> dict[str, str | None]:
    creds = _r2_credentials()
    client = _make_r2_client(
        endpoint_url=creds["r2_endpoint_url"],
        access_key_id=creds["r2_access_key_id"],
        secret_access_key=creds["r2_secret_access_key"],
    )
    digest = hashlib.sha256(data).hexdigest()[:16]
    safe_name = _safe_name(filename)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    kind = "video" if media_kind == "video" else "image"
    key = f"blockflow/assets/{kind}/{stamp}-{digest}-{safe_name}"
    bucket = creds["r2_bucket"]
    client.put_object(
        Bucket=bucket,
        Key=key,
        Body=data,
        ContentType=content_type or "application/octet-stream",
    )
    url = client.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": key},
        ExpiresIn=DEFAULT_PRESIGNED_TTL_SECONDS,
    )
    expires_at = datetime.now(UTC) + timedelta(seconds=DEFAULT_PRESIGNED_TTL_SECONDS)
    return {
        "url": url,
        "provider": "r2_signed",
        "expires_at": expires_at.isoformat(),
    }


def upload_asset(
    data: bytes,
    *,
    filename: str,
    content_type: str,
    media_kind: str,
) -> dict[str, str | None]:
    mode = get_asset_storage_mode()
    if mode == "local_only":
        raise RemoteAssetUploadDisabled(
            "Remote asset upload is disabled by local-only storage mode"
        )
    if mode == "r2_signed":
        return _upload_to_r2_signed(
            data,
            filename=filename,
            content_type=content_type,
            media_kind=media_kind,
        )
    return {
        "url": _upload_to_tmpfiles(data, filename, content_type),
        "provider": "tmpfiles",
        "expires_at": None,
    }

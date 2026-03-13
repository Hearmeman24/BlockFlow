"""Shared utility for uploading local files to tmpfiles.org."""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path

TMPFILES_UPLOAD_URL = "https://tmpfiles.org/api/v1/upload"

MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".gif": "image/gif",
}


def is_local_path(url: str) -> bool:
    """Check if a URL is a local /outputs/ path (not publicly accessible)."""
    return url.startswith("/outputs/") or (not url.startswith("http") and "/" in url)


def upload_to_tmpfiles(file_path: Path) -> str:
    """Upload a local file to tmpfiles.org and return a direct download URL.

    Raises RuntimeError on failure.
    """
    if not file_path.exists():
        raise RuntimeError(f"File not found: {file_path}")

    content_type = MIME_TYPES.get(file_path.suffix.lower(), "application/octet-stream")
    file_data = file_path.read_bytes()

    boundary = "----TmpFilesBoundary9876543210"
    parts = [
        f"--{boundary}".encode(),
        f'Content-Disposition: form-data; name="file"; filename="{file_path.name}"'.encode(),
        f"Content-Type: {content_type}".encode(),
        b"",
        file_data,
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

    # Convert view URL to direct download URL
    if "tmpfiles.org/" in url and "/dl/" not in url:
        url = url.replace("tmpfiles.org/", "tmpfiles.org/dl/", 1)

    return url


def ensure_public_url(url: str) -> str:
    """If the URL is a local /outputs/ path, upload to tmpfiles and return public URL.

    If already a public URL (http/https), return as-is.
    """
    if not url or url.startswith("http"):
        return url

    from backend import config

    if url.startswith("/outputs/"):
        local_path = config.LOCAL_OUTPUT_DIR / url.split("/outputs/", 1)[1]
    else:
        local_path = Path(url)

    if not local_path.exists():
        raise RuntimeError(f"Cannot resolve local file: {url}")

    return upload_to_tmpfiles(local_path)

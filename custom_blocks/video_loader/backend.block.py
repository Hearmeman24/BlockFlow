from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from backend import config

router = APIRouter()

TMPFILES_UPLOAD_URL = "https://tmpfiles.org/api/v1/upload"


@router.post("/save-local")
async def save_local(request: Request) -> JSONResponse:
    """Save uploaded video to local /outputs directory."""
    body = await request.body()
    filename = request.headers.get("X-Filename", "video.mp4")

    if not body:
        return JSONResponse({"ok": False, "error": "empty body"}, status_code=400)

    try:
        config.LOCAL_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        # Prefix with timestamp to avoid collisions
        ts = time.strftime("%Y%m%d_%H%M%S")
        safe_name = Path(filename).name  # strip any path components
        dest = config.LOCAL_OUTPUT_DIR / f"{ts}_{safe_name}"
        dest.write_bytes(body)
        video_url = f"/outputs/{dest.name}"
        return JSONResponse({"ok": True, "video_url": video_url})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)})


@router.post("/upload")
async def upload(request: Request) -> JSONResponse:
    body = await request.body()
    filename = request.headers.get("X-Filename", "video.mp4")
    content_type = request.headers.get("X-Content-Type", "video/mp4")

    if not body:
        return JSONResponse({"ok": False, "error": "empty body"}, status_code=400)

    try:
        boundary = "----TmpFilesBoundary9876543210"
        parts = []
        parts.append(f"--{boundary}".encode())
        parts.append(f'Content-Disposition: form-data; name="file"; filename="{filename}"'.encode())
        parts.append(f"Content-Type: {content_type}".encode())
        parts.append(b"")
        parts.append(body)
        parts.append(f"--{boundary}--".encode())
        multipart_body = b"\r\n".join(parts)

        req = urllib.request.Request(
            TMPFILES_UPLOAD_URL,
            data=multipart_body,
            method="POST",
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Content-Length": str(len(multipart_body)),
            },
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            resp_data = json.loads(resp.read().decode("utf-8"))

        url = resp_data.get("data", {}).get("url", "")
        if not url:
            return JSONResponse({"ok": False, "error": f"unexpected response: {resp_data}"})

        # Convert view URL to direct download URL
        if "tmpfiles.org/" in url and "/dl/" not in url:
            url = url.replace("tmpfiles.org/", "tmpfiles.org/dl/", 1)

        return JSONResponse({"ok": True, "video_url": url})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)})

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
    """Save uploaded image to local /outputs directory."""
    body = await request.body()
    filename = request.headers.get("X-Filename", "image.png")

    if not body:
        return JSONResponse({"ok": False, "error": "empty body"}, status_code=400)

    try:
        config.LOCAL_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        ts = time.strftime("%Y%m%d_%H%M%S")
        safe_name = Path(filename).name
        dest = config.LOCAL_OUTPUT_DIR / f"{ts}_{safe_name}"
        dest.write_bytes(body)
        image_url = f"/outputs/{dest.name}"
        return JSONResponse({"ok": True, "image_url": image_url})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)})


@router.post("/upload")
async def upload(request: Request) -> JSONResponse:
    body = await request.body()
    filename = request.headers.get("X-Filename", "image.png")
    content_type = request.headers.get("X-Content-Type", "image/png")

    if not body:
        return JSONResponse({"ok": False, "error": "empty body"}, status_code=400)

    try:
        # Build multipart/form-data manually
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
                "User-Agent": "Mozilla/5.0 (compatible; SGS-UI/1.0)",
            },
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            resp_data = json.loads(resp.read().decode("utf-8"))

        # tmpfiles.org returns {"status": "success", "data": {"url": "https://tmpfiles.org/12345/file.png"}}
        url = resp_data.get("data", {}).get("url", "")
        if not url:
            return JSONResponse({"ok": False, "error": f"unexpected response: {resp_data}"})

        # Convert view URL to direct download URL
        # https://tmpfiles.org/12345/file.png -> https://tmpfiles.org/dl/12345/file.png
        if "tmpfiles.org/" in url and "/dl/" not in url:
            url = url.replace("tmpfiles.org/", "tmpfiles.org/dl/", 1)

        return JSONResponse({"ok": True, "image_url": url})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)})

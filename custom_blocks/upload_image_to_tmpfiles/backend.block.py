from __future__ import annotations

import time
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from backend import asset_uploads, config, image_payload

router = APIRouter()

@router.get("/health")
def health() -> JSONResponse:
    return JSONResponse({"ok": True})


@router.post("/save-local")
async def save_local(request: Request) -> JSONResponse:
    """Save uploaded image to local /outputs directory. Deduplicates by content hash."""
    import hashlib

    body = await request.body()
    filename = request.headers.get("X-Filename", "image.png")

    if not body:
        return JSONResponse({"ok": False, "error": "empty body"}, status_code=400)

    try:
        config.LOCAL_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

        # Check if this exact file already exists in output dir by content hash
        content_hash = hashlib.sha256(body).hexdigest()[:16]
        for existing in config.LOCAL_OUTPUT_DIR.iterdir():
            if existing.is_file() and existing.stat().st_size == len(body):
                if hashlib.sha256(existing.read_bytes()).hexdigest()[:16] == content_hash:
                    image_url = f"/outputs/{existing.name}"
                    return JSONResponse({"ok": True, "image_url": image_url})

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
        prepared = image_payload.prepare_image_for_upload(
            body,
            filename=filename,
            content_type=content_type,
        )
        body = prepared.data
        filename = prepared.name
        content_type = prepared.content_type

        uploaded = asset_uploads.upload_asset(
            body,
            filename=filename,
            content_type=content_type,
            media_kind="image",
        )
        return JSONResponse(
            {
                "ok": True,
                "image_url": uploaded["url"],
                "provider": uploaded["provider"],
                "expires_at": uploaded["expires_at"],
            }
        )
    except asset_uploads.RemoteAssetUploadDisabled as e:
        return JSONResponse({"ok": False, "error": str(e), "provider": "local_only"})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)})

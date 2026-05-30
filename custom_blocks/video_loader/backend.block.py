from __future__ import annotations

import time
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from backend import asset_uploads, config

router = APIRouter()

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
        uploaded = asset_uploads.upload_asset(
            body,
            filename=filename,
            content_type=content_type,
            media_kind="video",
        )
        return JSONResponse(
            {
                "ok": True,
                "video_url": uploaded["url"],
                "provider": uploaded["provider"],
                "expires_at": uploaded["expires_at"],
            }
        )
    except asset_uploads.RemoteAssetUploadDisabled as e:
        return JSONResponse({"ok": False, "error": str(e), "provider": "local_only"})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)})

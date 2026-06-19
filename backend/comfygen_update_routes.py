"""ComfyGen image-update banner endpoints (sgs-ui-cxs).

- GET  /api/comfygen/update-status  → is the configured endpoint behind the
  published image? Current tag is read live from RunPod (endpoint → template →
  imageName); any read error fails closed (stale=False, no false banner).
- POST /api/comfygen/update          → re-image the endpoint via the ComfyGen
  `update_endpoint` recipe. Propagation takes ~1h (rolling release).
"""
from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from backend import runpod_api, runtime_manifest, settings_store

router = APIRouter()

_TAG_RE = re.compile(r"^v(\d+)$")


def _tag_num(tag: str | None) -> int | None:
    m = _TAG_RE.match(tag.strip()) if isinstance(tag, str) else None
    return int(m.group(1)) if m else None


@router.get("/api/comfygen/update-status")
def update_status() -> JSONResponse:
    latest = runtime_manifest.latest_comfygen()
    endpoint = settings_store.get_endpoint("comfygen")
    if not endpoint:
        return JSONResponse({"configured": False, "stale": False, "latest_tag": latest["tag"]})

    current_image = None
    api_key = settings_store.get_credential("runpod_api_key")
    if api_key:
        try:
            current_image = runpod_api.get_endpoint_image(api_key, endpoint["endpoint_id"])
        except runpod_api.RunPodAPIError:
            current_image = None  # fail closed — never a false "update available"

    current_tag = current_image.rsplit(":", 1)[-1] if current_image else None
    current_n, latest_n = _tag_num(current_tag), _tag_num(latest["tag"])
    stale = current_n is not None and latest_n is not None and latest_n > current_n

    return JSONResponse({
        "configured": True,
        "current_tag": current_tag,
        "latest_tag": latest["tag"],
        "latest_image": latest["image"],
        "stale": stale,
        "release_notes": latest["release_notes"],
    })


@router.post("/api/comfygen/update")
def update() -> JSONResponse:
    endpoint = settings_store.get_endpoint("comfygen")
    if not endpoint:
        raise HTTPException(status_code=404, detail="no ComfyGen endpoint configured")
    api_key = settings_store.get_credential("runpod_api_key")
    if not api_key:
        raise HTTPException(status_code=400, detail="runpod_api_key not configured in Settings")

    latest = runtime_manifest.latest_comfygen()
    try:
        # CUDA floor first: for an upgrade the old image still runs on the
        # higher-CUDA hosts, so there's no failing window. Skipped when the
        # manifest carries no floor for this tag.
        if latest["min_cuda_version"]:
            runpod_api.update_endpoint_cuda(api_key, endpoint["endpoint_id"], latest["min_cuda_version"])
        runpod_api.update_endpoint_image(api_key, endpoint["endpoint_id"], latest["image"])
    except runpod_api.RunPodAPIError as exc:
        raise HTTPException(status_code=502, detail=f"RunPod update failed: {exc}") from exc

    return JSONResponse({
        "ok": True,
        "image": latest["image"],
        "message": (
            f"Update to {latest['tag']} started — can take ~1 hour to "
            "propagate to running workers."
        ),
    })

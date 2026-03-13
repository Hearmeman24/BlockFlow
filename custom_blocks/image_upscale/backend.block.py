from __future__ import annotations

import os
import threading
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from backend import config, state
from backend.topaz_image_upscaler import upscale_image

router = APIRouter()

_upscale_jobs: dict[str, dict[str, Any]] = {}
_upscale_lock = threading.Lock()


def _update_job(job_id: str, **updates: Any) -> None:
    with _upscale_lock:
        if job_id in _upscale_jobs:
            _upscale_jobs[job_id].update(updates)
            _upscale_jobs[job_id]["updated_at"] = time.time()


def _run_upscale_job(
    job_id: str,
    source_image: str,
    topaz_api_key: str,
    category: str,
    model: str,
    resolution_preset: str,
    output_format: str,
    face_enhancement: bool,
    face_enhancement_strength: float,
    face_enhancement_creativity: float,
) -> None:
    t0 = time.time()
    try:
        _update_job(job_id, status="RUNNING", remote_status="DOWNLOADING")

        # Resolve source image to local path
        if source_image.startswith(("http://", "https://")):
            ts = time.strftime("%Y%m%d_%H%M%S")
            temp_path = config.LOCAL_OUTPUT_DIR / f"img_upscale_src_{ts}_{job_id[:8]}.png"
            req = urllib.request.Request(source_image)
            with urllib.request.urlopen(req, timeout=120) as resp:
                temp_path.write_bytes(resp.read())
            local_path = temp_path
        elif source_image.startswith("/outputs/"):
            local_path = config.LOCAL_OUTPUT_DIR / source_image.split("/outputs/", 1)[1]
            if not local_path.exists():
                raise RuntimeError(f"Local file not found: {local_path}")
        else:
            local_path = Path(source_image)
            if not local_path.exists():
                raise RuntimeError(f"Cannot resolve source image: {source_image}")

        _update_job(job_id, remote_status="PROCESSING")

        result_path = upscale_image(
            image_path=local_path,
            api_key=topaz_api_key,
            category=category,
            model=model,
            resolution_preset=resolution_preset,
            output_format=output_format,
            face_enhancement=face_enhancement,
            face_enhancement_strength=face_enhancement_strength,
            face_enhancement_creativity=face_enhancement_creativity,
            log=lambda msg: _update_job(job_id, remote_status=msg),
        )

        # Move to outputs if not already there
        if result_path.parent != config.LOCAL_OUTPUT_DIR:
            dest = config.LOCAL_OUTPUT_DIR / result_path.name
            result_path.rename(dest)
            result_path = dest

        local_url = f"/outputs/{result_path.name}"
        _update_job(
            job_id,
            status="COMPLETED",
            image_url=local_url,
            local_image_url=local_url,
            local_file=str(result_path),
            elapsed_seconds=round(time.time() - t0, 3),
            remote_status="COMPLETED",
        )
    except Exception as e:
        _update_job(
            job_id,
            status="FAILED",
            error=str(e),
            elapsed_seconds=round(time.time() - t0, 3),
            remote_status="FAILED",
        )


@router.get("/settings")
def get_settings() -> JSONResponse:
    return JSONResponse({
        "ok": True,
        "has_env_api_key": bool(os.getenv("TOPAZ_API_KEY", "")),
    })


@router.post("/upscale")
async def upscale(request: Request) -> JSONResponse:
    payload = await request.json()
    source_images = payload.get("source_images", [])
    topaz_api_key = str(payload.get("topaz_api_key") or os.getenv("TOPAZ_API_KEY", ""))
    category = str(payload.get("category", "enhance"))
    model = str(payload.get("model", "Standard V2"))
    resolution_preset = str(payload.get("resolution_preset", "4k"))
    output_format = str(payload.get("output_format", "png"))
    face_enhancement = bool(payload.get("face_enhancement", True))
    face_enhancement_strength = float(payload.get("face_enhancement_strength", 0.8))
    face_enhancement_creativity = float(payload.get("face_enhancement_creativity", 0.0))

    if not source_images:
        return JSONResponse({"ok": False, "error": "source_images is required"}, status_code=400)
    if not topaz_api_key:
        return JSONResponse({"ok": False, "error": "Topaz API key is required"}, status_code=400)

    if not isinstance(source_images, list):
        source_images = [source_images]

    job_ids: list[str] = []
    for src in source_images:
        job_id = str(uuid.uuid4())
        now = time.time()
        with _upscale_lock:
            _upscale_jobs[job_id] = {
                "job_id": job_id,
                "status": "QUEUED",
                "remote_status": None,
                "image_url": None,
                "local_image_url": None,
                "local_file": None,
                "error": None,
                "elapsed_seconds": None,
                "created_at": now,
                "updated_at": now,
            }

        state.EXECUTOR.submit(
            _run_upscale_job,
            job_id, str(src), topaz_api_key,
            category, model, resolution_preset, output_format,
            face_enhancement, face_enhancement_strength, face_enhancement_creativity,
        )
        job_ids.append(job_id)

    return JSONResponse({"ok": True, "job_ids": job_ids})


@router.get("/status/{job_id}")
def status(job_id: str) -> JSONResponse:
    with _upscale_lock:
        job = _upscale_jobs.get(job_id)
        if not job:
            return JSONResponse({"job": {"job_id": job_id, "status": "UNKNOWN"}})
        return JSONResponse({"job": dict(job)})

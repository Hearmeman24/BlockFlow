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

from backend import config, media_meta, state
from backend.topaz_upscaler import TopazProgress, upscale_video

router = APIRouter()

# In-memory upscale job tracking
_upscale_jobs: dict[str, dict[str, Any]] = {}
_upscale_lock = threading.Lock()


def _update_upscale_job(job_id: str, **updates: Any) -> None:
    with _upscale_lock:
        if job_id in _upscale_jobs:
            _upscale_jobs[job_id].update(updates)
            _upscale_jobs[job_id]["updated_at"] = time.time()


def _run_upscale_job(
    job_id: str,
    source_video: str,
    topaz_api_key: str,
    enhancement_model: str,
    interpolation_model: str | None,
    output_fps: int | None,
    resolution_preset: str,
    video_encoder: str,
    compression: str,
) -> None:
    t0 = time.time()
    try:
        _update_upscale_job(job_id, status="RUNNING", remote_status="DOWNLOADING")

        # Download source video to temp file
        ts = time.strftime("%Y%m%d_%H%M%S")
        temp_path = config.LOCAL_OUTPUT_DIR / f"upscale_src_{ts}_{job_id[:8]}.mp4"

        if source_video.startswith(("http://", "https://")):
            req = urllib.request.Request(source_video)
            with urllib.request.urlopen(req, timeout=300) as resp:
                temp_path.write_bytes(resp.read())
        elif source_video.startswith("/outputs/"):
            local = config.LOCAL_OUTPUT_DIR / source_video.split("/outputs/", 1)[1]
            if not local.exists():
                raise RuntimeError(f"Local file not found: {local}")
            temp_path = local
        else:
            p = Path(source_video)
            if p.exists():
                temp_path = p
            else:
                raise RuntimeError(f"Cannot resolve source video: {source_video}")

        _update_upscale_job(job_id, remote_status="PROCESSING")

        logs: list[str] = []

        def _log(msg: str) -> None:
            logs.append(msg)
            # Keep last 50 log lines in the job for frontend visibility
            with _upscale_lock:
                if job_id in _upscale_jobs:
                    _upscale_jobs[job_id]["logs"] = logs[-50:]

        def _on_progress(p: TopazProgress) -> None:
            phase_label = p.phase.upper() if p.phase else "PROCESSING"
            fps_str = f" @ {p.avg_fps:.1f} fps" if p.avg_fps > 0 else ""
            status_str = f"{phase_label} {p.progress:.0f}%{fps_str} ({p.elapsed_seconds:.0f}s)"
            _update_upscale_job(
                job_id,
                remote_status=status_str,
                topaz_phase=p.phase,
                topaz_progress=round(p.progress, 1),
                topaz_fps=round(p.avg_fps, 1),
                topaz_elapsed=round(p.elapsed_seconds, 1),
                topaz_request_id=p.topaz_request_id,
                topaz_chunks=p.chunks,
            )

        result_path = upscale_video(
            video_path=temp_path,
            api_key=topaz_api_key,
            enhancement_model=enhancement_model,
            interpolation_model=interpolation_model,
            output_fps=output_fps,
            resolution_preset=resolution_preset,
            video_encoder=video_encoder,
            compression=compression,
            log=_log,
            on_progress=_on_progress,
        )

        # Carry over source metadata and mark as upscaled
        src_meta = media_meta.read_metadata(temp_path) or {}
        src_meta["upscaled"] = True
        media_meta.embed_metadata(result_path, src_meta)

        local_url = f"/outputs/{result_path.name}"
        _update_upscale_job(
            job_id,
            status="COMPLETED",
            video_url=local_url,
            local_video_url=local_url,
            local_file=str(result_path),
            elapsed_seconds=round(time.time() - t0, 3),
            remote_status="COMPLETED",
        )
    except Exception as e:
        _update_upscale_job(
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
    source_videos = payload.get("source_videos", [])
    topaz_api_key = str(payload.get("topaz_api_key") or os.getenv("TOPAZ_API_KEY", ""))
    enhancement_model = str(payload.get("enhancement_model", "ahq-12"))
    interpolation_model = payload.get("interpolation_model", "apo-8")
    output_fps = payload.get("output_fps")
    resolution_preset = str(payload.get("resolution_preset", "4k"))
    video_encoder = str(payload.get("video_encoder", "H265"))
    compression = str(payload.get("compression", "Mid"))

    if not source_videos:
        return JSONResponse({"ok": False, "error": "source_videos is required"}, status_code=400)
    if not topaz_api_key:
        return JSONResponse({"ok": False, "error": "Topaz API key is required"}, status_code=400)

    if not isinstance(source_videos, list):
        source_videos = [source_videos]

    job_ids: list[str] = []
    for src in source_videos:
        job_id = str(uuid.uuid4())
        now = time.time()
        with _upscale_lock:
            _upscale_jobs[job_id] = {
                "job_id": job_id,
                "status": "QUEUED",
                "remote_status": None,
                "video_url": None,
                "local_video_url": None,
                "local_file": None,
                "error": None,
                "elapsed_seconds": None,
                "logs": [],
                "topaz_phase": None,
                "topaz_progress": None,
                "topaz_fps": None,
                "topaz_elapsed": None,
                "topaz_request_id": None,
                "topaz_chunks": None,
                "created_at": now,
                "updated_at": now,
            }

        state.EXECUTOR.submit(
            _run_upscale_job,
            job_id, str(src), topaz_api_key,
            enhancement_model, interpolation_model,
            int(output_fps) if output_fps else None,
            resolution_preset, video_encoder, compression,
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

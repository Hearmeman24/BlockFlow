from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

import json

from backend import config, state, services, tmpfiles

router = APIRouter()


@router.post("/run")
async def run(request: Request) -> JSONResponse:
    payload = await request.json()
    endpoint_id = str(payload.get("endpoint_id") or config.RUNPOD_ENDPOINT_ID)
    prompt = str(payload.get("prompt") or "")
    raw_image_url = str(payload.get("image_url") or "")

    # Auto-upload local files to tmpfiles for RunPod accessibility
    image_url = ""
    if raw_image_url:
        if tmpfiles.is_local_path(raw_image_url):
            print(f"[wan22-i2v] Auto-uploading local image to tmpfiles: {raw_image_url}", flush=True)
            try:
                image_url = tmpfiles.ensure_public_url(raw_image_url)
                print(f"[wan22-i2v] Uploaded: {image_url}", flush=True)
            except Exception as e:
                return JSONResponse({"ok": False, "error": f"Failed to upload image: {e}"}, status_code=400)
        else:
            image_url = raw_image_url
    width = int(payload.get("width", config.DEFAULT_WIDTH))
    height = int(payload.get("height", config.DEFAULT_HEIGHT))
    frames = int(payload.get("frames", config.DEFAULT_FRAMES))
    fps = int(payload.get("fps", config.DEFAULT_FPS))
    parallel_count = min(int(payload.get("parallel_count", 1)), config.MAX_PARALLEL_PER_REQUEST)
    seed_mode = str(payload.get("seed_mode", "random"))
    seed = payload.get("seed")
    loras = payload.get("loras", [])
    negative_prompt = str(payload.get("negative_prompt", config.DEFAULT_NEGATIVE_PROMPT))

    if not endpoint_id:
        return JSONResponse({"ok": False, "error": "endpoint_id is required"}, status_code=400)

    try:
        job_ids: list[str] = []
        for _ in range(parallel_count):
            job_id = str(uuid.uuid4())
            job_input: dict[str, Any] = {
                "task_type": "i2v",
                "prompt": prompt,
                "width": width,
                "height": height,
                "frames": frames,
                "fps": fps,
                "negative_prompt": negative_prompt,
            }
            if image_url:
                job_input["image_url"] = image_url
            if loras:
                job_input["loras"] = loras
            if seed_mode == "fixed" and seed is not None:
                job_input["seed"] = int(seed)

            print(f"[wan22-i2v] RunPod payload for job {job_id}:\n{json.dumps(job_input, indent=2, default=str)}", flush=True)

            record = services._new_job_record(job_id, endpoint_id, job_input)
            with state.JOBS_LOCK:
                state.JOBS[job_id] = record
                state._persist_jobs_locked()

            state.EXECUTOR.submit(services._run_local_job, job_id, endpoint_id, job_input)
            job_ids.append(job_id)

        return JSONResponse({"ok": True, "job_ids": job_ids})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.get("/status/{job_id}")
def status(job_id: str) -> JSONResponse:
    job = services._job_snapshot(job_id)
    if not job:
        return JSONResponse({"job": {"job_id": job_id, "status": "UNKNOWN"}})
    return JSONResponse({"job": job})

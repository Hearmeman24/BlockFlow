"""Seedance 2 / 2-Fast video generation via PiAPI's task API.

Exposes the three Dreamina Seedance modes: text_to_video, first_last_frames,
omni_reference (image + video + audio). Submits to PiAPI's POST /api/v1/task,
polls /api/v1/task/{id}, and streams the resulting mp4 to LOCAL_OUTPUT_DIR.
"""
from __future__ import annotations

import asyncio
import json
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from backend import config, settings_store

router = APIRouter()

PIAPI_BASE = "https://api.piapi.ai"
PIAPI_TASK_URL = f"{PIAPI_BASE}/api/v1/task"
# PiAPI sits behind Cloudflare which 1010-blocks the default python-urllib UA.
PIAPI_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)

POLL_INITIAL_SEC = 5.0
POLL_MAX_SEC = 20.0
POLL_BACKOFF = 1.3
DEFAULT_TIMEOUT_SEC = 60 * 60  # PiAPI queue can stretch past 30m at peak

SEEDANCE_DIR = config.LOCAL_OUTPUT_DIR / "seedance"
SEEDANCE_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_MODES = {"text_to_video", "first_last_frames", "omni_reference"}

# seedance-2 family — `mode`-driven, 4-15 continuous duration, 6 ARs + auto,
#   ALL face references blocked at upstream visual review (no pre-submission).
# *-preview-vip family — `mode`-less, 5/10/15 duration enum, 4 ARs only,
#   non-real faces allowed (tightening), pre-submission moderation +
#   refund on block. With `video_urls` set, output length = input video
#   length and the `duration` field is ignored upstream.
ALLOWED_TASK_TYPES = {
    "seedance-2",
    "seedance-2-fast",
    "seedance-2-preview-vip",
    "seedance-2-fast-preview-vip",
}
VIP_TASK_TYPES = {"seedance-2-preview-vip", "seedance-2-fast-preview-vip"}

VIP_ALLOWED_DURATIONS = {5, 10, 15}
VIP_ALLOWED_ASPECTS = {"16:9", "9:16", "4:3", "3:4"}
TASK_TYPE_RESOLUTIONS: dict[str, set[str]] = {
    "seedance-2": {"480p", "720p", "1080p"},
    "seedance-2-fast": {"480p", "720p"},
    "seedance-2-preview-vip": {"720p", "1080p"},
    "seedance-2-fast-preview-vip": {"720p"},
}

ALLOWED_RESOLUTIONS = {"480p", "720p", "1080p"}
ALLOWED_ASPECTS = {"21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "auto"}
MAX_REFERENCES_TOTAL = 12
MAX_IMAGE_REFS = 9
MAX_VIDEO_REFS = 3
MAX_AUDIO_REFS = 3
MAX_OUTPUT_DURATION = 15
MIN_OUTPUT_DURATION = 4

JOBS_LOCK = Lock()
JOBS: dict[str, dict[str, Any]] = {}


def _api_key() -> str:
    return settings_store.get_credential("piapi_api_key") or ""


def _headers(api_key: str) -> dict[str, str]:
    return {
        "X-API-Key": api_key,
        "Content-Type": "application/json",
        "User-Agent": PIAPI_UA,
    }


def _request_json(method: str, url: str, headers: dict[str, str], payload: dict[str, Any] | None = None, timeout: int = 60) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} from PiAPI: {body[:500]}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"PiAPI request failed: {e}") from e


def _download(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": PIAPI_UA})
    with urllib.request.urlopen(req, timeout=600) as resp, dest.open("wb") as f:
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            f.write(chunk)


@router.get("/health")
def health() -> JSONResponse:
    return JSONResponse({
        "ok": True,
        "piapi_key_present": bool(_api_key()),
        "modes": sorted(ALLOWED_MODES),
        "task_types": sorted(ALLOWED_TASK_TYPES),
        "vip_task_types": sorted(VIP_TASK_TYPES),
        "vip_allowed_durations": sorted(VIP_ALLOWED_DURATIONS),
        "vip_allowed_aspects": sorted(VIP_ALLOWED_ASPECTS),
        "task_type_resolutions": {k: sorted(v) for k, v in TASK_TYPE_RESOLUTIONS.items()},
    })


def _validate_and_build_input(body: dict[str, Any], task_type: str) -> dict[str, Any]:
    """Build the `input` payload for PiAPI. Schema branches by task_type family:

    - seedance-2 / seedance-2-fast: `mode` enum, 4-15 continuous duration,
      6 ARs + auto, 480p/720p/1080p (480p Fast caps at 720p).
    - *-preview-vip: no `mode` field, 5/10/15 duration enum (ignored when
      `video_urls` present), 4 ARs only, 720p/1080p (Fast VIP is 720p-only).
    """
    is_vip = task_type in VIP_TASK_TYPES

    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt is required")
    if len(prompt) > 4000:
        raise ValueError("prompt exceeds 4000 chars")

    def _clean_list(key: str) -> list[str]:
        raw = body.get(key) or []
        if not isinstance(raw, list):
            raise ValueError(f"{key} must be a list")
        return [str(u).strip() for u in raw if isinstance(u, str) and u.strip()]

    images = _clean_list("image_urls")
    videos = _clean_list("video_urls")
    audios = _clean_list("audio_urls")

    allowed_resolutions = TASK_TYPE_RESOLUTIONS[task_type]
    resolution = str(body.get("resolution") or sorted(allowed_resolutions)[0]).lower()
    if resolution not in allowed_resolutions:
        raise ValueError(f"resolution for {task_type} must be one of {sorted(allowed_resolutions)}")

    aspect_ratio = str(body.get("aspect_ratio") or "16:9")

    # === VIP family: mode-less, restricted enums ===
    if is_vip:
        allowed_aspects = VIP_ALLOWED_ASPECTS
        if aspect_ratio not in allowed_aspects:
            raise ValueError(f"aspect_ratio for {task_type} must be one of {sorted(allowed_aspects)}")

        if images and len(images) > MAX_IMAGE_REFS:
            raise ValueError(f"VIP accepts at most {MAX_IMAGE_REFS} images (got {len(images)})")
        if videos and len(videos) > MAX_VIDEO_REFS:
            raise ValueError(f"VIP accepts at most {MAX_VIDEO_REFS} videos (got {len(videos)})")
        if audios and len(audios) > MAX_AUDIO_REFS:
            raise ValueError(f"VIP accepts at most {MAX_AUDIO_REFS} audios (got {len(audios)})")
        if audios and not (images or videos):
            raise ValueError("audio-only is not allowed; pair with image or video")

        payload: dict[str, Any] = {
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "resolution": resolution,
        }
        if images: payload["image_urls"] = images
        if videos: payload["video_urls"] = videos
        if audios: payload["audio_urls"] = audios

        # `duration` is meaningful ONLY without a video reference. When
        # `video_urls` is present, PiAPI sets output length = input video
        # length — but only if `duration` is OMITTED. Sending duration=5
        # caps the output to 5s (a 9s input then renders just 5s). The PiAPI
        # VIP video-reference example sends no duration; the completed VIP
        # response echoes duration:0. So drop it (and skip enum validation,
        # which is irrelevant) whenever a video reference is supplied.
        if not videos:
            duration_raw = body.get("duration", 5)
            try:
                duration = int(duration_raw)
            except (TypeError, ValueError):
                duration = 5
            if duration not in VIP_ALLOWED_DURATIONS:
                raise ValueError(f"duration for {task_type} must be one of {sorted(VIP_ALLOWED_DURATIONS)}")
            payload["duration"] = duration

        return payload

    # === seedance-2 family: mode-driven ===
    mode = str(body.get("mode") or "").strip()
    if mode not in ALLOWED_MODES:
        raise ValueError(f"mode must be one of {sorted(ALLOWED_MODES)}")

    duration_raw = body.get("duration", 5)
    try:
        duration = int(duration_raw)
    except (TypeError, ValueError):
        duration = 5
    if duration < MIN_OUTPUT_DURATION or duration > MAX_OUTPUT_DURATION:
        raise ValueError(f"duration must be {MIN_OUTPUT_DURATION}-{MAX_OUTPUT_DURATION}")

    if aspect_ratio not in ALLOWED_ASPECTS:
        raise ValueError(f"aspect_ratio must be one of {sorted(ALLOWED_ASPECTS)}")

    payload = {
        "prompt": prompt,
        "mode": mode,
        "duration": duration,
        "resolution": resolution,
    }

    if mode == "text_to_video":
        if images or videos or audios:
            raise ValueError("text_to_video accepts no references")
        payload["aspect_ratio"] = aspect_ratio if aspect_ratio != "auto" else "16:9"
    elif mode == "first_last_frames":
        if not images:
            raise ValueError("first_last_frames requires 1-2 images")
        if len(images) > 2:
            raise ValueError("first_last_frames accepts at most 2 images")
        if videos or audios:
            raise ValueError("first_last_frames accepts images only (no videos or audio)")
        payload["image_urls"] = images
        payload["aspect_ratio"] = aspect_ratio
    elif mode == "omni_reference":
        total = len(images) + len(videos) + len(audios)
        if total < 1:
            raise ValueError("omni_reference requires 1-12 references total")
        if total > MAX_REFERENCES_TOTAL:
            raise ValueError(f"omni_reference accepts at most {MAX_REFERENCES_TOTAL} references total (got {total})")
        if audios and not (images or videos):
            raise ValueError("audio-only is not allowed; pair with image or video")
        if len(images) > MAX_IMAGE_REFS:
            raise ValueError(f"omni_reference accepts at most {MAX_IMAGE_REFS} images (got {len(images)})")
        if len(videos) > MAX_VIDEO_REFS:
            raise ValueError(f"omni_reference accepts at most {MAX_VIDEO_REFS} videos (got {len(videos)})")
        if len(audios) > MAX_AUDIO_REFS:
            raise ValueError(f"omni_reference accepts at most {MAX_AUDIO_REFS} audios (got {len(audios)})")
        if aspect_ratio == "auto":
            aspect_ratio = "16:9"
        payload["aspect_ratio"] = aspect_ratio
        if images: payload["image_urls"] = images
        if videos: payload["video_urls"] = videos
        if audios: payload["audio_urls"] = audios

    return payload


async def _submit(api_key: str, task_type: str, input_payload: dict[str, Any]) -> dict[str, Any]:
    body = {
        "model": "seedance",
        "task_type": task_type,
        "input": input_payload,
    }
    return await asyncio.to_thread(
        _request_json, "POST", PIAPI_TASK_URL, _headers(api_key), body, 90
    )


async def _poll_once(api_key: str, task_id: str) -> dict[str, Any]:
    return await asyncio.to_thread(
        _request_json, "GET", f"{PIAPI_TASK_URL}/{task_id}", _headers(api_key), None, 60
    )


async def _run_job(job_id: str, api_key: str, task_type: str, input_payload: dict[str, Any]) -> None:
    def _is_cancelled() -> bool:
        with JOBS_LOCK:
            rec = JOBS.get(job_id)
            return bool(rec and rec.get("cancel_requested"))

    try:
        submit_resp = await _submit(api_key, task_type, input_payload)
        if not isinstance(submit_resp, dict) or submit_resp.get("code") != 200:
            raise RuntimeError(f"submit non-200: {json.dumps(submit_resp)[:500]}")
        data = submit_resp.get("data") or {}
        task_id = data.get("task_id")
        if not task_id:
            raise RuntimeError(f"submit returned no task_id: {json.dumps(data)[:500]}")
        with JOBS_LOCK:
            rec = JOBS.get(job_id)
            if rec is not None:
                rec["remote_id"] = task_id
                rec["status"] = "RUNNING"
                rec["remote_status"] = data.get("status") or "pending"

        interval = POLL_INITIAL_SEC
        deadline = time.monotonic() + DEFAULT_TIMEOUT_SEC
        while True:
            if _is_cancelled():
                with JOBS_LOCK:
                    rec = JOBS.get(job_id)
                    if rec is not None:
                        rec["status"] = "CANCELLED"
                        rec["ended_at"] = time.time()
                return
            if time.monotonic() > deadline:
                raise TimeoutError(f"PiAPI task exceeded {DEFAULT_TIMEOUT_SEC}s")

            await asyncio.sleep(interval)
            interval = min(POLL_MAX_SEC, interval * POLL_BACKOFF)

            try:
                poll = await _poll_once(api_key, task_id)
            except Exception as exc:
                print(f"[seedance] poll {task_id} error: {exc}", flush=True)
                continue

            poll_data = (poll.get("data") if isinstance(poll, dict) else None) or {}
            remote_status = str(poll_data.get("status") or "").lower()
            logs_raw = poll_data.get("logs") or []
            remote_logs = [str(x) for x in logs_raw if isinstance(x, str)]
            with JOBS_LOCK:
                rec = JOBS.get(job_id)
                if rec is not None:
                    rec["remote_status"] = remote_status
                    rec["remote_logs"] = remote_logs

            if remote_status == "completed":
                output = poll_data.get("output") or {}
                video_url = output.get("video") if isinstance(output, dict) else None
                if not video_url:
                    raise RuntimeError(f"completed but no output.video: {json.dumps(poll_data)[:500]}")
                local_path = SEEDANCE_DIR / f"{job_id}.mp4"
                await asyncio.to_thread(_download, video_url, local_path)
                rel_url = f"/outputs/seedance/{local_path.name}"
                with JOBS_LOCK:
                    rec = JOBS.get(job_id)
                    if rec is not None:
                        rec["status"] = "COMPLETED"
                        rec["video_url"] = rel_url
                        rec["remote_url"] = video_url
                        rec["usage"] = (poll_data.get("meta") or {}).get("usage")
                        rec["remote_logs"] = remote_logs
                        rec["ended_at"] = time.time()
                return

            if remote_status == "failed":
                err = poll_data.get("error") or {}
                msg = err.get("message") or err.get("raw_message") or "unknown error"
                raise RuntimeError(f"PiAPI status=failed: {msg}")

    except Exception as exc:
        with JOBS_LOCK:
            rec = JOBS.get(job_id)
            if rec is not None:
                rec["status"] = "FAILED"
                rec["error"] = str(exc)[:600]
                rec["ended_at"] = time.time()


@router.post("/run")
async def run(request: Request) -> JSONResponse:
    body = await request.json()
    api_key = (str(body.get("piapi_api_key") or "").strip() or _api_key())
    if not api_key:
        return JSONResponse({"ok": False, "error": "PiAPI key required (set in Settings)"}, status_code=400)

    task_type = str(body.get("task_type") or "seedance-2-fast")
    if task_type not in ALLOWED_TASK_TYPES:
        return JSONResponse({"ok": False, "error": f"task_type must be one of {sorted(ALLOWED_TASK_TYPES)}"}, status_code=400)

    try:
        input_payload = _validate_and_build_input(body, task_type)
    except ValueError as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

    job_id = uuid.uuid4().hex
    record: dict[str, Any] = {
        "job_id": job_id,
        "status": "QUEUED",
        "remote_status": None,
        "remote_id": None,
        "video_url": None,
        "remote_url": None,
        "usage": None,
        "remote_logs": [],
        "error": "",
        "started_at": time.time(),
        "ended_at": None,
        "cancel_requested": False,
        "task_type": task_type,
        "mode": input_payload.get("mode"),
    }
    with JOBS_LOCK:
        JOBS[job_id] = record

    asyncio.create_task(_run_job(job_id, api_key, task_type, input_payload))
    return JSONResponse({"ok": True, "job_id": job_id})


@router.get("/status/{job_id}")
def status(job_id: str) -> JSONResponse:
    with JOBS_LOCK:
        rec = JOBS.get(job_id)
        if not rec:
            return JSONResponse({"ok": False, "error": "job not found"}, status_code=404)
        return JSONResponse({"ok": True, "job": dict(rec)})


@router.post("/cancel/{job_id}")
def cancel(job_id: str) -> JSONResponse:
    """Mark a job cancelled locally. PiAPI doesn't expose a cancel endpoint
    in the documented surface, so this just stops polling on our side — the
    remote task will continue billing until it finishes upstream."""
    with JOBS_LOCK:
        rec = JOBS.get(job_id)
        if not rec:
            return JSONResponse({"ok": False, "error": "job not found"}, status_code=404)
        rec["cancel_requested"] = True
    return JSONResponse({"ok": True, "note": "local cancel only; remote task still bills"})

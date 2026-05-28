"""Seedance video generation via OpenRouter `/api/v1/videos`.

OpenRouter exposes Seedance 2.0 and Seedance 2.0 Fast (plus 1.5 Pro) through
the async video-generation API. Submit a job, poll until completed, then
stream the rendered MP4 down. The block UI is the source of truth for
parameter shape — we just forward.
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

OPENROUTER_VIDEO_URL = "https://openrouter.ai/api/v1/videos"
OPENROUTER_VIDEO_MODELS_URL = "https://openrouter.ai/api/v1/videos/models"

POLL_INITIAL_SEC = 5.0
POLL_MAX_SEC = 20.0
POLL_BACKOFF = 1.3
DEFAULT_TIMEOUT_SEC = 30 * 60  # 30 minutes (generous, big videos take time)

SEEDANCE_DIR = config.LOCAL_OUTPUT_DIR / "seedance"
SEEDANCE_DIR.mkdir(parents=True, exist_ok=True)

JOBS_LOCK = Lock()
JOBS: dict[str, dict[str, Any]] = {}

_MODELS_CACHE: dict[str, Any] = {"ts": 0.0, "data": []}
_MODELS_TTL_SEC = 600


def _api_key() -> str:
    return settings_store.get_credential("openrouter_api_key") or ""


def _auth_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
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
        raise RuntimeError(f"HTTP {e.code} from OpenRouter: {body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"OpenRouter request failed: {e}") from e


@router.get("/health")
def health() -> JSONResponse:
    return JSONResponse({
        "ok": True,
        "openrouter_key_present": bool(_api_key()),
    })


@router.get("/models")
def models(refresh: int = 0) -> JSONResponse:
    """List Seedance variants discovered from OpenRouter's video models index."""
    now = time.time()
    if not refresh and _MODELS_CACHE.get("data") and (now - float(_MODELS_CACHE.get("ts", 0))) < _MODELS_TTL_SEC:
        return JSONResponse({"ok": True, "models": _MODELS_CACHE["data"], "from_cache": True})

    api_key = _api_key()
    if not api_key:
        return JSONResponse({"ok": False, "error": "openrouter_api_key not set in Settings"}, status_code=400)

    try:
        data = _request_json("GET", OPENROUTER_VIDEO_MODELS_URL, _auth_headers(api_key))
    except Exception as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=502)

    items = [m for m in data.get("data", []) if isinstance(m, dict) and "seedance" in str(m.get("id", "")).lower()]
    _MODELS_CACHE["data"] = items
    _MODELS_CACHE["ts"] = now
    return JSONResponse({"ok": True, "models": items, "from_cache": False})


def _build_payload(body: dict[str, Any]) -> dict[str, Any]:
    model = str(body.get("model") or "bytedance/seedance-2.0")
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt is required")

    payload: dict[str, Any] = {"model": model, "prompt": prompt}

    for key in ("duration", "resolution", "aspect_ratio", "size", "seed"):
        v = body.get(key)
        if v is None or v == "":
            continue
        payload[key] = v

    if body.get("generate_audio") is not None:
        payload["generate_audio"] = bool(body.get("generate_audio"))

    # frame_images: image-to-video (first / last frame)
    first_frame = body.get("first_frame_url")
    last_frame = body.get("last_frame_url")
    frame_images: list[dict[str, Any]] = []
    if isinstance(first_frame, str) and first_frame.strip():
        frame_images.append({
            "type": "image_url",
            "image_url": {"url": first_frame.strip()},
            "frame_type": "first_frame",
        })
    if isinstance(last_frame, str) and last_frame.strip():
        frame_images.append({
            "type": "image_url",
            "image_url": {"url": last_frame.strip()},
            "frame_type": "last_frame",
        })
    if frame_images:
        payload["frame_images"] = frame_images

    # input_references: reference-to-video (style/character guidance)
    refs = body.get("input_references")
    if isinstance(refs, list) and refs:
        payload["input_references"] = [
            {"type": "image_url", "image_url": {"url": u.strip()}}
            for u in refs
            if isinstance(u, str) and u.strip()
        ]

    # Provider passthrough (watermark, req_key) — Seedance supports these.
    provider_options: dict[str, Any] = {}
    if body.get("watermark") is not None:
        provider_options["watermark"] = bool(body.get("watermark"))
    req_key = body.get("req_key")
    if isinstance(req_key, str) and req_key.strip():
        provider_options["req_key"] = req_key.strip()
    if provider_options:
        # Seedance is served by the "seed" provider on OpenRouter.
        payload["provider"] = {"options": {"seed": {"parameters": provider_options}}}

    return payload


async def _submit(api_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(
        _request_json, "POST", OPENROUTER_VIDEO_URL, _auth_headers(api_key), payload, 120
    )


async def _poll_once(api_key: str, polling_url: str) -> dict[str, Any]:
    return await asyncio.to_thread(
        _request_json, "GET", polling_url, _auth_headers(api_key), None, 60
    )


def _download(url: str, dest: Path, api_key: str | None = None) -> None:
    headers: dict[str, str] = {}
    if api_key and url.startswith("https://openrouter.ai/"):
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, method="GET", headers=headers)
    with urllib.request.urlopen(req, timeout=600) as resp, dest.open("wb") as f:
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            f.write(chunk)


async def _run_job(job_id: str, api_key: str, payload: dict[str, Any]) -> None:
    def _is_cancelled() -> bool:
        with JOBS_LOCK:
            rec = JOBS.get(job_id)
            return bool(rec and rec.get("cancel_requested"))

    try:
        submit_resp = await _submit(api_key, payload)
        remote_id = submit_resp.get("id")
        polling_url = submit_resp.get("polling_url") or f"{OPENROUTER_VIDEO_URL}/{remote_id}"
        with JOBS_LOCK:
            rec = JOBS.get(job_id)
            if rec is not None:
                rec["remote_id"] = remote_id
                rec["polling_url"] = polling_url
                rec["status"] = "RUNNING"

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
                raise TimeoutError(f"video gen exceeded {DEFAULT_TIMEOUT_SEC}s")

            await asyncio.sleep(interval)
            interval = min(POLL_MAX_SEC, interval * POLL_BACKOFF)

            poll = await _poll_once(api_key, polling_url)
            remote_status = str(poll.get("status") or "").lower()
            with JOBS_LOCK:
                rec = JOBS.get(job_id)
                if rec is not None:
                    rec["remote_status"] = remote_status

            if remote_status == "completed":
                urls = poll.get("unsigned_urls") or []
                if not urls or not isinstance(urls, list):
                    raise RuntimeError(f"COMPLETED but no unsigned_urls in {poll}")
                content_url = str(urls[0])
                local_path = SEEDANCE_DIR / f"{job_id}.mp4"
                await asyncio.to_thread(_download, content_url, local_path, api_key)
                rel_url = f"/outputs/seedance/{local_path.name}"
                with JOBS_LOCK:
                    rec = JOBS.get(job_id)
                    if rec is not None:
                        rec["status"] = "COMPLETED"
                        rec["video_url"] = rel_url
                        rec["remote_url"] = content_url
                        rec["usage"] = poll.get("usage")
                        rec["ended_at"] = time.time()
                return

            if remote_status in ("failed", "cancelled", "error"):
                err = poll.get("error") or poll
                raise RuntimeError(f"OpenRouter status={remote_status}: {err}")

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
    api_key = (str(body.get("openrouter_api_key") or "").strip() or _api_key())
    if not api_key:
        return JSONResponse({"ok": False, "error": "OpenRouter API key required (set in Settings)"}, status_code=400)

    try:
        payload = _build_payload(body)
    except ValueError as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

    job_id = uuid.uuid4().hex
    record: dict[str, Any] = {
        "job_id": job_id,
        "status": "QUEUED",
        "remote_status": None,
        "remote_id": None,
        "polling_url": None,
        "video_url": None,
        "remote_url": None,
        "usage": None,
        "error": "",
        "started_at": time.time(),
        "ended_at": None,
        "cancel_requested": False,
        "model": payload.get("model"),
    }
    with JOBS_LOCK:
        JOBS[job_id] = record

    asyncio.create_task(_run_job(job_id, api_key, payload))
    return JSONResponse({"ok": True, "job_id": job_id})


@router.get("/status/{job_id}")
def status(job_id: str) -> JSONResponse:
    with JOBS_LOCK:
        rec = JOBS.get(job_id)
        if not rec:
            return JSONResponse({"ok": False, "error": "job not found"}, status_code=404)
        snap = dict(rec)
    return JSONResponse({"ok": True, "job": snap})


@router.post("/cancel/{job_id}")
def cancel(job_id: str) -> JSONResponse:
    with JOBS_LOCK:
        rec = JOBS.get(job_id)
        if not rec:
            return JSONResponse({"ok": False, "error": "job not found"}, status_code=404)
        rec["cancel_requested"] = True
    return JSONResponse({"ok": True})

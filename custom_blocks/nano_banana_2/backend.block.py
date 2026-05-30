"""Nano Banana 2 standalone — single-image generation via the RunPod
`google-nano-banana-2-edit` serverless endpoint.

Same underlying endpoint as `dataset_create`, but exposes a focused
single-image API surface (one prompt → one image) so it can plug into
ad-hoc image pipelines without the dataset-mode overhead.
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

NANO_BANANA_ENDPOINT = "google-nano-banana-2-edit"
NB2_DIR = config.LOCAL_OUTPUT_DIR / "nano_banana_2"
NB2_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_QUALITY = {"1k", "2k", "4k"}
ALLOWED_ASPECT = {"1:1", "9:16", "16:9", "4:3", "3:4", "3:2", "2:3"}
MAX_REFERENCE_IMAGES = 14

POLL_INITIAL_SEC = 2.0
POLL_MAX_SEC = 10.0
POLL_BACKOFF = 1.4
DEFAULT_TIMEOUT_SEC = 600

JOBS_LOCK = Lock()
JOBS: dict[str, dict[str, Any]] = {}


def _api_key() -> str:
    return settings_store.get_credential("runpod_api_key") or ""


def _extract_image_url(output: Any) -> str:
    if isinstance(output, str) and output.startswith("http"):
        return output
    if isinstance(output, list):
        for item in output:
            url = _extract_image_url(item)
            if url:
                return url
        return ""
    if isinstance(output, dict):
        for key in ("image_url", "url", "output_url", "result"):
            v = output.get(key)
            if isinstance(v, str) and v.startswith("http"):
                return v
        for key in ("images", "output", "data"):
            v = output.get(key)
            if v is not None:
                url = _extract_image_url(v)
                if url:
                    return url
    return ""


def _request_json(method: str, url: str, headers: dict[str, str], payload: dict[str, Any] | None = None, timeout: int = 60) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} from RunPod: {body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"RunPod request failed: {e}") from e


def _download(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=max(config.HTTP_TIMEOUT_SEC, 180)) as resp, dest.open("wb") as f:
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            f.write(chunk)


async def _run_job(
    job_id: str,
    api_key: str,
    prompt: str,
    aspect_ratio: str,
    quality: str,
    references: list[str],
) -> None:
    def _is_cancelled() -> bool:
        with JOBS_LOCK:
            rec = JOBS.get(job_id)
            return bool(rec and rec.get("cancel_requested"))

    base = f"{config.RUNPOD_API_BASE.rstrip('/')}/{NANO_BANANA_ENDPOINT}"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    try:
        submit_payload = {
            "input": {
                "prompt": prompt,
                "images": references,
                "resolution": quality,
                "aspect_ratio": aspect_ratio,
                "enable_safety_checker": False,
            }
        }
        submit = await asyncio.to_thread(
            _request_json, "POST", f"{base}/run", headers, submit_payload, 60
        )
        remote_id = submit.get("id") or submit.get("job_id")
        if not remote_id:
            raise RuntimeError(f"submit returned no id: {submit}")
        with JOBS_LOCK:
            rec = JOBS.get(job_id)
            if rec is not None:
                rec["remote_id"] = remote_id

        interval = POLL_INITIAL_SEC
        deadline = time.monotonic() + DEFAULT_TIMEOUT_SEC
        while True:
            if _is_cancelled():
                try:
                    await asyncio.to_thread(
                        _request_json, "POST", f"{base}/cancel/{remote_id}", headers, None, 30
                    )
                except Exception:
                    pass
                with JOBS_LOCK:
                    rec = JOBS.get(job_id)
                    if rec is not None:
                        rec["status"] = "CANCELLED"
                        rec["ended_at"] = time.time()
                return
            if time.monotonic() > deadline:
                raise TimeoutError(f"Nano Banana 2 job exceeded {DEFAULT_TIMEOUT_SEC}s")

            await asyncio.sleep(interval)
            interval = min(POLL_MAX_SEC, interval * POLL_BACKOFF)
            try:
                poll = await asyncio.to_thread(
                    _request_json, "GET", f"{base}/status/{remote_id}", headers, None, 60
                )
            except Exception as exc:
                # transient — try again
                print(f"[nano_banana_2] poll {remote_id} error: {exc}", flush=True)
                continue

            remote_status = str(poll.get("status") or "").upper()
            with JOBS_LOCK:
                rec = JOBS.get(job_id)
                if rec is not None:
                    rec["remote_status"] = remote_status

            if remote_status == "COMPLETED":
                output = poll.get("output")
                img_url = _extract_image_url(output)
                if not img_url:
                    top_result = poll.get("result")
                    if isinstance(top_result, str) and top_result.startswith("http"):
                        img_url = top_result
                if not img_url:
                    raise RuntimeError(f"COMPLETED but no image in {poll}")

                ext = img_url.rsplit(".", 1)[-1].split("?")[0].lower()
                if ext not in ("png", "jpg", "jpeg", "webp"):
                    ext = "png"
                local_path = NB2_DIR / f"{job_id}.{ext}"
                await asyncio.to_thread(_download, img_url, local_path)
                rel_url = f"/outputs/nano_banana_2/{local_path.name}"
                with JOBS_LOCK:
                    rec = JOBS.get(job_id)
                    if rec is not None:
                        rec["status"] = "COMPLETED"
                        rec["image_url"] = rel_url
                        rec["remote_url"] = img_url
                        rec["ended_at"] = time.time()
                return
            if remote_status in ("FAILED", "CANCELLED", "TIMED_OUT"):
                raise RuntimeError(f"RunPod status={remote_status}: {poll.get('error') or poll}")

    except Exception as exc:
        with JOBS_LOCK:
            rec = JOBS.get(job_id)
            if rec is not None:
                rec["status"] = "FAILED"
                rec["error"] = str(exc)[:600]
                rec["ended_at"] = time.time()


@router.get("/health")
def health() -> JSONResponse:
    return JSONResponse({
        "ok": True,
        "runpod_key_present": bool(_api_key()),
        "endpoint": NANO_BANANA_ENDPOINT,
    })


@router.post("/run")
async def run(request: Request) -> JSONResponse:
    body = await request.json()
    api_key = (str(body.get("runpod_api_key") or "").strip() or _api_key())
    prompt = str(body.get("prompt") or "").strip()
    quality = str(body.get("quality") or "1k").lower()
    aspect_ratio = str(body.get("aspect_ratio") or "1:1")
    refs_raw = body.get("reference_image_urls") or []

    if not api_key:
        return JSONResponse({"ok": False, "error": "RunPod API key required"}, status_code=400)
    if not prompt:
        return JSONResponse({"ok": False, "error": "prompt required"}, status_code=400)
    if quality not in ALLOWED_QUALITY:
        return JSONResponse({"ok": False, "error": f"quality must be one of {sorted(ALLOWED_QUALITY)}"}, status_code=400)
    if aspect_ratio not in ALLOWED_ASPECT:
        return JSONResponse({"ok": False, "error": f"unsupported aspect_ratio {aspect_ratio!r}"}, status_code=400)
    if not isinstance(refs_raw, list):
        return JSONResponse({"ok": False, "error": "reference_image_urls must be a list"}, status_code=400)
    references = [u.strip() for u in refs_raw if isinstance(u, str) and u.strip()]
    if len(references) > MAX_REFERENCE_IMAGES:
        return JSONResponse({"ok": False, "error": f"max {MAX_REFERENCE_IMAGES} reference images"}, status_code=400)
    if not references:
        return JSONResponse({"ok": False, "error": "at least one reference image is required (Nano Banana 2 is an edit model)"}, status_code=400)

    job_id = uuid.uuid4().hex
    record: dict[str, Any] = {
        "job_id": job_id,
        "status": "RUNNING",
        "remote_status": None,
        "remote_id": None,
        "image_url": None,
        "remote_url": None,
        "error": "",
        "started_at": time.time(),
        "ended_at": None,
        "cancel_requested": False,
        "prompt": prompt,
        "quality": quality,
        "aspect_ratio": aspect_ratio,
    }
    with JOBS_LOCK:
        JOBS[job_id] = record

    asyncio.create_task(_run_job(job_id, api_key, prompt, aspect_ratio, quality, references))
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
    with JOBS_LOCK:
        rec = JOBS.get(job_id)
        if not rec:
            return JSONResponse({"ok": False, "error": "job not found"}, status_code=404)
        rec["cancel_requested"] = True
    return JSONResponse({"ok": True})

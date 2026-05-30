"""GPT Image generation/editing via PiAPI's OpenAI-compatible image API."""
from __future__ import annotations

import asyncio
import json
import mimetypes
import time
import urllib.error
import urllib.parse
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
GENERATIONS_URL = f"{PIAPI_BASE}/v1/images/generations"
EDITS_URL = f"{PIAPI_BASE}/v1/images/edits"
PIAPI_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)

GPT_IMAGE_DIR = config.LOCAL_OUTPUT_DIR / "gpt_image_piapi"
GPT_IMAGE_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_MODELS = {"gpt-image-1", "gpt-image-1.5", "gpt-image-2", "gpt-image-2-preview"}
ALLOWED_QUALITIES = {"standard", "low", "medium", "high", "auto"}
ALLOWED_ASPECTS_TO_SIZE = {
    "1:1": "1024x1024",
    "2:3": "1024x1536",
    "3:2": "1536x1024",
}
ALLOWED_SIZES = set(ALLOWED_ASPECTS_TO_SIZE.values())
ALLOWED_OUTPUT_FORMATS = {"png", "jpeg", "webp"}
MAX_REFERENCE_IMAGES = 10
DEFAULT_TIMEOUT_SEC = 300

JOBS_LOCK = Lock()
JOBS: dict[str, dict[str, Any]] = {}


def _api_key() -> str:
    return settings_store.get_credential("piapi_api_key") or ""


def _headers(api_key: str, *, content_type: str | None = None) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "User-Agent": PIAPI_UA,
    }
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def _request_json(url: str, api_key: str, payload: dict[str, Any], timeout: int = DEFAULT_TIMEOUT_SEC) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers=_headers(api_key, content_type="application/json"),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} from PiAPI: {body[:900]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"PiAPI request failed: {exc}") from exc


def _request_multipart(
    url: str,
    api_key: str,
    body: bytes,
    content_type: str,
    timeout: int = DEFAULT_TIMEOUT_SEC,
) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=body,
        headers=_headers(api_key, content_type=content_type),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} from PiAPI: {body_text[:900]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"PiAPI request failed: {exc}") from exc


def _build_generation_payload(
    *,
    prompt: str,
    model: str,
    size: str,
    quality: str,
    output_format: str,
) -> dict[str, Any]:
    return {
        "model": model,
        "prompt": prompt,
        "n": 1,
        "size": size,
        "quality": quality,
        "response_format": "url",
        "output_format": output_format,
    }


def _quote_filename(name: str) -> str:
    return name.replace("\\", "\\\\").replace('"', '\\"')


def _build_edit_multipart(
    *,
    fields: dict[str, str],
    images: list[tuple[str, bytes, str]],
) -> tuple[bytes, str]:
    boundary = f"----blockflow-gpt-image-{uuid.uuid4().hex}"
    chunks: list[bytes] = []

    for key, value in fields.items():
        chunks.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode(),
            str(value).encode("utf-8"),
            b"\r\n",
        ])

    for filename, data, content_type in images:
        safe_name = _quote_filename(filename)
        chunks.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="image"; filename="{safe_name}"\r\n'.encode(),
            f"Content-Type: {content_type or 'application/octet-stream'}\r\n\r\n".encode(),
            data,
            b"\r\n",
        ])

    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _extract_output_url(payload: Any) -> str:
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, list):
            for item in data:
                url = _extract_output_url(item)
                if url:
                    return url
        for key in ("url", "image_url", "output_url"):
            value = payload.get(key)
            if isinstance(value, str) and value.startswith("http"):
                return value
        for key in ("output", "result"):
            url = _extract_output_url(payload.get(key))
            if url:
                return url
    if isinstance(payload, list):
        for item in payload:
            url = _extract_output_url(item)
            if url:
                return url
    if isinstance(payload, str) and payload.startswith("http"):
        return payload
    return ""


def _validate_run_body(body: dict[str, Any]) -> dict[str, Any]:
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt is required")

    model = str(body.get("model") or "gpt-image-2-preview").strip()
    if model not in ALLOWED_MODELS:
        raise ValueError(f"model must be one of {sorted(ALLOWED_MODELS)}")

    quality = str(body.get("quality") or "standard").strip().lower()
    if quality not in ALLOWED_QUALITIES:
        raise ValueError(f"quality must be one of {sorted(ALLOWED_QUALITIES)}")

    aspect_ratio = str(body.get("aspect_ratio") or "1:1").strip()
    size = str(body.get("size") or "").strip()
    if size:
        if size not in ALLOWED_SIZES:
            raise ValueError(f"size must be one of {sorted(ALLOWED_SIZES)}")
    else:
        if aspect_ratio not in ALLOWED_ASPECTS_TO_SIZE:
            raise ValueError(f"aspect_ratio must be one of {sorted(ALLOWED_ASPECTS_TO_SIZE)}")
        size = ALLOWED_ASPECTS_TO_SIZE[aspect_ratio]

    output_format = str(body.get("output_format") or "png").strip().lower()
    if output_format not in ALLOWED_OUTPUT_FORMATS:
        raise ValueError(f"output_format must be one of {sorted(ALLOWED_OUTPUT_FORMATS)}")

    refs_raw = body.get("reference_image_urls") or []
    if not isinstance(refs_raw, list):
        raise ValueError("reference_image_urls must be a list")
    references = []
    seen = set()
    for item in refs_raw:
        if not isinstance(item, str):
            continue
        value = item.strip()
        if not value or value in seen:
            continue
        seen.add(value)
        references.append(value)
    if len(references) > MAX_REFERENCE_IMAGES:
        raise ValueError(f"max {MAX_REFERENCE_IMAGES} reference images")

    return {
        "mode": "edit" if references else "generation",
        "prompt": prompt,
        "model": model,
        "quality": quality,
        "aspect_ratio": aspect_ratio,
        "size": size,
        "output_format": output_format,
        "references": references,
    }


def _download_url(url: str, timeout: int = 60) -> tuple[bytes, str, str]:
    if url.startswith("/outputs/"):
        local_path = config.LOCAL_OUTPUT_DIR / url.split("/outputs/", 1)[1]
        if not local_path.exists():
            raise RuntimeError(f"Local reference not found: {url}")
        content_type = mimetypes.guess_type(local_path.name)[0] or "application/octet-stream"
        return local_path.read_bytes(), local_path.name, content_type

    local_candidate = Path(url)
    if not url.startswith(("http://", "https://")) and local_candidate.exists():
        content_type = mimetypes.guess_type(local_candidate.name)[0] or "application/octet-stream"
        return local_candidate.read_bytes(), local_candidate.name, content_type

    req = urllib.request.Request(url, method="GET", headers={"User-Agent": PIAPI_UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
        content_type = resp.headers.get("content-type", "").split(";")[0].strip()
    parsed_name = Path(urllib.parse.urlparse(url).path).name or "reference"
    if not content_type:
        content_type = mimetypes.guess_type(parsed_name)[0] or "application/octet-stream"
    return data, parsed_name, content_type


def _download_output(url: str, dest: Path) -> None:
    data, _, _ = _download_url(url, timeout=DEFAULT_TIMEOUT_SEC)
    dest.write_bytes(data)


def _extension_for_url(url: str, output_format: str) -> str:
    ext = Path(urllib.parse.urlparse(url).path).suffix.lower().lstrip(".")
    if ext in {"png", "jpg", "jpeg", "webp"}:
        return "jpg" if ext == "jpeg" else ext
    return "jpg" if output_format == "jpeg" else output_format


async def _submit_generation(api_key: str, settings: dict[str, Any]) -> dict[str, Any]:
    payload = _build_generation_payload(
        prompt=settings["prompt"],
        model=settings["model"],
        size=settings["size"],
        quality=settings["quality"],
        output_format=settings["output_format"],
    )
    return await asyncio.to_thread(_request_json, GENERATIONS_URL, api_key, payload, DEFAULT_TIMEOUT_SEC)


async def _submit_edit(api_key: str, settings: dict[str, Any]) -> dict[str, Any]:
    image_parts: list[tuple[str, bytes, str]] = []
    for index, url in enumerate(settings["references"], start=1):
        data, name, content_type = await asyncio.to_thread(_download_url, url, 90)
        suffix = Path(name).suffix or mimetypes.guess_extension(content_type) or ".png"
        image_parts.append((f"reference-{index}{suffix}", data, content_type))

    fields = {
        "model": settings["model"],
        "prompt": settings["prompt"],
        "n": "1",
        "size": settings["size"],
        "quality": settings["quality"],
        "response_format": "url",
        "output_format": settings["output_format"],
    }
    body, content_type = _build_edit_multipart(fields=fields, images=image_parts)
    return await asyncio.to_thread(_request_multipart, EDITS_URL, api_key, body, content_type, DEFAULT_TIMEOUT_SEC)


async def _run_job(job_id: str, api_key: str, settings: dict[str, Any]) -> None:
    def _cancelled() -> bool:
        with JOBS_LOCK:
            rec = JOBS.get(job_id)
            return bool(rec and rec.get("cancel_requested"))

    try:
        if _cancelled():
            raise asyncio.CancelledError()

        with JOBS_LOCK:
            rec = JOBS.get(job_id)
            if rec is not None:
                rec["remote_status"] = "submitting"

        if settings["mode"] == "edit":
            response = await _submit_edit(api_key, settings)
        else:
            response = await _submit_generation(api_key, settings)

        if _cancelled():
            raise asyncio.CancelledError()

        output_url = _extract_output_url(response)
        if not output_url:
            raise RuntimeError(f"PiAPI returned no image URL: {json.dumps(response)[:700]}")

        ext = _extension_for_url(output_url, settings["output_format"])
        local_path = GPT_IMAGE_DIR / f"{job_id}.{ext}"
        await asyncio.to_thread(_download_output, output_url, local_path)
        rel_url = f"/outputs/gpt_image_piapi/{local_path.name}"

        with JOBS_LOCK:
            rec = JOBS.get(job_id)
            if rec is not None:
                rec["status"] = "COMPLETED"
                rec["remote_status"] = "completed"
                rec["image_url"] = rel_url
                rec["remote_url"] = output_url
                rec["usage"] = response.get("usage") if isinstance(response, dict) else None
                rec["ended_at"] = time.time()
    except asyncio.CancelledError:
        with JOBS_LOCK:
            rec = JOBS.get(job_id)
            if rec is not None:
                rec["status"] = "CANCELLED"
                rec["remote_status"] = "cancelled-local"
                rec["ended_at"] = time.time()
    except Exception as exc:
        with JOBS_LOCK:
            rec = JOBS.get(job_id)
            if rec is not None:
                rec["status"] = "FAILED"
                rec["remote_status"] = "failed"
                rec["error"] = str(exc)[:900]
                rec["ended_at"] = time.time()


@router.get("/health")
def health() -> JSONResponse:
    return JSONResponse({
        "ok": True,
        "piapi_key_present": bool(_api_key()),
        "models": sorted(ALLOWED_MODELS),
        "qualities": sorted(ALLOWED_QUALITIES),
        "sizes": sorted(ALLOWED_SIZES),
        "output_formats": sorted(ALLOWED_OUTPUT_FORMATS),
    })


@router.post("/run")
async def run(request: Request) -> JSONResponse:
    body = await request.json()
    api_key = str(body.get("piapi_api_key") or "").strip() or _api_key()
    if not api_key:
        return JSONResponse({"ok": False, "error": "PiAPI key required (set in Settings)"}, status_code=400)

    try:
        settings = _validate_run_body(body)
    except ValueError as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "job_id": job_id,
            "status": "RUNNING",
            "remote_status": "queued",
            "image_url": None,
            "remote_url": None,
            "usage": None,
            "error": "",
            "started_at": time.time(),
            "ended_at": None,
            "cancel_requested": False,
            "mode": settings["mode"],
            "model": settings["model"],
            "size": settings["size"],
            "quality": settings["quality"],
            "output_format": settings["output_format"],
            "reference_count": len(settings["references"]),
        }

    asyncio.create_task(_run_job(job_id, api_key, settings))
    return JSONResponse({"ok": True, "job_id": job_id, "mode": settings["mode"]})


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
    return JSONResponse({"ok": True, "note": "local cancel only"})

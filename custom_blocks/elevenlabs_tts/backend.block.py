"""ElevenLabs Text-to-Speech via the v3 model.

Synchronous endpoint: POST /v1/text-to-speech/{voice_id} returns audio bytes.
We persist the rendered audio under LOCAL_OUTPUT_DIR/tts/ and surface a
/outputs/tts/... URL so downstream blocks (and the in-block <audio>) can
play it.
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

ELEVENLABS_BASE = "https://api.elevenlabs.io"
TTS_DIR = config.LOCAL_OUTPUT_DIR / "tts"
TTS_DIR.mkdir(parents=True, exist_ok=True)

_VOICES_CACHE: dict[str, Any] = {"ts": 0.0, "data": []}
_VOICES_TTL_SEC = 600
_MODELS_CACHE: dict[str, Any] = {"ts": 0.0, "data": []}

JOBS_LOCK = Lock()
JOBS: dict[str, dict[str, Any]] = {}

# Output formats supported across plans. Free tier is limited to mp3_44100_128.
SUPPORTED_FORMATS = [
    "mp3_22050_32",
    "mp3_44100_32",
    "mp3_44100_64",
    "mp3_44100_96",
    "mp3_44100_128",
    "mp3_44100_192",
    "pcm_16000",
    "pcm_22050",
    "pcm_24000",
    "pcm_44100",
    "pcm_48000",
    "ulaw_8000",
    "alaw_8000",
    "opus_48000_64",
    "opus_48000_96",
    "opus_48000_128",
    "opus_48000_192",
]


def _api_key() -> str:
    return settings_store.get_credential("elevenlabs_api_key") or ""


def _headers(api_key: str, json_body: bool = True) -> dict[str, str]:
    h = {"xi-api-key": api_key, "Accept": "*/*"}
    if json_body:
        h["Content-Type"] = "application/json"
    return h


def _format_to_ext(fmt: str) -> str:
    if fmt.startswith("mp3"):
        return "mp3"
    if fmt.startswith("opus"):
        return "ogg"
    if fmt.startswith("pcm"):
        return "pcm"
    if fmt.startswith("ulaw") or fmt.startswith("alaw"):
        return "wav"
    return "bin"


def _request_json(method: str, url: str, headers: dict[str, str], payload: dict[str, Any] | None = None, timeout: int = 60) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} from ElevenLabs: {body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"ElevenLabs request failed: {e}") from e


def _request_bytes(method: str, url: str, headers: dict[str, str], payload: dict[str, Any] | None, timeout: int = 180) -> bytes:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} from ElevenLabs: {body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"ElevenLabs request failed: {e}") from e


@router.get("/health")
def health() -> JSONResponse:
    return JSONResponse({
        "ok": True,
        "elevenlabs_key_present": bool(_api_key()),
        "supported_formats": SUPPORTED_FORMATS,
    })


@router.get("/voices")
def voices(refresh: int = 0) -> JSONResponse:
    now = time.time()
    if not refresh and _VOICES_CACHE.get("data") and (now - float(_VOICES_CACHE.get("ts", 0))) < _VOICES_TTL_SEC:
        return JSONResponse({"ok": True, "voices": _VOICES_CACHE["data"], "from_cache": True})
    api_key = _api_key()
    if not api_key:
        return JSONResponse({"ok": False, "error": "elevenlabs_api_key not set in Settings"}, status_code=400)
    try:
        data = _request_json("GET", f"{ELEVENLABS_BASE}/v1/voices", _headers(api_key, json_body=False))
    except Exception as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=502)
    items = [
        {
            "voice_id": v.get("voice_id"),
            "name": v.get("name"),
            "category": v.get("category"),
            "labels": v.get("labels") or {},
            "preview_url": v.get("preview_url"),
        }
        for v in data.get("voices", [])
        if isinstance(v, dict) and v.get("voice_id")
    ]
    items.sort(key=lambda x: (x.get("category") or "", x.get("name") or ""))
    _VOICES_CACHE["data"] = items
    _VOICES_CACHE["ts"] = now
    return JSONResponse({"ok": True, "voices": items, "from_cache": False})


@router.get("/models")
def models(refresh: int = 0) -> JSONResponse:
    now = time.time()
    if not refresh and _MODELS_CACHE.get("data") and (now - float(_MODELS_CACHE.get("ts", 0))) < _VOICES_TTL_SEC:
        return JSONResponse({"ok": True, "models": _MODELS_CACHE["data"], "from_cache": True})
    api_key = _api_key()
    if not api_key:
        return JSONResponse({"ok": False, "error": "elevenlabs_api_key not set in Settings"}, status_code=400)
    try:
        raw = _request_json("GET", f"{ELEVENLABS_BASE}/v1/models", _headers(api_key, json_body=False))
    except Exception as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=502)
    items = [
        {
            "model_id": m.get("model_id"),
            "name": m.get("name"),
            "can_do_text_to_speech": m.get("can_do_text_to_speech"),
        }
        for m in raw
        if isinstance(m, dict) and m.get("model_id")
    ]
    _MODELS_CACHE["data"] = items
    _MODELS_CACHE["ts"] = now
    return JSONResponse({"ok": True, "models": items})


@router.post("/generate")
async def generate(request: Request) -> JSONResponse:
    body = await request.json()
    api_key = (str(body.get("elevenlabs_api_key") or "").strip() or _api_key())
    if not api_key:
        return JSONResponse({"ok": False, "error": "ElevenLabs API key required (set in Settings)"}, status_code=400)

    voice_id = str(body.get("voice_id") or "").strip()
    text = str(body.get("text") or "").strip()
    model_id = str(body.get("model_id") or "eleven_v3").strip()
    output_format = str(body.get("output_format") or "mp3_44100_128").strip()
    seed_raw = body.get("seed")
    language_code = str(body.get("language_code") or "").strip()

    if not voice_id:
        return JSONResponse({"ok": False, "error": "voice_id required"}, status_code=400)
    if not text:
        return JSONResponse({"ok": False, "error": "text required"}, status_code=400)
    if output_format not in SUPPORTED_FORMATS:
        return JSONResponse({"ok": False, "error": f"unsupported output_format {output_format!r}"}, status_code=400)

    voice_settings: dict[str, Any] = {}
    for k in ("stability", "similarity_boost", "style", "speed"):
        v = body.get(k)
        if isinstance(v, (int, float)):
            voice_settings[k] = float(v)
    if body.get("use_speaker_boost") is not None:
        voice_settings["use_speaker_boost"] = bool(body.get("use_speaker_boost"))

    payload: dict[str, Any] = {
        "text": text,
        "model_id": model_id,
    }
    if voice_settings:
        payload["voice_settings"] = voice_settings
    if language_code:
        payload["language_code"] = language_code
    if isinstance(seed_raw, (int, float)) and seed_raw >= 0:
        payload["seed"] = int(seed_raw)

    url = f"{ELEVENLABS_BASE}/v1/text-to-speech/{voice_id}?output_format={output_format}"

    job_id = uuid.uuid4().hex
    record: dict[str, Any] = {
        "job_id": job_id,
        "status": "RUNNING",
        "audio_url": None,
        "error": "",
        "started_at": time.time(),
        "ended_at": None,
        "voice_id": voice_id,
        "model_id": model_id,
        "output_format": output_format,
    }
    with JOBS_LOCK:
        JOBS[job_id] = record

    try:
        audio_bytes = await asyncio.to_thread(
            _request_bytes, "POST", url, _headers(api_key, json_body=True), payload, 180
        )
    except Exception as exc:
        with JOBS_LOCK:
            JOBS[job_id]["status"] = "FAILED"
            JOBS[job_id]["error"] = str(exc)[:600]
            JOBS[job_id]["ended_at"] = time.time()
        return JSONResponse({"ok": False, "error": str(exc), "job_id": job_id}, status_code=502)

    ext = _format_to_ext(output_format)
    out_path = TTS_DIR / f"{job_id}.{ext}"
    out_path.write_bytes(audio_bytes)
    rel_url = f"/outputs/tts/{out_path.name}"

    with JOBS_LOCK:
        JOBS[job_id]["status"] = "COMPLETED"
        JOBS[job_id]["audio_url"] = rel_url
        JOBS[job_id]["ended_at"] = time.time()
        JOBS[job_id]["bytes"] = len(audio_bytes)

    return JSONResponse({
        "ok": True,
        "job_id": job_id,
        "audio_url": rel_url,
        "bytes": len(audio_bytes),
        "format": output_format,
    })


@router.get("/status/{job_id}")
def status(job_id: str) -> JSONResponse:
    with JOBS_LOCK:
        rec = JOBS.get(job_id)
        if not rec:
            return JSONResponse({"ok": False, "error": "job not found"}, status_code=404)
        return JSONResponse({"ok": True, "job": dict(rec)})

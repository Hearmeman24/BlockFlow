from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

import base64

from backend import config, state, services, tmpfiles

router = APIRouter()


@router.get("/settings")
def get_settings() -> JSONResponse:
    settings = state._get_writer_settings()
    return JSONResponse({
        "ok": True,
        "has_api_key": bool(config.OPENROUTER_API_KEY or config.MINIMAX_API_KEY),
        "has_openrouter_key": bool(config.OPENROUTER_API_KEY),
        "has_minimax_key": bool(config.MINIMAX_API_KEY),
        "settings": settings,
        "fanout_limits": {
            "max_variants": config.PROMPT_WRITER_FANOUT_MAX_VARIANTS,
            "max_parallel": config.PROMPT_WRITER_FANOUT_MAX_PARALLEL,
        },
    })


@router.post("/settings")
async def save_settings(request: Request) -> JSONResponse:
    payload = await request.json()
    updated = state._update_writer_settings(**payload)
    return JSONResponse({
        "ok": True,
        "has_api_key": bool(config.OPENROUTER_API_KEY or config.MINIMAX_API_KEY),
        "has_openrouter_key": bool(config.OPENROUTER_API_KEY),
        "has_minimax_key": bool(config.MINIMAX_API_KEY),
        "settings": updated,
        "fanout_limits": {
            "max_variants": config.PROMPT_WRITER_FANOUT_MAX_VARIANTS,
            "max_parallel": config.PROMPT_WRITER_FANOUT_MAX_PARALLEL,
        },
    })


@router.get("/models")
def get_models(refresh: int = Query(0)) -> JSONResponse:
    models, error, from_cache = services._get_llm_models(refresh=bool(refresh))
    resp: dict[str, Any] = {"ok": True, "models": models, "from_cache": from_cache}
    if error:
        resp["warning"] = error
    return JSONResponse(resp)


@router.post("/generate")
async def generate(request: Request) -> JSONResponse:
    payload = await request.json()
    model = str(payload.get("model") or "")
    system_prompt = str(payload.get("system_prompt") or "")
    user_prompt = str(payload.get("user_prompt") or "")
    raw_image_url = str(payload.get("image_url") or "")
    temperature = float(payload.get("temperature", 0.9))
    max_tokens = int(payload.get("max_tokens", 600))

    if not model:
        return JSONResponse({"ok": False, "error": "model is required"}, status_code=400)
    if not user_prompt and not raw_image_url:
        return JSONResponse({"ok": False, "error": "user_prompt or image_url is required"}, status_code=400)

    # Convert local paths to base64 data URI for vision models
    image_url = raw_image_url
    if raw_image_url and tmpfiles.is_local_path(raw_image_url):
        from pathlib import Path
        if raw_image_url.startswith("/outputs/"):
            local_path = config.LOCAL_OUTPUT_DIR / raw_image_url.split("/outputs/", 1)[1]
        else:
            local_path = Path(raw_image_url)
        if local_path.exists():
            mime = tmpfiles.MIME_TYPES.get(local_path.suffix.lower(), "image/png")
            b64 = base64.b64encode(local_path.read_bytes()).decode("ascii")
            image_url = f"data:{mime};base64,{b64}"
        else:
            return JSONResponse({"ok": False, "error": f"Image not found: {raw_image_url}"}, status_code=400)

    messages: list[dict[str, Any]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})

    # Build user message with optional image
    if image_url:
        content: list[dict[str, Any]] = []
        content.append({"type": "image_url", "image_url": {"url": image_url}})
        if user_prompt:
            content.append({"type": "text", "text": user_prompt})
        messages.append({"role": "user", "content": content})
    else:
        messages.append({"role": "user", "content": user_prompt})

    try:
        resp = services._llm_chat_completion({
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }, timeout=120)
        text = services._extract_openrouter_completion_text(resp)
        return JSONResponse({"ok": True, "output_text": text})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)})

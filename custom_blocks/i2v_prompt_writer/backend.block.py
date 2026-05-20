from __future__ import annotations

import json
import logging
from typing import Any

log = logging.getLogger(__name__)

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

import base64

from backend import config, state, services, tmpfiles


_N_PROMPTS_DIRECTIVE = (
    "\n\n"
    "MULTI-PROMPT MODE — output {n} distinct prompts as a JSON object. "
    "Each prompt must describe a different variation (setting, pose, lighting, framing, etc.) "
    "while keeping the same subject as shown in the reference image. "
    "Do not number or label the prompts inside their text. "
    "Return ONLY a JSON object of the form {{\"prompts\": [\"prompt 1\", \"prompt 2\", ...]}} "
    "with exactly {n} entries."
)


def _parse_prompts_list(text: str) -> list[str]:
    import re
    text = (text or "").strip()
    if not text:
        return []
    try:
        data = json.loads(text)
        if isinstance(data, dict) and isinstance(data.get("prompts"), list):
            return [str(p).strip() for p in data["prompts"] if str(p).strip()]
        if isinstance(data, list):
            return [str(p).strip() for p in data if str(p).strip()]
    except (json.JSONDecodeError, ValueError):
        pass
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        try:
            data = json.loads(fence.group(1).strip())
            if isinstance(data, dict) and isinstance(data.get("prompts"), list):
                return [str(p).strip() for p in data["prompts"] if str(p).strip()]
            if isinstance(data, list):
                return [str(p).strip() for p in data if str(p).strip()]
        except (json.JSONDecodeError, ValueError):
            pass
    arr = re.search(r"\[\s*\"[\s\S]*?\"\s*(?:,\s*\"[\s\S]*?\"\s*)*\]", text)
    if arr:
        try:
            data = json.loads(arr.group(0))
            if isinstance(data, list):
                return [str(p).strip() for p in data if str(p).strip()]
        except (json.JSONDecodeError, ValueError):
            pass
    nums = re.findall(r"(?:^|\n)\s*\d+[.)]\s*([\s\S]+?)(?=\n\s*\d+[.)]|\Z)", text)
    if len(nums) >= 2:
        return [p.strip() for p in nums if p.strip()]
    parts = [p.strip() for p in text.split("\n\n") if p.strip()]
    if len(parts) >= 2:
        return parts
    return [text]


def _build_prompts_response_format() -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "prompts",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "prompts": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["prompts"],
                "additionalProperties": False,
            },
        },
    }

router = APIRouter()


@router.get("/settings")
def get_settings() -> JSONResponse:
    settings = state._get_writer_settings()
    return JSONResponse({
        "ok": True,
        "has_api_key": bool(config.OPENROUTER_API_KEY),
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
        "has_api_key": bool(config.OPENROUTER_API_KEY),
        "settings": updated,
        "fanout_limits": {
            "max_variants": config.PROMPT_WRITER_FANOUT_MAX_VARIANTS,
            "max_parallel": config.PROMPT_WRITER_FANOUT_MAX_PARALLEL,
        },
    })


@router.get("/models")
def get_models(refresh: int = Query(0)) -> JSONResponse:
    models, error, from_cache = services._get_openrouter_models(refresh=bool(refresh))
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
    num_prompts = max(1, min(int(payload.get("num_prompts") or 1),
                              max(1, config.PROMPT_WRITER_FANOUT_MAX_VARIANTS)))

    if not model:
        return JSONResponse({"ok": False, "error": "model is required"}, status_code=400)
    if not user_prompt and not raw_image_url:
        return JSONResponse({"ok": False, "error": "user_prompt or image_url is required"}, status_code=400)

    # Convert local paths to base64 data URI for OpenRouter vision
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

    effective_system_prompt = system_prompt
    if num_prompts > 1:
        effective_system_prompt = (system_prompt or "") + _N_PROMPTS_DIRECTIVE.format(n=num_prompts)

    messages: list[dict[str, Any]] = []
    if effective_system_prompt:
        messages.append({"role": "system", "content": [
            {"type": "text", "text": effective_system_prompt, "cache_control": {"type": "ephemeral"}},
        ]})

    # Build user message with optional image
    if image_url:
        content: list[dict[str, Any]] = []
        content.append({"type": "image_url", "image_url": {"url": image_url}})
        if user_prompt:
            content.append({"type": "text", "text": user_prompt})
        messages.append({"role": "user", "content": content})
    else:
        messages.append({"role": "user", "content": user_prompt})

    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max(max_tokens, num_prompts * 1500) if num_prompts > 1 else max_tokens,
        "reasoning": {"effort": "medium"},
    }
    if num_prompts > 1:
        body["response_format"] = _build_prompts_response_format()

    try:
        resp = services._openrouter_request_json("POST", "/chat/completions", body, timeout=180)
        text = services._extract_openrouter_completion_text(resp)
        if num_prompts == 1:
            return JSONResponse({"ok": True, "output_text": text})

        prompts = _parse_prompts_list(text)
        if not prompts:
            log.error("[i2v generate] N=%d produced no parseable prompts. Raw (%d chars):\n%s",
                      num_prompts, len(text or ""), (text or "")[:2000])
            return JSONResponse({"ok": False, "error": "LLM returned no parseable prompts"})
        if len(prompts) > num_prompts:
            prompts = prompts[:num_prompts]
        return JSONResponse({
            "ok": True,
            "prompts": prompts,
            "count": len(prompts),
            "requested": num_prompts,
        })
    except Exception as e:
        log.exception("[i2v generate] OpenRouter call failed")
        return JSONResponse({"ok": False, "error": str(e)})

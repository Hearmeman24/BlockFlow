from __future__ import annotations

import json
import logging
from typing import Any

log = logging.getLogger(__name__)

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from backend import config, state, services

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
    temperature = float(payload.get("temperature", 0.9))
    max_tokens = int(payload.get("max_tokens", 600))
    reasoning_effort = str(payload.get("reasoning_effort") or "medium").lower()

    if not model:
        return JSONResponse({"ok": False, "error": "model is required"}, status_code=400)
    if not user_prompt:
        return JSONResponse({"ok": False, "error": "user_prompt is required"}, status_code=400)

    messages: list[dict[str, Any]] = []
    if system_prompt:
        messages.append({"role": "system", "content": [
            {"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}},
        ]})
    messages.append({"role": "user", "content": user_prompt})

    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if reasoning_effort in ("low", "medium", "high"):
        body["reasoning"] = {"effort": reasoning_effort}

    try:
        resp = services._openrouter_request_json("POST", "/chat/completions", body, timeout=120)
        text = services._extract_openrouter_completion_text(resp)
        return JSONResponse({"ok": True, "output_text": text})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)})


_IDEA_SYSTEM_PROMPT = """You are a creative prompt idea generator for AI image/video generation.

Given a high-level description and a count, generate short prompt ideas (1-2 sentences each).
Each idea should be a concise scene description that captures a unique variation — different pose, setting, outfit, lighting, mood, or activity.

CRITICAL RULES:
- The user's description defines the CHARACTER. Every single idea MUST describe the SAME character with the EXACT same physical attributes (hair color, eye color, body type, skin tone, glasses, facial features, etc.). Copy the character description verbatim into each idea. NEVER vary the character between ideas.
- Only vary: setting, location, clothing/outfit, pose, activity, lighting, mood, time of day, composition.
- Each idea is 1-2 sentences maximum — short and punchy.
- Include the character description + a unique scene in each idea.
- Keep ideas diverse — never repeat the same type of scene twice in a row.
- Include specific visual details: clothing items, colors, locations, time of day.
- These will be expanded into full detailed prompts by another system, so keep them as creative seeds.

Use the user's exact words and terminology. If the user uses explicit or NSFW language, repeat those same words in each idea — never euphemize, sanitize, or rephrase them.

If the user's description requests a specific setting, mood, style, or aesthetic, that is the highest priority — adapt all choices to serve their vision."""


@router.post("/generate-ideas")
async def generate_ideas(request: Request) -> JSONResponse:
    payload = await request.json()
    model = str(payload.get("model") or "")
    description = str(payload.get("description") or "")
    count = int(payload.get("count", 8))
    temperature = float(payload.get("temperature", 0.9))
    reasoning_effort = str(payload.get("reasoning_effort") or "medium").lower()

    if not model:
        return JSONResponse({"ok": False, "error": "model is required"}, status_code=400)
    if not description:
        return JSONResponse({"ok": False, "error": "description is required"}, status_code=400)

    count = max(1, min(count, 64))

    messages = [
        {"role": "system", "content": [
            {"type": "text", "text": _IDEA_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}},
        ]},
        {"role": "user", "content": f"Generate {count} prompt ideas for: {description}"},
    ]

    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": count * 1500,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "prompt_ideas",
                "strict": True,
                "schema": {
                    "type": "object",
                    "properties": {
                        "ideas": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                    "required": ["ideas"],
                    "additionalProperties": False,
                },
            },
        },
    }
    if reasoning_effort in ("low", "medium", "high"):
        body["reasoning"] = {"effort": reasoning_effort}

    try:
        resp = services._openrouter_request_json("POST", "/chat/completions", body, timeout=120)
        text = services._extract_openrouter_completion_text(resp)

        import json as _json

        if not text or not text.strip():
            log.error("[generate-ideas] Empty response from LLM. Raw response: %s", json.dumps(resp, default=str)[:1000])
            return JSONResponse({"ok": False, "error": "Empty response from LLM"})

        try:
            parsed = _json.loads(text)
            ideas = parsed.get("ideas", []) if isinstance(parsed, dict) else parsed
        except _json.JSONDecodeError as parse_err:
            log.error("[generate-ideas] JSON parse failed: %s\nFull LLM response (%d chars):\n%s", parse_err, len(text), text)
            # Fallback: try extracting array from text
            import re
            match = re.search(r"\[[\s\S]*\]", text)
            if match:
                ideas = _json.loads(match.group(0))
            else:
                return JSONResponse({"ok": False, "error": "Failed to parse ideas from LLM — check console logs for full response"})

        if not isinstance(ideas, list):
            log.error("[generate-ideas] Expected list, got %s: %s", type(ideas).__name__, str(ideas)[:500])
            return JSONResponse({"ok": False, "error": "Expected array of ideas"})

        ideas = [str(i).strip() for i in ideas if str(i).strip()]
        if not ideas:
            log.error("[generate-ideas] Empty ideas array. Raw text (%d chars):\n%s", len(text), text)
            return JSONResponse({"ok": False, "error": "LLM returned empty ideas"})

        return JSONResponse({"ok": True, "ideas": ideas, "count": len(ideas)})
    except Exception as e:
        log.exception("[generate-ideas] Unexpected error")
        return JSONResponse({"ok": False, "error": str(e)})

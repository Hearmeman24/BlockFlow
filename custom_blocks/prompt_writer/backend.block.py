from __future__ import annotations

import json
from typing import Any

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

    if not model:
        return JSONResponse({"ok": False, "error": "model is required"}, status_code=400)
    if not user_prompt:
        return JSONResponse({"ok": False, "error": "user_prompt is required"}, status_code=400)

    messages: list[dict[str, Any]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_prompt})

    try:
        resp = services._openrouter_request_json("POST", "/chat/completions", {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }, timeout=120)
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

Respond with ONLY a JSON array of strings, no markdown, no explanation:
["idea 1", "idea 2", "idea 3", ...]"""


@router.post("/generate-ideas")
async def generate_ideas(request: Request) -> JSONResponse:
    payload = await request.json()
    model = str(payload.get("model") or "")
    description = str(payload.get("description") or "")
    count = int(payload.get("count", 8))
    temperature = float(payload.get("temperature", 0.9))

    if not model:
        return JSONResponse({"ok": False, "error": "model is required"}, status_code=400)
    if not description:
        return JSONResponse({"ok": False, "error": "description is required"}, status_code=400)

    count = max(1, min(count, 64))

    messages = [
        {"role": "system", "content": _IDEA_SYSTEM_PROMPT},
        {"role": "user", "content": f"Generate {count} prompt ideas for: {description}"},
    ]

    try:
        resp = services._openrouter_request_json("POST", "/chat/completions", {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": count * 200,
        }, timeout=120)
        text = services._extract_openrouter_completion_text(resp)

        # Parse JSON array from response
        import json as _json
        try:
            ideas = _json.loads(text)
        except _json.JSONDecodeError:
            # Try extracting from markdown code block
            import re
            match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
            if match:
                ideas = _json.loads(match.group(1).strip())
            else:
                # Try finding array in text
                match = re.search(r"\[[\s\S]*\]", text)
                if match:
                    ideas = _json.loads(match.group(0))
                else:
                    return JSONResponse({"ok": False, "error": "Failed to parse ideas from LLM response"})

        if not isinstance(ideas, list):
            return JSONResponse({"ok": False, "error": "Expected array of ideas"})

        ideas = [str(i).strip() for i in ideas if str(i).strip()]
        return JSONResponse({"ok": True, "ideas": ideas, "count": len(ideas)})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)})

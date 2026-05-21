from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from backend import config, services, state

log = logging.getLogger(__name__)

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


_N_PROMPTS_DIRECTIVE = (
    "\n\n"
    "MULTI-PROMPT MODE — output {n} distinct prompts as a JSON object. "
    "Each prompt must be a different variation (setting, pose, time of day, framing, etc.) "
    "while keeping the same subject/character described in the user's request. "
    "Do not number or label the prompts inside their text. "
    "Return ONLY a JSON object of the form {{\"prompts\": [\"prompt 1\", \"prompt 2\", ...]}} "
    "with exactly {n} entries."
)


def _parse_prompts_list(text: str) -> list[str]:
    """Best-effort parse of an LLM response into a list of prompt strings."""
    import re
    text = (text or "").strip()
    if not text:
        return []
    # 1. Raw JSON object/array
    try:
        data = json.loads(text)
        if isinstance(data, dict) and isinstance(data.get("prompts"), list):
            return [str(p).strip() for p in data["prompts"] if str(p).strip()]
        if isinstance(data, list):
            return [str(p).strip() for p in data if str(p).strip()]
    except (json.JSONDecodeError, ValueError):
        pass
    # 2. JSON inside a ```json fenced block
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
    # 3. Bare JSON array anywhere in the text
    arr = re.search(r"\[\s*\"[\s\S]*?\"\s*(?:,\s*\"[\s\S]*?\"\s*)*\]", text)
    if arr:
        try:
            data = json.loads(arr.group(0))
            if isinstance(data, list):
                return [str(p).strip() for p in data if str(p).strip()]
        except (json.JSONDecodeError, ValueError):
            pass
    # 4. Numbered list (1. ..., 2. ...)
    nums = re.findall(r"(?:^|\n)\s*\d+[.)]\s*([\s\S]+?)(?=\n\s*\d+[.)]|\Z)", text)
    if len(nums) >= 2:
        return [p.strip() for p in nums if p.strip()]
    # 5. Double-newline split
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


@router.post("/generate")
async def generate(request: Request) -> JSONResponse:
    payload = await request.json()
    model = str(payload.get("model") or "")
    system_prompt = str(payload.get("system_prompt") or "")
    user_prompt = str(payload.get("user_prompt") or "")
    temperature = float(payload.get("temperature", 0.9))
    max_tokens = int(payload.get("max_tokens", 600))
    reasoning_effort = str(payload.get("reasoning_effort") or "medium").lower()
    num_prompts = max(1, min(int(payload.get("num_prompts") or 1),
                              max(1, config.PROMPT_WRITER_FANOUT_MAX_VARIANTS)))

    if not model:
        return JSONResponse({"ok": False, "error": "model is required"}, status_code=400)
    if not user_prompt:
        return JSONResponse({"ok": False, "error": "user_prompt is required"}, status_code=400)

    # When asking for N>1, append a JSON-list directive to the system prompt.
    effective_system_prompt = system_prompt
    if num_prompts > 1:
        effective_system_prompt = (system_prompt or "") + _N_PROMPTS_DIRECTIVE.format(n=num_prompts)

    messages: list[dict[str, Any]] = []
    if effective_system_prompt:
        messages.append({"role": "system", "content": [
            {"type": "text", "text": effective_system_prompt, "cache_control": {"type": "ephemeral"}},
        ]})
    messages.append({"role": "user", "content": user_prompt})

    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max(max_tokens, num_prompts * 1500) if num_prompts > 1 else max_tokens,
    }
    if reasoning_effort in ("low", "medium", "high"):
        body["reasoning"] = {"effort": reasoning_effort}
    if num_prompts > 1:
        body["response_format"] = _build_prompts_response_format()

    try:
        resp = services._openrouter_request_json("POST", "/chat/completions", body, timeout=180)
        text = services._extract_openrouter_completion_text(resp)
        if num_prompts == 1:
            return JSONResponse({"ok": True, "output_text": text})

        prompts = _parse_prompts_list(text)
        if not prompts:
            log.error("[generate] N=%d produced no parseable prompts. Raw (%d chars):\n%s",
                      num_prompts, len(text or ""), (text or "")[:2000])
            return JSONResponse({"ok": False, "error": "LLM returned no parseable prompts"})

        # Truncate if model returned more than asked
        if len(prompts) > num_prompts:
            prompts = prompts[:num_prompts]
        return JSONResponse({
            "ok": True,
            "prompts": prompts,
            "count": len(prompts),
            "requested": num_prompts,
        })
    except Exception as e:
        log.exception("[generate] OpenRouter call failed")
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

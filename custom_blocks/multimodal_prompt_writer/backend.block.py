"""Multi-modal prompt writer.

Sends multiple images / video / audio / text references to a vision-capable
OpenRouter chat-completion model and asks it to synthesize a unified prompt
suitable for downstream video / image generation blocks (Seedance, NB2,
ComfyGen, etc.).

Mirrors the i2v_prompt_writer block, but:
- Accepts N images (not just one).
- Optionally accepts a video URL and an audio URL.
- The /models endpoint filters OpenRouter's catalogue down to models that
  actually declare image (and optionally video / audio) input modalities.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from backend import config, image_payload, services, state, tmpfiles

log = logging.getLogger(__name__)

router = APIRouter()

OPENROUTER_IMAGE_PAYLOAD_LIMIT_BYTES = 20 * 1024 * 1024

_N_PROMPTS_DIRECTIVE = (
    "\n\n"
    "MULTI-PROMPT MODE — output {n} distinct prompts as a JSON object. "
    "Each prompt must describe a different variation (scene, framing, lighting, "
    "action) while remaining consistent with the references provided. "
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
    return [text]


def _build_prompts_response_format() -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "prompts",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {"prompts": {"type": "array", "items": {"type": "string"}}},
                "required": ["prompts"],
                "additionalProperties": False,
            },
        },
    }


def _modalities(model_obj: dict[str, Any]) -> set[str]:
    # services._get_openrouter_models returns normalized rows with
    # `input_modalities` at the top level. Fall back to the legacy `modality`
    # string ("text+image->text") if that's missing.
    mods = model_obj.get("input_modalities") if isinstance(model_obj.get("input_modalities"), list) else []
    if not mods:
        s = str(model_obj.get("modality") or "").lower()
        left = s.split("->")[0] if "->" in s else s
        mods = [m.strip() for m in left.replace(" ", "").split("+") if m.strip()]
    return {str(m).lower() for m in (mods or [])}


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
def get_models(
    refresh: int = Query(0),
    require_image: int = Query(1),
    require_video: int = Query(0),
    require_audio: int = Query(0),
) -> JSONResponse:
    """Return OpenRouter models filtered by what input modalities they accept.

    The shared services._get_openrouter_models already constrains output to
    text-producing models. We additionally narrow to those whose
    input_modalities (or legacy modality string) include the requested
    channels. Image filter defaults on — that's the minimum to call this a
    "multi-modal" writer.
    """
    models, error, from_cache = services._get_openrouter_models(refresh=bool(refresh))
    needs: set[str] = set()
    if require_image:
        needs.add("image")
    if require_video:
        needs.add("video")
    if require_audio:
        needs.add("audio")

    filtered: list[dict[str, Any]] = []
    for m in models:
        mods = _modalities(m)
        if needs.issubset(mods):
            filtered.append(m)

    resp: dict[str, Any] = {
        "ok": True,
        "models": filtered,
        "total": len(models),
        "matched": len(filtered),
        "filter": {
            "image": bool(require_image),
            "video": bool(require_video),
            "audio": bool(require_audio),
        },
        "from_cache": from_cache,
    }
    if error:
        resp["warning"] = error
    return JSONResponse(resp)


def _local_image_path(raw: str) -> Path | None:
    if not raw:
        return None
    if not tmpfiles.is_local_path(raw):
        return None
    if raw.startswith("/outputs/"):
        return config.LOCAL_OUTPUT_DIR / raw.split("/outputs/", 1)[1]
    return Path(raw)


def _resolve_image_url(raw: str) -> str | None:
    """Convert one local image path into a data URI; remote URLs pass through."""
    if not raw:
        return None
    if not tmpfiles.is_local_path(raw):
        return raw
    resolved = _resolve_image_urls_for_payload([raw])
    return resolved[0] if resolved else None


def _resolve_image_urls_for_payload(image_urls: list[str]) -> list[str]:
    """Resolve image refs for OpenRouter while keeping local data URIs under budget."""
    resolved: list[str | None] = [None] * len(image_urls)
    local_sources: list[tuple[int, image_payload.ImagePayloadSource]] = []

    for idx, raw in enumerate(image_urls):
        if not raw:
            continue
        if not tmpfiles.is_local_path(raw):
            resolved[idx] = raw
            continue

        local_path = _local_image_path(raw)
        if local_path is None or not local_path.exists():
            raise ValueError(f"image not found: {raw}")
        content_type = image_payload.mime_for_name(local_path.name, "image/png")
        local_sources.append((
            idx,
            image_payload.ImagePayloadSource(
                name=local_path.name,
                data=local_path.read_bytes(),
                content_type=content_type,
            ),
        ))

    if local_sources:
        prepared = image_payload.prepare_data_uris_for_payload(
            [src for _, src in local_sources],
            max_payload_bytes=OPENROUTER_IMAGE_PAYLOAD_LIMIT_BYTES,
        )
        for (idx, _), item in zip(local_sources, prepared, strict=True):
            resolved[idx] = item.data_uri

    return [url for url in resolved if url]


@router.post("/generate")
async def generate(request: Request) -> JSONResponse:
    payload = await request.json()
    model = str(payload.get("model") or "")
    system_prompt = str(payload.get("system_prompt") or "")
    user_prompt = str(payload.get("user_prompt") or "")
    image_urls_raw = payload.get("image_urls") or []
    video_url = str(payload.get("video_url") or "").strip()
    audio_url = str(payload.get("audio_url") or "").strip()
    upstream_text = str(payload.get("upstream_text") or "").strip()

    temperature = float(payload.get("temperature", 0.9))
    max_tokens = int(payload.get("max_tokens", 800))
    num_prompts = max(1, min(int(payload.get("num_prompts") or 1),
                              max(1, config.PROMPT_WRITER_FANOUT_MAX_VARIANTS)))

    if not model:
        return JSONResponse({"ok": False, "error": "model is required"}, status_code=400)

    if not isinstance(image_urls_raw, list):
        return JSONResponse({"ok": False, "error": "image_urls must be a list"}, status_code=400)
    image_urls = [str(u).strip() for u in image_urls_raw if isinstance(u, str) and str(u).strip()]

    if not (image_urls or video_url or audio_url or user_prompt or upstream_text):
        return JSONResponse({"ok": False, "error": "at least one reference (image/video/audio) or text input is required"}, status_code=400)

    # Resolve any local /outputs image paths into budgeted data URIs.
    try:
        resolved_images = _resolve_image_urls_for_payload(image_urls)
    except ValueError as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

    effective_system_prompt = system_prompt
    if num_prompts > 1:
        effective_system_prompt = (system_prompt or "") + _N_PROMPTS_DIRECTIVE.format(n=num_prompts)

    messages: list[dict[str, Any]] = []
    if effective_system_prompt:
        messages.append({"role": "system", "content": [
            {"type": "text", "text": effective_system_prompt, "cache_control": {"type": "ephemeral"}},
        ]})

    # Compose user message: text framing + image parts + optional video / audio.
    content: list[dict[str, Any]] = []
    framing_bits: list[str] = []
    if upstream_text:
        framing_bits.append(f"Upstream text context:\n{upstream_text}")
    if user_prompt:
        framing_bits.append(f"User direction:\n{user_prompt}")
    if framing_bits:
        content.append({"type": "text", "text": "\n\n".join(framing_bits)})

    for idx, img in enumerate(resolved_images, start=1):
        content.append({"type": "text", "text": f"Reference image {idx}:"})
        content.append({"type": "image_url", "image_url": {"url": img}})

    if video_url:
        content.append({"type": "text", "text": "Reference video:"})
        content.append({"type": "video_url", "video_url": {"url": video_url}})

    if audio_url:
        content.append({"type": "text", "text": "Reference audio:"})
        # OpenRouter's audio input shape is `input_audio` with a base64 payload.
        # We pass a URL via the `format=url` hint and let the provider fetch.
        content.append({"type": "input_audio", "input_audio": {"data": audio_url, "format": "url"}})

    messages.append({"role": "user", "content": content})

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
        resp = services._openrouter_request_json("POST", "/chat/completions", body, timeout=240)
        text = services._extract_openrouter_completion_text(resp)
        if num_prompts == 1:
            return JSONResponse({"ok": True, "output_text": text})

        prompts = _parse_prompts_list(text)
        if not prompts:
            log.error("[multimodal_prompt_writer] N=%d produced no parseable prompts. Raw (%d chars):\n%s",
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
        log.exception("[multimodal_prompt_writer] OpenRouter call failed")
        return JSONResponse({"ok": False, "error": str(e)})

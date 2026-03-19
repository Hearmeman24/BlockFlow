from __future__ import annotations

import base64
import json
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter()

AUTO_TAG_MODEL = "google/gemini-3.1-flash-lite-preview"
AUTO_TAG_PROMPT = (
    "Generate 5-7 tags for this AI-generated media for CivitAI. Be explicit and accurate.\n\n"
    "Required tags (include when applicable):\n"
    "- NSFW or SFW (always include one)\n"
    "- Sex position if applicable (e.g. missionary, doggy style, cowgirl)\n"
    "- Explicit body parts if visible (e.g. breasts, pussy, dick, ass)\n"
    "- Pose (e.g. standing, sitting, lying down, bending over, kneeling)\n"
    "- Generation type if detectable: text-to-video, image-to-video, or text-to-image\n\n"
    "Fill remaining slots with descriptive tags (setting, mood, lighting, style).\n"
    "Maximum 7 tags. Return ONLY a comma-separated list, nothing else."
)

def _build_tag_prompt(model: str = "", loras: list[dict] | None = None) -> str:
    """Build the tagging prompt with optional model/lora context."""
    parts = [AUTO_TAG_PROMPT]
    context_parts = []
    if model:
        context_parts.append(f"Model: {model}")
    if loras:
        lora_names = [l.get("name", "") for l in loras if l.get("name")]
        if lora_names:
            context_parts.append(f"LoRAs: {', '.join(lora_names)}")
    if context_parts:
        parts.append(
            "\nGeneration context (for your understanding only — do NOT include model/LoRA names as tags):\n"
            + "\n".join(context_parts)
        )
    return "\n".join(parts)

CIVITAI_API_BASE = "https://civitai.com/api"
CIVITAI_TRPC_BASE = "https://civitai.com/api/trpc"




def _get_token() -> str:
    return os.environ.get("CIVITAI_API_KEY", "")


def _api_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    }


def _trpc_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    }


def _probe_dimensions(path: Path) -> tuple[int, int] | None:
    """Get real width x height from a media file using ffprobe."""
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "quiet", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)],
            timeout=10,
        ).decode().strip()
        parts = out.split(",")
        if len(parts) == 2:
            return int(parts[0]), int(parts[1])
    except Exception:
        pass
    return None


def _civitai_request(url: str, data: bytes | None, headers: dict[str, str], method: str = "POST", timeout: int = 30) -> dict[str, Any]:
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


@router.post("/share")
async def share(request: Request) -> JSONResponse:
    """Upload media and create a CivitAI post with metadata.

    Flow:
    1. Get presigned upload URL
    2. Upload media file
    3. Create post
    4. Add image/video with generation metadata (hashes for auto-resolve)
    5. Publish post
    """
    body = await request.json()
    token = body.get("token") or _get_token()
    if not token:
        return JSONResponse({"ok": False, "error": "No CivitAI API key"}, status_code=400)

    media_path = body.get("media_path", "")
    media_url = body.get("media_url", "")
    title = body.get("title", "")
    description = body.get("description", "")
    tags = body.get("tags", [])
    nsfw = body.get("nsfw", False)
    publish = body.get("publish", True)
    meta = body.get("meta", {})

    # Resolve media file
    local_file: Path | None = None
    if media_path:
        local_file = Path(media_path)
        if not local_file.exists():
            return JSONResponse({"ok": False, "error": f"File not found: {media_path}"}, status_code=400)
    elif media_url:
        if media_url.startswith("/outputs/"):
            from backend import config
            local_file = config.OUTPUT_DIR / media_url.split("/outputs/", 1)[1]
        elif media_url.startswith("http"):
            return JSONResponse({"ok": False, "error": "External URLs not supported yet, use local path"}, status_code=400)
        if local_file and not local_file.exists():
            return JSONResponse({"ok": False, "error": f"Output file not found: {local_file}"}, status_code=400)
    else:
        return JSONResponse({"ok": False, "error": "media_path or media_url required"}, status_code=400)

    if not local_file:
        return JSONResponse({"ok": False, "error": "Could not resolve media file"}, status_code=400)

    suffix = local_file.suffix.lower()
    mime = "video/mp4" if suffix == ".mp4" else "video/webm" if suffix == ".webm" else "image/png" if suffix == ".png" else "image/jpeg"

    try:
        # Step 1: Get presigned upload URL
        upload_req_body = json.dumps({"filename": local_file.name}).encode()
        upload_resp = _civitai_request(
            f"{CIVITAI_API_BASE}/v1/image-upload",
            upload_req_body,
            _api_headers(token),
        )
        upload_url = upload_resp.get("uploadURL", "")
        upload_id = upload_resp.get("id", "")
        if not upload_url:
            return JSONResponse({"ok": False, "error": f"No upload URL: {upload_resp}"})

        # Step 2: Upload media file to presigned S3 URL
        # Must use curl — Cloudflare blocks Python urllib's TLS fingerprint (error 1010)
        put_result = subprocess.run(
            ["curl", "-s", "-X", "PUT", upload_url,
             "-H", f"Content-Type: {mime}",
             "--data-binary", f"@{local_file}",
             "-w", "%{http_code}", "-o", "/dev/null"],
            capture_output=True, text=True, timeout=120,
        )
        if put_result.stdout.strip() not in ("200", "201"):
            return JSONResponse({"ok": False, "error": f"Upload failed: HTTP {put_result.stdout.strip()}"})

        # Step 3: Create post
        create_input = {"json": {"title": title or None}}
        create_body = json.dumps(create_input).encode()
        create_resp = _civitai_request(
            f"{CIVITAI_TRPC_BASE}/post.create",
            create_body,
            _trpc_headers(token),
        )
        post_id = create_resp.get("result", {}).get("data", {}).get("json", {}).get("id")
        if not post_id:
            return JSONResponse({"ok": False, "error": f"Failed to create post: {create_resp}"})

        # Step 4: Add image/video with metadata
        # Probe real dimensions from the file — metadata width/height can be wrong
        probed = _probe_dimensions(local_file)
        real_w = probed[0] if probed else meta.get("width", 1024)
        real_h = probed[1] if probed else meta.get("height", 1024)

        add_image_input: dict[str, Any] = {
            "json": {
                "postId": post_id,
                "url": upload_id,
                "type": "video" if suffix in (".mp4", ".webm") else "image",
                "width": real_w,
                "height": real_h,
                "name": local_file.name,
                "index": 0,
            }
        }

        # Build CivitAI meta from generation metadata
        civitai_meta: dict[str, Any] = {}

        # CivitAI requires a prompt — generate one from available metadata if absent
        prompt = meta.get("prompt", "")
        if not prompt:
            task = meta.get("task_type", "generation")
            model_names = [
                name.rsplit(".", 1)[0]
                for name, info in meta.get("model_hashes", {}).items()
                if info.get("strength") is not None  # user LoRAs only
            ]
            if model_names:
                prompt = f"AI {task} with {', '.join(model_names)}"
            else:
                prompt = f"AI {task}"
        civitai_meta["prompt"] = prompt
        if meta.get("negative_prompt"):
            civitai_meta["negativePrompt"] = meta["negative_prompt"]
        if meta.get("seed") is not None:
            civitai_meta["seed"] = meta["seed"]
        if meta.get("steps") is not None:
            civitai_meta["steps"] = meta["steps"]
        if meta.get("sampler"):
            civitai_meta["sampler"] = meta["sampler"]
        if meta.get("cfg_scale") is not None:
            cfg = meta["cfg_scale"]
            # sample_guide_scale can be a list like [4, 3] — CivitAI needs a single number
            civitai_meta["cfgScale"] = cfg[0] if isinstance(cfg, list) else cfg
        if meta.get("resolution"):
            civitai_meta["Size"] = meta["resolution"]
        civitai_meta["software"] = meta.get("software", "BlockFlow (comfy-gen)")

        # Build hashes + resources from model_hashes (all .safetensors used)
        # AutoV2 = first 10 hex chars of SHA-256, uppercase
        # CivitAI auto-resolves resources from these hashes
        hashes_map: dict[str, str] = {}
        resources_list: list[dict[str, Any]] = []

        model_hashes: dict[str, dict[str, Any]] = meta.get("model_hashes", {})
        if model_hashes:
            for filename, info in model_hashes.items():
                sha256 = info.get("sha256", "")
                if not sha256:
                    continue
                autov2 = sha256[:10].upper()
                base_name = filename.rsplit(".", 1)[0]
                strength = info.get("strength")
                # Anything with a strength is a user LoRA; otherwise infer from type
                is_lora = strength is not None
                hash_key = f"lora:{base_name}" if is_lora else f"model:{base_name}"
                hashes_map[hash_key] = autov2
                resource: dict[str, Any] = {
                    "type": "lora" if is_lora else "checkpoint",
                    "name": base_name,
                    "hash": autov2,
                }
                if is_lora:
                    resource["weight"] = strength
                resources_list.append(resource)
        else:
            # Backwards compat: fall back to lora_hashes + loras list
            lora_hashes: dict[str, str] = meta.get("lora_hashes", {})
            loras: list[dict[str, Any]] = meta.get("loras", [])
            for lora_name, full_sha256 in lora_hashes.items():
                autov2 = full_sha256[:10].upper()
                strength = 1.0
                for lora in loras:
                    if lora.get("name") == lora_name:
                        strength = lora.get("strength", 1.0)
                        break
                base_name = lora_name.rsplit(".", 1)[0]
                hashes_map[f"lora:{base_name}"] = autov2
                resources_list.append({
                    "type": "lora",
                    "name": base_name,
                    "weight": strength,
                    "hash": autov2,
                })

        if hashes_map:
            civitai_meta["hashes"] = hashes_map
        if resources_list:
            civitai_meta["resources"] = resources_list

        if civitai_meta:
            add_image_input["json"]["meta"] = civitai_meta

        add_image_body = json.dumps(add_image_input).encode()
        add_resp = _civitai_request(
            f"{CIVITAI_TRPC_BASE}/post.addImage",
            add_image_body,
            _trpc_headers(token),
        )

        # Step 5: Add tags
        for tag_name in (tags or []):
            if not tag_name or not tag_name.strip():
                continue
            tag_input = {"json": {"id": post_id, "name": tag_name.strip()}}
            try:
                _civitai_request(
                    f"{CIVITAI_TRPC_BASE}/post.addTag",
                    json.dumps(tag_input).encode(),
                    _trpc_headers(token),
                )
            except Exception:
                pass  # Tag failures are non-critical

        # Step 6: Set NSFW rating if needed
        if nsfw:
            try:
                nsfw_input = {"json": {"id": post_id, "nsfw": True, "nsfwLevel": 28}}
                _civitai_request(
                    f"{CIVITAI_TRPC_BASE}/post.update",
                    json.dumps(nsfw_input).encode(),
                    _trpc_headers(token),
                )
            except Exception:
                pass

        # Step 7: Publish
        post_url = f"https://civitai.com/posts/{post_id}"
        if publish:
            try:
                now_iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
                publish_input = {
                    "json": {
                        "id": post_id,
                        "title": title or None,
                        "detail": description or None,
                        "publishedAt": now_iso,
                    },
                    "meta": {
                        "values": {
                            "publishedAt": ["Date"],
                        }
                    },
                }
                _civitai_request(
                    f"{CIVITAI_TRPC_BASE}/post.update",
                    json.dumps(publish_input).encode(),
                    _trpc_headers(token),
                )
            except Exception as e:
                return JSONResponse({
                    "ok": True,
                    "post_id": post_id,
                    "post_url": post_url,
                    "published": False,
                    "publish_error": str(e),
                })

        return JSONResponse({
            "ok": True,
            "post_id": post_id,
            "post_url": post_url,
            "published": publish,
        })

    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            pass
        return JSONResponse({"ok": False, "error": f"HTTP Error {e.code}: {e.reason}", "detail": body}, status_code=500)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.get("/job-metadata/{job_id}")
async def job_metadata(job_id: str) -> JSONResponse:
    """Get generation metadata for a completed job (for CivitAI sharing)."""
    from backend import services
    job = services._job_snapshot(job_id)
    if not job:
        return JSONResponse({"ok": False, "error": "Job not found"}, status_code=404)

    try:
        request_data = job.get("request", {})
        meta = {
            "prompt": request_data.get("prompt", ""),
            "negative_prompt": request_data.get("negative_prompt", ""),
            "seed": job.get("seed"),
            "model": job.get("model_cls", ""),
            "loras": request_data.get("loras", []),
            "lora_hashes": job.get("lora_hashes", {}),
            "model_hashes": job.get("model_hashes", {}),
            "resolution": f"{request_data.get('width', '?')}x{request_data.get('height', '?')}",
            "width": request_data.get("width"),
            "height": request_data.get("height"),
            "frames": request_data.get("frames"),
            "fps": request_data.get("fps"),
            "inference_settings": job.get("inference_settings", {}),
            "video_url": job.get("local_video_url") or job.get("video_url"),
        }

        # Extract steps from inference settings
        inf = job.get("inference_settings", {})
        if inf.get("infer_steps"):
            meta["steps"] = inf["infer_steps"]
        if inf.get("sample_guide_scale"):
            meta["cfg_scale"] = inf["sample_guide_scale"]

        return JSONResponse({"ok": True, "meta": meta})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.post("/file-metadata")
async def file_metadata(request: Request) -> JSONResponse:
    """Read embedded generation metadata from a local media file."""
    from backend import config, media_meta
    body = await request.json()
    media_url = body.get("media_url", "")
    if not media_url:
        return JSONResponse({"ok": False, "error": "media_url required"}, status_code=400)

    if media_url.startswith("/outputs/"):
        local_file = config.OUTPUT_DIR / media_url.split("/outputs/", 1)[1]
    else:
        return JSONResponse({"ok": False, "error": "Only /outputs/ URLs supported"}, status_code=400)

    if not local_file.exists():
        return JSONResponse({"ok": False, "error": f"File not found: {local_file}"}, status_code=404)

    meta = media_meta.read_metadata(local_file)
    if not meta:
        return JSONResponse({"ok": False, "error": "No embedded metadata found"})

    return JSONResponse({"ok": True, "meta": meta})


def _resolve_media_path(media_url: str) -> Path | None:
    """Resolve a /outputs/ URL to a local file path."""
    from backend import config
    if media_url.startswith("/outputs/"):
        return config.OUTPUT_DIR / media_url.split("/outputs/", 1)[1]
    local = Path(media_url)
    if local.exists():
        return local
    return None


def _extract_video_frames_grid(video_path: Path, num_frames: int = 4) -> bytes:
    """Extract evenly-spaced frames from a video and tile them into a 2x2 grid as JPEG."""
    # Get video duration
    duration_out = subprocess.check_output(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(video_path)],
        timeout=10,
    ).decode().strip()
    duration = float(duration_out)

    frames_dir = tempfile.mkdtemp()
    timestamps = [duration * (i + 1) / (num_frames + 1) for i in range(num_frames)]
    frame_paths = []
    for i, ts in enumerate(timestamps):
        out_path = f"{frames_dir}/frame_{i:02d}.jpg"
        subprocess.run(
            ["ffmpeg", "-y", "-ss", f"{ts:.2f}", "-i", str(video_path),
             "-frames:v", "1", "-q:v", "2", out_path],
            capture_output=True, timeout=15,
        )
        if Path(out_path).exists():
            frame_paths.append(out_path)

    if not frame_paths:
        raise ValueError("Failed to extract any frames from video")

    if len(frame_paths) == 1:
        with open(frame_paths[0], "rb") as f:
            return f.read()

    # Tile into a 2-column grid
    grid_path = f"{frames_dir}/grid.jpg"
    cols = 2
    filter_parts = []
    for i in range(len(frame_paths)):
        filter_parts.append(
            f"[{i}:v]scale=512:512:force_original_aspect_ratio=decrease,"
            f"pad=512:512:(ow-iw)/2:(oh-ih)/2[s{i}]"
        )
    concat_inputs = "".join(f"[s{i}]" for i in range(len(frame_paths)))
    layouts = []
    for i in range(len(frame_paths)):
        col, row = i % cols, i // cols
        layouts.append(f"{col * 512}_{row * 512}")
    filter_parts.append(
        f"{concat_inputs}xstack=inputs={len(frame_paths)}:layout={'|'.join(layouts)}"
    )
    cmd = ["ffmpeg", "-y"]
    for fp in frame_paths:
        cmd.extend(["-i", fp])
    cmd.extend(["-filter_complex", ";".join(filter_parts), "-q:v", "2", grid_path])
    subprocess.run(cmd, capture_output=True, timeout=30)

    with open(grid_path, "rb") as f:
        return f.read()


@router.post("/auto-tags")
async def auto_tags(request: Request) -> JSONResponse:
    """Generate tags for media using Gemini Flash Lite via OpenRouter."""
    from backend import config

    if not config.OPENROUTER_API_KEY:
        return JSONResponse({"ok": False, "error": "OPENROUTER_API_KEY not set"}, status_code=400)

    body = await request.json()
    media_url = body.get("media_url", "")
    model_name = body.get("model", "")
    loras = body.get("loras", [])
    if not media_url:
        return JSONResponse({"ok": False, "error": "media_url required"}, status_code=400)

    local_file = _resolve_media_path(media_url)
    if not local_file or not local_file.exists():
        return JSONResponse({"ok": False, "error": f"File not found: {media_url}"}, status_code=404)

    try:
        suffix = local_file.suffix.lower()
        is_video = suffix in (".mp4", ".webm", ".mov", ".avi")

        if is_video:
            image_bytes = _extract_video_frames_grid(local_file, num_frames=4)
            mime_type = "image/jpeg"
        else:
            image_bytes = local_file.read_bytes()
            mime_type = "image/png" if suffix == ".png" else "image/jpeg"

        b64_image = base64.b64encode(image_bytes).decode("ascii")
        prompt_text = _build_tag_prompt(model_name, loras)

        openrouter_body = json.dumps({
            "model": AUTO_TAG_MODEL,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt_text},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{mime_type};base64,{b64_image}",
                            },
                        },
                    ],
                }
            ],
            "max_tokens": 200,
            "temperature": 0.3,
        }).encode()

        headers = {
            "Authorization": f"Bearer {config.OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
        }
        if config.OPENROUTER_SITE_URL:
            headers["HTTP-Referer"] = config.OPENROUTER_SITE_URL
        if config.OPENROUTER_APP_NAME:
            headers["X-Title"] = config.OPENROUTER_APP_NAME

        req = urllib.request.Request(
            f"{config.OPENROUTER_API_BASE}/chat/completions",
            data=openrouter_body,
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))

        content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        if not content:
            return JSONResponse({"ok": False, "error": "Empty response from LLM"})

        # Parse comma-separated tags
        raw_tags = [t.strip().strip('"').strip("'") for t in content.split(",")]
        tags = [t for t in raw_tags if t and len(t) < 50][:7]

        return JSONResponse({"ok": True, "tags": tags})

    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        return JSONResponse({"ok": False, "error": f"OpenRouter error {e.code}: {detail}"}, status_code=500)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

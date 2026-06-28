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

from fastapi import APIRouter
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
        lora_names = [lora.get("name", "") for lora in loras if lora.get("name")]
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
    from backend import settings_store
    return settings_store.get_credential("civitai_api_key") or os.environ.get("CIVITAI_API_KEY", "")


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


def _resolve_local_file(media_url: str) -> Path | None:
    """Resolve a media_url to a local file path, or None."""
    if media_url.startswith("/outputs/"):
        from backend import config
        return config.OUTPUT_DIR / media_url.split("/outputs/", 1)[1]
    local = Path(media_url)
    if local.exists():
        return local
    return None


def _upload_media_file(local_file: Path, token: str) -> tuple[str, str]:
    """Upload a single media file to CivitAI. Returns (upload_id, media_type)."""
    suffix = local_file.suffix.lower()
    mime = "video/mp4" if suffix == ".mp4" else "video/webm" if suffix == ".webm" else "image/png" if suffix == ".png" else "image/jpeg"

    # Get presigned upload URL
    upload_req_body = json.dumps({"filename": local_file.name}).encode()
    upload_resp = _civitai_request(
        f"{CIVITAI_API_BASE}/v1/image-upload",
        upload_req_body,
        _api_headers(token),
    )
    upload_url = upload_resp.get("uploadURL", "")
    upload_id = upload_resp.get("id", "")
    if not upload_url:
        raise ValueError(f"No upload URL for {local_file.name}: {upload_resp}")

    # Upload to presigned S3 URL (curl — Cloudflare blocks Python urllib's TLS fingerprint)
    put_result = subprocess.run(
        ["curl", "-s", "-X", "PUT", upload_url,
         "-H", f"Content-Type: {mime}",
         "--data-binary", f"@{local_file}",
         "-w", "%{http_code}", "-o", "/dev/null"],
        capture_output=True, text=True, timeout=120,
    )
    if put_result.stdout.strip() not in ("200", "201"):
        raise ValueError(f"Upload failed for {local_file.name}: HTTP {put_result.stdout.strip()}")

    media_type = "video" if suffix in (".mp4", ".webm") else "image"
    return upload_id, media_type


def _build_civitai_meta(
    meta: dict[str, Any],
    manual_resources: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build CivitAI metadata dict from generation metadata.

    manual_resources: user-supplied modelVersionId references emitted under
    `civitaiResources` (the field CivitAI links by modelVersionId). Entries
    without modelVersionId are dropped. Not added to hashes_map/resources (no
    AutoV2 locally, and CivitAI ignores a modelVersionId in `resources`).
    """
    civitai_meta: dict[str, Any] = {}

    prompt = meta.get("prompt", "")
    if not prompt:
        task = meta.get("task_type", "generation")
        model_names = [
            name.rsplit(".", 1)[0]
            for name, info in meta.get("model_hashes", {}).items()
            if info.get("strength") is not None
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
        civitai_meta["cfgScale"] = cfg[0] if isinstance(cfg, list) else cfg
    if meta.get("resolution"):
        civitai_meta["Size"] = meta["resolution"]
    civitai_meta["software"] = meta.get("software", "BlockFlow (comfy-gen)")

    # Build hashes + resources from model_hashes
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

    # Manual resources carry a modelVersionId but no local hash. CivitAI only
    # honors modelVersionId from `civitaiResources` (the legacy `resources`
    # array is matched by hash, so a modelVersionId there is silently ignored —
    # the "resolves locally but never attaches" bug). Type is omitted; CivitAI
    # derives it from the resolved version.
    civitai_resources_list: list[dict[str, Any]] = []
    for entry in (manual_resources or []):
        mvid = entry.get("modelVersionId")
        if mvid is None:
            continue
        cr: dict[str, Any] = {"modelVersionId": int(mvid)}
        if entry.get("name"):
            cr["modelName"] = entry["name"]
        if entry.get("versionName"):
            cr["versionName"] = entry["versionName"]
        civitai_resources_list.append(cr)

    if hashes_map:
        civitai_meta["hashes"] = hashes_map
    if resources_list:
        civitai_meta["resources"] = resources_list
    if civitai_resources_list:
        civitai_meta["civitaiResources"] = civitai_resources_list

    return civitai_meta


@router.post("/share")
def share(body: dict) -> JSONResponse:
    """Upload media and create a single CivitAI post with all images.

    Accepts either a single media_url or a list of media_urls.
    All media files are uploaded and added to one post.

    Flow:
    1. Resolve and upload all media files
    2. Create one post
    3. Add each image/video to the post with incrementing index
    4. Add tags, set NSFW, publish

    Defined `def` (not `async def`) ON PURPOSE: the body does synchronous blocking
    I/O (urllib presigns + curl S3 PUTs + tRPC calls, one round per image). A sync
    path-op runs in FastAPI's threadpool, so a 10-image upload no longer freezes the
    event loop and stall every other request (e.g. the Artifacts /api/runs poll →
    ECONNRESET). Do not make this async without offloading the I/O via to_thread.
    """
    token = body.get("token") or _get_token()
    if not token:
        return JSONResponse({"ok": False, "error": "No CivitAI API key"}, status_code=400)

    # Accept single media_url or list of media_urls
    media_urls: list[str] = body.get("media_urls", [])
    if not media_urls:
        single = body.get("media_url", "")
        if single:
            media_urls = [single]
    if not media_urls:
        return JSONResponse({"ok": False, "error": "media_url or media_urls required"}, status_code=400)

    title = body.get("title", "")
    description = body.get("description", "")
    tags = body.get("tags", [])
    nsfw = body.get("nsfw", False)
    publish = body.get("publish", True)
    meta = body.get("meta", {})
    # Per-image metadata aligned with media_urls. Prompt/seed/dims differ per image in
    # a batch (shared `meta` only covers batch-wide resources), so each image gets its
    # own. Falls back to the single `meta` when absent or short.
    metas = body.get("metas") or []
    manual_resources = body.get("manual_resources", []) or []

    # Resolve all media files to local paths
    local_files: list[Path] = []
    for url in media_urls:
        local_file = _resolve_local_file(url)
        if not local_file or not local_file.exists():
            return JSONResponse({"ok": False, "error": f"File not found: {url}"}, status_code=400)
        local_files.append(local_file)

    try:
        # Step 1: Upload all media files
        uploads: list[tuple[str, str, Path]] = []  # (upload_id, media_type, local_file)
        for local_file in local_files:
            upload_id, media_type = _upload_media_file(local_file, token)
            uploads.append((upload_id, media_type, local_file))

        # Step 2: Create post
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

        # Step 3: Add each image/video to the post, each with ITS OWN metadata.
        for idx, (upload_id, media_type, local_file) in enumerate(uploads):
            img_meta = metas[idx] if idx < len(metas) and isinstance(metas[idx], dict) else meta
            civitai_meta = _build_civitai_meta(img_meta, manual_resources=manual_resources)

            probed = _probe_dimensions(local_file)
            real_w = probed[0] if probed else img_meta.get("width", 1024)
            real_h = probed[1] if probed else img_meta.get("height", 1024)

            add_image_input: dict[str, Any] = {
                "json": {
                    "postId": post_id,
                    "url": upload_id,
                    "type": media_type,
                    "width": real_w,
                    "height": real_h,
                    "name": local_file.name,
                    "index": idx,
                }
            }
            # Attach metadata to every image so CivitAI resolves models on each
            if civitai_meta:
                add_image_input["json"]["meta"] = civitai_meta

            add_image_body = json.dumps(add_image_input).encode()
            _civitai_request(
                f"{CIVITAI_TRPC_BASE}/post.addImage",
                add_image_body,
                _trpc_headers(token),
            )

        # Step 4: Resolve modelVersionId from first LoRA hash and link post to model
        model_version_id = None
        model_hashes: dict[str, dict[str, Any]] = meta.get("model_hashes", {})
        for filename, info in model_hashes.items():
            sha256 = info.get("sha256", "")
            if not sha256 or info.get("strength") is None:
                continue  # skip non-LoRA models
            try:
                resolve_resp = _civitai_request(
                    f"{CIVITAI_API_BASE}/v1/model-versions/by-hash/{sha256}",
                    None,
                    _api_headers(token),
                    method="GET",
                )
                vid = resolve_resp.get("id")
                if vid:
                    model_version_id = vid
                    break
            except Exception:
                continue

        if model_version_id:
            try:
                link_input = {"json": {"id": post_id, "modelVersionId": model_version_id}}
                _civitai_request(
                    f"{CIVITAI_TRPC_BASE}/post.update",
                    json.dumps(link_input).encode(),
                    _trpc_headers(token),
                )
            except Exception:
                pass  # Non-critical — post still works without model link

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
                pass

        # Step 5: Set NSFW rating if needed
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

        # Step 6: Publish
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
                    "image_count": len(uploads),
                    "published": False,
                    "publish_error": str(e),
                })

        return JSONResponse({
            "ok": True,
            "post_id": post_id,
            "post_url": post_url,
            "image_count": len(uploads),
            "published": publish,
        })

    except urllib.error.HTTPError as e:
        body_text = ""
        try:
            body_text = e.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            pass
        return JSONResponse({"ok": False, "error": f"HTTP Error {e.code}: {e.reason}", "detail": body_text}, status_code=500)
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
            # request["prompt"] is often empty (e.g. upstream Prompt Writer);
            # ComfyGen persists the real prompt at the top level. Prefer the
            # explicit request prompt, else fall back so CivitAI gets the
            # actual prompt instead of the generic synthesised fallback.
            "prompt": request_data.get("prompt") or job.get("prompt", ""),
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
def file_metadata(body: dict) -> JSONResponse:
    """Read embedded generation metadata from a local media file.

    Sync (threadpool) — does blocking file I/O; see the note on `share`.
    """
    from backend import config, media_meta
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
def auto_tags(body: dict) -> JSONResponse:
    """Generate tags for media using Gemini Flash Lite via OpenRouter.

    Sync (threadpool) — does a blocking OpenRouter HTTP call; see the note on `share`.
    """
    from backend import config

    if not config.OPENROUTER_API_KEY:
        return JSONResponse({"ok": False, "error": "OPENROUTER_API_KEY not set"}, status_code=400)

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


@router.post("/resolve-hashes")
def resolve_hashes(body: dict) -> JSONResponse:
    """Batch-resolve detected SHA256 hashes to CivitAI model versions.

    Powers the HITL approval gate: the user sees real model names instead
    of raw AutoV2 hex before clicking Approve. Rows whose hash 404s come
    back with resolved=false so the gate renders 'Unknown — not on CivitAI'
    and the share endpoint excludes them from meta.resources.

    Sync (threadpool) — blocking per-hash HTTP calls; see the note on `share`.
    """
    from backend import civitai_client
    hashes_in = body.get("hashes", []) or []
    seen: dict[str, dict[str, Any] | None] = {}
    out: list[dict[str, Any]] = []
    for entry in hashes_in:
        sha = (entry.get("sha256") or "").lower()
        filename = entry.get("filename", "")
        if not sha:
            out.append({"filename": filename, "sha256": sha, "resolved": False})
            continue
        if sha not in seen:
            try:
                meta = civitai_client.fetch_version_by_hash(sha)
            except Exception:
                meta = None
            # Prefer the model title (model.name) over the version label
            # (name) as the primary display string — "WAN 2.2 SVI 4 Passes"
            # is what the user recognises, "v1.0" is not. Fall back to the
            # version label if the model block is absent.
            seen[sha] = (
                {
                    "modelVersionId": meta.version_id,
                    "modelId": meta.model_id,
                    "name": meta.model_name or meta.name or "",
                    "versionName": meta.name or "",
                    "type": meta.model_type or "",
                }
                if meta is not None
                else None
            )
        resolved = seen[sha]
        if resolved is None:
            out.append({"filename": filename, "sha256": sha, "resolved": False})
        else:
            out.append({
                "filename": filename,
                "sha256": sha,
                "resolved": True,
                **resolved,
            })
    return JSONResponse({"ok": True, "resolved": out})


@router.post("/resolve-resource")
def resolve_resource(body: dict) -> JSONResponse:
    """Resolve a user-supplied CivitAI URL or ID to a model version.

    Used by the 'Linked resources' UI section so the user can credit
    workflows (which have no detectable hash locally) by pasting their
    civitai.com URL.

    Sync (threadpool) — blocking HTTP call; see the note on `share`.
    """
    from backend import civitai_client
    raw = (body.get("input") or "").strip()
    if not raw:
        return JSONResponse({"ok": False, "error": "input required"})

    try:
        ref = civitai_client.parse_civitai_ref(raw)
    except civitai_client.CivitAIRefError as e:
        return JSONResponse({"ok": False, "error": str(e)})

    try:
        if ref.version_id is not None:
            meta = civitai_client.fetch_version_metadata(ref.version_id)
        else:
            assert ref.model_id is not None  # parse_civitai_ref invariant
            meta = civitai_client.fetch_latest_version_for_model(ref.model_id)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)})

    return JSONResponse({
        "ok": True,
        "resource": {
            "modelVersionId": meta.version_id,
            "modelId": meta.model_id,
            "name": meta.model_name or meta.name or "",
            "versionName": meta.name or "",
            "type": meta.model_type or "",
        },
    })

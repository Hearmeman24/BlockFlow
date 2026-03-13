"""Topaz Image AI upscaler — client for the Topaz Labs Image REST API.

Supports two modes:
  - Synchronous: POST /enhance (returns binary image directly, up to 96MP output)
  - Asynchronous: POST /enhance-gen/async → poll status → download output

Categories available: enhance, sharpen, denoise, restore, lighting
"""

from __future__ import annotations

import json
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

IMAGE_API_BASE = "https://api.topazlabs.com/image/v1"

# Enhance models (upscale + denoise + sharpen)
ENHANCE_MODELS: list[dict[str, str]] = [
    {"value": "Standard V2", "label": "Standard V2 - best for most images"},
    {"value": "Low Resolution V2", "label": "Low Resolution V2 - small/low-res sources"},
    {"value": "High Fidelity V2", "label": "High Fidelity V2 - preserve fine details"},
    {"value": "CGI", "label": "CGI - AI-generated / CG art"},
    {"value": "Text Refine", "label": "Text Refine - images with text"},
]

# Sharpen models
SHARPEN_MODELS: list[dict[str, str]] = [
    {"value": "Standard", "label": "Standard - general sharpening"},
    {"value": "Strong", "label": "Strong - aggressive sharpening"},
    {"value": "Lens Blur V2", "label": "Lens Blur V2 - out-of-focus fix"},
    {"value": "Motion Blur", "label": "Motion Blur - motion deblur"},
    {"value": "Natural", "label": "Natural - subtle, natural sharpening"},
]

RESOLUTION_PRESETS: dict[str, int] = {
    "4k": 2160,
    "2k": 1440,
    "1080p": 1080,
    "original": 0,
}

OUTPUT_FORMATS = ["png", "jpeg", "tiff"]


def _probe_image(path: Path) -> dict[str, Any]:
    """Get image dimensions via ffprobe."""
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "json",
        str(path),
    ]
    raw = subprocess.check_output(cmd, stderr=subprocess.STDOUT, timeout=10).decode()
    obj = json.loads(raw)
    stream = (obj.get("streams") or [{}])[0]
    return {
        "width": int(stream.get("width", 0)),
        "height": int(stream.get("height", 0)),
        "size": path.stat().st_size,
    }


def _calculate_output_dims(
    src_w: int, src_h: int, preset: str,
) -> tuple[int, int]:
    """Calculate output dimensions from a resolution preset."""
    target_h = RESOLUTION_PRESETS.get(preset, 0)
    if target_h == 0 or target_h >= src_h:
        return (0, 0)  # 0,0 means don't specify — let Topaz decide / keep original
    # Scale proportionally
    ratio = src_w / src_h if src_h > 0 else 1.0
    out_h = target_h
    out_w = round(out_h * ratio)
    # Ensure even
    out_w = out_w + (out_w % 2)
    out_h = out_h + (out_h % 2)
    return (out_w, out_h)


def upscale_image(
    image_path: Path,
    api_key: str,
    category: str = "enhance",
    model: str = "Standard V2",
    resolution_preset: str = "4k",
    output_format: str = "png",
    face_enhancement: bool = True,
    face_enhancement_strength: float = 0.8,
    face_enhancement_creativity: float = 0.0,
    log: Callable[[str], None] | None = None,
) -> Path:
    """Upscale an image using the Topaz Image API (synchronous endpoint).

    Returns path to the enhanced image file.
    """
    _log = log or (lambda msg: None)

    # Probe source
    _log("Probing image...")
    meta = _probe_image(image_path)
    if meta["width"] == 0 or meta["height"] == 0:
        raise RuntimeError(f"ffprobe returned invalid dimensions: {meta}")

    _log(f"Source: {meta['width']}x{meta['height']}, {meta['size']} bytes")

    out_w, out_h = _calculate_output_dims(meta["width"], meta["height"], resolution_preset)

    # Build multipart form data
    boundary = "----TopazImageUpload"
    body_parts: list[bytes] = []

    def add_field(name: str, value: str) -> None:
        body_parts.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{value}\r\n".encode()
        )

    def add_file(name: str, filename: str, data: bytes, content_type: str) -> None:
        body_parts.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n".encode()
            + data
            + b"\r\n"
        )

    # Image file
    suffix = image_path.suffix.lower()
    mime = "image/png" if suffix == ".png" else "image/tiff" if suffix in (".tiff", ".tif") else "image/jpeg"
    add_file("image", image_path.name, image_path.read_bytes(), mime)

    add_field("model", model)
    add_field("output_format", output_format)
    add_field("face_enhancement", str(face_enhancement).lower())
    add_field("face_enhancement_strength", str(face_enhancement_strength))
    add_field("face_enhancement_creativity", str(face_enhancement_creativity))

    if out_w > 0 and out_h > 0:
        add_field("output_width", str(out_w))
        add_field("output_height", str(out_h))
        _log(f"Target: {out_w}x{out_h}")
    else:
        _log(f"Target: autopilot (model decides)")

    body_parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(body_parts)

    # Determine endpoint from category
    endpoint = f"{IMAGE_API_BASE}/{category}"
    _log(f"Submitting to {category} (model={model})...")

    headers = {
        "X-API-Key": api_key,
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }

    req = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            content_type = resp.headers.get("Content-Type", "")
            process_id = resp.headers.get("X-Process-ID", "")

            if "image/" in content_type:
                # Synchronous — got the image back directly
                result_data = resp.read()
                ext = output_format if output_format in ("png", "jpeg", "tiff") else "png"
                if ext == "jpeg":
                    ext = "jpg"
                ts = time.strftime("%Y%m%d_%H%M%S")
                output_path = image_path.parent / f"{image_path.stem}_upscaled_{ts}.{ext}"
                output_path.write_bytes(result_data)
                _log(f"Done! Saved to {output_path.name} ({len(result_data)} bytes)")
                return output_path

            # Async response — got JSON with process_id
            resp_body = json.loads(resp.read().decode())
            process_id = process_id or resp_body.get("process_id", "")

    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Topaz Image API {category} → HTTP {e.code}: {err_body}") from e

    if not process_id:
        raise RuntimeError("No process_id returned from Topaz API")

    # Poll for completion
    _log(f"Async job {process_id} — polling...")
    max_wait = 600  # 10 minutes
    t0 = time.time()
    while time.time() - t0 < max_wait:
        time.sleep(3)
        try:
            status_req = urllib.request.Request(
                f"{IMAGE_API_BASE}/status/{process_id}",
                headers={"X-API-Key": api_key},
                method="GET",
            )
            with urllib.request.urlopen(status_req, timeout=30) as status_resp:
                status_data = json.loads(status_resp.read().decode())
        except urllib.error.HTTPError:
            continue

        status = str(status_data.get("status", "")).lower()
        progress = status_data.get("progress", 0)

        if status in ("completed", "complete"):
            _log("Processing complete!")
            # Download output
            dl_req = urllib.request.Request(
                f"{IMAGE_API_BASE}/download/output/{process_id}",
                headers={"X-API-Key": api_key},
                method="GET",
            )
            with urllib.request.urlopen(dl_req, timeout=120) as dl_resp:
                result_data = dl_resp.read()

            ext = output_format if output_format in ("png", "jpeg", "tiff") else "png"
            if ext == "jpeg":
                ext = "jpg"
            ts = time.strftime("%Y%m%d_%H%M%S")
            output_path = image_path.parent / f"{image_path.stem}_upscaled_{ts}.{ext}"
            output_path.write_bytes(result_data)
            _log(f"Saved to {output_path.name} ({len(result_data)} bytes)")
            return output_path

        if status == "failed":
            error_msg = status_data.get("message") or status_data.get("error") or "Unknown"
            raise RuntimeError(f"Topaz processing failed: {error_msg}")

        _log(f"  Progress: {progress}%")

    raise RuntimeError(f"Topaz processing timed out after {max_wait}s")

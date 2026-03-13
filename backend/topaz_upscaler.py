"""Topaz Video AI upscaler — synchronous client for the Topaz Labs REST API.

Workflow:
  1. Create request (POST /video/) — send video metadata + filters
  2. Accept request (PATCH /video/{id}/accept) — get presigned upload URLs
  3. Upload video (PUT to S3 presigned URLs) — multipart byte-range upload
  4. Complete upload (PATCH /video/{id}/complete-upload) — finalize
  5. Poll status (GET /video/{id}/status) — until complete/failed
  6. Download result — from signed URL in status response
"""

from __future__ import annotations

import json
import math
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

API_BASE = "https://api.topazlabs.com"

ENCODER_PROFILES: dict[str, str] = {
    "H265": "Main",
    "H264": "High",
    "ProRes": "422 HQ",
    "AV1": "10-bit",
    "VP9": "Good",
    "FFV1": "Default",
}

RESOLUTION_PRESETS: dict[str, int] = {
    "4k": 2160,
    "2k": 1440,
    "1080p": 1080,
    "original": 0,
}

COMMON_RATIOS = [
    (16, 9),
    (9, 16),
    (1, 1),
    (4, 3),
    (3, 4),
    (21, 9),
    (9, 21),
]


def _topaz_request(
    method: str,
    path: str,
    api_key: str,
    payload: dict[str, Any] | None = None,
    timeout: int = 60,
) -> dict[str, Any]:
    url = f"{API_BASE}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "X-API-Key": api_key,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; SGS-UI/1.0)",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body.strip() else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Topaz API {method} {path} → HTTP {e.code}: {body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Topaz API request failed: {e}") from e


def _probe_video(path: Path) -> dict[str, Any]:
    """Extract video metadata with ffprobe."""
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=size,duration:stream=width,height,avg_frame_rate,nb_frames,codec_name",
        "-select_streams", "v:0",
        "-of", "json",
        str(path),
    ]
    raw = subprocess.check_output(cmd, stderr=subprocess.STDOUT, timeout=30).decode("utf-8", errors="replace")
    obj = json.loads(raw)
    fmt = obj.get("format", {})
    streams = obj.get("streams", [{}])
    stream = streams[0] if streams else {}

    # Parse frame rate from ratio like "24000/1001"
    fps = 0.0
    fr = str(stream.get("avg_frame_rate", "0/0"))
    if "/" in fr:
        n, d = fr.split("/", 1)
        fps = float(n) / float(d) if float(d) else 0.0
    else:
        fps = float(fr)

    nb_frames = stream.get("nb_frames")
    frame_count = int(nb_frames) if nb_frames and str(nb_frames).strip().isdigit() else 0
    duration = float(fmt.get("duration", 0))
    if frame_count == 0 and fps > 0 and duration > 0:
        frame_count = round(fps * duration)

    return {
        "width": int(stream.get("width", 0)),
        "height": int(stream.get("height", 0)),
        "fps": round(fps, 3),
        "frame_count": frame_count,
        "duration": round(duration, 3),
        "size": int(fmt.get("size", 0)) or path.stat().st_size,
        "container": path.suffix.lstrip(".").lower() or "mp4",
        "codec": stream.get("codec_name", "unknown"),
    }


def _snap_aspect_ratio(w: int, h: int) -> tuple[int, int]:
    """Snap to nearest common aspect ratio."""
    if w <= 0 or h <= 0:
        return (9, 16)
    ratio = w / h
    best = min(COMMON_RATIOS, key=lambda r: abs(r[0] / r[1] - ratio))
    return best


def _calculate_output_resolution(
    src_w: int, src_h: int, preset: str,
) -> tuple[int, int]:
    target_h = RESOLUTION_PRESETS.get(preset, 0)
    if target_h == 0:
        return (src_w, src_h)
    ar_w, ar_h = _snap_aspect_ratio(src_w, src_h)
    out_h = target_h
    out_w = round(out_h * ar_w / ar_h)
    # Ensure even dimensions
    out_w = out_w + (out_w % 2)
    out_h = out_h + (out_h % 2)
    return (out_w, out_h)


class TopazProgress:
    """Structured progress data from the Topaz polling loop."""

    def __init__(
        self,
        phase: str,
        progress: float,
        avg_fps: float,
        elapsed_seconds: float,
        topaz_request_id: str,
        chunks: list[dict[str, Any]] | None = None,
    ):
        self.phase = phase
        self.progress = progress
        self.avg_fps = avg_fps
        self.elapsed_seconds = elapsed_seconds
        self.topaz_request_id = topaz_request_id
        self.chunks = chunks or []


def upscale_video(
    video_path: Path,
    api_key: str,
    enhancement_model: str = "ahq-12",
    interpolation_model: str | None = "apo-8",
    output_fps: int | None = None,
    resolution_preset: str = "4k",
    video_encoder: str = "H265",
    compression: str = "Mid",
    log: Callable[[str], None] | None = None,
    on_progress: Callable[[TopazProgress], None] | None = None,
) -> Path:
    """Run the full 6-step Topaz upscale workflow. Returns path to downloaded result."""
    _log = log or (lambda msg: None)
    _on_progress = on_progress or (lambda p: None)

    # --- Step 0: Probe video metadata ---
    _log("Probing video metadata...")
    meta = _probe_video(video_path)
    if meta["width"] == 0 or meta["height"] == 0:
        raise RuntimeError(f"ffprobe returned invalid resolution: {meta}")

    out_w, out_h = _calculate_output_resolution(
        meta["width"], meta["height"], resolution_preset,
    )
    profile = ENCODER_PROFILES.get(video_encoder, "Main")
    target_fps = int(output_fps) if output_fps else round(meta["fps"])
    target_fps = max(1, target_fps)
    filters = [{"model": enhancement_model}]
    if interpolation_model:
        filters.append({"model": interpolation_model})

    _log(f"Source: {meta['width']}x{meta['height']} @ {meta['fps']}fps, {meta['frame_count']} frames")
    interp_label = interpolation_model if interpolation_model else "none"
    _log(
        f"Target: {out_w}x{out_h} @ {target_fps}fps, encoder={video_encoder}, "
        f"enhancement={enhancement_model}, interpolation={interp_label}"
    )

    # --- Step 1: Create request ---
    _log("Creating Topaz request...")
    create_payload = {
        "source": {
            "container": meta["container"],
            "size": meta["size"],
            "duration": meta["duration"],
            "frameCount": meta["frame_count"],
            "frameRate": meta["fps"],
            "resolution": {"width": meta["width"], "height": meta["height"]},
        },
        "filters": filters,
        "output": {
            "frameRate": target_fps,
            "audioTransfer": "Copy",
            "audioCodec": "AAC",
            "videoEncoder": video_encoder,
            "videoProfile": profile,
            "dynamicCompressionLevel": compression,
            "resolution": {"width": out_w, "height": out_h},
        },
    }
    create_resp = _topaz_request("POST", "/video/", api_key, create_payload)
    request_id = create_resp.get("requestId") or create_resp.get("id")
    if not request_id:
        raise RuntimeError(f"No requestId in create response: {create_resp}")
    _log(f"Request created: {request_id}")

    # --- Step 2: Accept request (get upload URLs) ---
    _log("Accepting request...")
    accept_resp = _topaz_request("PATCH", f"/video/{request_id}/accept", api_key)
    upload_urls = accept_resp.get("uploadUrls") or accept_resp.get("upload_urls") or accept_resp.get("urls") or []
    if not upload_urls:
        raise RuntimeError(f"No upload URLs in accept response: {accept_resp}")
    _log(f"Got {len(upload_urls)} upload URL(s)")

    # --- Step 3: Upload video (multipart) ---
    _log("Uploading video...")
    file_size = meta["size"]
    num_parts = len(upload_urls)
    chunk_size = math.ceil(file_size / num_parts)
    parts: list[dict[str, Any]] = []

    with open(video_path, "rb") as f:
        for i, url in enumerate(upload_urls):
            start = i * chunk_size
            end = min(start + chunk_size, file_size)
            f.seek(start)
            data = f.read(end - start)

            req = urllib.request.Request(url, data=data, method="PUT")
            req.add_header("Content-Type", "application/octet-stream")
            req.add_header("Content-Length", str(len(data)))

            with urllib.request.urlopen(req, timeout=300) as resp:
                etag = resp.headers.get("ETag", "").strip('"')
                parts.append({"partNum": i + 1, "eTag": etag})
            _log(f"  Uploaded part {i + 1}/{num_parts}")

    # --- Step 4: Complete upload ---
    _log("Completing upload...")
    _topaz_request("PATCH", f"/video/{request_id}/complete-upload", api_key, {"uploadResults": parts})

    # --- Step 5: Poll status ---
    _log("Processing... (polling every 5s)")
    max_wait = 3600  # 1 hour
    poll_t0 = time.time()
    last_progress = -1.0
    stall_since: float | None = None
    STALL_TIMEOUT = 600  # 10 minutes with no progress change → timeout

    while time.time() - poll_t0 < max_wait:
        time.sleep(5)
        status_resp = _topaz_request("GET", f"/video/{request_id}/status", api_key)
        status = str(status_resp.get("status", "")).lower()

        # Extract per-chunk stats for detailed progress
        chunks = status_resp.get("processingStats") or []
        # Aggregate progress across chunks
        if chunks:
            progress = sum(c.get("progress", 0) for c in chunks) / len(chunks)
            avg_fps = sum(c.get("fps", 0) for c in chunks) / len(chunks)
        else:
            progress = status_resp.get("progress", 0)
            avg_fps = status_resp.get("averageFps", 0)

        elapsed = round(time.time() - poll_t0, 1)

        # Emit structured progress
        _on_progress(TopazProgress(
            phase=status,
            progress=progress,
            avg_fps=avg_fps,
            elapsed_seconds=elapsed,
            topaz_request_id=request_id,
            chunks=[{
                "index": c.get("chunkIndex", i),
                "status": c.get("status", "unknown"),
                "progress": c.get("progress", 0),
                "fps": c.get("fps", 0),
                "gpu": c.get("gpuUtilization", 0),
            } for i, c in enumerate(chunks)],
        ))

        if status == "complete":
            _log(f"Processing complete! ({elapsed:.0f}s)")
            download_url = (status_resp.get("download") or {}).get("url")
            if not download_url:
                raise RuntimeError(f"No download URL in complete response: {status_resp}")

            # --- Step 6: Download result ---
            _log("Downloading upscaled video...")
            output_path = video_path.parent / f"{video_path.stem}_upscaled.mp4"
            req = urllib.request.Request(download_url)
            with urllib.request.urlopen(req, timeout=600) as resp:
                output_path.write_bytes(resp.read())
            _log(f"Saved to {output_path}")
            return output_path

        if status in ("failed", "canceled", "cancelled"):
            error_msg = status_resp.get("message") or status_resp.get("error") or "Unknown error"
            raise RuntimeError(f"Topaz processing {status}: {error_msg}")

        # Stall detection: if progress hasn't changed for STALL_TIMEOUT seconds
        if progress != last_progress:
            last_progress = progress
            stall_since = None
        else:
            if stall_since is None:
                stall_since = time.time()
            elif time.time() - stall_since > STALL_TIMEOUT:
                raise RuntimeError(
                    f"Topaz processing stalled at {progress:.0f}% for "
                    f"{STALL_TIMEOUT}s (phase: {status}, elapsed: {elapsed:.0f}s)"
                )

        _log(f"  [{status}] {progress:.0f}% @ {avg_fps:.1f} fps ({elapsed:.0f}s)")

    raise RuntimeError(f"Topaz processing timed out after {max_wait}s")

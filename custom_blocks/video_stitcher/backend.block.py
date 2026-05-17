from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend import config

router = APIRouter()

STITCHED_DIR = config.LOCAL_OUTPUT_DIR / "stitched"
STITCHED_DIR.mkdir(parents=True, exist_ok=True)

# xfade transitions exposed in the UI. Key: UI label, Value: xfade transition name or None for hard cut.
TRANSITIONS: dict[str, str | None] = {
    "none": None,
    "fade": "fade",
    "slide": "slideleft",
    "wipe": "wipeleft",
    "circle": "circleopen",
    "pixelize": "pixelize",
}


class StitchRequest(BaseModel):
    videos: list[str] = Field(..., min_length=1, description="Ordered list of video URLs/paths")
    transition: str = Field("none", description="Transition key (none/fade/slide/wipe/circle/pixelize)")
    duration: float = Field(0.5, ge=0.0, le=2.0, description="Crossfade duration in seconds")


def _resolve_to_local(src: str) -> Path:
    src = (src or "").strip()
    if not src:
        raise ValueError("Empty video URL")
    if src.startswith(("http://", "https://")):
        ts = time.strftime("%Y%m%d_%H%M%S")
        sha = hashlib.sha1(src.encode()).hexdigest()[:8]
        ext = Path(src.split("?", 1)[0]).suffix or ".mp4"
        dst = STITCHED_DIR / f"_src_{ts}_{sha}{ext}"
        req = urllib.request.Request(src)
        with urllib.request.urlopen(req, timeout=300) as resp:
            dst.write_bytes(resp.read())
        return dst
    if src.startswith("/outputs/"):
        return config.LOCAL_OUTPUT_DIR / src.split("/outputs/", 1)[1]
    p = Path(src)
    if not p.is_absolute():
        p = config.LOCAL_OUTPUT_DIR / src
    return p


def _probe_dims(path: Path) -> tuple[int, int]:
    """Return (width, height) of first video stream via ffprobe."""
    out = subprocess.check_output(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "json",
            str(path),
        ],
        timeout=30,
    )
    data = json.loads(out)
    stream = (data.get("streams") or [{}])[0]
    return int(stream.get("width") or 0), int(stream.get("height") or 0)


def _probe_duration(path: Path) -> float:
    out = subprocess.check_output(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=nokey=1:noprint_wrappers=1",
            str(path),
        ],
        timeout=30,
    )
    try:
        return float(out.strip())
    except ValueError:
        return 0.0


def _concat_demuxer(paths: list[Path], out_path: Path) -> None:
    """Hard-cut concat. Requires same codec/dims — re-encodes to be safe."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
        for p in paths:
            f.write(f"file '{p.resolve().as_posix()}'\n")
        list_path = f.name
    try:
        # Re-encode (concat demuxer is finicky with mixed sources)
        cmd = [
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0", "-i", list_path,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-an",
            str(out_path),
        ]
        subprocess.run(cmd, check=True, capture_output=True, timeout=1800)
    finally:
        try:
            Path(list_path).unlink()
        except OSError:
            pass


def _xfade_chain(paths: list[Path], transition: str, duration: float, out_path: Path) -> None:
    """Build an xfade chain across N clips. Assumes uniform resolution; scales otherwise."""
    n = len(paths)
    if n == 1:
        shutil.copyfile(paths[0], out_path)
        return

    # Probe target dims (use first clip)
    w, h = _probe_dims(paths[0])
    if not w or not h:
        raise RuntimeError("Could not probe first clip dimensions")

    durations = [_probe_duration(p) for p in paths]
    if any(d <= 0 for d in durations):
        raise RuntimeError("Could not probe one or more clip durations")
    if any(d <= duration for d in durations[:-1]):
        # Clip too short for requested xfade
        raise RuntimeError(
            f"Crossfade duration {duration}s exceeds clip length; reduce duration or use 'none'"
        )

    inputs: list[str] = []
    for p in paths:
        inputs.extend(["-i", str(p)])

    # Build filter graph: scale each clip to first clip's dims, then xfade-chain.
    filter_parts: list[str] = []
    for i in range(n):
        filter_parts.append(
            f"[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v{i}]"
        )

    # Cumulative offsets: offset_k = sum(d_0..d_{k-1}) - k*duration
    offset = 0.0
    prev_label = "v0"
    for k in range(1, n):
        offset += durations[k - 1] - duration
        out_label = f"vx{k}" if k < n - 1 else "outv"
        filter_parts.append(
            f"[{prev_label}][v{k}]xfade=transition={transition}:duration={duration}:offset={offset:.3f}[{out_label}]"
        )
        prev_label = out_label

    filter_graph = ";".join(filter_parts)

    cmd = [
        "ffmpeg", "-y",
        *inputs,
        "-filter_complex", filter_graph,
        "-map", "[outv]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-an",
        str(out_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True, timeout=1800)


@router.post("/run")
async def run_stitch(req: StitchRequest) -> JSONResponse:
    try:
        local_paths = [_resolve_to_local(v) for v in req.videos]
        missing = [str(p) for p in local_paths if not p.exists()]
        if missing:
            return JSONResponse({"ok": False, "error": f"Missing files: {missing}"}, status_code=400)

        transition_key = (req.transition or "none").lower()
        if transition_key not in TRANSITIONS:
            return JSONResponse(
                {"ok": False, "error": f"Unknown transition '{transition_key}'"}, status_code=400
            )

        ts = time.strftime("%Y%m%d_%H%M%S")
        sig = hashlib.sha1(
            ("|".join(str(p) for p in local_paths) + f"|{transition_key}|{req.duration}").encode()
        ).hexdigest()[:8]
        out_path = STITCHED_DIR / f"stitched_{ts}_{sig}.mp4"

        loop = asyncio.get_running_loop()
        xfade_name = TRANSITIONS[transition_key]
        if xfade_name is None or len(local_paths) == 1:
            await loop.run_in_executor(None, _concat_demuxer, local_paths, out_path)
        else:
            await loop.run_in_executor(
                None, _xfade_chain, local_paths, xfade_name, req.duration, out_path
            )

        local_url = f"/outputs/stitched/{out_path.name}"
        return JSONResponse({"ok": True, "video_url": local_url, "local_video_url": local_url})
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or b"").decode(errors="replace")[-800:]
        return JSONResponse({"ok": False, "error": f"ffmpeg failed: {stderr}"}, status_code=500)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

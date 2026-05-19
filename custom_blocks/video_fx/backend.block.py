import asyncio
import hashlib
import os
import subprocess
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend import config

router = APIRouter()

FX_DIR = config.LOCAL_OUTPUT_DIR / "fx"
FX_DIR.mkdir(parents=True, exist_ok=True)

LUT_CACHE_DIR = FX_DIR / "_luts"
LUT_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# RIFE (rife-ncnn-vulkan) for optical-flow smoothing.
# Install with scripts/install_rife.sh; override paths via env if needed.
RIFE_BIN_DEFAULT = Path.home() / "bin" / "rife-ncnn-vulkan"
RIFE_MODEL_DEFAULT = Path.home() / ".cache" / "rife" / "rife-v4.6"
# Serialize RIFE calls — running multiple instances against one GPU just thrashes.
_RIFE_LOCK = threading.Semaphore(1)


def _sanitize_lut(src: Path) -> Path:
    """Strip directives ffmpeg's lut3d filter rejects (e.g. Resolve's LUT_3D_INPUT_RANGE).
    Cache by content hash so we re-process only when the source changes."""
    raw = src.read_bytes()
    digest = hashlib.sha1(raw + b"|v1").hexdigest()[:16]
    cached = LUT_CACHE_DIR / f"{digest}.cube"
    if cached.exists():
        return cached
    cleaned_lines = []
    for line in raw.decode("utf-8", errors="replace").splitlines():
        stripped = line.strip()
        # Drop directives ffmpeg doesn't understand. LUT_3D_INPUT_RANGE 0..1 is the default
        # for lut3d anyway, so removing the line is safe.
        if stripped.upper().startswith("LUT_3D_INPUT_RANGE"):
            continue
        if stripped.upper().startswith("LUT_1D_INPUT_RANGE"):
            continue
        cleaned_lines.append(line)
    cached.write_text("\n".join(cleaned_lines) + "\n", encoding="utf-8")
    return cached


class FxRequest(BaseModel):
    videos: List[str] = Field(..., min_length=1)
    speed_enabled: bool = False
    speed: float = Field(1.0, gt=0.0, le=8.0)
    smooth: bool = False
    smooth_fps: int = Field(60, ge=24, le=120)
    loop_enabled: bool = False
    loop_count: int = Field(2, ge=1, le=8)
    boomerang: bool = False
    lut_enabled: bool = False
    lut_path: Optional[str] = None


def _resolve_to_local(src: str) -> Path:
    src = (src or "").strip()
    if not src:
        raise ValueError("Empty video URL")
    if src.startswith(("http://", "https://")):
        sha = hashlib.sha1(src.encode()).hexdigest()[:8]
        ext = Path(src.split("?", 1)[0]).suffix or ".mp4"
        dst = FX_DIR / f"_src_{sha}{ext}"
        if not dst.exists():
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


def _build_filter(req: FxRequest, lut_path: Path | None) -> str:
    """Order: lut → speed → boomerang → loop. Final output label is [vout]."""
    parts: list[str] = []
    label = "0:v"

    if req.lut_enabled and lut_path is not None:
        lut_str = lut_path.resolve().as_posix().replace(":", r"\:")
        parts.append(f"[{label}]lut3d=file='{lut_str}'[vlut]")
        label = "vlut"

    if req.speed_enabled and abs(req.speed - 1.0) > 1e-3:
        parts.append(f"[{label}]setpts=PTS/{req.speed:.4f}[vsp]")
        label = "vsp"

    if req.loop_enabled and req.boomerang:
        parts.append(
            f"[{label}]split=2[vf][vr];"
            f"[vr]reverse[vrev];"
            f"[vf][vrev]concat=n=2:v=1:a=0[vb]"
        )
        label = "vb"

    if req.loop_enabled and req.loop_count > 1:
        n = max(0, req.loop_count - 1)
        parts.append(f"[{label}]loop=loop={n}:size=32767:start=0[vl]")
        label = "vl"

    # Always end with a rename to [vout]
    parts.append(f"[{label}]null[vout]")
    return ";".join(parts)


def _rife_paths() -> tuple[Path, Path]:
    bin_path = Path(os.environ.get("RIFE_BIN") or RIFE_BIN_DEFAULT)
    model_dir = Path(os.environ.get("RIFE_MODEL_DIR") or RIFE_MODEL_DEFAULT)
    if not bin_path.exists():
        raise RuntimeError(
            f"rife-ncnn-vulkan not found at {bin_path}. "
            f"Run scripts/install_rife.sh, or set $RIFE_BIN."
        )
    if not model_dir.exists():
        raise RuntimeError(
            f"RIFE model dir not found at {model_dir}. "
            f"Run scripts/install_rife.sh, or set $RIFE_MODEL_DIR."
        )
    return bin_path, model_dir


def _probe_fps(src: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=r_frame_rate", "-of", "default=nw=1:nk=1",
         str(src)],
        check=True, capture_output=True, timeout=30,
    ).stdout.decode().strip()
    if "/" in out:
        n, d = out.split("/", 1)
        return float(n) / float(d) if float(d) else float(n)
    return float(out)


def _choose_multiplier(src_fps: float, target_fps: int, speed: float) -> int:
    # Intermediate (post-RIFE) has src_fps * M frames per source-second.
    # After setpts/speed, effective playback fps is src_fps * M * speed.
    # Want >= target_fps → M >= target_fps / (src_fps * speed).
    needed = target_fps / max(src_fps * max(speed, 1e-3), 1e-3)
    for m in (2, 4, 8):
        if m >= needed:
            return m
    return 8


def _rife_preprocess(
    src: Path, target_fps: int, speed: float, work_dir: Path
) -> tuple[Path, float]:
    """Extract → RIFE interpolate → re-encode. Returns (intermediate_mp4, intermediate_fps)."""
    bin_path, model_dir = _rife_paths()
    src_fps = _probe_fps(src)
    mult = _choose_multiplier(src_fps, target_fps, speed)

    frames_in = work_dir / "in"
    frames_out = work_dir / "out"
    frames_in.mkdir(parents=True, exist_ok=True)
    frames_out.mkdir(parents=True, exist_ok=True)

    subprocess.run(
        ["ffmpeg", "-y", "-i", str(src),
         "-vsync", "0", "-q:v", "1",
         str(frames_in / "%08d.png")],
        check=True, capture_output=True, timeout=1800,
    )
    n_in = sum(1 for _ in frames_in.glob("*.png"))
    if n_in < 2:
        raise RuntimeError(f"RIFE needs ≥2 input frames, got {n_in}")
    target_n = mult * n_in

    with _RIFE_LOCK:
        subprocess.run(
            [str(bin_path),
             "-i", str(frames_in),
             "-o", str(frames_out),
             "-m", str(model_dir),
             "-n", str(target_n)],
            check=True, capture_output=True, timeout=3600,
        )

    intermediate_fps = src_fps * mult
    intermediate = work_dir / "interp.mp4"
    subprocess.run(
        ["ffmpeg", "-y",
         "-framerate", f"{intermediate_fps:.6f}",
         "-i", str(frames_out / "%08d.png"),
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
         "-pix_fmt", "yuv420p", "-an",
         str(intermediate)],
        check=True, capture_output=True, timeout=1800,
    )
    return intermediate, intermediate_fps


def _run_fx_one(src: Path, req: FxRequest, lut_path: Path | None, out_path: Path) -> None:
    use_rife = req.smooth and req.speed_enabled and abs(req.speed - 1.0) > 1e-3
    with tempfile.TemporaryDirectory(prefix="vfx_rife_") as td:
        actual_src = src
        if use_rife:
            actual_src, _ = _rife_preprocess(src, req.smooth_fps, req.speed, Path(td))

        filter_graph = _build_filter(req, lut_path)
        cmd = [
            "ffmpeg", "-y",
            "-i", str(actual_src),
            "-filter_complex", filter_graph,
            "-map", "[vout]",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-an",
        ]
        if use_rife:
            cmd += ["-r", str(req.smooth_fps)]
        cmd.append(str(out_path))
        subprocess.run(cmd, check=True, capture_output=True, timeout=1800)


def _signature(src: Path, req: FxRequest) -> str:
    raw = "|".join([
        str(src),
        f"s={req.speed_enabled}/{req.speed}/smooth={req.smooth}/{req.smooth_fps}",
        f"l={req.loop_enabled}/{req.loop_count}/{req.boomerang}",
        f"lut={req.lut_enabled}/{req.lut_path or ''}",
    ])
    return hashlib.sha1(raw.encode()).hexdigest()[:10]


@router.post("/run")
async def run_fx(req: FxRequest) -> JSONResponse:
    try:
        lut_path: Path | None = None
        if req.lut_enabled:
            if not req.lut_path:
                return JSONResponse({"ok": False, "error": "LUT enabled but no path provided"}, status_code=400)
            lut_path = Path(req.lut_path).expanduser()
            if not lut_path.exists():
                return JSONResponse(
                    {"ok": False, "error": f"LUT file not found: {lut_path}"}, status_code=400
                )
            lut_path = _sanitize_lut(lut_path)

        local_paths = [_resolve_to_local(v) for v in req.videos]
        missing = [str(p) for p in local_paths if not p.exists()]
        if missing:
            return JSONResponse({"ok": False, "error": f"Missing files: {missing}"}, status_code=400)

        ts = time.strftime("%Y%m%d_%H%M%S")
        outputs: list[Path] = [
            FX_DIR / f"fx_{ts}_{i:02d}_{_signature(src, req)}.mp4"
            for i, src in enumerate(local_paths)
        ]

        loop = asyncio.get_running_loop()
        await asyncio.gather(
            *[
                loop.run_in_executor(None, _run_fx_one, src, req, lut_path, out)
                for src, out in zip(local_paths, outputs)
            ]
        )

        urls = [f"/outputs/fx/{p.name}" for p in outputs]
        return JSONResponse({"ok": True, "videos": urls})
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or b"").decode(errors="replace")[-800:]
        return JSONResponse({"ok": False, "error": f"ffmpeg failed: {stderr}"}, status_code=500)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

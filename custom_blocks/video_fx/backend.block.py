import asyncio
import hashlib
import subprocess
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


def _run_fx_one(src: Path, req: FxRequest, lut_path: Path | None, out_path: Path) -> None:
    filter_graph = _build_filter(req, lut_path)
    cmd = [
        "ffmpeg", "-y",
        "-i", str(src),
        "-filter_complex", filter_graph,
        "-map", "[vout]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-an",
        str(out_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True, timeout=1800)


def _signature(src: Path, req: FxRequest) -> str:
    raw = "|".join([
        str(src),
        f"s={req.speed_enabled}/{req.speed}",
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

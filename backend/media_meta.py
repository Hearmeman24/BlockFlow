"""Embed and read generation metadata in media files.

Supports:
- MP4/WebM: ffmpeg comment metadata field
- PNG: tEXt chunk with key "sgs_meta"
- JPEG: EXIF UserComment (falls back to ffmpeg comment)

The metadata is a JSON string containing generation parameters:
prompt, negative_prompt, seed, model, loras, lora_hashes, resolution, etc.
"""
from __future__ import annotations

import json
import logging
import shutil
import struct
import subprocess
import tempfile
import zlib
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

META_KEY = "sgs_meta"


def embed_metadata(media_path: Path, meta: dict[str, Any]) -> bool:
    """Embed generation metadata into a media file. Returns True on success."""
    suffix = media_path.suffix.lower()
    meta_json = json.dumps(meta, separators=(",", ":"), ensure_ascii=False)

    if suffix in (".mp4", ".webm", ".mkv"):
        return _embed_video_meta(media_path, meta_json)
    elif suffix == ".png":
        return _embed_png_meta(media_path, meta_json)
    elif suffix in (".jpg", ".jpeg"):
        return _embed_jpeg_meta(media_path, meta_json)
    else:
        log.warning("Unsupported media format for metadata embedding: %s", suffix)
        return False


def read_metadata(media_path: Path) -> dict[str, Any] | None:
    """Read generation metadata from a media file. Returns None if not found."""
    suffix = media_path.suffix.lower()

    if suffix in (".mp4", ".webm", ".mkv"):
        return _read_video_meta(media_path)
    elif suffix == ".png":
        return _read_png_meta(media_path)
    elif suffix in (".jpg", ".jpeg"):
        return _read_jpeg_meta(media_path)
    return None


# ---- Video (ffmpeg/ffprobe) ----

def _embed_video_meta(path: Path, meta_json: str) -> bool:
    """Embed metadata as the 'comment' field in a video container."""
    tmp = Path(tempfile.mktemp(suffix=path.suffix, dir=path.parent))
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", str(path), "-c", "copy",
             "-metadata", f"comment={meta_json}",
             str(tmp)],
            capture_output=True, timeout=60,
        )
        if result.returncode != 0:
            log.warning("ffmpeg embed failed: %s", result.stderr.decode()[-200:])
            tmp.unlink(missing_ok=True)
            return False
        # Replace original with tagged version
        shutil.move(str(tmp), str(path))
        return True
    except Exception as e:
        log.warning("Video metadata embed error: %s", e)
        tmp.unlink(missing_ok=True)
        return False


def _read_video_meta(path: Path) -> dict[str, Any] | None:
    """Read metadata from the 'comment' field of a video container."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format_tags=comment",
             "-of", "json", str(path)],
            capture_output=True, text=True, timeout=10,
        )
        data = json.loads(result.stdout)
        comment = data.get("format", {}).get("tags", {}).get("comment", "")
        if comment and comment.startswith("{"):
            return json.loads(comment)
    except Exception as e:
        log.debug("Video metadata read error: %s", e)
    return None


# ---- PNG (tEXt chunk) ----

def _embed_png_meta(path: Path, meta_json: str) -> bool:
    """Insert a tEXt chunk with generation metadata into a PNG file."""
    try:
        data = path.read_bytes()
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            return False

        # Build tEXt chunk: keyword + null separator + text
        chunk_data = META_KEY.encode("latin-1") + b"\x00" + meta_json.encode("latin-1", errors="replace")
        chunk_len = struct.pack(">I", len(chunk_data))
        chunk_type = b"tEXt"
        chunk_crc = struct.pack(">I", zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF)
        text_chunk = chunk_len + chunk_type + chunk_data + chunk_crc

        # Insert before IEND (last 12 bytes)
        iend_pos = data.rfind(b"IEND") - 4  # 4 bytes for length field
        if iend_pos < 8:
            return False
        new_data = data[:iend_pos] + text_chunk + data[iend_pos:]
        path.write_bytes(new_data)
        return True
    except Exception as e:
        log.warning("PNG metadata embed error: %s", e)
        return False


def _read_png_meta(path: Path) -> dict[str, Any] | None:
    """Read tEXt chunk with our metadata key from a PNG file."""
    try:
        data = path.read_bytes()
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            return None

        pos = 8
        while pos < len(data) - 12:
            chunk_len = struct.unpack(">I", data[pos:pos + 4])[0]
            chunk_type = data[pos + 4:pos + 8]
            chunk_body = data[pos + 8:pos + 8 + chunk_len]

            if chunk_type == b"tEXt":
                null_idx = chunk_body.find(b"\x00")
                if null_idx >= 0:
                    key = chunk_body[:null_idx].decode("latin-1")
                    if key == META_KEY:
                        value = chunk_body[null_idx + 1:].decode("latin-1")
                        if value.startswith("{"):
                            return json.loads(value)

            pos += 12 + chunk_len  # 4 len + 4 type + data + 4 crc

            if chunk_type == b"IEND":
                break
    except Exception as e:
        log.debug("PNG metadata read error: %s", e)
    return None


# ---- JPEG (ffmpeg comment as fallback) ----

def _embed_jpeg_meta(path: Path, meta_json: str) -> bool:
    """Embed metadata into JPEG using ffmpeg comment field."""
    return _embed_video_meta(path, meta_json)


def _read_jpeg_meta(path: Path) -> dict[str, Any] | None:
    """Read metadata from JPEG using ffmpeg comment field."""
    return _read_video_meta(path)


# ---- Helper to build metadata dict from job data ----

def build_generation_meta(
    *,
    prompt: str = "",
    negative_prompt: str = "",
    seed: int | None = None,
    model: str = "",
    task_type: str = "",
    width: int | None = None,
    height: int | None = None,
    frames: int | None = None,
    fps: int | None = None,
    loras: list[dict[str, Any]] | None = None,
    lora_hashes: dict[str, str] | None = None,
    model_hashes: dict[str, dict[str, Any]] | None = None,
    inference_settings: dict[str, Any] | None = None,
    software: str = "SGS-UI (LightX2V)",
) -> dict[str, Any]:
    """Build a standardized metadata dict for embedding."""
    meta: dict[str, Any] = {"software": software}
    if prompt:
        meta["prompt"] = prompt
    if negative_prompt:
        meta["negative_prompt"] = negative_prompt
    if seed is not None:
        meta["seed"] = seed
    if model:
        meta["model"] = model
    if task_type:
        meta["task_type"] = task_type
    if width is not None:
        meta["width"] = width
    if height is not None:
        meta["height"] = height
    if frames is not None:
        meta["frames"] = frames
    if fps is not None:
        meta["fps"] = fps
    if loras:
        meta["loras"] = loras
    if lora_hashes:
        meta["lora_hashes"] = lora_hashes
    if model_hashes:
        meta["model_hashes"] = model_hashes
    if inference_settings:
        meta["inference_settings"] = inference_settings
    return meta

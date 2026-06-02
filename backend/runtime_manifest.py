from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from curl_cffi import requests as _cffi_requests

from backend import config

RUNTIME_MANIFEST_URL = (
    "https://raw.githubusercontent.com/Hearmeman24/blockflow-presets/main/runtime-manifest.json"
)
FALLBACK_DOCKER_IMAGE = "hearmeman/comfyui-serverless:v24"

_CACHE_TTL_SEC = 3600
_HTTP_TIMEOUT_SEC = 15
_IMAGE_RE = re.compile(r"^hearmeman/comfyui-serverless:v\d+$")

_CACHE_PATH: Path = config.RUNTIME_MANIFEST_CACHE_PATH
_cache: dict[str, Any] = {
    "fetched_at": 0.0,
    "manifest": None,
}


def _cache_reset() -> None:
    _cache["fetched_at"] = 0.0
    _cache["manifest"] = None
    try:
        _CACHE_PATH.unlink(missing_ok=True)
    except OSError:
        pass


def _cache_is_fresh() -> bool:
    return _cache["manifest"] is not None and (time.time() - _cache["fetched_at"]) < _CACHE_TTL_SEC


def _load_disk_cache() -> dict | None:
    if not _CACHE_PATH.exists():
        return None
    try:
        loaded = json.loads(_CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return loaded if isinstance(loaded, dict) else None


def _save_disk_cache(manifest: dict) -> None:
    try:
        _CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _CACHE_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass


def _fetch_manifest() -> dict:
    resp = _cffi_requests.get(RUNTIME_MANIFEST_URL, timeout=_HTTP_TIMEOUT_SEC)
    if resp.status_code >= 400:
        raise RuntimeError(f"runtime manifest returned HTTP {resp.status_code}")
    try:
        body = resp.json()
    except (ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"runtime manifest returned non-JSON: {exc}") from exc
    if not isinstance(body, dict):
        raise RuntimeError("runtime manifest root must be an object")
    return body


def _image_from_manifest(manifest: dict | None) -> str | None:
    if not manifest:
        return None
    section = manifest.get("comfygen_serverless")
    if not isinstance(section, dict):
        return None
    image = section.get("image")
    if not isinstance(image, str):
        return None
    image = image.strip()
    return image if _IMAGE_RE.match(image) else None


def resolve_comfygen_image() -> str:
    if _cache_is_fresh():
        return _image_from_manifest(_cache["manifest"]) or FALLBACK_DOCKER_IMAGE

    try:
        manifest = _fetch_manifest()
    except Exception:
        manifest = _cache["manifest"] or _load_disk_cache()
        return _image_from_manifest(manifest) or FALLBACK_DOCKER_IMAGE

    image = _image_from_manifest(manifest)
    if not image:
        manifest = _cache["manifest"] or _load_disk_cache()
        return _image_from_manifest(manifest) or FALLBACK_DOCKER_IMAGE

    _cache["manifest"] = manifest
    _cache["fetched_at"] = time.time()
    _save_disk_cache(manifest)
    return image

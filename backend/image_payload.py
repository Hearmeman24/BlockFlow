from __future__ import annotations

import base64
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps

DATA_URI_PAYLOAD_LIMIT_BYTES = 20 * 1024 * 1024
UPLOAD_RESIZE_THRESHOLD_BYTES = 3 * 1024 * 1024
UPLOAD_MAX_EDGE = 2048
MIN_COMPRESS_EDGE = 384

_QUALITY_STEPS = (85, 78, 70, 62, 54, 46, 38, 30)
_EDGE_STEPS = (2048, 1792, 1536, 1280, 1024, 768, 512, 384)

_MIME_BY_SUFFIX = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}


@dataclass(frozen=True)
class ImagePayloadSource:
    name: str
    data: bytes
    content_type: str


@dataclass(frozen=True)
class PreparedImagePayload:
    name: str
    data: bytes
    content_type: str
    compressed: bool
    original_size: int

    @property
    def data_uri(self) -> str:
        return data_uri(self.data, self.content_type)

    @property
    def data_uri_payload_size(self) -> int:
        return data_uri_payload_size(self.data, self.content_type)


def mime_for_name(name: str, fallback: str = "image/png") -> str:
    suffix = Path(name).suffix.lower()
    return _MIME_BY_SUFFIX.get(suffix, fallback)


def data_uri(data: bytes, content_type: str) -> str:
    return f"data:{content_type};base64,{base64.b64encode(data).decode('ascii')}"


def data_uri_payload_size(data: bytes, content_type: str) -> int:
    prefix_size = len(f"data:{content_type};base64,")
    return prefix_size + len(base64.b64encode(data))


def _open_image(data: bytes) -> Image.Image:
    img = Image.open(BytesIO(data))
    img.load()
    return ImageOps.exif_transpose(img)


def _fit_within_edge(img: Image.Image, max_edge: int) -> Image.Image:
    width, height = img.size
    longest = max(width, height)
    if longest <= max_edge:
        return img.copy()
    scale = max_edge / longest
    target = (max(1, round(width * scale)), max(1, round(height * scale)))
    return img.resize(target, Image.Resampling.LANCZOS)


def _as_jpeg_rgb(img: Image.Image) -> Image.Image:
    if img.mode in {"RGBA", "LA"} or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        background.alpha_composite(rgba)
        return background.convert("RGB")
    return img.convert("RGB")


def _encode_jpeg(img: Image.Image, quality: int) -> bytes:
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
    return buf.getvalue()


def compress_image_for_data_uri(
    source: ImagePayloadSource,
    *,
    max_payload_bytes: int,
    max_edge: int = UPLOAD_MAX_EDGE,
) -> PreparedImagePayload:
    """Return a JPEG payload whose data URI fits within max_payload_bytes."""
    if data_uri_payload_size(source.data, source.content_type) <= max_payload_bytes:
        return PreparedImagePayload(
            name=source.name,
            data=source.data,
            content_type=source.content_type,
            compressed=False,
            original_size=len(source.data),
        )

    img = _as_jpeg_rgb(_open_image(source.data))
    edge_steps = tuple(edge for edge in _EDGE_STEPS if edge <= max_edge and edge >= MIN_COMPRESS_EDGE)
    if not edge_steps:
        edge_steps = (max(MIN_COMPRESS_EDGE, min(max_edge, UPLOAD_MAX_EDGE)),)

    best: bytes | None = None
    for edge in edge_steps:
        resized = _fit_within_edge(img, edge)
        for quality in _QUALITY_STEPS:
            encoded = _encode_jpeg(resized, quality)
            best = encoded if best is None or len(encoded) < len(best) else best
            if data_uri_payload_size(encoded, "image/jpeg") <= max_payload_bytes:
                return PreparedImagePayload(
                    name=f"{Path(source.name).stem or 'image'}.jpg",
                    data=encoded,
                    content_type="image/jpeg",
                    compressed=True,
                    original_size=len(source.data),
                )

    raise ValueError(
        f"image {source.name} cannot be compressed under {max_payload_bytes} bytes "
        f"(smallest candidate {len(best or b'')} bytes)"
    )


def prepare_data_uris_for_payload(
    sources: list[ImagePayloadSource],
    *,
    max_payload_bytes: int = DATA_URI_PAYLOAD_LIMIT_BYTES,
) -> list[PreparedImagePayload]:
    if not sources:
        return []

    current = [
        PreparedImagePayload(
            name=src.name,
            data=src.data,
            content_type=src.content_type,
            compressed=False,
            original_size=len(src.data),
        )
        for src in sources
    ]
    if sum(item.data_uri_payload_size for item in current) <= max_payload_bytes:
        return current

    per_image_budget = max(1024, max_payload_bytes // len(sources))
    prepared = [
        compress_image_for_data_uri(src, max_payload_bytes=per_image_budget)
        for src in sources
    ]
    total = sum(item.data_uri_payload_size for item in prepared)
    if total <= max_payload_bytes:
        return prepared

    # Even split can be too loose after base64/header overhead. Tighten each
    # image's budget proportionally and retry once with an explicit margin.
    per_image_budget = max(1024, int(max_payload_bytes * 0.95) // len(sources))
    prepared = [
        compress_image_for_data_uri(src, max_payload_bytes=per_image_budget)
        for src in sources
    ]
    total = sum(item.data_uri_payload_size for item in prepared)
    if total > max_payload_bytes:
        raise ValueError(f"compressed image payload is {total} bytes, above {max_payload_bytes} byte limit")
    return prepared


def prepare_image_for_upload(
    data: bytes,
    *,
    filename: str,
    content_type: str,
    threshold_bytes: int = UPLOAD_RESIZE_THRESHOLD_BYTES,
    max_edge: int = UPLOAD_MAX_EDGE,
) -> PreparedImagePayload:
    if not content_type.lower().startswith("image/") or len(data) <= threshold_bytes:
        return PreparedImagePayload(
            name=filename,
            data=data,
            content_type=content_type,
            compressed=False,
            original_size=len(data),
        )

    source = ImagePayloadSource(name=filename, data=data, content_type=content_type)
    try:
        prepared = compress_image_for_data_uri(
            source,
            max_payload_bytes=data_uri_payload_size(data, content_type) - 1,
            max_edge=max_edge,
        )
    except Exception:
        return PreparedImagePayload(
            name=filename,
            data=data,
            content_type=content_type,
            compressed=False,
            original_size=len(data),
        )

    if len(prepared.data) >= len(data):
        return PreparedImagePayload(
            name=filename,
            data=data,
            content_type=content_type,
            compressed=False,
            original_size=len(data),
        )
    return prepared

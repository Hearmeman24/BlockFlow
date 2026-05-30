from __future__ import annotations

import base64
import importlib.util
import json
import sys
import urllib.request
from io import BytesIO
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _jpeg_bytes(size: tuple[int, int], quality: int = 95) -> bytes:
    img = Image.effect_noise(size, 100).convert("RGB")
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def _png_bytes(size: tuple[int, int], color: tuple[int, int, int] = (40, 80, 120)) -> bytes:
    img = Image.new("RGB", size, color)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _data_uri_payload_size(uri: str) -> int:
    return len(uri.encode("utf-8"))


def test_data_uri_budget_keeps_small_images_unmodified():
    from backend.image_payload import ImagePayloadSource, prepare_data_uris_for_payload

    raw = _png_bytes((64, 64))
    prepared = prepare_data_uris_for_payload(
        [ImagePayloadSource(name="small.png", data=raw, content_type="image/png")],
        max_payload_bytes=200_000,
    )

    assert len(prepared) == 1
    assert prepared[0].compressed is False
    assert prepared[0].data == raw
    assert prepared[0].data_uri.startswith("data:image/png;base64,")


def test_data_uri_budget_compresses_large_images_under_total_limit():
    from backend.image_payload import ImagePayloadSource, prepare_data_uris_for_payload

    raw_images = [
        _jpeg_bytes((1800, 1800), quality=98),
        _jpeg_bytes((1800, 1800), quality=98),
        _jpeg_bytes((1800, 1800), quality=98),
    ]
    raw_total_payload = sum(
        _data_uri_payload_size(f"data:image/jpeg;base64,{base64.b64encode(raw).decode('ascii')}")
        for raw in raw_images
    )

    prepared = prepare_data_uris_for_payload(
        [
            ImagePayloadSource(name=f"large-{i}.jpg", data=raw, content_type="image/jpeg")
            for i, raw in enumerate(raw_images)
        ],
        max_payload_bytes=900_000,
    )

    prepared_total_payload = sum(_data_uri_payload_size(item.data_uri) for item in prepared)
    assert raw_total_payload > 900_000
    assert prepared_total_payload <= 900_000
    assert any(item.compressed for item in prepared)
    assert all(item.content_type == "image/jpeg" for item in prepared)


def test_multimodal_prompt_writer_resolves_local_images_under_payload_budget(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from backend import config

    local_dir = tmp_path / "outputs"
    local_dir.mkdir()
    monkeypatch.setattr(config, "LOCAL_OUTPUT_DIR", local_dir)

    for i in range(3):
        (local_dir / f"ref-{i}.jpg").write_bytes(_jpeg_bytes((1800, 1800), quality=98))

    spec = importlib.util.spec_from_file_location(
        "multimodal_prompt_writer_budget",
        ROOT / "custom_blocks" / "multimodal_prompt_writer" / "backend.block.py",
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)

    monkeypatch.setattr(mod, "OPENROUTER_IMAGE_PAYLOAD_LIMIT_BYTES", 900_000)

    resolved = mod._resolve_image_urls_for_payload([f"/outputs/ref-{i}.jpg" for i in range(3)])

    assert len(resolved) == 3
    assert all(url.startswith("data:image/jpeg;base64,") for url in resolved)
    assert sum(_data_uri_payload_size(url) for url in resolved) <= 900_000


def test_tmpfiles_upload_compresses_large_image_before_external_post(monkeypatch: pytest.MonkeyPatch):
    spec = importlib.util.spec_from_file_location(
        "upload_image_to_tmpfiles_budget",
        ROOT / "custom_blocks" / "upload_image_to_tmpfiles" / "backend.block.py",
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)

    captured: dict[str, Any] = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self) -> bytes:
            return json.dumps({"status": "success", "data": {"url": "https://tmpfiles.org/abc/ref.jpg"}}).encode()

    def fake_urlopen(req: urllib.request.Request, timeout: int = 60):
        captured["data"] = req.data
        captured["headers"] = dict(req.header_items())
        return FakeResponse()

    monkeypatch.setattr(mod.urllib.request, "urlopen", fake_urlopen)

    app = FastAPI()
    app.include_router(mod.router)
    client = TestClient(app)

    raw = _jpeg_bytes((2200, 2200), quality=98)
    resp = client.post(
        "/upload",
        content=raw,
        headers={"X-Filename": "huge.jpg", "X-Content-Type": "image/jpeg"},
    )

    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "image_url": "https://tmpfiles.org/dl/abc/ref.jpg"}
    multipart = captured["data"]
    assert isinstance(multipart, bytes)
    assert len(multipart) < len(raw)
    assert b"Content-Type: image/jpeg" in multipart

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def load_block():
    spec = importlib.util.spec_from_file_location(
        "gpt_image_piapi_backend",
        ROOT / "custom_blocks" / "gpt_image_piapi" / "backend.block.py",
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def test_generation_payload_requests_url_response() -> None:
    mod = load_block()

    payload = mod._build_generation_payload(
        prompt="a small red circle",
        model="gpt-image-2-preview",
        size="1024x1024",
        quality="standard",
        output_format="png",
    )

    assert payload == {
        "model": "gpt-image-2-preview",
        "prompt": "a small red circle",
        "n": 1,
        "size": "1024x1024",
        "quality": "standard",
        "response_format": "url",
        "output_format": "png",
    }


def test_edit_multipart_repeats_image_field_for_multiple_references() -> None:
    mod = load_block()

    body, content_type = mod._build_edit_multipart(
        fields={
            "model": "gpt-image-2-preview",
            "prompt": "combine both references",
            "n": "1",
            "size": "1024x1024",
            "quality": "standard",
            "response_format": "url",
            "output_format": "png",
        },
        images=[
            ("ref1.png", b"first-image", "image/png"),
            ("ref2.png", b"second-image", "image/png"),
        ],
    )

    assert content_type.startswith("multipart/form-data; boundary=")
    assert body.count(b'name="image"; filename=') == 2
    assert b'name="image"; filename="ref1.png"' in body
    assert b'name="image"; filename="ref2.png"' in body
    assert b"first-image" in body
    assert b"second-image" in body
    assert b'name="response_format"' in body
    assert b"\r\nurl\r\n" in body


def test_validate_run_body_switches_to_edit_mode_with_references() -> None:
    mod = load_block()

    validated = mod._validate_run_body(
        {
            "prompt": "edit these",
            "model": "gpt-image-2-preview",
            "aspect_ratio": "2:3",
            "quality": "standard",
            "output_format": "png",
            "reference_image_urls": ["https://example.com/a.png", "https://example.com/b.png"],
        }
    )

    assert validated["mode"] == "edit"
    assert validated["size"] == "1024x1536"
    assert validated["references"] == ["https://example.com/a.png", "https://example.com/b.png"]


def test_download_url_reads_local_outputs_reference(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    mod = load_block()
    source = tmp_path / "gpt_image_piapi" / "frame.png"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"local-image")
    monkeypatch.setattr(mod.config, "LOCAL_OUTPUT_DIR", tmp_path)

    data, filename, content_type = mod._download_url("/outputs/gpt_image_piapi/frame.png")

    assert data == b"local-image"
    assert filename == "frame.png"
    assert content_type == "image/png"


def test_validate_run_body_rejects_unknown_settings() -> None:
    mod = load_block()

    with pytest.raises(ValueError, match="model"):
        mod._validate_run_body({"prompt": "x", "model": "bad-model"})

    with pytest.raises(ValueError, match="aspect_ratio"):
        mod._validate_run_body({"prompt": "x", "aspect_ratio": "21:9"})


def test_extract_output_url_reads_data_url() -> None:
    mod = load_block()

    assert (
        mod._extract_output_url({"data": [{"url": "https://oss.example/out.png"}]})
        == "https://oss.example/out.png"
    )


def test_request_json_uses_bearer_auth_and_json_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    mod = load_block()
    captured: dict[str, Any] = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self) -> bytes:
            return b'{"data":[{"url":"https://oss.example/out.png"}]}'

    def fake_urlopen(req, timeout=60):
        captured["url"] = req.full_url
        captured["headers"] = dict(req.header_items())
        captured["data"] = req.data
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr(mod.urllib.request, "urlopen", fake_urlopen)

    result = mod._request_json(
        "https://api.piapi.ai/v1/images/generations",
        "secret-key",
        {"model": "gpt-image-2-preview", "prompt": "x"},
        timeout=12,
    )

    assert result["data"][0]["url"] == "https://oss.example/out.png"
    assert captured["headers"]["Authorization"] == "Bearer secret-key"
    assert captured["headers"]["Content-type"] == "application/json"
    assert json.loads(captured["data"])["model"] == "gpt-image-2-preview"
    assert captured["timeout"] == 12

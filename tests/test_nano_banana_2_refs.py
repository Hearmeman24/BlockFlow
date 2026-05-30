from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def load_block():
    spec = importlib.util.spec_from_file_location(
        "nano_banana_2_backend_refs",
        ROOT / "custom_blocks" / "nano_banana_2" / "backend.block.py",
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def test_run_route_converts_local_reference_images_before_job(monkeypatch):
    mod = load_block()
    captured: dict[str, Any] = {}

    def fake_run_job(job_id, api_key, prompt, aspect_ratio, quality, references):
        captured.update({
            "job_id": job_id,
            "api_key": api_key,
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "quality": quality,
            "references": references,
        })
        return object()

    def fake_create_task(awaitable):
        captured["scheduled"] = awaitable
        return object()

    monkeypatch.setattr(
        mod.tmpfiles,
        "ensure_public_url",
        lambda url: "https://tmpfiles.test/dl/frame.png" if url == "/outputs/frame.png" else url,
    )
    monkeypatch.setattr(mod, "_run_job", fake_run_job)
    monkeypatch.setattr(mod.asyncio, "create_task", fake_create_task)
    mod.JOBS.clear()

    app = FastAPI()
    app.include_router(mod.router)
    client = TestClient(app)

    resp = client.post(
        "/run",
        json={
            "prompt": "edit this",
            "quality": "1k",
            "aspect_ratio": "1:1",
            "reference_image_urls": ["/outputs/frame.png"],
            "runpod_api_key": "test-key",
        },
    )

    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    assert captured["references"] == ["https://tmpfiles.test/dl/frame.png"]

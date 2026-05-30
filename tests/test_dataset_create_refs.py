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
        "dataset_create_backend_refs",
        ROOT / "custom_blocks" / "dataset_create" / "backend.block.py",
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def test_run_route_converts_local_reference_images_before_job(monkeypatch):
    mod = load_block()
    captured: dict[str, Any] = {}

    def fake_run_dataset_job(**kwargs):
        captured.update(kwargs)
        return object()

    def fake_create_task(awaitable):
        captured["scheduled"] = awaitable
        return object()

    monkeypatch.setattr(
        mod.tmpfiles,
        "ensure_public_url",
        lambda url: "https://tmpfiles.test/dl/frame.png" if url == "/outputs/frame.png" else url,
    )
    monkeypatch.setattr(mod, "_run_dataset_job", fake_run_dataset_job)
    monkeypatch.setattr(mod.asyncio, "create_task", fake_create_task)
    mod.JOBS.clear()

    app = FastAPI()
    app.include_router(mod.router)
    client = TestClient(app)

    resp = client.post(
        "/run",
        json={
            "name": "Dataset",
            "quality": "1k",
            "aspect_ratios": ["1:1"],
            "image_count": 1,
            "pack_ids": [],
            "custom_prompts": ["make one image"],
            "reference_image_urls": ["/outputs/frame.png"],
            "runpod_api_key": "test-key",
        },
    )

    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    assert captured["references"] == ["https://tmpfiles.test/dl/frame.png"]

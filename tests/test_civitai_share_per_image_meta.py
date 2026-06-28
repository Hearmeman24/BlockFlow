"""Each image in a multi-image CivitAI post must carry ITS OWN prompt/seed, not a
single shared prompt copied across the batch."""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _load():
    path = ROOT / "custom_blocks" / "civitai_share" / "backend.block.py"
    spec = importlib.util.spec_from_file_location("civitai_share_per_image", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cg = _load()


@pytest.fixture
def client(tmp_path, monkeypatch):
    # Two real files so _resolve_local_file + .exists() pass.
    f0, f1 = tmp_path / "a.png", tmp_path / "b.png"
    f0.write_bytes(b"x")
    f1.write_bytes(b"y")
    mapping = {"/outputs/a.png": f0, "/outputs/b.png": f1}

    monkeypatch.setattr(cg, "_resolve_local_file", lambda url: mapping.get(url))
    monkeypatch.setattr(cg, "_upload_media_file", lambda lf, tok: (f"up-{lf.name}", "image"))
    monkeypatch.setattr(cg, "_probe_dimensions", lambda lf: (1024, 1024))

    calls: list[dict] = []

    def fake_request(url, data, headers, method="POST"):
        if url.endswith("/post.create"):
            return {"result": {"data": {"json": {"id": 999}}}}
        if data is not None:
            calls.append({"url": url, "body": json.loads(data.decode())})
        return {}

    monkeypatch.setattr(cg, "_civitai_request", fake_request)

    app = FastAPI()
    app.include_router(cg.router)
    c = TestClient(app)
    c._calls = calls  # type: ignore[attr-defined]
    return c


def _add_image_prompts(calls):
    return [
        c["body"]["json"]["meta"]["prompt"]
        for c in calls
        if c["url"].endswith("/post.addImage")
    ]


def test_each_image_gets_its_own_prompt(client):
    resp = client.post("/share", json={
        "token": "t",
        "media_urls": ["/outputs/a.png", "/outputs/b.png"],
        "metas": [
            {"prompt": "a red fox", "seed": 1},
            {"prompt": "a blue whale", "seed": 2},
        ],
        "meta": {"prompt": "SHARED WRONG"},
        "publish": False,
    })
    assert resp.status_code == 200, resp.text
    assert _add_image_prompts(client._calls) == ["a red fox", "a blue whale"]


def test_falls_back_to_shared_meta_when_metas_absent(client):
    resp = client.post("/share", json={
        "token": "t",
        "media_urls": ["/outputs/a.png", "/outputs/b.png"],
        "meta": {"prompt": "only one"},
        "publish": False,
    })
    assert resp.status_code == 200, resp.text
    assert _add_image_prompts(client._calls) == ["only one", "only one"]

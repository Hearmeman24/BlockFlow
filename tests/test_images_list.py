"""GET /api/images: newest-first, image-only, paginated listing of the outputs dir
(powers the Upload Image block's 'past generations' picker)."""

import os
import sys
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import config, routes  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "LOCAL_OUTPUT_DIR", tmp_path)
    app = FastAPI()
    app.include_router(routes.router)
    return TestClient(app)


def _touch(d: Path, name: str, when: float):
    p = d / name
    p.write_bytes(b"x")
    os.utime(p, (when, when))


def test_lists_images_newest_first_excluding_non_images(client, tmp_path):
    now = time.time()
    _touch(tmp_path, "old.png", now - 100)
    _touch(tmp_path, "new.jpg", now)
    _touch(tmp_path, "mid.webp", now - 50)
    _touch(tmp_path, "clip.mp4", now - 10)   # video — excluded
    _touch(tmp_path, "notes.txt", now - 10)  # non-image — excluded

    data = client.get("/api/images").json()
    assert data["ok"] is True
    assert data["total"] == 3
    names = [img["name"] for img in data["images"]]
    assert names == ["new.jpg", "mid.webp", "old.png"]  # mtime desc
    assert data["images"][0]["url"] == "/outputs/new.jpg"


def test_pagination(client, tmp_path):
    now = time.time()
    for i in range(5):
        _touch(tmp_path, f"img{i}.png", now + i)  # img4 newest
    page = client.get("/api/images?limit=2&offset=0").json()
    assert page["total"] == 5
    assert [i["name"] for i in page["images"]] == ["img4.png", "img3.png"]
    page2 = client.get("/api/images?limit=2&offset=2").json()
    assert [i["name"] for i in page2["images"]] == ["img2.png", "img1.png"]


def test_missing_dir_is_empty(client, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "LOCAL_OUTPUT_DIR", tmp_path / "does-not-exist")
    data = client.get("/api/images").json()
    assert data == {"ok": True, "images": [], "total": 0, "limit": 60, "offset": 0}

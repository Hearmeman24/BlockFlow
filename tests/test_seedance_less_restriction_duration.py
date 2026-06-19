"""Tests for the Seedance less-restriction `duration` ⇄ `video_urls` interaction.

PiAPI less-restriction models (`seedance-2-less-restriction`,
`seedance-2-fast-less-restriction`) only accept the 5/10/15 duration enum, even
when `video_urls` is present. The docs say video references should drive output
length, but live less-restriction tasks reject `duration: 0` with
"invalid duration, use '5' as default".

These tests pin the defensive local behavior: keep the selected enum duration
with video references so a hidden auto sentinel cannot fall back to 5s.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location(
    "seedance_block_duration",
    ROOT / "custom_blocks" / "seedance" / "backend.block.py",
)
mod = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = mod
_spec.loader.exec_module(mod)

LESS_RESTRICTION_TYPES = ["seedance-2-less-restriction", "seedance-2-fast-less-restriction"]


@pytest.mark.parametrize("task_type", LESS_RESTRICTION_TYPES)
def test_less_restriction_with_video_keeps_selected_duration(task_type):
    """With a video reference, less-restriction still needs a valid duration enum."""
    payload = mod._validate_and_build_input(
        {
            "prompt": "make it cinematic",
            "duration": 10,
            "resolution": "720p",
            "aspect_ratio": "16:9",
            "video_urls": ["https://tmpfiles.org/dl/abc/clip.mp4"],
        },
        task_type,
    )
    assert payload["duration"] == 10
    assert payload["video_urls"] == ["https://tmpfiles.org/dl/abc/clip.mp4"]


@pytest.mark.parametrize("task_type", LESS_RESTRICTION_TYPES)
def test_less_restriction_without_video_keeps_duration(task_type):
    """Image/text less-restriction runs still carry the chosen duration enum (5/10/15)."""
    payload = mod._validate_and_build_input(
        {
            "prompt": "a woman walks",
            "duration": 10,
            "resolution": "720p",
            "aspect_ratio": "16:9",
            "image_urls": ["https://tmpfiles.org/dl/abc/face.png"],
        },
        task_type,
    )
    assert payload["duration"] == 10


def test_seedance_converts_local_output_image_refs_to_public_urls(monkeypatch):
    from backend import tmpfiles

    monkeypatch.setattr(
        tmpfiles,
        "ensure_public_url",
        lambda url: f"https://tmpfiles.test/dl/{Path(url).name}" if url.startswith("/outputs/") else url,
    )

    payload = mod._validate_and_build_input(
        {
            "prompt": "make it move",
            "duration": 5,
            "resolution": "720p",
            "aspect_ratio": "3:4",
            "image_urls": ["/outputs/gpt_image_piapi/frame.png"],
            "video_urls": ["/outputs/video_viewer/clip.mp4"],
            "audio_urls": ["/outputs/tts/voice.mp3"],
        },
        "seedance-2-fast-less-restriction",
    )

    assert payload["image_urls"] == ["https://tmpfiles.test/dl/frame.png"]
    assert payload["video_urls"] == ["https://tmpfiles.test/dl/clip.mp4"]
    assert payload["audio_urls"] == ["https://tmpfiles.test/dl/voice.mp3"]


@pytest.mark.parametrize("task_type", LESS_RESTRICTION_TYPES)
def test_less_restriction_with_video_rejects_invalid_duration(task_type):
    """Avoid sending invalid auto sentinels that PiAPI turns into 5s outputs."""
    with pytest.raises(ValueError, match="duration"):
        mod._validate_and_build_input({
            "prompt": "x",
            "duration": 0,
            "resolution": "720p",
            "aspect_ratio": "16:9",
            "video_urls": ["https://tmpfiles.org/dl/abc/clip.mp4"],
        }, task_type)


@pytest.mark.parametrize(
    ("task_type", "resolution"),
    [("seedance-2", "1080p"), ("seedance-2-fast", "480p")],
)
def test_standard_seedance_models_keep_mode_driven_payload(task_type, resolution):
    payload = mod._validate_and_build_input(
        {
            "prompt": "x",
            "mode": "omni_reference",
            "duration": 7,
            "resolution": resolution,
            "aspect_ratio": "9:16",
            "image_urls": ["https://tmpfiles.org/dl/abc/frame.png"],
        },
        task_type,
    )

    assert payload == {
        "prompt": "x",
        "mode": "omni_reference",
        "duration": 7,
        "resolution": resolution,
        "aspect_ratio": "9:16",
        "image_urls": ["https://tmpfiles.org/dl/abc/frame.png"],
    }


def test_run_route_passes_selected_duration_to_job(monkeypatch):
    """The HTTP route must pass the corrected PiAPI payload to the job runner."""
    captured: dict[str, object] = {}

    def fake_run_job(job_id, api_key, task_type, input_payload):
        captured.update({
            "job_id": job_id,
            "api_key": api_key,
            "task_type": task_type,
            "input_payload": input_payload,
        })
        return object()

    def fake_create_task(awaitable):
        captured["scheduled"] = awaitable
        return object()

    monkeypatch.setattr(mod, "_run_job", fake_run_job)
    monkeypatch.setattr(mod.asyncio, "create_task", fake_create_task)
    mod.JOBS.clear()

    app = FastAPI()
    app.include_router(mod.router)
    client = TestClient(app)

    resp = client.post(
        "/run",
        json={
            "piapi_api_key": "test-key",
            "task_type": "seedance-2-less-restriction",
            "prompt": "make it cinematic",
            "duration": 10,
            "resolution": "720p",
            "aspect_ratio": "16:9",
            "video_urls": ["https://tmpfiles.org/dl/abc/clip.mp4"],
        },
    )

    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    assert captured["task_type"] == "seedance-2-less-restriction"
    assert captured["input_payload"] == {
        "prompt": "make it cinematic",
        "aspect_ratio": "16:9",
        "resolution": "720p",
        "video_urls": ["https://tmpfiles.org/dl/abc/clip.mp4"],
        "duration": 10,
    }

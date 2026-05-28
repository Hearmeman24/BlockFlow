"""Tests for the seedance VIP `duration` ⇄ `video_urls` interaction.

PiAPI VIP models (`seedance-2-preview-vip`, `seedance-2-fast-preview-vip`)
set output length = input video length ONLY when `duration` is omitted from
the request. The PiAPI doc's VIP video-reference example sends no `duration`,
and the completed VIP response echoes `duration: 0`.

Our backend used to always send `duration` (default 5), which PiAPI honored —
capping a 9s input video's output to 5s. These tests pin the corrected
behavior: drop `duration` when `video_urls` is present, keep it otherwise.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location(
    "seedance_block_duration",
    ROOT / "custom_blocks" / "seedance" / "backend.block.py",
)
mod = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = mod
_spec.loader.exec_module(mod)

VIP_TYPES = ["seedance-2-preview-vip", "seedance-2-fast-preview-vip"]


@pytest.mark.parametrize("task_type", VIP_TYPES)
def test_vip_with_video_omits_duration(task_type):
    """With a video reference, duration must NOT be sent (output = input length)."""
    payload = mod._validate_and_build_input(
        {
            "prompt": "make it cinematic",
            "duration": 5,
            "resolution": "720p",
            "aspect_ratio": "16:9",
            "video_urls": ["https://tmpfiles.org/dl/abc/clip.mp4"],
        },
        task_type,
    )
    assert "duration" not in payload, payload
    assert payload["video_urls"] == ["https://tmpfiles.org/dl/abc/clip.mp4"]


@pytest.mark.parametrize("task_type", VIP_TYPES)
def test_vip_without_video_keeps_duration(task_type):
    """Image/text VIP runs still carry the chosen duration enum (5/10/15)."""
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


@pytest.mark.parametrize("task_type", VIP_TYPES)
def test_vip_with_video_skips_duration_enum_validation(task_type):
    """A non-enum duration is harmless when a video ref is present (it's dropped),
    so it must not raise — the value is irrelevant upstream."""
    payload = mod._validate_and_build_input(
        {
            "prompt": "x",
            "duration": 9,  # not in {5,10,15}; ignored because video_urls present
            "resolution": "720p",
            "aspect_ratio": "16:9",
            "video_urls": ["https://tmpfiles.org/dl/abc/clip.mp4"],
        },
        task_type,
    )
    assert "duration" not in payload

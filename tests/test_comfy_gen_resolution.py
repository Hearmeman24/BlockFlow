"""Resolution detection tests for the comfy_gen block.

Covers sgs-ui-hbl: WanAnimateToVideo workflows with width/height wired to
shared PrimitiveInts must surface a single resolution entry whose source
points at the PrimitiveInts (so overrides patch them and propagate via the
wiring to every consumer).
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location(
    "comfy_gen_block", ROOT / "custom_blocks" / "comfy_gen" / "backend.block.py"
)
comfy_gen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(comfy_gen)

_detect = comfy_gen._detect_resolution_nodes


def _wan_animate_workflow() -> dict:
    """Sanitized minimum from Wan_Animate_BlockFlow.json: two PrimitiveInts
    (Video Width/Height) feeding four consumers."""
    return {
        "330": {"class_type": "PrimitiveInt", "inputs": {"value": 720},
                "_meta": {"title": "Video Width"}},
        "331": {"class_type": "PrimitiveInt", "inputs": {"value": 1280},
                "_meta": {"title": "Video Height"}},
        "370": {"class_type": "WanAnimateToVideo", "inputs": {
            "width": ["330", 0], "height": ["331", 0], "length": ["383", 0],
            "batch_size": 1,
        }, "_meta": {"title": "WanAnimateToVideo"}},
        "412": {"class_type": "ImageScale", "inputs": {
            "width": ["330", 0], "height": ["331", 0],
            "image": ["311", 0], "upscale_method": "lanczos", "crop": "disabled",
        }, "_meta": {"title": "Upscale Image"}},
        "451": {"class_type": "PoseAndFaceDetection", "inputs": {
            "width": ["330", 0], "height": ["331", 0],
        }, "_meta": {"title": "Pose and Face Detection"}},
        "456": {"class_type": "DrawViTPose", "inputs": {
            "width": ["330", 0], "height": ["331", 0],
        }, "_meta": {"title": "Draw ViT Pose"}},
    }


def test_wan_animate_resolution_surfaces_from_primitive_ints():
    res = _detect(_wan_animate_workflow())
    wan_entries = [r for r in res if r["class_type"] == "WanAnimateToVideo"]
    assert len(wan_entries) == 1, f"expected 1 WanAnimateToVideo entry, got {res}"
    e = wan_entries[0]
    assert e["width"] == 720
    assert e["height"] == 1280
    assert e["width_source_node"] == "330"
    assert e["width_source_field"] == "value"
    assert e["height_source_node"] == "331"
    assert e["height_source_field"] == "value"
    assert e["category"] == "latent"


def test_wan_animate_other_consumers_with_wired_wh_not_surfaced():
    """ImageScale / DrawViTPose / PoseAndFaceDetection have wired width+height
    but are NOT in the whitelist — they must be skipped, not surfaced as
    'other' resolution entries that would duplicate the same logical knob."""
    res = _detect(_wan_animate_workflow())
    non_whitelisted = {"ImageScale", "PoseAndFaceDetection", "DrawViTPose"}
    leaked = [r for r in res if r["class_type"] in non_whitelisted]
    assert leaked == [], f"non-whitelisted nodes leaked into resolution list: {leaked}"


def test_existing_latent_workflows_unchanged_literal_wh():
    """Regression guard: a plain EmptyLatentImage with literal width/height
    still surfaces as it did before."""
    wf = {
        "1": {"class_type": "EmptyLatentImage", "inputs": {
            "width": 1024, "height": 1024, "batch_size": 1,
        }, "_meta": {"title": "Empty Latent Image"}},
    }
    res = _detect(wf)
    assert len(res) == 1
    assert res[0]["node_id"] == "1"
    assert res[0]["width"] == 1024
    assert res[0]["height"] == 1024
    assert res[0]["category"] == "latent"
    # No source node fields when the value is literal on the latent itself.
    assert "width_source_node" not in res[0]
    assert "height_source_node" not in res[0]


def test_existing_latent_workflows_unchanged_wired_via_primitive():
    """Regression guard: EmptyLTXVLatentVideo with width/height wired to
    PrimitiveInts still resolves through the upstream walker."""
    wf = {
        "10": {"class_type": "PrimitiveInt", "inputs": {"value": 768},
               "_meta": {"title": "W"}},
        "11": {"class_type": "PrimitiveInt", "inputs": {"value": 512},
               "_meta": {"title": "H"}},
        "20": {"class_type": "EmptyLTXVLatentVideo", "inputs": {
            "width": ["10", 0], "height": ["11", 0], "length": 81,
        }, "_meta": {"title": "Empty LTXV"}},
    }
    res = _detect(wf)
    ltxv = [r for r in res if r["class_type"] == "EmptyLTXVLatentVideo"]
    assert len(ltxv) == 1
    assert ltxv[0]["width"] == 768
    assert ltxv[0]["height"] == 512
    assert ltxv[0]["width_source_node"] == "10"
    assert ltxv[0]["height_source_node"] == "11"


def _wan_i2v_workflow() -> dict:
    """Sanitized minimum from WanI2V.json: WanImageToVideo's width/height are
    wired through an ImageResizeKJv2 (which carries BOTH dimensions) into a pair
    of aspect-ratio switches that pick between two PrimitiveInts (RES 1 / RES 2).
    The walker must follow the matching dimension so width→RES1 and height→RES2,
    not collapse both onto whichever literal it hits first."""
    return {
        "364": {"class_type": "PrimitiveInt", "inputs": {"value": 960},
                "_meta": {"title": "RES 1"}},
        "365": {"class_type": "PrimitiveInt", "inputs": {"value": 544},
                "_meta": {"title": "RES 2"}},
        "362": {"class_type": "Image Aspect Ratio", "inputs": {"image": ["352", 0]},
                "_meta": {"title": "Image Aspect Ratio"}},
        "363": {"class_type": "If ANY return A else B", "inputs": {
            "ANY": ["362", 2], "IF_TRUE": ["364", 0], "IF_FALSE": ["365", 0],
        }},
        "366": {"class_type": "If ANY return A else B", "inputs": {
            "ANY": ["362", 2], "IF_TRUE": ["365", 0], "IF_FALSE": ["364", 0],
        }},
        "354": {"class_type": "ImageResizeKJv2", "inputs": {
            "width": ["363", 0], "height": ["366", 0], "image": ["352", 0],
        }, "_meta": {"title": "Image Resize KJ v2"}},
        "350": {"class_type": "WanImageToVideo", "inputs": {
            "width": ["354", 1], "height": ["354", 2], "length": 81,
        }, "_meta": {"title": "WanImageToVideo"}},
        "352": {"class_type": "LoadImage", "inputs": {"image": "x.png"}},
    }


def test_wan_image_to_video_resolution_dimension_aware():
    res = _detect(_wan_i2v_workflow())
    wan = [r for r in res if r["class_type"] == "WanImageToVideo"]
    assert len(wan) == 1, f"expected 1 WanImageToVideo entry, got {res}"
    e = wan[0]
    assert e["category"] == "latent"
    # width must trace its OWN dimension to RES 1, height to RES 2 — not collapse.
    assert e["width"] == 960
    assert e["height"] == 544
    assert e["width_source_node"] == "364"
    assert e["width_source_field"] == "value"
    assert e["height_source_node"] == "365"
    assert e["height_source_field"] == "value"


def test_crop_like_node_with_wired_wh_not_surfaced():
    """A non-whitelisted node with width+height both wired must NOT be
    surfaced as a resolution entry — otherwise editing 'resolution' in the
    UI would silently resize crops/masks."""
    wf = {
        "1": {"class_type": "PrimitiveInt", "inputs": {"value": 256}},
        "2": {"class_type": "PrimitiveInt", "inputs": {"value": 256}},
        "3": {"class_type": "ImageCrop", "inputs": {
            "width": ["1", 0], "height": ["2", 0], "x": 0, "y": 0,
            "image": ["99", 0],
        }, "_meta": {"title": "Crop"}},
    }
    res = _detect(wf)
    assert [r for r in res if r["class_type"] == "ImageCrop"] == []

"""Tests for _build_civitai_meta — specifically the manual_resources path.

manual_resources are user-supplied modelVersionId references (typically for
workflows/checkpoints that don't surface a hash locally). They get appended to
the resources_list as additive credit. They must NOT be added to hashes_map
because there's no AutoV2 to attach.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _load_share_backend():
    path = ROOT / "custom_blocks" / "civitai_share" / "backend.block.py"
    spec = importlib.util.spec_from_file_location("civitai_share_backend_for_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


share_backend = _load_share_backend()


def test_no_manual_resources_unchanged_behavior():
    """Sanity: when no manual_resources passed, output matches today's shape."""
    meta = {
        "prompt": "a cat",
        "model_hashes": {
            "char.safetensors": {"sha256": "a" * 64, "strength": 1.0},
        },
    }
    civitai_meta = share_backend._build_civitai_meta(meta)
    assert civitai_meta["resources"] == [
        {"type": "lora", "name": "char", "weight": 1.0, "hash": ("A" * 10)},
    ]
    assert civitai_meta["hashes"] == {"lora:char": "A" * 10}


def test_manual_resources_appended_to_resources_list():
    """Manual entries are appended after auto-detected ones, identified by
    modelVersionId (no hash). Strength defaults to 1.0 when unspecified."""
    meta = {"prompt": "x"}
    civitai_meta = share_backend._build_civitai_meta(
        meta,
        manual_resources=[
            {"modelVersionId": 67890, "name": "WAN 2.2 SVI", "type": "workflow"},
        ],
    )
    assert civitai_meta["resources"] == [
        {"type": "workflow", "name": "WAN 2.2 SVI", "modelVersionId": 67890},
    ]
    # No hash for manual resources — they have no AutoV2 locally.
    assert "hashes" not in civitai_meta or civitai_meta["hashes"] == {}


def test_manual_resources_coexist_with_detected_loras():
    """Both auto + manual appear in resources_list; auto comes first."""
    meta = {
        "prompt": "x",
        "model_hashes": {
            "lora.safetensors": {"sha256": "a" * 64, "strength": 0.8},
        },
    }
    civitai_meta = share_backend._build_civitai_meta(
        meta,
        manual_resources=[
            {"modelVersionId": 111, "name": "Workflow A", "type": "workflow"},
        ],
    )
    resources = civitai_meta["resources"]
    assert len(resources) == 2
    assert resources[0]["name"] == "lora"  # auto
    assert resources[1]["modelVersionId"] == 111  # manual


def test_manual_resources_empty_list_is_noop():
    meta = {"prompt": "x"}
    civitai_meta = share_backend._build_civitai_meta(meta, manual_resources=[])
    assert "resources" not in civitai_meta or civitai_meta["resources"] == []


def test_manual_resource_missing_required_fields_skipped():
    """Defensive: a manual resource with no modelVersionId is dropped (can't
    link without one). Don't fail the whole post for a malformed entry."""
    meta = {"prompt": "x"}
    civitai_meta = share_backend._build_civitai_meta(
        meta,
        manual_resources=[
            {"name": "bogus", "type": "workflow"},  # no modelVersionId
            {"modelVersionId": 222, "name": "good", "type": "checkpoint"},
        ],
    )
    resources = civitai_meta.get("resources", [])
    assert len(resources) == 1
    assert resources[0]["modelVersionId"] == 222

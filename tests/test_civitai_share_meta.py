"""Tests for _build_civitai_meta — specifically the manual_resources path.

manual_resources are user-supplied modelVersionId references (typically for
workflows/checkpoints that don't surface a hash locally). CivitAI only honors a
modelVersionId when it appears in the `civitaiResources` array — NOT the legacy
`resources` array (which it matches by hash). So manual entries must be emitted
under `civitaiResources`, otherwise CivitAI resolves them locally but never
attaches them to the uploaded image.
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
    """Sanity: auto-detected (hash) resources are unchanged."""
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
    assert "civitaiResources" not in civitai_meta


def test_manual_resources_emitted_as_civitai_resources():
    """Manual entries go to civitaiResources keyed by modelVersionId — the only
    field CivitAI reads for modelVersionId-based attribution. modelName +
    versionName are carried through for display; no hash exists locally."""
    meta = {"prompt": "x"}
    civitai_meta = share_backend._build_civitai_meta(
        meta,
        manual_resources=[
            {"modelVersionId": 67890, "name": "WAN 2.2 SVI", "versionName": "v1.0",
             "type": "workflow"},
        ],
    )
    assert civitai_meta["civitaiResources"] == [
        {"modelVersionId": 67890, "modelName": "WAN 2.2 SVI", "versionName": "v1.0"},
    ]
    # Manual resources do NOT pollute the legacy hash-based `resources`/`hashes`.
    assert "resources" not in civitai_meta or civitai_meta["resources"] == []
    assert "hashes" not in civitai_meta or civitai_meta["hashes"] == {}


def test_manual_resources_coexist_with_detected_loras():
    """Auto (hash) resources stay in `resources`/`hashes`; manual ones land in
    `civitaiResources`. The two channels are independent."""
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
    assert civitai_meta["resources"] == [
        {"type": "lora", "name": "lora", "weight": 0.8, "hash": "A" * 10},
    ]
    assert civitai_meta["civitaiResources"] == [
        {"modelVersionId": 111, "modelName": "Workflow A"},
    ]


def test_manual_resources_empty_list_is_noop():
    meta = {"prompt": "x"}
    civitai_meta = share_backend._build_civitai_meta(meta, manual_resources=[])
    assert "civitaiResources" not in civitai_meta


def test_manual_resource_missing_modelversionid_skipped():
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
    assert civitai_meta["civitaiResources"] == [
        {"modelVersionId": 222, "modelName": "good"},
    ]

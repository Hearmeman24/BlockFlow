"""Tests for LoRA chain detection and runtime LoRA insertion in comfy_gen."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "comfy_gen_block", ROOT / "custom_blocks" / "comfy_gen" / "backend.block.py"
)
comfy_gen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(comfy_gen)


def _wf_single_chain() -> dict:
    """KSampler ← LoraLoader(11) ← LoraLoader(10) ← CheckpointLoader(5)."""
    return {
        "5":  {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "model.safetensors"}},
        "10": {"class_type": "LoraLoader", "inputs": {
            "lora_name": "a.safetensors", "strength_model": 1.0, "strength_clip": 1.0,
            "model": ["5", 0], "clip": ["5", 1],
        }},
        "11": {"class_type": "LoraLoader", "inputs": {
            "lora_name": "b.safetensors", "strength_model": 0.8, "strength_clip": 0.8,
            "model": ["10", 0], "clip": ["10", 1],
        }},
        "20": {"class_type": "KSampler", "inputs": {
            "model": ["11", 0], "positive": ["30", 0], "negative": ["31", 0],
            "latent_image": ["40", 0],
            "seed": 0, "steps": 20, "cfg": 7.0, "sampler_name": "euler",
            "scheduler": "normal", "denoise": 1.0,
        }},
        "30": {"class_type": "CLIPTextEncode", "inputs": {"text": "pos", "clip": ["11", 1]}},
        "31": {"class_type": "CLIPTextEncode", "inputs": {"text": "neg", "clip": ["11", 1]}},
        "40": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 1}},
    }


def _wf_two_chains() -> dict:
    """Two independent LoRA chains feeding two different samplers."""
    return {
        "5":  {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "m.safetensors"}},
        "10": {"class_type": "LoraLoaderModelOnly", "inputs": {
            "lora_name": "chainA.safetensors", "strength_model": 1.0,
            "model": ["5", 0],
        }},
        "11": {"class_type": "LoraLoaderModelOnly", "inputs": {
            "lora_name": "chainA2.safetensors", "strength_model": 0.5,
            "model": ["10", 0],
        }},
        "20": {"class_type": "KSampler", "inputs": {"model": ["11", 0], "seed": 0}},
        # chain B - independent root from a different checkpoint
        "60": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "m2.safetensors"}},
        "70": {"class_type": "LoraLoaderModelOnly", "inputs": {
            "lora_name": "chainB.safetensors", "strength_model": 1.0,
            "model": ["60", 0],
        }},
        "80": {"class_type": "KSampler", "inputs": {"model": ["70", 0], "seed": 1}},
    }


# ---------------- _detect_lora_nodes: chain_id ----------------

def test_detect_single_chain_assigns_one_chain_id():
    nodes = comfy_gen._detect_lora_nodes(_wf_single_chain())
    assert len(nodes) == 2
    chain_ids = {n["chain_id"] for n in nodes}
    assert chain_ids == {0}
    # ordered: root first, then downstream
    assert nodes[0]["node_id"] == "10"
    assert nodes[1]["node_id"] == "11"


def test_detect_two_chains_assigns_distinct_chain_ids():
    nodes = comfy_gen._detect_lora_nodes(_wf_two_chains())
    by_id = {n["node_id"]: n["chain_id"] for n in nodes}
    assert by_id["10"] == by_id["11"]  # same chain
    assert by_id["70"] != by_id["10"]  # different chain
    # chain ids are 0-indexed and contiguous
    assert set(by_id.values()) == {0, 1}


# ---------------- _insert_lora_nodes: splice mechanics ----------------

def test_insert_single_lora_after_chain_tail():
    wf = _wf_single_chain()
    added = [{
        "chain_anchor": "11",  # current last LoRA in the chain
        "class_type": "LoraLoader",
        "lora_name": "added.safetensors",
        "strength_model": 0.9,
        "strength_clip": 0.9,
    }]
    out = comfy_gen._insert_lora_nodes(wf, added)
    # new node id allocated
    new_ids = [nid for nid in out if nid not in _wf_single_chain()]
    assert len(new_ids) == 1
    new_id = new_ids[0]
    new = out[new_id]
    assert new["class_type"] == "LoraLoader"
    assert new["inputs"]["lora_name"] == "added.safetensors"
    assert new["inputs"]["strength_model"] == 0.9
    assert new["inputs"]["strength_clip"] == 0.9
    # new loader's model/clip pull from prior tail (11)
    assert new["inputs"]["model"] == ["11", 0]
    assert new["inputs"]["clip"] == ["11", 1]
    # downstream consumers rewired from 11 → new_id
    assert out["20"]["inputs"]["model"] == [new_id, 0]
    assert out["30"]["inputs"]["clip"] == [new_id, 1]
    assert out["31"]["inputs"]["clip"] == [new_id, 1]
    # original tail loader untouched
    assert out["11"]["inputs"]["model"] == ["10", 0]


def test_insert_model_only_skips_clip_rewire():
    wf = _wf_two_chains()
    added = [{
        "chain_anchor": "70",
        "class_type": "LoraLoaderModelOnly",
        "lora_name": "extra.safetensors",
        "strength_model": 0.4,
    }]
    out = comfy_gen._insert_lora_nodes(wf, added)
    new_id = next(nid for nid in out if nid not in _wf_two_chains())
    assert out[new_id]["class_type"] == "LoraLoaderModelOnly"
    assert "clip" not in out[new_id]["inputs"]
    assert out[new_id]["inputs"]["model"] == ["70", 0]
    # KSampler 80 rewired
    assert out["80"]["inputs"]["model"] == [new_id, 0]


def test_insert_two_loras_chains_sequentially():
    """Two added LoRAs sharing the same anchor should chain in order."""
    wf = _wf_single_chain()
    added = [
        {"chain_anchor": "11", "class_type": "LoraLoader",
         "lora_name": "x.safetensors", "strength_model": 1.0, "strength_clip": 1.0},
        {"chain_anchor": "11", "class_type": "LoraLoader",
         "lora_name": "y.safetensors", "strength_model": 1.0, "strength_clip": 1.0},
    ]
    out = comfy_gen._insert_lora_nodes(wf, added)
    new_ids = [nid for nid in out if nid not in _wf_single_chain()]
    assert len(new_ids) == 2
    # Identify which new node feeds the KSampler (the new tail)
    tail_ref = out["20"]["inputs"]["model"]
    tail_id = tail_ref[0]
    assert tail_id in new_ids
    # The tail's model input must reference the *other* new node
    other_id = next(nid for nid in new_ids if nid != tail_id)
    assert out[tail_id]["inputs"]["model"] == [other_id, 0]
    # And the other one anchors to 11
    assert out[other_id]["inputs"]["model"] == ["11", 0]


def test_insert_isolates_chains():
    """Inserting into chain A must not touch chain B."""
    wf = _wf_two_chains()
    before_b_70 = dict(wf["70"]["inputs"])
    before_b_80 = dict(wf["80"]["inputs"])
    added = [{"chain_anchor": "11", "class_type": "LoraLoaderModelOnly",
              "lora_name": "z.safetensors", "strength_model": 1.0}]
    out = comfy_gen._insert_lora_nodes(wf, added)
    assert out["70"]["inputs"] == before_b_70
    assert out["80"]["inputs"] == before_b_80


def test_insert_unknown_anchor_is_noop():
    wf = _wf_single_chain()
    out = comfy_gen._insert_lora_nodes(wf, [
        {"chain_anchor": "9999", "class_type": "LoraLoader",
         "lora_name": "ghost.safetensors", "strength_model": 1.0, "strength_clip": 1.0},
    ])
    assert set(out.keys()) == set(wf.keys())

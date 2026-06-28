"""Adversarial SEAM tests for MoE detection (sgs-ui-8zu, breaker).

Append-only. Attacks the backend _detect_moe_pairs on the REAL workflow files
end-to-end plus hand-built adversarial graphs that probe the component-size /
direction-marker / shared-source rules.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location(
    "comfy_gen_block_seams", ROOT / "custom_blocks" / "comfy_gen" / "backend.block.py"
)
comfy_gen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(comfy_gen)

_detect_moe = comfy_gen._detect_moe_pairs

# Real-workflow corpus lives outside the repo (large, not redistributable). Point
# BLOCKFLOW_REAL_WF_DIR at a dir holding the Wan2.2_T2V_*.json files to run these;
# absent (e.g. CI), the file-backed tests skip instead of erroring.
WF_DIR = Path(os.environ.get("BLOCKFLOW_REAL_WF_DIR", str(ROOT / "tests" / "fixtures" / "real_workflows")))

_requires_real_wf = pytest.mark.skipif(
    not WF_DIR.is_dir(),
    reason="real workflow corpus absent; set BLOCKFLOW_REAL_WF_DIR to run",
)

# Field set the TS MoePairInfo interface requires (the py->TS seam contract).
_REQUIRED_FIELDS = {
    "family", "high_node_id", "low_node_id", "total", "split",
    "total_targets", "split_targets", "owned_keys",
}


def _load(name: str) -> dict:
    return json.loads((WF_DIR / name).read_text())


@_requires_real_wf
def test_real_lightning_file_detects_ksa_pair_8_4():
    pairs = _detect_moe(_load("Wan2.2_T2V_Lightning.json"))
    assert len(pairs) == 1
    p = pairs[0]
    assert p["family"] == "KSamplerAdvanced"
    assert (p["high_node_id"], p["low_node_id"]) == ("401", "402")
    assert p["total"] == 8 and p["split"] == 4


@_requires_real_wf
def test_real_res4lyf_file_detects_clownshark_pair_16_4():
    pairs = _detect_moe(_load("Wan2.2_T2V_RES4LYF_Full.json"))
    assert len(pairs) == 1
    p = pairs[0]
    assert p["family"] == "ClownsharKSampler_Beta"
    assert (p["high_node_id"], p["low_node_id"]) == ("407", "408")
    assert p["total"] == 16 and p["split"] == 4


@_requires_real_wf
def test_py_dict_has_every_field_the_ts_interface_requires():
    """Seam: the emitted dict must carry every MoePairInfo field, correct shapes."""
    for name in ("Wan2.2_T2V_Lightning.json", "Wan2.2_T2V_RES4LYF_Full.json"):
        for p in _detect_moe(_load(name)):
            missing = _REQUIRED_FIELDS - set(p.keys())
            assert not missing, f"{name}: missing {missing}"
            assert isinstance(p["total"], int)
            assert isinstance(p["split"], int)
            assert isinstance(p["total_targets"], list)
            # split_targets values must all be the literal recipe 'split'
            assert all(v == "split" for v in p["split_targets"].values())
            assert isinstance(p["owned_keys"], list)


def _ksa(node_id: str, latent_from: str, *, add_noise: str, steps: int,
         end_at: int | None = None, start_at: int | None = None) -> dict:
    inp: dict = {
        "add_noise": add_noise, "steps": steps, "cfg": 1,
        "sampler_name": "euler", "scheduler": "beta",
        "latent_image": [latent_from, 0],
    }
    if end_at is not None:
        inp["end_at_step"] = end_at
    if start_at is not None:
        inp["start_at_step"] = start_at
    return {"class_type": "KSamplerAdvanced", "inputs": inp, "_meta": {"title": "KSampler (Advanced)"}}


def test_two_independent_pairs_sharing_one_empty_latent_source():
    """Both pairs' HIGH read latent from the SAME EmptyLatent (like real 401/407
    both reading ["403",0]). The shared non-family source must NOT merge them
    into one oversized component — expect exactly TWO pairs."""
    wf = {
        "403": {"class_type": "EmptyHunyuanLatentVideo", "inputs": {"width": 480, "height": 832, "length": 81}},
        # pair A
        "401": _ksa("401", "403", add_noise="enable", steps=8, end_at=4),
        "402": _ksa("402", "401", add_noise="disable", steps=8, start_at=4),
        # pair B — independent, also seeded off 403
        "501": _ksa("501", "403", add_noise="enable", steps=6, end_at=2),
        "502": _ksa("502", "501", add_noise="disable", steps=6, start_at=2),
    }
    pairs = _detect_moe(wf)
    highs = sorted(p["high_node_id"] for p in pairs)
    assert highs == ["401", "501"], f"expected two pairs, got {pairs}"


def test_three_chained_same_family_yields_no_pair():
    """A->B->C component size 3 must emit ZERO pairs (O1 deferred)."""
    wf = {
        "403": {"class_type": "EmptyHunyuanLatentVideo", "inputs": {}},
        "401": _ksa("401", "403", add_noise="enable", steps=9, end_at=3),
        "402": _ksa("402", "401", add_noise="disable", steps=9, start_at=3, end_at=6),
        "403b": _ksa("403b", "402", add_noise="disable", steps=9, start_at=6),
    }
    # rename 403b key to avoid colliding with the latent node id
    wf["410"] = wf.pop("403b")
    wf["410"]["inputs"]["latent_image"] = ["402", 0]
    assert _detect_moe(wf) == []


def test_direction_marker_disagree_rejects():
    """Chain says 401->402 but 401.add_noise=disable: reject (no guessing)."""
    wf = {
        "403": {"class_type": "EmptyHunyuanLatentVideo", "inputs": {}},
        "401": _ksa("401", "403", add_noise="disable", steps=8, end_at=4),
        "402": _ksa("402", "401", add_noise="enable", steps=8, start_at=4),
    }
    assert _detect_moe(wf) == []


def test_boundary_out_of_range_rejects():
    """end_at_step == steps (not <= steps-1) must reject."""
    wf = {
        "403": {"class_type": "EmptyHunyuanLatentVideo", "inputs": {}},
        "401": _ksa("401", "403", add_noise="enable", steps=8, end_at=8),
        "402": _ksa("402", "401", add_noise="disable", steps=8, start_at=8),
    }
    assert _detect_moe(wf) == []


def test_lone_ksa_no_pair():
    """Single KSA whose latent is the empty latent (not a sampler) -> no pair."""
    wf = {
        "403": {"class_type": "EmptyHunyuanLatentVideo", "inputs": {}},
        "401": _ksa("401", "403", add_noise="enable", steps=8, end_at=4),
    }
    assert _detect_moe(wf) == []


def test_start_at_step_must_equal_end_at_step():
    """LOW.start_at_step != HIGH.end_at_step must reject (mismatched handoff)."""
    wf = {
        "403": {"class_type": "EmptyHunyuanLatentVideo", "inputs": {}},
        "401": _ksa("401", "403", add_noise="enable", steps=8, end_at=4),
        "402": _ksa("402", "401", add_noise="disable", steps=8, start_at=5),
    }
    assert _detect_moe(wf) == []

"""Sampler detection tests for the comfy_gen block.

Covers sgs-ui-wz6: SamplerCustom (non-Advanced) nodes have noise_seed and
cfg as inline inputs (unlike SamplerCustomAdvanced which wires them through
RandomNoise / CFGGuider), but their sampler and sigmas are still wired.
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

_detect = comfy_gen._detect_ksamplers


def _sampler_custom_workflow() -> dict:
    """Minimal SamplerCustom shape from HiDreamO1-ImageEdit.json:
    inline cfg + noise_seed, sampler wired to a custom sampler node
    (here KSamplerSelect), sigmas wired to BasicScheduler."""
    return {
        "108": {
            "class_type": "SamplerCustom",
            "inputs": {
                "add_noise": True,
                "noise_seed": 270186383729385,
                "cfg": 1,
                "model": ["124", 0],
                "positive": ["104", 0],
                "negative": ["104", 1],
                "sampler": ["125", 0],
                "sigmas": ["112", 0],
                "latent_image": ["172", 0],
            },
        },
        "112": {
            "class_type": "BasicScheduler",
            "inputs": {
                "scheduler": "normal",
                "steps": 28,
                "denoise": 1,
                "model": ["124", 0],
            },
        },
        "125": {
            "class_type": "KSamplerSelect",
            "inputs": {"sampler_name": "euler"},
        },
    }


def test_sampler_custom_inline_cfg_and_seed():
    [entry] = _detect(_sampler_custom_workflow())
    assert entry["node_id"] == "108"
    assert entry["class_type"] == "SamplerCustom"
    assert entry["cfg"] == 1
    assert entry["seed"] == 270186383729385


def test_sampler_custom_traces_sigmas_for_steps_and_scheduler():
    [entry] = _detect(_sampler_custom_workflow())
    assert entry["steps"] == 28
    assert entry["scheduler"] == "normal"


def test_sampler_custom_traces_wired_sampler_name():
    [entry] = _detect(_sampler_custom_workflow())
    assert entry["sampler_name"] == "euler"


def test_sampler_custom_override_map_targets_correct_nodes():
    [entry] = _detect(_sampler_custom_workflow())
    om = entry["override_map"]
    # cfg + seed live on the SamplerCustom node itself
    assert om["cfg"] == "108.cfg"
    assert om["seed"] == "108.noise_seed"
    # sampler_name lives on the KSamplerSelect node
    assert om["sampler_name"] == "125.sampler_name"
    # steps + scheduler live on the BasicScheduler node
    assert om["steps"] == "112.steps"
    assert om["scheduler"] == "112.scheduler"


def _wired_seed_workflow() -> dict:
    """SamplerCustom with noise_seed WIRED through a PrimitiveInt to a
    Seed (rgthree) node (API_Wan2.2_SVI_2pass_V3.json shape). The seed value
    must resolve through the chain, and the seed override must target the
    shared source node — not the dead `<sampler>.seed` field that ComfyUI
    ignores (the sampler's own field is `noise_seed`, and it's wired anyway)."""
    return {
        "1006": {
            "class_type": "SamplerCustom",
            "inputs": {
                "add_noise": True,
                "noise_seed": ["980", 0],
                "cfg": 1,
                "sampler": ["125", 0],
                "sigmas": ["112", 0],
            },
        },
        "1007": {
            "class_type": "SamplerCustom",
            "inputs": {
                "add_noise": True,
                "noise_seed": ["980", 0],
                "cfg": 1,
                "sampler": ["125", 0],
                "sigmas": ["112", 0],
            },
        },
        "980": {"class_type": "PrimitiveInt", "inputs": {"value": ["984", 0]}},
        "984": {"class_type": "Seed (rgthree)", "inputs": {"seed": 12345}},
        "112": {"class_type": "BasicScheduler",
                 "inputs": {"scheduler": "normal", "steps": 6, "denoise": 1}},
        "125": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
    }


def test_sampler_custom_wired_seed_resolves_through_chain():
    entries = _detect(_wired_seed_workflow())
    entry = next(e for e in entries if e["node_id"] == "1006")
    assert entry["seed"] == 12345


def test_sampler_custom_wired_seed_override_targets_source_node():
    entries = _detect(_wired_seed_workflow())
    # Both samplers share the same seed source — each must point the override at
    # the source node's literal field, so the run-time randomize hits a real
    # input (and dedupes to a single shared seed).
    for nid in ("1006", "1007"):
        entry = next(e for e in entries if e["node_id"] == nid)
        assert entry["override_map"]["seed"] == "984.seed", entry["override_map"]


def test_sampler_custom_without_kselect_skips_sampler_name():
    """If sampler is wired to a non-KSamplerSelect node (e.g. SamplerLCM)
    with no sampler_name field, we still detect the node but omit
    sampler_name and its override entry."""
    wf = _sampler_custom_workflow()
    wf["125"] = {
        "class_type": "SamplerLCM",
        "inputs": {"s_noise": 1.0},
    }
    [entry] = _detect(wf)
    assert "sampler_name" not in entry
    assert "sampler_name" not in entry.get("override_map", {})
    # The rest still resolves
    assert entry["cfg"] == 1
    assert entry["steps"] == 28

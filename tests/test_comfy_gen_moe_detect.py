"""MoE KSampler detection tests — sgs-ui-8zu.

Covers _detect_moe_pairs() and ClownsharKSampler_Beta detection in
_detect_ksamplers(). Fixtures are built from real node shapes in:
  - Wan2.2_T2V_Lightning.json  (KSamplerAdvanced pair 401→402, total=8 split=4)
  - Wan2.2_T2V_RES4LYF_Full.json (ClownsharKSampler_Beta pair 407→408, total=16 split=4)
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

_detect_moe = comfy_gen._detect_moe_pairs
_detect_ks = comfy_gen._detect_ksamplers


# ---------------------------------------------------------------------------
# Fixtures — real node shapes from the reference workflows
# ---------------------------------------------------------------------------

def _ksa_pair_workflow() -> dict:
    """KSamplerAdvanced pair: node 401 (high) → 402 (low).

    From Wan2.2_T2V_Lightning.json: total=8, split=4.
    402.latent_image == ["401", 0] — direct wire.
    """
    return {
        "401": {
            "inputs": {
                "add_noise": "enable",
                "noise_seed": 972166878009085,
                "steps": 8,
                "cfg": 1,
                "sampler_name": "euler",
                "scheduler": "beta",
                "start_at_step": 0,
                "end_at_step": 4,
                "return_with_leftover_noise": "enable",
                "model": ["302", 0],
                "positive": ["227", 0],
                "negative": ["406", 0],
                "latent_image": ["403", 0],
            },
            "class_type": "KSamplerAdvanced",
            "_meta": {"title": "KSampler (Advanced)"},
        },
        "402": {
            "inputs": {
                "add_noise": "disable",
                "noise_seed": 0,
                "steps": 8,
                "cfg": 1,
                "sampler_name": "res_2s",
                "scheduler": "beta",
                "start_at_step": 4,
                "end_at_step": 10000,
                "return_with_leftover_noise": "disable",
                "model": ["307", 0],
                "positive": ["227", 0],
                "negative": ["406", 0],
                "latent_image": ["401", 0],
            },
            "class_type": "KSamplerAdvanced",
            "_meta": {"title": "KSampler (Advanced)"},
        },
    }


def _clownshark_pair_workflow() -> dict:
    """ClownsharKSampler_Beta pair: node 407 (high) → 408 (low).

    From Wan2.2_T2V_RES4LYF_Full.json: total=16, split=4.
    408.latent_image == ["407", 0] — direct wire.
    """
    return {
        "407": {
            "inputs": {
                "eta": 0.75,
                "sampler_name": "linear/euler",
                "scheduler": "beta",
                "steps": 16,
                "steps_to_run": 4,
                "denoise": 1,
                "cfg": 1,
                "seed": 200371215504766,
                "sampler_mode": "standard",
                "bongmath": True,
                "model": ["302", 0],
                "positive": ["227", 0],
                "negative": ["228", 0],
                "latent_image": ["403", 0],
            },
            "class_type": "ClownsharKSampler_Beta",
            "_meta": {"title": "ClownsharKSampler"},
        },
        "408": {
            "inputs": {
                "eta": 0.75,
                "sampler_name": "multistep/res_3m",
                "scheduler": "bong_tangent",
                "steps": 16,
                "steps_to_run": -1,
                "denoise": 1,
                "cfg": 1.9,
                "seed": 0,
                "sampler_mode": "resample",
                "bongmath": True,
                "model": ["307", 0],
                "positive": ["227", 0],
                "negative": ["228", 0],
                "latent_image": ["407", 0],
            },
            "class_type": "ClownsharKSampler_Beta",
            "_meta": {"title": "ClownsharKSampler"},
        },
    }


# ---------------------------------------------------------------------------
# KSamplerAdvanced MoE pair — detection
# ---------------------------------------------------------------------------

def test_ksa_moe_pair_detected():
    """Real 401/402 fixture → one pair, correct family/high/low/total/split."""
    pairs = _detect_moe(_ksa_pair_workflow())
    assert len(pairs) == 1
    p = pairs[0]
    assert p["family"] == "KSamplerAdvanced"
    assert p["high_node_id"] == "401"
    assert p["low_node_id"] == "402"
    assert p["total"] == 8
    assert p["split"] == 4


def test_ksa_moe_total_targets():
    """total_targets covers both samplers' steps fields."""
    [p] = _detect_moe(_ksa_pair_workflow())
    assert set(p["total_targets"]) == {"401.steps", "402.steps"}


def test_ksa_moe_split_targets():
    """split_targets: 401.end_at_step and 402.start_at_step, both recipe 'split'.
    LOW.end_at_step (10000 sentinel) must NOT be a target.
    """
    [p] = _detect_moe(_ksa_pair_workflow())
    st = p["split_targets"]
    assert "401.end_at_step" in st
    assert "402.start_at_step" in st
    assert st["401.end_at_step"] == "split"
    assert st["402.start_at_step"] == "split"
    # Sentinel never written
    assert "402.end_at_step" not in st


def test_ksa_moe_owned_keys():
    """owned_keys = the 4 keys the MoE panel owns."""
    [p] = _detect_moe(_ksa_pair_workflow())
    assert set(p["owned_keys"]) == {
        "401.steps", "402.steps",
        "401.end_at_step", "402.start_at_step",
    }


# ---------------------------------------------------------------------------
# ClownsharKSampler_Beta MoE pair — detection
# ---------------------------------------------------------------------------

def test_clownshark_moe_pair_detected():
    """Real 407/408 fixture → one pair, correct family/total/split."""
    pairs = _detect_moe(_clownshark_pair_workflow())
    assert len(pairs) == 1
    p = pairs[0]
    assert p["family"] == "ClownsharKSampler_Beta"
    assert p["high_node_id"] == "407"
    assert p["low_node_id"] == "408"
    assert p["total"] == 16
    assert p["split"] == 4


def test_clownshark_split_targets():
    """split_targets: only HIGH.steps_to_run; LOW.steps_to_run (-1 sentinel) NOT a target."""
    [p] = _detect_moe(_clownshark_pair_workflow())
    st = p["split_targets"]
    assert "407.steps_to_run" in st
    assert st["407.steps_to_run"] == "split"
    assert "408.steps_to_run" not in st


# ---------------------------------------------------------------------------
# Single ClownShark in _detect_ksamplers
# ---------------------------------------------------------------------------

def _lone_clownshark_workflow() -> dict:
    """Lone ClownsharKSampler_Beta with seed=0 (truthiness trap check)."""
    return {
        "10": {
            "inputs": {
                "eta": 0.5,
                "sampler_name": "res_2s",
                "scheduler": "beta",
                "steps": 20,
                "steps_to_run": -1,
                "denoise": 0.85,
                "cfg": 2.5,
                "seed": 0,
                "sampler_mode": "standard",
                "bongmath": False,
                "model": ["1", 0],
                "positive": ["2", 0],
                "negative": ["3", 0],
                "latent_image": ["4", 0],
            },
            "class_type": "ClownsharKSampler_Beta",
            "_meta": {"title": "ClownsharKSampler"},
        },
    }


def test_clownshark_single_detected():
    """Lone ClownShark node → _detect_ksamplers entry with all fields."""
    entries = _detect_ks(_lone_clownshark_workflow())
    cs = [e for e in entries if e.get("class_type") == "ClownsharKSampler_Beta"]
    assert len(cs) == 1
    e = cs[0]
    assert e["node_id"] == "10"
    assert e["steps"] == 20
    assert e["cfg"] == 2.5
    assert e["denoise"] == round(0.85, 3)
    assert e["sampler_name"] == "res_2s"
    assert e["scheduler"] == "beta"
    # No override_map (all fields are inline on the node)
    assert "override_map" not in e


def test_clownshark_seed_from_seed_field():
    """seed is read from the 'seed' input field, not 'noise_seed'. seed=0 must be emitted."""
    entries = _detect_ks(_lone_clownshark_workflow())
    [e] = [x for x in entries if x.get("class_type") == "ClownsharKSampler_Beta"]
    # seed=0 must be present (no truthiness bug)
    assert "seed" in e
    assert e["seed"] == 0


def test_clownshark_entry_has_curated_options():
    """ClownShark entry carries sampler_options + scheduler_options.
    A standard KSampler entry does NOT carry those fields.
    """
    # ClownShark entry
    entries = _detect_ks(_lone_clownshark_workflow())
    [e] = [x for x in entries if x.get("class_type") == "ClownsharKSampler_Beta"]
    assert "sampler_options" in e, "ClownShark entry must carry sampler_options"
    assert "scheduler_options" in e, "ClownShark entry must carry scheduler_options"
    # Current value must be unioned in
    assert "res_2s" in e["sampler_options"]
    assert "beta" in e["scheduler_options"]
    # Standard KSampler entry does NOT carry these fields
    std_wf = {
        "99": {
            "inputs": {"steps": 20, "cfg": 7, "seed": 1234, "denoise": 1.0,
                       "sampler_name": "euler", "scheduler": "normal"},
            "class_type": "KSampler",
        },
    }
    std_entries = _detect_ks(std_wf)
    [std] = std_entries
    assert "sampler_options" not in std
    assert "scheduler_options" not in std


# ---------------------------------------------------------------------------
# Degradation / negative tests
# ---------------------------------------------------------------------------

def test_lone_ksa_no_pair():
    """A lone KSamplerAdvanced (latent not from another sampler) → zero MoE pairs,
    but still one _detect_ksamplers entry."""
    wf = {
        "401": {
            "inputs": {
                "add_noise": "enable",
                "noise_seed": 0,
                "steps": 8,
                "cfg": 1,
                "sampler_name": "euler",
                "scheduler": "beta",
                "start_at_step": 0,
                "end_at_step": 4,
                "return_with_leftover_noise": "enable",
                "model": ["302", 0],
                "positive": ["227", 0],
                "negative": ["406", 0],
                "latent_image": ["403", 0],  # not from another sampler
            },
            "class_type": "KSamplerAdvanced",
        },
        # Node 403 is a latent generator, NOT a sampler
        "403": {
            "inputs": {"width": 832, "height": 480, "length": 81, "batch_size": 1},
            "class_type": "EmptyLTXVLatentVideo",
        },
    }
    pairs = _detect_moe(wf)
    assert pairs == []
    entries = _detect_ks(wf)
    ksa = [e for e in entries if e["node_id"] == "401"]
    assert len(ksa) == 1


def test_three_chained_no_pair():
    """A→B→C same-family chain → zero MoE pairs (size==3 component), three singles."""
    wf = {
        "1": {
            "inputs": {
                "add_noise": "enable", "noise_seed": 0, "steps": 8, "cfg": 1,
                "sampler_name": "euler", "scheduler": "beta",
                "start_at_step": 0, "end_at_step": 3,
                "return_with_leftover_noise": "enable",
                "model": ["99", 0], "positive": ["p", 0], "negative": ["n", 0],
                "latent_image": ["lat", 0],
            },
            "class_type": "KSamplerAdvanced",
        },
        "2": {
            "inputs": {
                "add_noise": "disable", "noise_seed": 0, "steps": 8, "cfg": 1,
                "sampler_name": "euler", "scheduler": "beta",
                "start_at_step": 3, "end_at_step": 6,
                "return_with_leftover_noise": "enable",
                "model": ["99", 0], "positive": ["p", 0], "negative": ["n", 0],
                "latent_image": ["1", 0],  # chained from node 1
            },
            "class_type": "KSamplerAdvanced",
        },
        "3": {
            "inputs": {
                "add_noise": "disable", "noise_seed": 0, "steps": 8, "cfg": 1,
                "sampler_name": "euler", "scheduler": "beta",
                "start_at_step": 6, "end_at_step": 10000,
                "return_with_leftover_noise": "disable",
                "model": ["99", 0], "positive": ["p", 0], "negative": ["n", 0],
                "latent_image": ["2", 0],  # chained from node 2
            },
            "class_type": "KSamplerAdvanced",
        },
    }
    pairs = _detect_moe(wf)
    assert pairs == []
    entries = _detect_ks(wf)
    assert len(entries) == 3


def test_cross_family_no_pair():
    """KSamplerAdvanced feeding ClownsharKSampler_Beta → no pair (cross-family)."""
    wf = {
        "501": {
            "inputs": {
                "add_noise": "enable", "noise_seed": 0, "steps": 8, "cfg": 1,
                "sampler_name": "euler", "scheduler": "beta",
                "start_at_step": 0, "end_at_step": 4,
                "return_with_leftover_noise": "enable",
                "model": ["99", 0], "positive": ["p", 0], "negative": ["n", 0],
                "latent_image": ["lat", 0],
            },
            "class_type": "KSamplerAdvanced",
        },
        "502": {
            "inputs": {
                "eta": 0.75, "sampler_name": "res_2s", "scheduler": "beta",
                "steps": 8, "steps_to_run": -1, "denoise": 1, "cfg": 1.5,
                "seed": 0, "sampler_mode": "resample", "bongmath": True,
                "model": ["99", 0], "positive": ["p", 0], "negative": ["n", 0],
                "latent_image": ["501", 0],  # chained from KSA
            },
            "class_type": "ClownsharKSampler_Beta",
        },
    }
    pairs = _detect_moe(wf)
    assert pairs == []


def test_direction_marker_disagree_no_pair():
    """Chain says 401→402 (402's latent from 401) but 401.add_noise='disable'
    (should be HIGH=enable). Direction and marker disagree → reject."""
    wf = _ksa_pair_workflow()
    # Flip 401's add_noise to what a LOW node would have
    wf["401"]["inputs"]["add_noise"] = "disable"
    pairs = _detect_moe(wf)
    assert pairs == []


def test_boundary_out_of_range_no_pair():
    """end_at_step=0 → boundary signal fails → no pair."""
    wf = _ksa_pair_workflow()
    wf["401"]["inputs"]["end_at_step"] = 0
    pairs = _detect_moe(wf)
    assert pairs == []


def test_boundary_out_of_range_equal_steps_no_pair():
    """end_at_step == steps (= 8) → not in [1, steps-1] → no pair."""
    wf = _ksa_pair_workflow()
    wf["401"]["inputs"]["end_at_step"] = 8  # == steps, not [1,7]
    pairs = _detect_moe(wf)
    assert pairs == []


def test_steps_mismatch_flag():
    """HIGH.steps=8, LOW.steps=10 → pair still forms, steps_mismatch=True, total=8."""
    wf = _ksa_pair_workflow()
    wf["402"]["inputs"]["steps"] = 10
    [p] = _detect_moe(wf)
    assert p["steps_mismatch"] is True
    assert p["total"] == 8  # from HIGH (authoritative)


def test_steps_mismatch_false_when_equal():
    """When HIGH.steps == LOW.steps, steps_mismatch is False (not absent)."""
    [p] = _detect_moe(_ksa_pair_workflow())
    # Explicit False, not just absent
    assert p.get("steps_mismatch") is False


def test_two_independent_pairs():
    """Two independent KSA pairs in one workflow → two MoE pairs."""
    wf = _ksa_pair_workflow()
    # Add a second independent pair with different node IDs
    wf["501"] = {
        "inputs": {
            "add_noise": "enable", "noise_seed": 11, "steps": 12, "cfg": 2,
            "sampler_name": "dpmpp_2m", "scheduler": "karras",
            "start_at_step": 0, "end_at_step": 6,
            "return_with_leftover_noise": "enable",
            "model": ["99", 0], "positive": ["p", 0], "negative": ["n", 0],
            "latent_image": ["lat2", 0],
        },
        "class_type": "KSamplerAdvanced",
    }
    wf["502"] = {
        "inputs": {
            "add_noise": "disable", "noise_seed": 22, "steps": 12, "cfg": 2,
            "sampler_name": "dpmpp_2m", "scheduler": "karras",
            "start_at_step": 6, "end_at_step": 10000,
            "return_with_leftover_noise": "disable",
            "model": ["99", 0], "positive": ["p", 0], "negative": ["n", 0],
            "latent_image": ["501", 0],
        },
        "class_type": "KSamplerAdvanced",
    }
    pairs = _detect_moe(wf)
    assert len(pairs) == 2
    # Both pairs formed correctly
    pair_keys = {(p["high_node_id"], p["low_node_id"]) for p in pairs}
    assert ("401", "402") in pair_keys
    assert ("501", "502") in pair_keys


# ---------------------------------------------------------------------------
# Curated list coverage
# ---------------------------------------------------------------------------

def test_clownshark_curated_list_contains_known_values():
    """CLOWNSHARK_SAMPLERS and CLOWNSHARK_SCHEDULERS contain the values from
    the reference workflows and the minimum required set."""
    samplers = comfy_gen.CLOWNSHARK_SAMPLERS
    schedulers = comfy_gen.CLOWNSHARK_SCHEDULERS

    # The full RES4LYF RK_SAMPLER_NAMES_BETA_FOLDERS list (folder-prefixed form),
    # not a hand-picked subset.
    assert len(samplers) == 119

    # Values seen in the reference workflows (folder-prefixed form).
    assert "linear/euler" in samplers
    assert "multistep/res_3m" in samplers
    assert "exponential/res_2s" in samplers
    # A spread across the real RES4LYF families.
    assert "fully_implicit/gauss-legendre_2s" in samplers
    assert "linear/dormand-prince_6s" in samplers
    assert "diag_implicit/crouzeix_2s" in samplers
    assert "none" in samplers

    # Fabricated / standard-ComfyUI names that are NOT ClownShark samplers must
    # be absent (regression guard against the original guessed list).
    for bogus in ("dpm_fast", "dpm_adaptive", "rk4", "heun", "bogacki_shampine"):
        assert bogus not in samplers, bogus

    # Schedulers = comfy core SCHEDULER_NAMES + RES4LYF bong_tangent + beta57.
    assert len(schedulers) == 11
    for s in ("beta", "bong_tangent", "beta57", "ddim_uniform", "kl_optimal"):
        assert s in schedulers, s
    # Names that were in the original guess but are not real comfy/RES4LYF schedulers.
    for bogus in ("polyexponential", "laplace"):
        assert bogus not in schedulers, bogus


def test_clownshark_curated_options_union_current_value():
    """sampler_options = CLOWNSHARK_SAMPLERS ∪ {current node value}.
    A hypothetical future sampler not yet in the constant still appears.
    """
    wf = {
        "20": {
            "inputs": {
                "steps": 10, "cfg": 1, "seed": 99, "denoise": 1.0,
                "sampler_name": "future/sampler_not_in_const",
                "scheduler": "future_scheduler",
                "sampler_mode": "standard", "steps_to_run": -1,
                "bongmath": False,
                "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0],
                "latent_image": ["4", 0],
            },
            "class_type": "ClownsharKSampler_Beta",
        },
    }
    [e] = _detect_ks(wf)
    # The current (unknown) value must be present despite not being in the constant
    assert "future/sampler_not_in_const" in e["sampler_options"]
    assert "future_scheduler" in e["scheduler_options"]
    # Known constants still present
    assert "exponential/res_2s" in e["sampler_options"]
    assert "beta" in e["scheduler_options"]

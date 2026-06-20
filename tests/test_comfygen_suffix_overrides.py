"""Detection tests for the _ComfyGen suffix override feature (sgs-ui-lix0).

A node whose _meta.title ends with "_ComfyGen" exposes EACH of its literal
String/Int/Float (non-bool) inputs as an overrideable entry keyed
<node_id>.<input>. Wired/bool/combo-typed-by-value inputs follow the same
literal-only rule; the label strips the suffix and disambiguates by input name
when a node yields more than one field.
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

_detect = comfy_gen._detect_comfygen_overrides


def _by_key(entries):
    return {f'{e["node_id"]}.{e["field"]}': e for e in entries}


def test_single_value_primitive_int():
    wf = {
        "5": {"class_type": "PrimitiveInt", "inputs": {"value": 8},
              "_meta": {"title": "Steps_ComfyGen"}},
    }
    res = _detect(wf)
    assert len(res) == 1
    e = res[0]
    assert e["node_id"] == "5"
    assert e["field"] == "value"
    assert e["type"] == "int"
    assert e["current_value"] == 8
    # single field → label is the stripped title (no input-name disambiguation)
    assert e["label"] == "Steps"


def test_string_and_float_types():
    wf = {
        "1": {"class_type": "PrimitiveString", "inputs": {"value": "hello"},
              "_meta": {"title": "Caption_ComfyGen"}},
        "2": {"class_type": "PrimitiveFloat", "inputs": {"value": 0.75},
              "_meta": {"title": "Strength_ComfyGen"}},
    }
    res = _by_key(_detect(wf))
    assert res["1.value"]["type"] == "string"
    assert res["1.value"]["current_value"] == "hello"
    assert res["2.value"]["type"] == "float"
    assert res["2.value"]["current_value"] == 0.75


def test_multi_input_node_surfaces_each_literal_input():
    # Custom node (not in the object_info map) so the value-guess path is what's
    # under test here; schema-driven combo skipping is covered separately.
    wf = {
        "9": {"class_type": "MyCustomMultiNode", "inputs": {
            "steps": 8, "cfg": 1.0, "mode": "fast",
            "add_noise": True,            # bool — excluded
            "model": ["3", 0],            # wired — excluded
        }, "_meta": {"title": "Sampler_ComfyGen"}},
    }
    res = _by_key(_detect(wf))
    assert set(res) == {"9.steps", "9.cfg", "9.mode"}
    assert res["9.steps"]["type"] == "int"
    assert res["9.cfg"]["type"] == "float"
    assert res["9.mode"]["type"] == "string"
    # multiple fields → label disambiguated by input name
    assert res["9.steps"]["label"] == "Sampler · steps"
    assert res["9.cfg"]["label"] == "Sampler · cfg"
    # bool and wired must not surface
    assert "9.add_noise" not in res
    assert "9.model" not in res


def test_bool_excluded_even_as_only_input():
    wf = {
        "1": {"class_type": "PrimitiveBoolean", "inputs": {"value": True},
              "_meta": {"title": "Enabled_ComfyGen"}},
    }
    assert _detect(wf) == []


def test_untagged_node_not_surfaced():
    wf = {
        "1": {"class_type": "PrimitiveInt", "inputs": {"value": 8},
              "_meta": {"title": "Steps"}},  # no suffix
    }
    assert _detect(wf) == []


def test_suffix_is_exact_and_case_sensitive():
    wf = {
        "1": {"class_type": "PrimitiveInt", "inputs": {"value": 1},
              "_meta": {"title": "x_comfygen"}},        # wrong case
        "2": {"class_type": "PrimitiveInt", "inputs": {"value": 2},
              "_meta": {"title": "x_ComfyGenX"}},       # not a suffix
        "3": {"class_type": "PrimitiveInt", "inputs": {"value": 3},
              "_meta": {"title": "_ComfyGen"}},          # bare suffix → strips to ""
    }
    res = _by_key(_detect(wf))
    assert "1.value" not in res
    assert "2.value" not in res
    assert "3.value" in res  # bare suffix still matches; label falls back to input name


def test_all_wired_node_surfaces_nothing():
    wf = {
        "1": {"class_type": "SomeNode", "inputs": {
            "a": ["2", 0], "b": ["3", 0],
        }, "_meta": {"title": "Thing_ComfyGen"}},
    }
    assert _detect(wf) == []


# ---- Authoritative typing via object_info map + title hints (sgs-ui-xaqf) ----


def test_whole_number_float_typed_via_object_info_map():
    """The core bug: ModelSamplingSD3.shift is FLOAT but ComfyUI saves the
    whole-number value as bare `5` (a JSON int). The static type map must type
    it float so the UI allows decimals."""
    wf = {
        "292": {"class_type": "ModelSamplingSD3",
                "inputs": {"model": ["304", 0], "shift": 5},
                "_meta": {"title": "LowShift_ComfyGen"}},
    }
    res = _by_key(_detect(wf))
    assert "292.shift" in res
    assert res["292.shift"]["type"] == "float"     # not 'int'
    assert res["292.shift"]["current_value"] == 5
    assert res["292.shift"]["label"] == "LowShift"
    assert "292.model" not in res                  # wired, skipped


def test_int_field_stays_int_via_map():
    wf = {
        "5": {"class_type": "PrimitiveInt", "inputs": {"value": 20},
              "_meta": {"title": "Steps_ComfyGen"}},
    }
    assert _by_key(_detect(wf))["5.value"]["type"] == "int"


def test_combo_input_skipped_via_map():
    """A tagged node's enum (COMBO) inputs must NOT surface as free-text — only
    its real int/float/string inputs do. KSampler.sampler_name/scheduler are
    combos; steps/cfg are int/float."""
    wf = {
        "9": {"class_type": "KSampler", "inputs": {
            "seed": 1, "steps": 8, "cfg": 7.0, "denoise": 1.0,
            "sampler_name": "euler", "scheduler": "simple",
        }, "_meta": {"title": "Sampler_ComfyGen"}},
    }
    res = _by_key(_detect(wf))
    assert res["9.steps"]["type"] == "int"
    assert res["9.cfg"]["type"] == "float"
    assert "9.sampler_name" not in res
    assert "9.scheduler" not in res


def test_title_type_hint_forces_type_for_unknown_node():
    """A custom node not in the map: an explicit _ComfyGen_<type> hint forces
    the type and is stripped from the label."""
    wf = {
        "1": {"class_type": "TotallyCustomNode", "inputs": {"value": 5},
              "_meta": {"title": "Knob_ComfyGen_float"}},
    }
    res = _by_key(_detect(wf))
    assert res["1.value"]["type"] == "float"
    assert res["1.value"]["label"] == "Knob"       # hint stripped


def test_title_hint_overrides_object_info_map():
    """Explicit author intent beats the schema: _ComfyGen_int on a FLOAT field."""
    wf = {
        "292": {"class_type": "ModelSamplingSD3",
                "inputs": {"model": ["304", 0], "shift": 5},
                "_meta": {"title": "LowShift_ComfyGen_int"}},
    }
    assert _by_key(_detect(wf))["292.shift"]["type"] == "int"


def test_unknown_node_no_hint_falls_back_to_value_guess():
    """No map entry, no hint → legacy value-based guess (imperfect but the
    documented fallback)."""
    wf = {
        "1": {"class_type": "TotallyCustomNode",
              "inputs": {"a": 5, "b": 5.5, "c": "x"},
              "_meta": {"title": "Custom_ComfyGen"}},
    }
    res = _by_key(_detect(wf))
    assert res["1.a"]["type"] == "int"
    assert res["1.b"]["type"] == "float"
    assert res["1.c"]["type"] == "string"

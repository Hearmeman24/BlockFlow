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
    wf = {
        "9": {"class_type": "KSamplerAdvanced", "inputs": {
            "steps": 8, "cfg": 1.0, "sampler_name": "euler",
            "add_noise": True,            # bool — excluded
            "model": ["3", 0],            # wired — excluded
        }, "_meta": {"title": "Sampler_ComfyGen"}},
    }
    res = _by_key(_detect(wf))
    assert set(res) == {"9.steps", "9.cfg", "9.sampler_name"}
    assert res["9.steps"]["type"] == "int"
    assert res["9.cfg"]["type"] == "float"
    assert res["9.sampler_name"]["type"] == "string"
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

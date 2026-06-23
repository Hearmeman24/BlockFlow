"""Tests for Power Lora Loader (rgthree) detection and apply in the ComfyGen block.

Covers detection, chain ordering with mixed regular+power loaders,
_apply_power_lora_overrides mutations, add:true allocation, and error
tolerance. Regular-loader detection must be byte-for-byte unchanged.
"""
from __future__ import annotations

import copy
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

_detect = comfy_gen._detect_lora_nodes
_apply = comfy_gen._apply_power_lora_overrides


# ---------------------------------------------------------------------------
# Minimal workflow fixtures
# ---------------------------------------------------------------------------

def _single_power_node():
    """Single Power Lora Loader with one lora_1 entry (on=false)."""
    return {
        "1021": {
            "inputs": {
                "PowerLoraLoaderHeaderWidget": {"type": "PowerLoraLoaderHeaderWidget"},
                "lora_1": {"on": False, "lora": "some_lora.safetensors", "strength": 1},
                "➕ Add Lora": "",
                "model": ["883", 0],
            },
            "class_type": "Power Lora Loader (rgthree)",
            "_meta": {"title": "Segment 1 High LoRAs"},
        },
    }


def _multi_power_node():
    """Single Power Lora Loader with two lora entries."""
    return {
        "1083": {
            "inputs": {
                "PowerLoraLoaderHeaderWidget": {"type": "PowerLoraLoaderHeaderWidget"},
                "lora_1": {"on": True, "lora": "oral-insertion-high.safetensors", "strength": 1},
                "lora_2": {"on": False, "lora": "smash_cut_high.safetensors", "strength": 1},
                "➕ Add Lora": "",
                "model": ["883", 0],
            },
            "class_type": "Power Lora Loader (rgthree)",
            "_meta": {"title": "Segment 3 High LoRAs"},
        },
    }


def _regular_lora_node():
    """Standard LoraLoaderModelOnly node."""
    return {
        "881": {
            "inputs": {
                "lora_name": "base_distill.safetensors",
                "strength_model": 1.0,
                "model": ["500", 0],
            },
            "class_type": "LoraLoaderModelOnly",
            "_meta": {"title": "Base Distill"},
        },
    }


def _mixed_workflow():
    """One regular LoraLoaderModelOnly + one Power Lora Loader in the same chain."""
    return {
        "881": {
            "inputs": {
                "lora_name": "base_distill.safetensors",
                "strength_model": 1.0,
                "model": ["500", 0],
            },
            "class_type": "LoraLoaderModelOnly",
            "_meta": {"title": "Base Distill"},
        },
        "1021": {
            "inputs": {
                "PowerLoraLoaderHeaderWidget": {"type": "PowerLoraLoaderHeaderWidget"},
                "lora_1": {"on": True, "lora": "power_lora.safetensors", "strength": 0.8},
                "➕ Add Lora": "",
                "model": ["881", 0],  # feeds from regular lora
            },
            "class_type": "Power Lora Loader (rgthree)",
            "_meta": {"title": "Power LoRAs"},
        },
    }


# ---------------------------------------------------------------------------
# Detection tests
# ---------------------------------------------------------------------------

class TestDetectSinglePowerNode:
    def test_single_lora_1_yields_one_row(self):
        rows = _detect(_single_power_node())
        assert len(rows) == 1

    def test_row_fields(self):
        row = _detect(_single_power_node())[0]
        assert row["node_id"] == "1021"
        assert row["lora_key"] == "lora_1"
        assert row["class_type"] == "Power Lora Loader (rgthree)"
        assert row["label"] == "Segment 1 High LoRAs"
        assert row["lora_name"] == "some_lora.safetensors"
        assert row["strength_model"] == 1.0
        assert row["on"] is False
        assert row["is_power"] is True
        assert "chain_id" in row

    def test_on_true_preserved(self):
        wf = _single_power_node()
        wf["1021"]["inputs"]["lora_1"]["on"] = True
        row = _detect(wf)[0]
        assert row["on"] is True


class TestDetectMultiPowerNode:
    def test_two_loras_yield_two_rows(self):
        rows = _detect(_multi_power_node())
        assert len(rows) == 2

    def test_lora_keys_and_names(self):
        rows = _detect(_multi_power_node())
        by_key = {r["lora_key"]: r for r in rows}
        assert "lora_1" in by_key
        assert "lora_2" in by_key
        assert by_key["lora_1"]["on"] is True
        assert by_key["lora_2"]["on"] is False
        assert by_key["lora_1"]["lora_name"] == "oral-insertion-high.safetensors"
        assert by_key["lora_2"]["lora_name"] == "smash_cut_high.safetensors"

    def test_same_chain_id_for_same_node(self):
        rows = _detect(_multi_power_node())
        assert rows[0]["chain_id"] == rows[1]["chain_id"]

    def test_same_node_id_for_both_rows(self):
        rows = _detect(_multi_power_node())
        assert all(r["node_id"] == "1083" for r in rows)


class TestDetectMixedWorkflow:
    def test_regular_and_power_both_detected(self):
        rows = _detect(_mixed_workflow())
        class_types = {r["class_type"] for r in rows}
        assert "LoraLoaderModelOnly" in class_types
        assert "Power Lora Loader (rgthree)" in class_types

    def test_regular_row_has_no_is_power(self):
        rows = _detect(_mixed_workflow())
        reg = next(r for r in rows if r["class_type"] == "LoraLoaderModelOnly")
        assert reg.get("is_power") is not True

    def test_power_row_is_power_true(self):
        rows = _detect(_mixed_workflow())
        power = next(r for r in rows if r["class_type"] == "Power Lora Loader (rgthree)")
        assert power["is_power"] is True

    def test_chain_ordering_regular_before_power(self):
        """Regular LoRA feeds model into Power LoRA — regular must come first."""
        rows = _detect(_mixed_workflow())
        reg_idx = next(i for i, r in enumerate(rows) if r["class_type"] == "LoraLoaderModelOnly")
        pow_idx = next(i for i, r in enumerate(rows) if r["class_type"] == "Power Lora Loader (rgthree)")
        assert reg_idx < pow_idx


class TestDetectRegularLoaderUnchanged:
    """Regular LoraLoader/LoraLoaderModelOnly behavior must be byte-for-byte unchanged."""

    def test_regular_loader_fields(self):
        rows = _detect(_regular_lora_node())
        assert len(rows) == 1
        r = rows[0]
        assert r["node_id"] == "881"
        assert r["class_type"] == "LoraLoaderModelOnly"
        assert r["lora_name"] == "base_distill.safetensors"
        assert r["strength_model"] == 1.0
        assert "is_power" not in r or r.get("is_power") is not True

    def test_power_nodes_do_not_add_extra_fields_to_regular(self):
        """Regular rows must never have lora_key or is_power."""
        wf = {**_regular_lora_node(), **_single_power_node()}
        rows = _detect(wf)
        reg = next(r for r in rows if r["class_type"] == "LoraLoaderModelOnly")
        assert "lora_key" not in reg


class TestDetectMalformed:
    def test_non_dict_lora_n_value_skipped(self):
        """A lora_N whose value is not a dict (wired as [node, port]) is not emitted."""
        wf = {
            "99": {
                "inputs": {
                    "lora_1": ["883", 0],  # wired, not a dict
                    "model": ["500", 0],
                },
                "class_type": "Power Lora Loader (rgthree)",
                "_meta": {"title": "Wired Only"},
            },
        }
        rows = _detect(wf)
        power = [r for r in rows if r.get("is_power")]
        assert len(power) == 0

    def test_lora_n_without_lora_field_skipped(self):
        """A lora_N dict that doesn't have the expected {lora, strength, on} keys is skipped."""
        wf = {
            "99": {
                "inputs": {
                    "lora_1": {"something_else": "foo"},
                    "model": ["500", 0],
                },
                "class_type": "Power Lora Loader (rgthree)",
                "_meta": {"title": "Bad Fields"},
            },
        }
        rows = _detect(wf)
        power = [r for r in rows if r.get("is_power")]
        assert len(power) == 0

    def test_power_header_widget_not_emitted(self):
        """PowerLoraLoaderHeaderWidget key must not produce a row."""
        rows = _detect(_single_power_node())
        keys = [r.get("lora_key") for r in rows]
        assert "PowerLoraLoaderHeaderWidget" not in keys


# ---------------------------------------------------------------------------
# Apply tests
# ---------------------------------------------------------------------------

class TestApplyMutateStrengthAndOn:
    def test_apply_changes_strength(self):
        wf = copy.deepcopy(_single_power_node())
        entries = [{"node_id": "1021", "lora_key": "lora_1", "on": True,
                    "lora": "some_lora.safetensors", "strength": 0.7}]
        result = _apply(wf, entries)
        assert result["1021"]["inputs"]["lora_1"]["strength"] == 0.7

    def test_apply_changes_on_to_false(self):
        wf = copy.deepcopy(_single_power_node())
        wf["1021"]["inputs"]["lora_1"]["on"] = True
        entries = [{"node_id": "1021", "lora_key": "lora_1", "on": False,
                    "lora": "some_lora.safetensors", "strength": 1}]
        result = _apply(wf, entries)
        assert result["1021"]["inputs"]["lora_1"]["on"] is False

    def test_apply_changes_lora_name(self):
        wf = copy.deepcopy(_single_power_node())
        entries = [{"node_id": "1021", "lora_key": "lora_1", "on": True,
                    "lora": "new_lora.safetensors", "strength": 1}]
        result = _apply(wf, entries)
        assert result["1021"]["inputs"]["lora_1"]["lora"] == "new_lora.safetensors"

    def test_apply_preserves_other_keys_in_lora_dict(self):
        """Extra keys in the lora_N dict (if any) should survive the mutation."""
        wf = copy.deepcopy(_single_power_node())
        wf["1021"]["inputs"]["lora_1"]["extra_key"] = "preserved"
        entries = [{"node_id": "1021", "lora_key": "lora_1", "on": True,
                    "lora": "some_lora.safetensors", "strength": 0.5}]
        result = _apply(wf, entries)
        assert result["1021"]["inputs"]["lora_1"]["extra_key"] == "preserved"
        assert result["1021"]["inputs"]["lora_1"]["strength"] == 0.5

    def test_apply_multi_entries_same_node(self):
        wf = copy.deepcopy(_multi_power_node())
        entries = [
            {"node_id": "1083", "lora_key": "lora_1", "on": False,
             "lora": "oral-insertion-high.safetensors", "strength": 0.6},
            {"node_id": "1083", "lora_key": "lora_2", "on": True,
             "lora": "smash_cut_high.safetensors", "strength": 0.9},
        ]
        result = _apply(wf, entries)
        assert result["1083"]["inputs"]["lora_1"]["on"] is False
        assert result["1083"]["inputs"]["lora_1"]["strength"] == 0.6
        assert result["1083"]["inputs"]["lora_2"]["on"] is True
        assert result["1083"]["inputs"]["lora_2"]["strength"] == 0.9


class TestApplyAdd:
    def test_add_allocates_lora_2_when_only_lora_1_exists(self):
        wf = copy.deepcopy(_single_power_node())
        entries = [{"node_id": "1021", "lora_key": "lora_2", "on": True,
                    "lora": "new.safetensors", "strength": 1, "add": True}]
        result = _apply(wf, entries)
        assert "lora_2" in result["1021"]["inputs"]
        lora_2 = result["1021"]["inputs"]["lora_2"]
        assert lora_2["on"] is True
        assert lora_2["lora"] == "new.safetensors"
        assert lora_2["strength"] == 1

    def test_add_allocates_lora_3_when_lora_1_and_2_exist(self):
        wf = copy.deepcopy(_multi_power_node())
        entries = [{"node_id": "1083", "lora_key": "lora_3", "on": True,
                    "lora": "third.safetensors", "strength": 0.5, "add": True}]
        result = _apply(wf, entries)
        assert "lora_3" in result["1083"]["inputs"]
        assert result["1083"]["inputs"]["lora_3"]["lora"] == "third.safetensors"

    def test_add_does_not_clobber_existing_lora(self):
        """Add with a key that already exists should NOT overwrite it."""
        wf = copy.deepcopy(_single_power_node())
        original_lora = wf["1021"]["inputs"]["lora_1"]["lora"]
        entries = [{"node_id": "1021", "lora_key": "lora_1", "on": True,
                    "lora": "intruder.safetensors", "strength": 1, "add": True}]
        result = _apply(wf, entries)
        # existing lora_1 must not be overwritten by add
        assert result["1021"]["inputs"]["lora_1"]["lora"] == original_lora


class TestDetectNonNumericStrength:
    """Regression guard for the medium finding: non-numeric strength must not
    crash detection and make the entire workflow unloadable (sgs-ui-67rq fix)."""

    def test_string_strength_defaults_to_one(self):
        """A 'strength': 'high' value must not raise; row still emitted with 1.0."""
        wf = {
            "1021": {
                "inputs": {
                    "lora_1": {"on": True, "lora": "a.safetensors", "strength": "high"},
                    "model": ["883", 0],
                },
                "class_type": "Power Lora Loader (rgthree)",
                "_meta": {"title": "LoRAs"},
            },
        }
        rows = [r for r in _detect(wf) if r.get("is_power")]
        assert len(rows) == 1
        assert rows[0]["strength_model"] == 1.0

    def test_wired_strength_defaults_to_one(self):
        """A 'strength': [node, port] ref must not raise; defaults to 1.0."""
        wf = {
            "1021": {
                "inputs": {
                    "lora_1": {"on": True, "lora": "a.safetensors", "strength": ["999", 0]},
                    "model": ["883", 0],
                },
                "class_type": "Power Lora Loader (rgthree)",
                "_meta": {"title": "LoRAs"},
            },
        }
        rows = [r for r in _detect(wf) if r.get("is_power")]
        assert len(rows) == 1
        assert rows[0]["strength_model"] == 1.0

    def test_bad_strength_in_power_node_does_not_prevent_regular_lora_detection(self):
        """A power node with bad strength must not crash the whole workflow parse;
        regular LoRA nodes in the same workflow must still be detected."""
        wf = {
            "881": {
                "inputs": {"lora_name": "base.safetensors", "strength_model": 1.0,
                           "model": ["500", 0]},
                "class_type": "LoraLoaderModelOnly",
                "_meta": {"title": "Base"},
            },
            "1021": {
                "inputs": {
                    "lora_1": {"on": True, "lora": "a.safetensors", "strength": "broken"},
                    "model": ["881", 0],
                },
                "class_type": "Power Lora Loader (rgthree)",
                "_meta": {"title": "Power LoRAs"},
            },
        }
        rows = _detect(wf)  # must not raise
        regular = [r for r in rows if r["class_type"] == "LoraLoaderModelOnly"]
        assert len(regular) == 1
        assert regular[0]["lora_name"] == "base.safetensors"
        power = [r for r in rows if r.get("is_power")]
        assert len(power) == 1
        assert power[0]["strength_model"] == 1.0


class TestApplyAddCollisionReallocates:
    """Regression guard for the low finding: add:true on a colliding key must
    reallocate to the next free lora_N index rather than silently dropping (sgs-ui-67rq fix)."""

    def test_add_collision_with_undetected_slot_reallocates(self):
        """A lora_N with no 'lora' field escapes detection but occupies the slot.
        An add:true targeting that slot must reallocate rather than vanish."""
        wf = copy.deepcopy(_single_power_node())
        # Plant a lora_2 with no 'lora' field — invisible to _detect
        wf["1021"]["inputs"]["lora_2"] = {"on": True, "strength": 1}
        detected_keys = [r["lora_key"] for r in _detect(wf) if r.get("is_power")]
        assert detected_keys == ["lora_1"]  # lora_2 invisible

        # Frontend computed maxN=1 and sends lora_2 as the new key — collision
        entries = [{"node_id": "1021", "lora_key": "lora_2", "on": True,
                    "lora": "user_added.safetensors", "strength": 1.0, "add": True}]
        result = _apply(copy.deepcopy(wf), entries)

        # user_added must land somewhere (reallocated, not dropped)
        lora_dicts = {k: v for k, v in result["1021"]["inputs"].items()
                      if k.startswith("lora_") and isinstance(v, dict)}
        assert any(v.get("lora") == "user_added.safetensors" for v in lora_dicts.values())
        # the occupying lora_2 must remain untouched
        assert result["1021"]["inputs"]["lora_2"] == {"on": True, "strength": 1}

    def test_add_collision_with_detected_slot_reallocates_to_next(self):
        """Collision with a normally-detected lora_1: must land on lora_2, not drop."""
        wf = copy.deepcopy(_single_power_node())
        original_lora = wf["1021"]["inputs"]["lora_1"]["lora"]

        entries = [{"node_id": "1021", "lora_key": "lora_1", "on": True,
                    "lora": "new.safetensors", "strength": 1.0, "add": True}]
        result = _apply(copy.deepcopy(wf), entries)

        # existing lora_1 must be intact
        assert result["1021"]["inputs"]["lora_1"]["lora"] == original_lora
        # new entry must land on lora_2
        assert "lora_2" in result["1021"]["inputs"]
        assert result["1021"]["inputs"]["lora_2"]["lora"] == "new.safetensors"


class TestApplyErrorTolerance:
    def test_missing_node_id_skipped(self):
        wf = copy.deepcopy(_single_power_node())
        entries = [{"node_id": "9999", "lora_key": "lora_1", "on": True,
                    "lora": "x.safetensors", "strength": 1}]
        result = _apply(wf, entries)
        # original node unchanged
        assert result["1021"]["inputs"]["lora_1"]["on"] is False

    def test_non_power_node_skipped(self):
        """Apply must not mutate a regular LoraLoader node."""
        wf = {
            "881": {
                "inputs": {"lora_name": "base.safetensors", "strength_model": 1.0,
                           "model": ["500", 0]},
                "class_type": "LoraLoaderModelOnly",
                "_meta": {"title": "Base"},
            },
        }
        entries = [{"node_id": "881", "lora_key": "lora_1", "on": False,
                    "lora": "x.safetensors", "strength": 0.5}]
        result = _apply(wf, entries)
        # inputs unchanged — no lora_1 key created
        assert "lora_1" not in result["881"]["inputs"]

    def test_empty_entries_returns_unchanged_workflow(self):
        wf = copy.deepcopy(_single_power_node())
        result = _apply(wf, [])
        assert result == wf

    def test_apply_returns_same_dict_object(self):
        """_apply mutates in place and returns the same workflow dict."""
        wf = copy.deepcopy(_single_power_node())
        entries = [{"node_id": "1021", "lora_key": "lora_1", "on": True,
                    "lora": "some_lora.safetensors", "strength": 0.5}]
        result = _apply(wf, entries)
        assert result is wf

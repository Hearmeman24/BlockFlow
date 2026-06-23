"""Adversarial attack tests for Power Lora Loader (rgthree) support.

These probe the load-bearing constraints the spec/implementation claim to hold:
no leak into --override, in-place mutation correctness, add allocation against
gaps and undetected entries, detection edge cases, float fidelity, and on:false
round-trips. Separate file from the author's tests by design.
"""
from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location(
    "comfy_gen_block_attack", ROOT / "custom_blocks" / "comfy_gen" / "backend.block.py"
)
comfy_gen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(comfy_gen)

_detect = comfy_gen._detect_lora_nodes
_apply = comfy_gen._apply_power_lora_overrides
POWER = comfy_gen._POWER_LORA_CLASS_TYPE


def _power_node(node_id, loras, model_src="883"):
    inputs = {
        "PowerLoraLoaderHeaderWidget": {"type": "PowerLoraLoaderHeaderWidget"},
        "➕ Add Lora": "",
        "model": [model_src, 0],
    }
    inputs.update(loras)
    return {node_id: {"class_type": POWER, "inputs": inputs}}


# ---------------------------------------------------------------------------
# Surface 3 — add allocation against an UNDETECTED lora_N (silent overwrite)
# ---------------------------------------------------------------------------

def test_add_collision_reallocates_to_next_free_index():
    """FIXED (was latent low sev): `_apply` used to drop an add:true entry when
    its lora_key already existed (silent no-op). The frontend computes the next
    lora_N index from detected rows only — a lora_N with no 'lora' field escapes
    detection, occupies a slot, and causes a collision. Now _apply reallocates to
    the next free lora_N index rather than dropping the entry silently."""
    wf = _power_node("1021", {
        "lora_1": {"on": True, "lora": "real.safetensors", "strength": 1},
        # lora_2 has no 'lora' field -> undetected, but occupies the lora_2 slot
        "lora_2": {"on": True, "strength": 1},
    })
    detected = [r for r in _detect(wf) if r.get("is_power")]
    assert [r["lora_key"] for r in detected] == ["lora_1"]  # lora_2 invisible

    add_entry = {"node_id": "1021", "lora_key": "lora_2",
                 "on": True, "lora": "user_added.safetensors", "strength": 1.0, "add": True}
    out = _apply(copy.deepcopy(wf), [add_entry])
    loras = {k: v for k, v in out["1021"]["inputs"].items()
             if k.startswith("lora_") and isinstance(v, dict)}
    # user_added must land somewhere (reallocated to lora_3, the next free slot)
    assert any(v.get("lora") == "user_added.safetensors" for v in loras.values())
    # the undetected lora_2 (no 'lora' field) must be untouched
    assert out["1021"]["inputs"]["lora_2"] == {"on": True, "strength": 1}


# ---------------------------------------------------------------------------
# Surface 2 — apply mutates the CALLER's dict (no deep copy inside apply)
# ---------------------------------------------------------------------------

def test_apply_mutates_in_place_by_design():
    """Documents (not a bug): _apply edits the passed workflow in place. /run
    deep-copies before calling it, so this is safe THERE. Any future caller that
    forgets to deep-copy will corrupt its input. Pinned as a known sharp edge."""
    wf = _power_node("1021", {
        "lora_1": {"on": True, "lora": "orig.safetensors", "strength": 1},
    })
    out = _apply(wf, [{"node_id": "1021", "lora_key": "lora_1",
                       "on": False, "lora": "changed.safetensors", "strength": 0.5}])
    assert out is wf  # same object
    assert wf["1021"]["inputs"]["lora_1"]["lora"] == "changed.safetensors"


# ---------------------------------------------------------------------------
# Surface 2 — editing lora_1 must not disturb lora_2; extra keys preserved
# ---------------------------------------------------------------------------

def test_edit_one_row_preserves_sibling_and_extra_keys():
    wf = _power_node("1021", {
        "lora_1": {"on": True, "lora": "a.safetensors", "strength": 1, "strengthTwo": 0.7},
        "lora_2": {"on": True, "lora": "b.safetensors", "strength": 1},
    })
    _apply(wf, [{"node_id": "1021", "lora_key": "lora_1",
                 "on": False, "lora": "a.safetensors", "strength": 0.5}])
    # sibling untouched
    assert wf["1021"]["inputs"]["lora_2"] == {"on": True, "lora": "b.safetensors", "strength": 1}
    # extra rgthree key preserved
    assert wf["1021"]["inputs"]["lora_1"].get("strengthTwo") == 0.7
    assert wf["1021"]["inputs"]["lora_1"]["on"] is False
    assert wf["1021"]["inputs"]["lora_1"]["strength"] == 0.5


# ---------------------------------------------------------------------------
# Surface 4 — malformed (non-numeric) strength CRASHES the whole parse.
# The regular-loader path guards with isinstance(sm, (int, float)); the power
# path calls round(float(...)) unconditionally, so one bad node takes down
# detection for the ENTIRE workflow (every block, every node).
# ---------------------------------------------------------------------------

def test_non_numeric_strength_defaults_to_one():
    """FIXED (was medium finding): a power lora_N with a non-numeric strength used
    to raise ValueError out of _detect_lora_nodes, making the ENTIRE workflow
    unloadable. Now the bad value is skipped/defaulted to 1.0 (mirrors the regular
    LoraLoader path which guards with isinstance). The row must still be detected."""
    wf = _power_node("1021", {
        "lora_1": {"on": True, "lora": "a.safetensors", "strength": "high"},
    })
    rows = [r for r in _detect(wf) if r.get("is_power")]
    assert len(rows) == 1
    assert rows[0]["strength_model"] == 1.0


def test_strength_as_node_ref_defaults_to_one():
    """FIXED: rgthree can carry a wired/list value; used to raise TypeError.
    Now defaults to 1.0 and the row is still emitted."""
    wf = _power_node("1021", {
        "lora_1": {"on": True, "lora": "a.safetensors", "strength": ["999", 0]},
    })
    rows = [r for r in _detect(wf) if r.get("is_power")]
    assert len(rows) == 1
    assert rows[0]["strength_model"] == 1.0


# ---------------------------------------------------------------------------
# Surface 7 — float strength fidelity through detect
# ---------------------------------------------------------------------------

def test_float_strength_not_coerced_to_int():
    wf = _power_node("1021", {
        "lora_1": {"on": True, "lora": "a.safetensors", "strength": 1.5},
        "lora_2": {"on": True, "lora": "b.safetensors", "strength": 0.8},
    })
    rows = {r["lora_key"]: r for r in _detect(wf) if r.get("is_power")}
    assert rows["lora_1"]["strength_model"] == 1.5
    assert rows["lora_2"]["strength_model"] == 0.8


# ---------------------------------------------------------------------------
# Surface 4 — on:false entry is detected (so user can re-enable)
# ---------------------------------------------------------------------------

def test_disabled_entry_still_detected():
    wf = _power_node("1021", {
        "lora_1": {"on": False, "lora": "a.safetensors", "strength": 1},
    })
    rows = [r for r in _detect(wf) if r.get("is_power")]
    assert len(rows) == 1
    assert rows[0]["on"] is False


def test_on_false_roundtrips_through_apply():
    wf = _power_node("1021", {
        "lora_1": {"on": True, "lora": "a.safetensors", "strength": 1},
    })
    _apply(wf, [{"node_id": "1021", "lora_key": "lora_1",
                 "on": False, "lora": "a.safetensors", "strength": 1}])
    assert wf["1021"]["inputs"]["lora_1"]["on"] is False
    # not dropped
    assert "lora_1" in wf["1021"]["inputs"]


# ---------------------------------------------------------------------------
# Surface 4 — 'on' absent: default True
# ---------------------------------------------------------------------------

def test_on_absent_defaults_true():
    wf = _power_node("1021", {
        "lora_1": {"lora": "a.safetensors", "strength": 1},
    })
    rows = [r for r in _detect(wf) if r.get("is_power")]
    assert rows[0]["on"] is True


# ---------------------------------------------------------------------------
# Surface 4 — widget keys must not become rows
# ---------------------------------------------------------------------------

def test_header_widget_and_add_lora_not_rows():
    wf = _power_node("1021", {
        "lora_1": {"on": True, "lora": "a.safetensors", "strength": 1},
    })
    rows = [r for r in _detect(wf) if r.get("is_power")]
    assert [r["lora_key"] for r in rows] == ["lora_1"]


# ---------------------------------------------------------------------------
# Surface 3 — string-sort vs numeric ordering for lora_10+
# ---------------------------------------------------------------------------

def test_detection_orders_lora_10_after_lora_9():
    loras = {f"lora_{i}": {"on": True, "lora": f"l{i}.safetensors", "strength": 1}
             for i in range(1, 11)}
    wf = _power_node("1021", loras)
    rows = [r for r in _detect(wf) if r.get("is_power")]
    keys = [r["lora_key"] for r in rows]
    assert keys == [f"lora_{i}" for i in range(1, 11)], keys


# ---------------------------------------------------------------------------
# Surface 1 — apply must IGNORE entries targeting a non-power node
# (defense: a corrupted entry pointed at a regular LoraLoader must not mutate it)
# ---------------------------------------------------------------------------

def test_apply_ignores_non_power_node():
    wf = {
        "5": {"class_type": "LoraLoader",
              "inputs": {"lora_name": "x.safetensors", "strength_model": 1.0}},
    }
    before = copy.deepcopy(wf)
    _apply(wf, [{"node_id": "5", "lora_key": "lora_1",
                 "on": True, "lora": "evil.safetensors", "strength": 1}])
    assert wf == before


# ---------------------------------------------------------------------------
# Surface 5 — mixed chain: regular -> power -> regular ordering
# ---------------------------------------------------------------------------

def test_mixed_chain_ordering_and_chain_id():
    wf = {
        "A": {"class_type": "LoraLoaderModelOnly",
              "inputs": {"lora_name": "a.safetensors", "strength_model": 1.0,
                         "model": ["100", 0]}},
        "B": {"class_type": POWER,
              "inputs": {"lora_1": {"on": True, "lora": "b1.safetensors", "strength": 1},
                         "lora_2": {"on": True, "lora": "b2.safetensors", "strength": 1},
                         "model": ["A", 0]}},
        "C": {"class_type": "LoraLoader",
              "inputs": {"lora_name": "c.safetensors", "strength_model": 1.0,
                         "strength_clip": 1.0, "model": ["B", 0]}},
    }
    rows = _detect(wf)
    order = [(r.get("node_id"), r.get("lora_key")) for r in rows]
    assert order == [("A", None), ("B", "lora_1"), ("B", "lora_2"), ("C", None)], order
    # all in one chain
    assert len({r["chain_id"] for r in rows}) == 1


# ---------------------------------------------------------------------------
# Surface 3 — add allocation with a GAP (lora_1, lora_3 present)
# The author's frontend allocates maxN+1. Backend just needs to not overwrite.
# Probe the backend directly with a colliding add to confirm the drop behavior.
# ---------------------------------------------------------------------------

def test_add_with_gap_backend_drops_on_collision():
    """lora_1 and lora_3 exist (gap at lora_2). Frontend maxN = 3 -> new lora_4,
    fine. But if any path computes lora_2 (the gap) as 'next', backend drops it.
    This pins the backend's silent-drop-on-collision behavior as a hazard."""
    wf = _power_node("1021", {
        "lora_1": {"on": True, "lora": "a.safetensors", "strength": 1},
        "lora_3": {"on": True, "lora": "c.safetensors", "strength": 1},
    })
    # Simulate a naive 'fill the gap' add at lora_2 (non-colliding) -> should land
    out = _apply(copy.deepcopy(wf), [{"node_id": "1021", "lora_key": "lora_2",
                 "on": True, "lora": "added.safetensors", "strength": 1, "add": True}])
    assert out["1021"]["inputs"]["lora_2"]["lora"] == "added.safetensors"


# ===========================================================================
# Second-round attacks on the REALLOCATION fix itself (fresh code).
# ===========================================================================

def test_realloc_preserves_user_strength_and_on():
    """When an add collides and reallocates, the user's strength/on must follow
    it to the new slot — not get reset to defaults."""
    wf = _power_node("1021", {
        "lora_1": {"on": True, "lora": "real.safetensors", "strength": 1},
        "lora_2": {"on": True, "strength": 1},  # undetected slot occupant
    })
    out = _apply(copy.deepcopy(wf), [{"node_id": "1021", "lora_key": "lora_2",
                 "on": False, "lora": "u.safetensors", "strength": 0.65, "add": True}])
    placed = [v for v in out["1021"]["inputs"].values()
              if isinstance(v, dict) and v.get("lora") == "u.safetensors"]
    assert len(placed) == 1
    assert placed[0]["strength"] == 0.65
    assert placed[0]["on"] is False


def test_two_colliding_adds_get_distinct_slots():
    """Two add entries in one batch that both initially collide must NOT overwrite
    each other — the second must reallocate past the first's new slot."""
    wf = _power_node("1021", {
        "lora_1": {"on": True, "lora": "a.safetensors", "strength": 1},
        "lora_2": {"on": True, "strength": 1},  # occupied, undetected
    })
    out = _apply(copy.deepcopy(wf), [
        {"node_id": "1021", "lora_key": "lora_2", "on": True, "lora": "first.safetensors", "strength": 1, "add": True},
        {"node_id": "1021", "lora_key": "lora_2", "on": True, "lora": "second.safetensors", "strength": 1, "add": True},
    ])
    placed = [v["lora"] for v in out["1021"]["inputs"].values()
              if isinstance(v, dict) and v.get("lora") in ("first.safetensors", "second.safetensors")]
    assert sorted(placed) == ["first.safetensors", "second.safetensors"], (
        f"a colliding second add overwrote the first; inputs={out['1021']['inputs']}")


def test_realloc_jumps_past_lora_10():
    """Reallocation uses int() index math, not string sort. With lora_1..lora_10
    all occupied, a colliding add must land at lora_11, not lora_2 (string '10'<'2')
    nor overwrite an existing slot."""
    loras = {f"lora_{i}": {"on": True, "lora": f"l{i}.safetensors", "strength": 1}
             for i in range(1, 11)}
    wf = _power_node("1021", loras)
    out = _apply(copy.deepcopy(wf), [{"node_id": "1021", "lora_key": "lora_1",
                 "on": True, "lora": "new.safetensors", "strength": 1, "add": True}])
    # No original lora_i was overwritten
    for i in range(1, 11):
        assert out["1021"]["inputs"][f"lora_{i}"]["lora"] == f"l{i}.safetensors"
    assert out["1021"]["inputs"]["lora_11"]["lora"] == "new.safetensors"


def test_apply_add_malformed_strength_still_crashes():
    """FINDING (low, residual): the _detect path now guards non-numeric strength,
    but the _apply ADD path still does float(entry.get('strength', 1.0)) unguarded.
    The frontend sends parseFloat(v)||1 so it's numeric in practice; this pins the
    asymmetry — apply is not as defensive as detect."""
    wf = _power_node("1021", {
        "lora_1": {"on": True, "lora": "a.safetensors", "strength": 1},
    })
    import pytest
    with pytest.raises((ValueError, TypeError)):
        _apply(wf, [{"node_id": "1021", "lora_key": "lora_2",
                     "on": True, "lora": "x.safetensors", "strength": "high", "add": True}])

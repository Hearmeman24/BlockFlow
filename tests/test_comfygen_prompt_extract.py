"""Prompt extraction for embedded artifact metadata.

A manual prompt typed into a "Text String (Multiline)" node whose input field
is `value` (not `text`) was lost from the embedded sgs_meta because the
fallback only harvested overrides ending in `.text`. Detection (_is_text_input)
already accepts `value`/prose fields, so extraction must agree — otherwise the
prompt never reaches the artifacts page.
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

_extract = comfy_gen._extract_override_prompt

PROMPT = ("blouse, casually sitting with an Apple MacBook on her lap, she appears "
          "focused on the laptop, visible office open space in the background")


def test_text_override_wins_over_returned_prompt():
    # The override is THIS job's submitted prompt; comfy-gen's returned prompt is the
    # shared workflow text (identical across a batch). The override must win.
    assert _extract({"prompt": "from comfy-gen"}, {"6.value": PROMPT}) == PROMPT


def test_returned_prompt_used_when_no_text_override():
    # No text override (prompt baked into the workflow) → fall back to the returned one.
    assert _extract({"prompt": "from comfy-gen"}, {"2.steps": "8"}) == "from comfy-gen"


def test_batch_jobs_get_their_own_prompt_despite_shared_returned():
    # Two jobs, SAME returned prompt (shared workflow JSON), DIFFERENT overrides.
    # Each must resolve to its own submitted prompt, not the shared one.
    shared = {"prompt": "workflow default"}
    assert _extract(shared, {"6.text": "a red fox"}) == "a red fox"
    assert _extract(shared, {"6.text": "a blue whale"}) == "a blue whale"


def test_manual_value_field_is_extracted():
    # The reported bug: field is `value`, not `text`.
    assert _extract({}, {"6.value": PROMPT, "2.steps": "8", "2.cfg": "1"}) == PROMPT


def test_text_field_still_extracted():
    assert _extract({}, {"65.text": PROMPT}) == PROMPT


def test_prefers_longest_prose_over_short_config():
    overrides = {
        "16.lora_name": "FemNude_krea2_epoch10.safetensors",
        "2.sampler_name": "res_3s",
        "6.value": PROMPT,
    }
    assert _extract({}, overrides) == PROMPT


def test_no_text_overrides_returns_empty():
    assert _extract({}, {"2.steps": "8", "10.width": "1224"}) == ""

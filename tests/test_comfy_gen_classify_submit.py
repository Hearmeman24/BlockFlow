"""Tests for `_classify_submit_stdout` — the unified parse+classify helper.

Audit item A.1.5 (sgs-ui-h1c.1.2): two parallel error-handling code paths
in `_run_comfy_job` (one inside rc!=0, one inside rc==0) get unified
through a single classifier that runs on stdout regardless of returncode.

Classification kinds:
  - success         : valid JSON, no error_type
  - missing_models  : error_type == "missing_models" (the well-known case)
  - structured_error: any other error_type set
  - parse_failure   : stdout was non-empty but not valid JSON dict
  - empty           : stdout was empty / whitespace-only

The helper returns a SubmitResult dataclass; the caller decides the FAIL
message + whether to consult returncode.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from fakes import comfy_gen as fakes  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "comfy_gen_block_classify",
    ROOT / "custom_blocks" / "comfy_gen" / "backend.block.py",
)
mod = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = mod  # required so @dataclass can resolve cls.__module__
_spec.loader.exec_module(mod)


# ---- success ---------------------------------------------------------------

def test_classify_success_with_output_url():
    proc = fakes.submit_proc(output_url="https://s3/x.mp4", output_extras={"seed": 42})
    r = mod._classify_submit_stdout(proc.stdout.read())
    assert r.kind == "success"
    assert r.parsed["output"]["url"] == "https://s3/x.mp4"
    assert r.parsed["output"]["seed"] == 42


def test_classify_success_with_extra_top_level_fields():
    """job_id at top level, plus normal output — still classified as success."""
    proc = fakes.submit_proc(
        output_url="https://s3/y.png",
        extra_fields={"job_id": "rp_xyz"},
    )
    r = mod._classify_submit_stdout(proc.stdout.read())
    assert r.kind == "success"
    assert r.parsed["job_id"] == "rp_xyz"


# ---- missing_models --------------------------------------------------------

def test_classify_missing_models_on_rc_nonzero():
    """The original audit-flagged case: rc=1 + structured missing_models JSON.
    Helper is exit-code-agnostic; caller decides what to do."""
    proc = fakes.submit_proc(
        missing_models=[
            {"filename": "wan2.2.safetensors", "class_type": "LoraLoader"},
            {"filename": "vae.pt", "class_type": "VAELoader"},
        ],
        error_message="2 models missing on volume",
        returncode=1,
    )
    r = mod._classify_submit_stdout(proc.stdout.read())
    assert r.kind == "missing_models"
    assert len(r.missing_models) == 2
    assert r.missing_models[0]["filename"] == "wan2.2.safetensors"
    assert r.error_message == "2 models missing on volume"


def test_classify_missing_models_on_rc_zero():
    """Audit option (b): worker could exit 0 with structured missing_models
    (since it's "data, not crashes"). Helper handles it the same way."""
    proc = fakes.submit_proc(
        missing_models=[{"filename": "a.safetensors", "class_type": "LoraLoader"}],
        returncode=0,
    )
    r = mod._classify_submit_stdout(proc.stdout.read())
    assert r.kind == "missing_models"
    assert len(r.missing_models) == 1


def test_classify_missing_models_nested_under_output():
    """Some worker paths emit missing_models under `output.missing_models`
    instead of top-level (the audit specifically calls this out at A.1.4).
    Helper handles both locations."""
    import json
    payload = {
        "output": {
            "error_type": "missing_models",
            "missing_models": [{"filename": "x.pt", "class_type": "VAELoader"}],
            "error_message": "x.pt missing",
        }
    }
    r = mod._classify_submit_stdout(json.dumps(payload))
    assert r.kind == "missing_models"
    assert r.missing_models[0]["filename"] == "x.pt"
    assert r.error_message == "x.pt missing"


def test_classify_missing_models_with_default_message():
    proc = fakes.submit_proc(
        missing_models=[{"filename": "x.pt", "class_type": "VAELoader"}],
    )
    r = mod._classify_submit_stdout(proc.stdout.read())
    assert r.error_message  # non-empty default


# ---- structured_error (any other error_type) -------------------------------

def test_classify_structured_error_unknown_type():
    """Forward-compat: worker may later emit error_types like
    'validation_failed', 'workflow_error', etc. Helper surfaces them
    without losing the structured shape."""
    proc = fakes.submit_proc(
        error_type="validation_failed",
        error_message="Node 7 required input missing: prompt",
        returncode=1,
    )
    r = mod._classify_submit_stdout(proc.stdout.read())
    assert r.kind == "structured_error"
    assert r.error_type == "validation_failed"
    assert r.error_message == "Node 7 required input missing: prompt"


def test_classify_structured_error_falls_back_to_error_type_as_message():
    """If worker emits error_type without error_message, the caller still
    has something readable to display."""
    proc = fakes.submit_proc(error_type="worker_oom", returncode=1)
    r = mod._classify_submit_stdout(proc.stdout.read())
    assert r.kind == "structured_error"
    assert r.error_type == "worker_oom"
    assert "worker_oom" in r.error_message


# ---- parse_failure ---------------------------------------------------------

def test_classify_invalid_json_on_rc_nonzero():
    """Worker crashed mid-write or printed Python traceback — common
    real-world non-zero exit shape."""
    r = mod._classify_submit_stdout(
        "Traceback (most recent call last):\n  File ..."
    )
    assert r.kind == "parse_failure"
    assert "Traceback" in r.raw


def test_classify_json_array_treated_as_parse_failure():
    """Bare arrays / scalars aren't a valid result envelope."""
    r = mod._classify_submit_stdout("[1, 2, 3]")
    assert r.kind == "parse_failure"


def test_classify_json_scalar_treated_as_parse_failure():
    r = mod._classify_submit_stdout('"just a string"')
    assert r.kind == "parse_failure"


# ---- empty -----------------------------------------------------------------

def test_classify_empty_stdout():
    r = mod._classify_submit_stdout("")
    assert r.kind == "empty"


def test_classify_whitespace_only_stdout():
    r = mod._classify_submit_stdout("   \n  \n")
    assert r.kind == "empty"

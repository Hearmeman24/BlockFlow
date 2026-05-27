"""Smoke + contract tests for tests/fakes/comfy_gen.py.

These tests verify the harness itself behaves the way the rest of the
suite assumes — and, critically, that `progress_line()` produces output
that BlockFlow's real `_PROGRESS_RE` parser accepts. If the format ever
drifts on either side, the contract test here flags it before any
downstream test starts mysteriously passing on wrong data.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from fakes import comfy_gen as fakes  # noqa: E402

# Load the real backend.block.py so we can compare against its
# _PROGRESS_RE and _parse_progress_line — anchoring the contract test.
_spec = importlib.util.spec_from_file_location(
    "comfy_gen_block_for_fakes",
    ROOT / "custom_blocks" / "comfy_gen" / "backend.block.py",
)
real_block = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(real_block)


# ---- Contract tests: harness output must match real parsers ----------------

@pytest.mark.parametrize("stage,elapsed,i,n,detail", [
    ("inference", 258, 33, 57, "KSampler Step 1/4 (38%"),
    ("loading", 5, 1, 1, "Loading model"),
    ("inference", 100, 0, 10, ""),
    ("upload", 999, 5, 5, "Uploading inputs"),
])
def test_progress_line_matches_real_PROGRESS_RE(stage, elapsed, i, n, detail):
    line = fakes.progress_line(stage, elapsed, i, n, detail).rstrip("\n")
    m = real_block._PROGRESS_RE.match(line)
    assert m is not None, f"_PROGRESS_RE rejected: {line!r}"
    g_elapsed, g_stage, g_done, g_total, g_detail = m.groups()
    assert g_stage == stage
    assert int(g_elapsed) == elapsed
    assert int(g_done) == i
    assert int(g_total) == n
    assert g_detail.strip() == detail.strip()


def test_progress_line_parses_via_real_parser():
    """End-to-end: line through real _parse_progress_line produces the
    structured dict BlockFlow downstream relies on."""
    line = fakes.progress_line("inference", 100, 3, 10, "KSampler Step 2/4 (50%")
    result = real_block._parse_progress_line(line)
    assert result is not None
    assert result["progress_stage"] == "inference"
    assert result["progress_node"] == 3
    assert result["progress_node_total"] == 10
    assert result["progress_percent"] == 30
    assert result["progress_step"] == 2
    assert result["progress_total_steps"] == 4


def test_submitted_line_matches_real_regex():
    """`Job submitted: <id>` line is parsed by an inline regex at
    backend.block.py:1252 — verify our emitter produces a matching line."""
    import re
    line = fakes.submitted_line("rp_abc123").rstrip("\n")
    m = re.search(r"Job submitted:\s*(\S+)", line)
    assert m is not None
    assert m.group(1) == "rp_abc123"


# ---- submit_proc smoke -----------------------------------------------------

def test_submit_proc_success_shape():
    proc = fakes.submit_proc(
        output_url="https://s3/x.mp4",
        output_extras={"width": 768},
        remote_job_id="rp_job_99",
        stderr_lines=[
            fakes.progress_line("inference", 10, 1, 4, "KSampler Step 1/4 (25%"),
        ],
    )
    assert proc.returncode == 0
    body = json.loads(proc.stdout.read())
    assert body["output"]["url"] == "https://s3/x.mp4"
    assert body["output"]["width"] == 768
    stderr_text = proc.stderr.read()
    assert "Job submitted: rp_job_99" in stderr_text
    assert "[10s] inference: (1/4) KSampler Step 1/4 (25%" in stderr_text


def test_submit_proc_missing_models_error():
    proc = fakes.submit_proc(
        missing_models=[
            {"filename": "x.safetensors", "class_type": "LoraLoader"},
        ],
        error_message="3 models missing",
        returncode=1,
    )
    assert proc.returncode == 1
    body = json.loads(proc.stdout.read())
    assert body["error_type"] == "missing_models"
    assert body["missing_models"][0]["filename"] == "x.safetensors"
    assert body["error_message"] == "3 models missing"


def test_submit_proc_generic_error_type():
    proc = fakes.submit_proc(
        error_type="validation_failed",
        error_message="Node 7 invalid",
        returncode=1,
    )
    body = json.loads(proc.stdout.read())
    assert body["error_type"] == "validation_failed"
    assert body["error_message"] == "Node 7 invalid"


def test_submit_proc_empty_stdout_on_crash():
    proc = fakes.submit_proc(returncode=137)
    assert proc.returncode == 137
    assert proc.stdout.read() == ""


# ---- install_preset_proc smoke ---------------------------------------------

def test_install_preset_proc_events_are_line_delimited_json():
    events = [
        {"type": "pod_spawned", "pod_id": "pod_a", "token": "tok"},
        {"type": "preflight_ok", "preset_id": "x", "models_count": 1,
         "total_bytes": 1, "volume_free_bytes": 10},
        {"type": "install_done", "ok": True, "files": 1, "elapsed_sec": 30},
    ]
    proc = fakes.install_preset_proc(events)
    lines = [json.loads(line) for line in proc.stdout.read().splitlines()]
    assert lines == events
    assert proc.returncode == 0


def test_install_preset_proc_error_returncode():
    events = [{"type": "install_error", "stage": "download", "reason": "oom"}]
    proc = fakes.install_preset_proc(events, returncode=1, stderr="boom\n")
    assert proc.returncode == 1
    assert "oom" in proc.stdout.read()
    assert proc.stderr.read() == "boom\n"


# ---- make_proc smoke (raw path) --------------------------------------------

def test_make_proc_line_iteration():
    """Existing call sites iterate proc.stderr line-by-line. Verify our
    StringIO-backed fake supports that."""
    proc = fakes.make_proc(stderr="line one\nline two\nline three\n")
    lines = [line.rstrip("\n") for line in proc.stderr]
    assert lines == ["line one", "line two", "line three"]


def test_make_proc_returncode_propagates_to_poll_and_wait():
    proc = fakes.make_proc(returncode=42)
    assert proc.returncode == 42
    assert proc.poll() == 42
    assert proc.wait() == 42


# ---- run_result smoke ------------------------------------------------------

def test_run_result_shape():
    cp = fakes.run_result(stdout="ok\n", stderr="warn\n", returncode=0)
    assert cp.stdout == "ok\n"
    assert cp.stderr == "warn\n"
    assert cp.returncode == 0


def test_run_result_nonzero():
    cp = fakes.run_result(returncode=2)
    assert cp.returncode == 2


# ---- Preset fixtures -------------------------------------------------------

def test_manifest_with_default_shape():
    m = fakes.manifest_with()
    assert m["manifest_version"] == 1
    assert m["presets"][0]["id"] == "qwen-image-lighting"


def test_full_preset_default_has_four_models():
    p = fakes.full_preset()
    assert len(p["models"]) == 4
    assert p["models"][0]["dest"].endswith(".safetensors")


def test_ok_response_has_json_and_text():
    body = {"hello": "world"}
    r = fakes.ok_response(body)
    assert r.status_code == 200
    assert r.json() == body
    assert json.loads(r.text) == body

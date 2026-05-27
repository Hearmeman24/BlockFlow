"""Test fakes for the `comfy-gen` CLI subprocess contract.

BlockFlow speaks to ComfyGen exclusively through subprocess. There are two
distinct on-the-wire contracts:

  1. SUBMIT-LIKE (also `info`, `list`, `download`):
     stdout = a single JSON blob produced at the end
     stderr = line-by-line progress events using the canonical format
              `[<elapsed>s] <stage>: (<i>/<n>) <detail>` plus a few special
              lines (`Job submitted: <remote_id>`, ad-hoc status text).

  2. INSTALL-PRESET:
     stdout = newline-delimited JSON event stream (pod_spawned,
              preflight_ok, download_done, install_done, install_error, ...).
     stderr = unstructured progress text teed to a log file.

This module gives every test a single source for fakes covering both shapes.

Layered helpers (use the one that matches what your test needs):

  - `make_proc(stdout, stderr, returncode)`: bare Popen-mimic. Use when you
    want full control over stdout/stderr bytes.
  - `submit_proc(...)`: convenience for the submit shape — pass the final
    JSON dict (or an error_type) plus a list of progress lines and get back
    a configured fake Popen.
  - `install_preset_proc(events, returncode, stderr_lines)`: convenience
    for the install-preset shape — pass a list of event dicts and get back
    a configured fake Popen with the right line-delimited JSON stdout.
  - `progress_line(stage, elapsed_s, i, n, detail="")`: produces ONE stderr
    line in the canonical format that BlockFlow's `_PROGRESS_RE` parses.
  - `submitted_line(remote_job_id)`: produces the special "Job submitted: X"
    line that BlockFlow regex-extracts to record the RunPod job ID.

Preset registry fixtures live here too (`manifest_with`, `full_preset`,
`ok_response`) so install-preset tests don't have to redefine them per file.
"""
from __future__ import annotations

import io
import json
from typing import Any, Mapping, Sequence
from unittest.mock import MagicMock

# ============================================================================
# Submit / info / list / download contract — final-JSON stdout + progress stderr
# ============================================================================


def progress_line(stage: str, elapsed_s: int, i: int, n: int, detail: str = "") -> str:
    """Build one stderr progress line in the format BlockFlow parses.

    Matches `_PROGRESS_RE` in custom_blocks/comfy_gen/backend.block.py:
        r"\\[(\\d+)s\\]\\s+(\\w+):\\s+\\((\\d+)/(\\d+)\\)\\s*(.*)"
    """
    line = f"[{elapsed_s}s] {stage}: ({i}/{n})"
    if detail:
        line += f" {detail}"
    return line + "\n"


def submitted_line(remote_job_id: str) -> str:
    """Build the "Job submitted: <id>" stderr line BlockFlow regex-extracts."""
    return f"Job submitted: {remote_job_id}\n"


def submit_proc(
    *,
    output_url: str | None = None,
    output_extras: Mapping[str, Any] | None = None,
    error_type: str | None = None,
    error_message: str = "",
    missing_models: Sequence[Mapping[str, Any]] | None = None,
    extra_fields: Mapping[str, Any] | None = None,
    stderr_lines: Sequence[str] | None = None,
    returncode: int = 0,
    remote_job_id: str | None = None,
) -> MagicMock:
    """Build a fake Popen for the `comfy-gen submit` contract.

    Pick at most one of these stdout shapes:
      - `output_url` set → success blob: {"output": {"url": <url>, **extras}}
      - `error_type` set → error blob with that error_type
      - `missing_models` set → error_type='missing_models' with that list

    If none are set, stdout is empty (use to simulate crashes).

    Stderr is a join of any explicit `stderr_lines` plus the optional
    `submitted_line(remote_job_id)` prepended for convenience.
    """
    payload: dict[str, Any] = {}
    if output_url is not None:
        payload["output"] = {"url": output_url, **(output_extras or {})}
    if missing_models is not None:
        payload["error_type"] = "missing_models"
        payload["missing_models"] = list(missing_models)
        if error_message:
            payload["error_message"] = error_message
    elif error_type is not None:
        payload["error_type"] = error_type
        if error_message:
            payload["error_message"] = error_message
    if extra_fields:
        payload.update(extra_fields)

    stdout = json.dumps(payload) if payload else ""

    lines: list[str] = []
    if remote_job_id:
        lines.append(submitted_line(remote_job_id))
    if stderr_lines:
        lines.extend(stderr_lines)
    stderr = "".join(lines)

    return make_proc(stdout=stdout, stderr=stderr, returncode=returncode)


# ============================================================================
# Install-preset contract — newline-delimited JSON event stream on stdout
# ============================================================================


def events_to_stdout(events: Sequence[Mapping[str, Any]]) -> str:
    """Render a list of event dicts as the CLI's line-delimited JSON stdout."""
    return "".join(json.dumps(e) + "\n" for e in events)


def install_preset_proc(
    events: Sequence[Mapping[str, Any]],
    *,
    returncode: int = 0,
    stderr: str = "",
) -> MagicMock:
    """Build a fake Popen for the `comfy-gen install-preset` event stream."""
    return make_proc(
        stdout=events_to_stdout(events),
        stderr=stderr,
        returncode=returncode,
    )


# ============================================================================
# Bare Popen-mimic (use directly when you need raw stdout/stderr bytes)
# ============================================================================


def make_proc(stdout: str = "", stderr: str = "", returncode: int = 0) -> MagicMock:
    """Build a fake Popen with line-iterable stdout/stderr."""
    proc = MagicMock()
    proc.stdout = io.StringIO(stdout)
    proc.stderr = io.StringIO(stderr)
    proc.wait.return_value = returncode
    proc.returncode = returncode
    proc.poll.return_value = returncode
    return proc


# ============================================================================
# subprocess.run helper (cancel verb + any short-lived CLI call)
# ============================================================================


def run_result(stdout: str = "", stderr: str = "", returncode: int = 0) -> MagicMock:
    """Build a fake CompletedProcess for `subprocess.run` call sites.

    Used by short-lived verbs (`cancel`, `--help`) where BlockFlow blocks
    on the subprocess instead of streaming. To simulate timeouts, patch
    `subprocess.run` to raise `subprocess.TimeoutExpired` directly rather
    than returning one of these.
    """
    cp = MagicMock()
    cp.stdout = stdout
    cp.stderr = stderr
    cp.returncode = returncode
    return cp


# ============================================================================
# blockflow-presets registry fixtures
# ============================================================================


def manifest_with(preset_id: str = "qwen-image-lighting") -> dict[str, Any]:
    """Minimal manifest.json body containing one preset entry."""
    return {
        "manifest_version": 1,
        "presets": [{
            "id": preset_id,
            "name": preset_id,
            "comfygen_min_version": "0.2.0",
            "disk_size_estimate_gb": 50,
            "preset_url": "https://example/preset.json",
        }],
    }


def full_preset(preset_id: str = "qwen-image-lighting", n_models: int = 4) -> dict[str, Any]:
    """Minimal but complete preset.json body for install-preset tests."""
    return {
        "id": preset_id,
        "name": preset_id,
        "comfygen_min_version": "0.2.0",
        "disk_size_estimate_gb": 50,
        "workflows": [{"name": "Default", "json": {"3": {}}}],
        "models": [
            {
                "source": "huggingface",
                "url": f"https://x/file{i}.safetensors",
                "dest": f"diffusion_models/file{i}.safetensors",
                "sha256": f"{i:064d}",
                "size_gb": 1.0,
            }
            for i in range(n_models)
        ],
    }


def ok_response(body: Any) -> MagicMock:
    """Mock a curl_cffi.requests-style 200 response with a JSON body."""
    m = MagicMock()
    m.status_code = 200
    m.text = json.dumps(body)
    m.json = lambda: body
    return m

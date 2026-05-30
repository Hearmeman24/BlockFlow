"""Tests for `_filter_upstream_logs` — strip PiAPI retry chatter from the
surfaced `remote_logs`.

PiAPI's task `data.logs` is passed through to the block UI verbatim. It
includes retry mechanics ("Attempt N failed, retrying") and transient errors it
retried away (5xx). The user wants substantive outcome lines preserved; the
final failure already surfaces via the job error/status, so only retry chatter
is dropped.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location(
    "seedance_block_logfilter",
    ROOT / "custom_blocks" / "seedance" / "backend.block.py",
)
mod = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = mod
_spec.loader.exec_module(mod)


def test_drops_retry_and_transient_noise_but_keeps_duration_errors():
    raw = [
        "invalid duration, use '5' as default",
        "internal server error status code: 503",
        "Attempt 1 failed, retrying.",
        "content restriction: The request was rejected because the input image may contain a real person. Please try different inputs.",
        "Attempt 2 failed (content restriction), retrying.",
    ]
    out = mod._filter_upstream_logs(raw)
    assert out == [
        "invalid duration, use '5' as default",
        "content restriction: The request was rejected because the input image may contain a real person. Please try different inputs.",
    ]


def test_keeps_substantive_and_billing_lines():
    raw = [
        "moderation passed",
        "billing: input 9.0s + output 9.0s",
        "Attempt 1 failed, retrying.",
    ]
    assert mod._filter_upstream_logs(raw) == [
        "moderation passed",
        "billing: input 9.0s + output 9.0s",
    ]


def test_empty_and_noise_only():
    assert mod._filter_upstream_logs([]) == []
    assert mod._filter_upstream_logs(["Attempt 3 failed, retrying.", "retrying"]) == []

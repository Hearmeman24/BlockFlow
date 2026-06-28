"""submit_jobs must shape `inputs` into the backend's file_inputs contract and
reject missing local files before submitting (the I2V upload path)."""

import sys
from contextlib import contextmanager
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

pytest.importorskip("fastmcp", reason="MCP server tests require fastmcp (run with `uv run --with fastmcp`)")

import mcp_server  # noqa: E402


class _Resp:
    def __init__(self, job_id):
        self._job_id = job_id

    def raise_for_status(self):
        pass

    def json(self):
        return {"ok": True, "job_id": self._job_id}


class _FakeClient:
    def __init__(self, sink):
        self._sink = sink

    def post(self, path, json):  # noqa: A002
        self._sink.append(json)
        return _Resp(f"j{len(self._sink)}")


@contextmanager
def _patched(sink):
    @contextmanager
    def fake():
        yield _FakeClient(sink)

    orig = mcp_server._client
    mcp_server._client = fake
    try:
        yield
    finally:
        mcp_server._client = orig


WF = {"352": {"class_type": "LoadImage", "inputs": {"image": "x.png"}}}


def test_inputs_become_file_inputs(tmp_path):
    img = tmp_path / "start.png"
    img.write_bytes(b"\x89PNG\r\n")
    sink = []
    with _patched(sink):
        out = mcp_server.submit_jobs(WF, inputs={"352": str(img)}, count=2)
    assert len(out["job_ids"]) == 2
    assert sink[0]["file_inputs"] == {"352": {"media_url": str(img)}}
    assert sink[0]["source"] == "mcp"
    assert sink[0]["batch_id"] == out["batch_id"]
    assert sink[1]["file_inputs"] == {"352": {"media_url": str(img)}}  # shared across batch


def test_missing_file_rejected_before_submit():
    sink = []
    with _patched(sink), pytest.raises(FileNotFoundError):
        mcp_server.submit_jobs(WF, inputs={"352": "/no/such/image.png"})
    assert sink == []  # nothing submitted


def test_no_inputs_omits_file_inputs():
    sink = []
    with _patched(sink):
        mcp_server.submit_jobs(WF)
    assert sink[0]["file_inputs"] is None
    assert sink[0]["bypass_loras"] is None


def test_bypass_loras_passed_through():
    sink = []
    with _patched(sink):
        mcp_server.submit_jobs(WF, bypass_loras=["298", 300, "  ", ""])
    assert sink[0]["bypass_loras"] == ["298", "300"]  # stringified, blanks dropped


def test_add_loras_passed_through():
    sink = []
    with _patched(sink):
        mcp_server.submit_jobs(WF, add_loras=[{"lora_name": "x.safetensors", "anchor": "10"}])
    assert sink[0]["added_loras"] == [{"lora_name": "x.safetensors", "anchor": "10"}]


def test_submit_batch_spec_add_loras_overrides_call_level():
    sink = []
    with _patched(sink):
        mcp_server.submit_batch(
            WF,
            jobs=[{"overrides": {"6.text": "a"}}, {"overrides": {"6.text": "b"}, "add_loras": [{"lora_name": "b.safetensors"}]}],
            add_loras=[{"lora_name": "default.safetensors"}],
        )
    assert sink[0]["added_loras"] == [{"lora_name": "default.safetensors"}]  # call-level default
    assert sink[1]["added_loras"] == [{"lora_name": "b.safetensors"}]        # spec override


def test_submit_batch_fires_all_jobs_in_one_shared_batch():
    sink = []
    with _patched(sink):
        out = mcp_server.submit_batch(WF, jobs=[
            {"overrides": {"6.text": "a cat"}},
            {"overrides": {"6.text": "a dog"}, "bypass_loras": ["298"]},
            {"overrides": {"6.text": "a fox"}},
        ])
    assert len(out["job_ids"]) == 3
    # all three POSTed (concurrent fan-out, no waiting between)
    assert len(sink) == 3
    # one shared batch_id across the whole batch → one growing gallery card
    assert {b["batch_id"] for b in sink} == {out["batch_id"]}
    assert sink[0]["overrides"] == {"6.text": "a cat"}
    assert sink[1]["bypass_loras"] == ["298"]
    assert sink[2]["overrides"] == {"6.text": "a fox"}

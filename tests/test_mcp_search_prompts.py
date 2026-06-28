"""search_prompts queries /api/runs?q= and extracts the matching prompt strings
(with their output URLs) out of the runs' block_results."""

import sys
from contextlib import contextmanager
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

pytest.importorskip("fastmcp", reason="MCP server tests require fastmcp (run with `uv run --with fastmcp`)")

import mcp_server  # noqa: E402


def _run(run_id, prompts, urls):
    return {
        "id": run_id,
        "name": "MCP Run",
        "created_at": "2026-06-27T10:00:00",
        "block_results": [{
            "outputs": {
                "image": {"kind": "image", "value": urls},
                "metadata": {"kind": "metadata", "value": [{"prompt": p} for p in prompts]},
            },
        }],
    }


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class _FakeClient:
    def __init__(self, payload, calls):
        self._payload = payload
        self._calls = calls

    def get(self, path, params=None):
        self._calls.append((path, params))
        return _Resp(self._payload)


@contextmanager
def _patched(payload, calls):
    @contextmanager
    def fake():
        yield _FakeClient(payload, calls)

    orig = mcp_server._client
    mcp_server._client = fake
    try:
        yield
    finally:
        mcp_server._client = orig


def test_returns_only_matching_prompts_with_urls():
    payload = {"ok": True, "runs": [
        _run("run-mcp-a", ["a red cat on a roof", "a blue dog"], ["/outputs/1.png", "/outputs/2.png"]),
    ], "total": 1}
    calls = []
    with _patched(payload, calls):
        out = mcp_server.search_prompts("CAT")
    # case-insensitive match, only the matching prompt comes back
    assert out["count"] == 1
    hit = out["results"][0]
    assert hit["prompt"] == "a red cat on a roof"
    assert hit["url"] == "/outputs/1.png"  # zipped by index with media
    assert hit["run_id"] == "run-mcp-a"
    assert hit["created_at"] == "2026-06-27T10:00:00"
    # query forwarded to the backend's prompt filter
    assert calls[0][1]["q"] == "CAT"


def test_source_filter_forwarded():
    calls = []
    with _patched({"ok": True, "runs": []}, calls):
        mcp_server.search_prompts("x", source="mcp", limit=5)
    assert calls[0][1]["source"] == "mcp"
    assert calls[0][1]["limit"] == 5


def test_invalid_source_dropped():
    calls = []
    with _patched({"ok": True, "runs": []}, calls):
        mcp_server.search_prompts("x", source="bogus")
    assert "source" not in calls[0][1]


def test_empty_query_lists_recent_prompts():
    payload = {"ok": True, "runs": [_run("r1", ["sunset over hills"], ["/outputs/9.png"])]}
    calls = []
    with _patched(payload, calls):
        out = mcp_server.search_prompts("")
    assert out["count"] == 1
    assert out["results"][0]["prompt"] == "sunset over hills"
    assert "q" not in calls[0][1]  # no filter sent when query is blank


def test_backend_error_raises():
    with _patched({"ok": False, "error": "boom"}, []):
        with pytest.raises(RuntimeError, match="boom"):
            mcp_server.search_prompts("x")

"""Backend MCP batch behavior: the run-mcp-<batch_id> grows as jobs complete,
concurrent completions don't lose images, and the source filter scopes the gallery."""

import importlib.util
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import db  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "comfy_gen_block", ROOT / "custom_blocks" / "comfy_gen" / "backend.block.py"
)
cg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cg)


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t.db")
    db.init_db()
    yield db


def _meta(seed):
    return {"seed": seed, "prompt": "a cat", "software": "ComfyUI (comfy-gen)"}


def test_first_job_creates_run_with_array(temp_db):
    cg._upsert_mcp_batch_run("b1", "j1", "/outputs/a.png", _meta(1))
    run = db.get_run("run-mcp-b1")
    assert run is not None
    out = run["block_results"][0]["outputs"]
    assert out["image"]["value"] == ["/outputs/a.png"]  # array even with one
    assert out["metadata"]["value"] == [_meta(1)]
    assert run["block_results"][0]["block_type"] == "comfy_gen"


def test_subsequent_jobs_append(temp_db):
    cg._upsert_mcp_batch_run("b2", "j1", "/outputs/a.png", _meta(1))
    cg._upsert_mcp_batch_run("b2", "j2", "/outputs/b.png", _meta(2))
    cg._upsert_mcp_batch_run("b2", "j3", "/outputs/c.png", _meta(3))
    out = db.get_run("run-mcp-b2")["block_results"][0]["outputs"]
    assert out["image"]["value"] == ["/outputs/a.png", "/outputs/b.png", "/outputs/c.png"]
    assert [m["seed"] for m in out["metadata"]["value"]] == [1, 2, 3]


def test_concurrent_appends_lose_nothing(temp_db):
    # Mirrors the sliding-window: many jobs in one batch finishing at once.
    cg._upsert_mcp_batch_run("b3", "seed", "/outputs/0.png", _meta(0))
    threads = [
        threading.Thread(target=cg._upsert_mcp_batch_run,
                         args=("b3", f"j{i}", f"/outputs/{i}.png", _meta(i)))
        for i in range(1, 21)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    out = db.get_run("run-mcp-b3")["block_results"][0]["outputs"]
    assert len(out["image"]["value"]) == 21  # none clobbered
    assert len(out["metadata"]["value"]) == 21


def test_publish_event_delivers_cross_thread():
    """SSE: a worker thread publishing an event reaches a subscriber's asyncio queue."""
    import asyncio

    async def run():
        loop = asyncio.get_running_loop()
        q: asyncio.Queue = asyncio.Queue()
        sub = (loop, q)
        cg._EVENT_SUBSCRIBERS.add(sub)
        try:
            # Publish from a non-loop (worker) thread, like the job executor does.
            t = threading.Thread(target=cg._publish_event, args=({"type": "mcp", "phase": "end"},))
            t.start()
            t.join()
            return await asyncio.wait_for(q.get(), timeout=2)
        finally:
            cg._EVENT_SUBSCRIBERS.discard(sub)

    assert asyncio.run(run()) == {"type": "mcp", "phase": "end"}


def test_video_url_uses_video_port(temp_db):
    cg._upsert_mcp_batch_run("b4", "j1", "/outputs/clip.mp4", _meta(1))
    out = db.get_run("run-mcp-b4")["block_results"][0]["outputs"]
    assert out["video"]["value"] == ["/outputs/clip.mp4"]
    assert "image" not in out


_WF_WITH_LORA = {
    "5": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
    "10": {"class_type": "LoraLoaderModelOnly",
           "inputs": {"lora_name": "base.safetensors", "strength_model": 1, "model": ["5", 0]}},
}


def test_resolve_added_loras_explicit_anchor():
    resolved, err = cg._resolve_added_loras(_WF_WITH_LORA, [
        {"lora_name": "extra.safetensors", "strength_model": 0.7, "anchor": "10"},
    ])
    assert err is None
    assert resolved == [{
        "chain_anchor": "10", "class_type": "LoraLoaderModelOnly",
        "lora_name": "extra.safetensors", "strength_model": 0.7,
    }]


def test_resolve_added_loras_auto_anchor():
    resolved, err = cg._resolve_added_loras(_WF_WITH_LORA, [{"lora_name": "x.safetensors"}])
    assert err is None
    assert resolved[0]["chain_anchor"] == "10"  # auto-picked the only chain
    assert resolved[0]["strength_model"] == 1.0  # default


def test_resolve_added_loras_bad_anchor_errors():
    resolved, err = cg._resolve_added_loras(_WF_WITH_LORA, [
        {"lora_name": "x.safetensors", "anchor": "999"},
    ])
    assert resolved is None
    assert "999" in err and "Valid anchors: 10" in err


def test_resolve_added_loras_no_chain_errors():
    wf = {"5": {"class_type": "CheckpointLoaderSimple", "inputs": {}}}
    resolved, err = cg._resolve_added_loras(wf, [{"lora_name": "x.safetensors"}])
    assert resolved is None
    assert "no LoRA loader" in err


def test_resolve_added_loras_missing_name_errors():
    _, err = cg._resolve_added_loras(_WF_WITH_LORA, [{"anchor": "10"}])
    assert "lora_name" in err


def test_run_route_rejects_bad_lora_anchor(temp_db, monkeypatch):
    """A bad add_loras anchor must 400 with a clear message, not silently drop."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setattr(cg.state, "EXECUTOR", type("E", (), {"submit": lambda *a, **k: None})())
    monkeypatch.setattr(cg.state, "_persist_jobs_locked", lambda: None)
    monkeypatch.setattr(cg, "_publish_event", lambda *a, **k: None)
    app = FastAPI()
    app.include_router(cg.router, prefix="/api/blocks/comfy_gen")
    client = TestClient(app)

    resp = client.post("/api/blocks/comfy_gen/run", json={
        "workflow": _WF_WITH_LORA,
        "added_loras": [{"lora_name": "x.safetensors", "anchor": "nope"}],
        "source": "mcp", "batch_id": "bl",
    })
    assert resp.status_code == 400
    assert "nope" in resp.json()["error"]


def test_run_route_logs_added_loras(temp_db, monkeypatch, capsys):
    """add_loras must leave a trace in the log so a requested LoRA add is auditable."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setattr(cg.state, "EXECUTOR", type("E", (), {"submit": lambda *a, **k: None})())
    monkeypatch.setattr(cg.state, "_persist_jobs_locked", lambda: None)
    monkeypatch.setattr(cg, "_publish_event", lambda *a, **k: None)
    app = FastAPI()
    app.include_router(cg.router, prefix="/api/blocks/comfy_gen")
    client = TestClient(app)

    resp = client.post("/api/blocks/comfy_gen/run", json={
        "workflow": _WF_WITH_LORA,
        "added_loras": [{"lora_name": "Sadie01_krea2_epoch80.safetensors", "strength_model": 0.7}],
        "source": "mcp", "batch_id": "bl",
    })
    assert resp.status_code == 200, resp.text
    out = capsys.readouterr().out
    assert "added_loras" in out
    assert "Sadie01_krea2_epoch80.safetensors" in out
    assert '"chain_anchor": "10"' in out  # auto-anchored, logged as resolved


def test_run_route_tolerates_null_fields(temp_db, monkeypatch):
    """Regression: the MCP sends explicit JSON null for empty overrides/file_inputs;
    the /run route must coerce them, not 500 with NoneType.items()."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setattr(cg.state, "EXECUTOR", type("E", (), {"submit": lambda *a, **k: None})())
    monkeypatch.setattr(cg.state, "_persist_jobs_locked", lambda: None)
    monkeypatch.setattr(cg, "_publish_event", lambda *a, **k: None)

    app = FastAPI()
    app.include_router(cg.router, prefix="/api/blocks/comfy_gen")
    client = TestClient(app)

    resp = client.post("/api/blocks/comfy_gen/run", json={
        "workflow": {"1": {"class_type": "X", "inputs": {}}},
        "overrides": None, "file_inputs": None, "lock_seed": None,
        "endpoint_id": None, "source": "mcp", "batch_id": "b9",
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] is True


def test_source_filter_scopes_runs(temp_db):
    cg._upsert_mcp_batch_run("b5", "j1", "/outputs/a.png", _meta(1))
    db.save_run({
        "id": "run-normal-1", "name": "n", "status": "completed",
        "flow_snapshot": {"blocks": []}, "block_results": [], "created_at": "2026-01-01T00:00:00",
    })
    mcp = db.list_runs(source="mcp")
    pipeline = db.list_runs(source="pipeline")
    assert [r["id"] for r in mcp] == ["run-mcp-b5"]
    assert [r["id"] for r in pipeline] == ["run-normal-1"]
    assert db.count_runs(source="mcp") == 1
    assert len(db.list_runs()) == 2  # unfiltered sees both

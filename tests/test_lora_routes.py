"""HTTP route tests for /api/loras/* (sgs-ui-eqc.1).

Subprocess calls to comfy-gen are mocked at module-level helper boundaries.
CivitAI API calls mocked via the civitai_client._requests handle.
"""
from __future__ import annotations

import ast
import json
import sys
from pathlib import Path
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import pytest  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend import civitai_client, config, lora_metadata, lora_routes, settings_store  # noqa: E402
from tests.fakes import comfy_gen as comfy_gen_fakes  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ROOT_DIR", tmp_path)
    monkeypatch.setattr(config, "COMFY_GEN_INFO_CACHE_PATH",
                        tmp_path / "comfy_gen_info_cache.json")
    monkeypatch.setattr(lora_metadata, "DB_PATH", tmp_path / "run_history.db")
    monkeypatch.setattr(settings_store, "DB_PATH", tmp_path / "run_history.db")
    settings_store.init_db()
    lora_metadata.init_db()

    app = FastAPI()
    app.include_router(lora_routes.router)

    # Reset module-level state between tests.
    lora_routes._reset_download_state()

    return TestClient(app)


def _seed_cache(tmp_path, filenames, fetched_at=None):
    """Write the shared comfy_gen info cache file (schema v2) with the
    given LoRA filenames as stub objects."""
    import time as _time
    path = tmp_path / "comfy_gen_info_cache.json"
    path.write_text(json.dumps({
        "version": 2,
        "samplers": [], "schedulers": [],
        "loras": [{"filename": fn} for fn in filenames],
        "fetched_at": fetched_at if fetched_at is not None else _time.time(),
    }))


def _cached_filenames(tmp_path) -> list[str]:
    """Read the v2 cache and project to filename strings."""
    data = json.loads((tmp_path / "comfy_gen_info_cache.json").read_text())
    return [item["filename"] for item in data["loras"]]


def _configure_endpoint() -> None:
    settings_store.set_endpoint(type="comfygen", endpoint_id="ep-test-123", volume_id="vol-1")


def _resp(status: int, body: dict) -> MagicMock:
    m = MagicMock()
    m.status_code = status
    m.json.return_value = body
    m.raise_for_status.return_value = None if status < 400 else None
    if status >= 400:
        m.raise_for_status.side_effect = RuntimeError(f"http {status}")
    return m


def test_settings_mutating_tests_use_isolated_client_fixture() -> None:
    """Guard against leaking test endpoint/key fixtures into the live Settings DB."""
    tree = ast.parse(Path(__file__).read_text(encoding="utf-8"))
    offenders: list[str] = []
    for node in tree.body:
        if not isinstance(node, ast.FunctionDef) or not node.name.startswith("test_"):
            continue
        params = {arg.arg for arg in node.args.args}
        mutates_settings = False
        for child in ast.walk(node):
            if not isinstance(child, ast.Call):
                continue
            func = child.func
            if isinstance(func, ast.Name) and func.id == "_configure_endpoint":
                mutates_settings = True
            elif (
                isinstance(func, ast.Attribute)
                and func.attr in {"set_credential", "set_endpoint"}
                and isinstance(func.value, ast.Name)
                and func.value.id == "settings_store"
            ):
                mutates_settings = True
        if mutates_settings and "client" not in params:
            offenders.append(node.name)

    assert offenders == []


# ---- GET /api/loras ----

def test_list_returns_409_when_no_endpoint(client) -> None:
    r = client.get("/api/loras")
    assert r.status_code == 409


def test_list_merges_cached_volume_with_db_and_prunes_orphans(client, tmp_path) -> None:
    _configure_endpoint()
    lora_metadata.upsert(filename="known.safetensors", source="civitai", source_id="1",
                         trigger_words=["trig"])
    lora_metadata.upsert(filename="orphan.safetensors", source="civitai", source_id="2")
    _seed_cache(tmp_path, ["known.safetensors", "legacy.safetensors"])

    r = client.get("/api/loras")
    assert r.status_code == 200
    data = r.json()
    by_name = {row["filename"]: row for row in data["loras"]}
    assert set(by_name.keys()) == {"known.safetensors", "legacy.safetensors"}
    assert by_name["known.safetensors"]["source"] == "civitai"
    assert by_name["known.safetensors"]["trigger_words"] == ["trig"]
    assert by_name["legacy.safetensors"]["source"] == "unknown"
    assert data["pruned"] == ["orphan.safetensors"]
    assert lora_metadata.get("orphan.safetensors") is None
    assert data["stale"] is False
    assert data["fetched_at"] is not None


def test_list_marks_stale_when_no_cache(client) -> None:
    _configure_endpoint()
    r = client.get("/api/loras")
    assert r.status_code == 200
    data = r.json()
    assert data["loras"] == []
    assert data["stale"] is True
    assert data["fetched_at"] is None


def test_list_marks_stale_when_cache_older_than_24h(client, tmp_path) -> None:
    _configure_endpoint()
    _seed_cache(tmp_path, ["a.safetensors"], fetched_at=0.0)  # epoch
    r = client.get("/api/loras")
    assert r.json()["stale"] is True


def test_sync_shells_out_and_refreshes_cache(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    # Stub the cold-path subprocess so test stays fast and offline.
    monkeypatch.setattr(lora_routes, "_fetch_loras_from_comfygen",
                        lambda eid: ["fresh.safetensors", "newer.safetensors"])

    r = client.post("/api/loras/sync")
    assert r.status_code == 200
    data = r.json()
    assert {row["filename"] for row in data["loras"]} == {"fresh.safetensors", "newer.safetensors"}
    assert data["stale"] is False


def test_fetch_loras_uses_resolved_sidecar_command(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    settings_store.set_credential("runpod_api_key", "rpa_sidecar")
    sidecar = tmp_path / "venv" / "bin" / "comfy-gen"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    sidecar.chmod(0o755)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))
    monkeypatch.setenv("PATH", "")
    monkeypatch.setattr(config, "COMFY_GEN_INFO_CACHE_PATH", tmp_path / "comfy_gen_info_cache.json")

    captured: dict[str, object] = {}

    def fake_run(args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        m = MagicMock()
        m.returncode = 0
        m.stdout = json.dumps({"ok": True, "files": [{"filename": "fresh.safetensors"}]})
        m.stderr = ""
        return m

    monkeypatch.setattr(lora_routes.subprocess, "run", fake_run)

    assert lora_routes._fetch_loras_from_comfygen("ep-sidecar") == ["fresh.safetensors"]
    assert captured["args"][:3] == [str(sidecar), "list", "loras"]
    assert "--endpoint-id" in captured["args"]


def test_fetch_loras_passes_settings_runpod_key_via_env_not_argv(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    settings_store.set_credential("runpod_api_key", "rpa_from_settings")
    sidecar = tmp_path / "venv" / "bin" / "comfy-gen"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    sidecar.chmod(0o755)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))
    monkeypatch.delenv("RUNPOD_API_KEY", raising=False)
    monkeypatch.setattr(config, "COMFY_GEN_INFO_CACHE_PATH", tmp_path / "comfy_gen_info_cache.json")

    captured: dict[str, object] = {}

    def fake_run(args, **kwargs):
        captured["args"] = args
        captured["env"] = kwargs.get("env")
        m = MagicMock()
        m.returncode = 0
        m.stdout = json.dumps({"ok": True, "files": [{"filename": "fresh.safetensors"}]})
        m.stderr = ""
        return m

    monkeypatch.setattr(lora_routes.subprocess, "run", fake_run)

    assert lora_routes._fetch_loras_from_comfygen("ep-sidecar") == ["fresh.safetensors"]
    assert captured["env"]["RUNPOD_API_KEY"] == "rpa_from_settings"
    assert "rpa_from_settings" not in captured["args"]


def test_fetch_loras_requires_settings_runpod_key(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    sidecar = tmp_path / "venv" / "bin" / "comfy-gen"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    sidecar.chmod(0o755)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))
    monkeypatch.setattr(
        lora_routes.subprocess,
        "run",
        lambda *args, **kwargs: pytest.fail("subprocess should not run without Settings RunPod key"),
    )

    with pytest.raises(HTTPException) as exc:
        lora_routes._fetch_loras_from_comfygen("ep-sidecar")

    assert exc.value.status_code == 400
    assert "runpod_api_key not configured in Settings" in exc.value.detail


def test_sync_route_passes_settings_runpod_key_to_comfy_gen(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    settings_store.set_credential("runpod_api_key", "rpa_sync_route")
    sidecar = tmp_path / "venv" / "bin" / "comfy-gen"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    sidecar.chmod(0o755)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))
    monkeypatch.delenv("RUNPOD_API_KEY", raising=False)
    monkeypatch.setattr(config, "COMFY_GEN_INFO_CACHE_PATH", tmp_path / "comfy_gen_info_cache.json")

    captured: dict[str, object] = {}

    def fake_run(args, **kwargs):
        captured["args"] = args
        captured["env"] = kwargs.get("env")
        m = MagicMock()
        m.returncode = 0
        m.stdout = json.dumps({"ok": True, "files": [{"filename": "route.safetensors"}]})
        m.stderr = ""
        return m

    monkeypatch.setattr(lora_routes.subprocess, "run", fake_run)

    r = client.post("/api/loras/sync")

    assert r.status_code == 200
    assert r.json()["loras"][0]["filename"] == "route.safetensors"
    assert captured["env"]["RUNPOD_API_KEY"] == "rpa_sync_route"
    assert "rpa_sync_route" not in captured["args"]


def test_fetch_loras_preserves_status_error_from_cli_stdout(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    settings_store.set_credential("runpod_api_key", "rpa_sync_error")
    sidecar = tmp_path / "venv" / "bin" / "comfy-gen"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    sidecar.chmod(0o755)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))
    monkeypatch.setattr(config, "COMFY_GEN_INFO_CACHE_PATH", tmp_path / "comfy_gen_info_cache.json")
    _seed_cache(tmp_path, ["cached.safetensors"])

    monkeypatch.setattr(
        lora_routes.subprocess,
        "run",
        lambda *args, **kwargs: comfy_gen_fakes.run_result(
            stdout=json.dumps({
                "status": "error",
                "error": "Listing loras on network volume timed out",
            }),
            stderr="Listing loras on network volume...\n",
            returncode=1,
        ),
    )

    with pytest.raises(HTTPException) as exc:
        lora_routes._fetch_loras_from_comfygen("ep-sidecar")

    assert exc.value.status_code == 502
    assert "Listing loras on network volume timed out" in exc.value.detail
    assert _cached_filenames(tmp_path) == ["cached.safetensors"]


def test_sync_route_preserves_status_error_from_cli_stdout(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    settings_store.set_credential("runpod_api_key", "rpa_sync_route_error")
    sidecar = tmp_path / "venv" / "bin" / "comfy-gen"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    sidecar.chmod(0o755)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))
    monkeypatch.setattr(config, "COMFY_GEN_INFO_CACHE_PATH", tmp_path / "comfy_gen_info_cache.json")
    _seed_cache(tmp_path, ["cached.safetensors"])

    monkeypatch.setattr(
        lora_routes.subprocess,
        "run",
        lambda *args, **kwargs: comfy_gen_fakes.run_result(
            stdout=json.dumps({
                "status": "error",
                "error": "RunPod API returned 401 while listing loras",
            }),
            stderr="Listing loras on network volume...\n",
            returncode=1,
        ),
    )

    r = client.post("/api/loras/sync")

    assert r.status_code == 502
    assert "RunPod API returned 401 while listing loras" in r.json()["detail"]
    assert _cached_filenames(tmp_path) == ["cached.safetensors"]


def test_fetch_loras_reads_final_json_after_status_lines(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    settings_store.set_credential("runpod_api_key", "rpa_sync_mixed")
    sidecar = tmp_path / "venv" / "bin" / "comfy-gen"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    sidecar.chmod(0o755)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))
    monkeypatch.setattr(config, "COMFY_GEN_INFO_CACHE_PATH", tmp_path / "comfy_gen_info_cache.json")

    stdout = "\n".join([
        "Listing loras on network volume...",
        json.dumps({"ok": True, "files": [{"filename": "fresh.safetensors"}]}),
    ])
    monkeypatch.setattr(
        lora_routes.subprocess,
        "run",
        lambda *args, **kwargs: comfy_gen_fakes.run_result(stdout=stdout, returncode=0),
    )

    assert lora_routes._fetch_loras_from_comfygen("ep-sidecar") == ["fresh.safetensors"]
    assert _cached_filenames(tmp_path) == ["fresh.safetensors"]


def test_delete_subprocess_passes_settings_runpod_key_via_env_not_argv(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    settings_store.set_credential("runpod_api_key", "rpa_delete")
    sidecar = tmp_path / "venv" / "bin" / "comfy-gen"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    sidecar.chmod(0o755)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))
    monkeypatch.delenv("RUNPOD_API_KEY", raising=False)

    captured: dict[str, object] = {}

    def fake_run(args, **kwargs):
        captured["args"] = args
        captured["env"] = kwargs.get("env")
        m = MagicMock()
        m.returncode = 0
        m.stdout = json.dumps({"results": [{"path": f"{lora_routes.LORA_DEST_DIR}/a.safetensors", "deleted": True}]})
        m.stderr = ""
        return m

    monkeypatch.setattr(lora_routes.subprocess, "run", fake_run)

    assert lora_routes._delete_subprocess(["a.safetensors"], "ep-sidecar")[0]["deleted"] is True
    assert captured["env"]["RUNPOD_API_KEY"] == "rpa_delete"
    assert "rpa_delete" not in captured["args"]


# ---- POST /api/loras/delete ----

def test_delete_batch_drops_db_rows_for_deleted_only(client, monkeypatch) -> None:
    _configure_endpoint()
    for fn in ("a.safetensors", "b.safetensors", "c.safetensors"):
        lora_metadata.upsert(filename=fn, source="civitai", source_id="1")

    def fake_delete(filenames, eid):
        # b fails, others succeed
        return [
            {"path": f"/runpod-volume/ComfyUI/models/loras/{fn}",
             "deleted": fn != "b.safetensors",
             "error": "in use" if fn == "b.safetensors" else None}
            for fn in filenames
        ]

    monkeypatch.setattr(lora_routes, "_delete_subprocess", fake_delete)

    r = client.post("/api/loras/delete",
                    json={"filenames": ["a.safetensors", "b.safetensors", "c.safetensors"]})
    assert r.status_code == 207  # partial failure
    data = r.json()
    by_name = {row["filename"]: row for row in data["results"]}
    assert by_name["a.safetensors"]["deleted"] is True
    assert by_name["b.safetensors"]["deleted"] is False
    assert by_name["b.safetensors"]["error"] == "in use"
    assert by_name["c.safetensors"]["deleted"] is True

    assert lora_metadata.get("a.safetensors") is None
    assert lora_metadata.get("b.safetensors") is not None  # NOT dropped
    assert lora_metadata.get("c.safetensors") is None


def test_delete_all_ok_returns_200(client, monkeypatch) -> None:
    _configure_endpoint()
    lora_metadata.upsert(filename="a.safetensors", source="civitai", source_id="1")

    monkeypatch.setattr(lora_routes, "_delete_subprocess",
                        lambda fns, eid: [{"path": f"/runpod-volume/ComfyUI/models/loras/{fn}",
                                            "deleted": True} for fn in fns])

    r = client.post("/api/loras/delete", json={"filenames": ["a.safetensors"]})
    assert r.status_code == 200


def test_delete_empty_filenames_rejected(client) -> None:
    _configure_endpoint()
    r = client.post("/api/loras/delete", json={"filenames": []})
    assert r.status_code == 400


def test_delete_409_when_no_endpoint(client) -> None:
    r = client.post("/api/loras/delete", json={"filenames": ["a.safetensors"]})
    assert r.status_code == 409


def test_delete_removes_filenames_from_shared_cache(client, monkeypatch, tmp_path) -> None:
    """Successful deletes must update the shared comfy_gen cache so the
    ComfyGen block's LoRA dropdown reflects the new state immediately."""
    _configure_endpoint()
    _seed_cache(tmp_path, ["keep.safetensors", "drop.safetensors"])
    lora_metadata.upsert(filename="drop.safetensors", source="civitai", source_id="1")

    monkeypatch.setattr(lora_routes, "_delete_subprocess",
                        lambda fns, eid: [{"path": f"/runpod-volume/ComfyUI/models/loras/{fn}",
                                            "deleted": True} for fn in fns])

    client.post("/api/loras/delete", json={"filenames": ["drop.safetensors"]})

    cached = _cached_filenames(tmp_path)
    assert "drop.safetensors" not in cached
    assert "keep.safetensors" in cached


def test_delete_failed_rows_stay_in_cache(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    _seed_cache(tmp_path, ["a.safetensors", "b.safetensors"])

    monkeypatch.setattr(lora_routes, "_delete_subprocess",
                        lambda fns, eid: [
                            {"path": "/runpod-volume/ComfyUI/models/loras/a.safetensors", "deleted": True},
                            {"path": "/runpod-volume/ComfyUI/models/loras/b.safetensors",
                             "deleted": False, "error": "in use"},
                        ])

    client.post("/api/loras/delete", json={"filenames": ["a.safetensors", "b.safetensors"]})

    cached = _cached_filenames(tmp_path)
    assert "a.safetensors" not in cached
    assert "b.safetensors" in cached


# ---- POST /api/loras/download ----

# ---- Async download tests (sgs-ui-eqc.5) ----
#
# POST /api/loras/download now spawns a background thread and returns 202
# immediately. To keep tests deterministic, we patch threading.Thread so the
# runner executes inline before the POST returns — the state machine still
# transitions through running → completed but it all happens synchronously
# from the test's perspective.

def _inline_threads(monkeypatch):
    """Make threading.Thread in lora_routes execute target() synchronously."""
    class InlineThread:
        def __init__(self, target=None, daemon=None, **kwargs):
            self._target = target
        def start(self):
            if self._target:
                self._target()
        def join(self, timeout=None):
            pass
    monkeypatch.setattr(lora_routes.threading, "Thread", InlineThread)


def test_civitai_download_kicks_off_then_completes(client, monkeypatch, mocker) -> None:
    _configure_endpoint()
    monkeypatch.setattr(config, "CIVITAI_API_KEY", "")
    _inline_threads(monkeypatch)

    payload = {
        "id": 67890, "modelId": 12345, "baseModel": "Flux.1 D",
        "trainedWords": ["trigger one"],
        "files": [{"primary": True, "name": "char_v2.safetensors", "sizeKB": 100.0}],
    }
    mocker.patch.object(civitai_client._requests, "get",
                        return_value=_resp(200, payload))

    captured = []
    monkeypatch.setattr(lora_routes, "_run_download_streaming",
                        lambda entries, eid: (captured.append((entries, eid)), (True, {"ok": True}))[1])

    r = client.post("/api/loras/download",
                    json={"source": "civitai", "version_id": 67890})
    assert r.status_code == 202
    body = r.json()
    assert body["state"] == "completed"
    assert body["filename"] == "char_v2.safetensors"
    assert body["progress_percent"] == 100
    assert body["error"] is None

    assert captured[0][0] == [{"source": "civitai", "version_id": 67890, "dest": "loras"}]

    row = lora_metadata.get("char_v2.safetensors")
    assert row is not None
    assert row["source"] == "civitai"
    assert row["source_id"] == "67890"
    assert row["base_model"] == "Flux.1 D"
    assert row["trigger_words"] == ["trigger one"]
    assert row["size_bytes"] == 100 * 1024


def test_civitai_download_succeeds_when_metadata_fetch_fails(client, monkeypatch, mocker) -> None:
    _configure_endpoint()
    monkeypatch.setattr(config, "CIVITAI_API_KEY", "")
    _inline_threads(monkeypatch)
    mocker.patch.object(civitai_client._requests, "get",
                        side_effect=RuntimeError("network down"))
    monkeypatch.setattr(lora_routes, "_run_download_streaming",
                        lambda entries, eid: (True, {"ok": True}))

    r = client.post("/api/loras/download",
                    json={"source": "civitai", "version_id": 99999, "filename": "fallback.safetensors"})
    assert r.status_code == 202
    assert r.json()["state"] == "completed"
    row = lora_metadata.get("fallback.safetensors")
    assert row["source"] == "civitai"
    assert row["source_id"] == "99999"
    assert row["trigger_words"] == []
    assert row["base_model"] is None


def test_url_download_detects_huggingface(client, monkeypatch) -> None:
    _configure_endpoint()
    _inline_threads(monkeypatch)
    monkeypatch.setattr(lora_routes, "_run_download_streaming",
                        lambda entries, eid: (True, {"ok": True}))

    r = client.post("/api/loras/download",
                    json={"source": "url",
                          "url": "https://huggingface.co/foo/bar/resolve/main/model.safetensors"})
    assert r.status_code == 202
    row = lora_metadata.get("model.safetensors")
    assert row["source"] == "hf"
    assert row["source_id"] == "https://huggingface.co/foo/bar/resolve/main/model.safetensors"


def test_url_download_generic_url(client, monkeypatch) -> None:
    _configure_endpoint()
    _inline_threads(monkeypatch)
    monkeypatch.setattr(lora_routes, "_run_download_streaming",
                        lambda entries, eid: (True, {"ok": True}))

    r = client.post("/api/loras/download",
                    json={"source": "url", "url": "https://example.com/some/path/x.safetensors"})
    assert r.status_code == 202
    row = lora_metadata.get("x.safetensors")
    assert row["source"] == "url"


def test_download_subprocess_passes_settings_runpod_key_via_env_not_argv(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    settings_store.set_credential("runpod_api_key", "rpa_download")
    sidecar = tmp_path / "venv" / "bin" / "comfy-gen"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    sidecar.chmod(0o755)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))
    monkeypatch.delenv("RUNPOD_API_KEY", raising=False)

    captured: dict[str, object] = {}

    class FakePopen:
        returncode = 0
        stderr: list[str] = []

        def __init__(self, args, **kwargs):
            captured["args"] = args
            captured["env"] = kwargs.get("env")

        def communicate(self, timeout=None):
            return (json.dumps({"ok": True}), "")

    monkeypatch.setattr(lora_routes.subprocess, "Popen", FakePopen)

    ok, payload = lora_routes._run_download_streaming(
        [{"source": "url", "url": "https://x/a.safetensors", "dest": "loras"}],
        "ep-sidecar",
    )

    assert ok is True
    assert payload == {"ok": True}
    assert captured["env"]["RUNPOD_API_KEY"] == "rpa_download"
    assert "rpa_download" not in captured["args"]


def test_download_appends_filename_to_shared_cache(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    _seed_cache(tmp_path, ["existing.safetensors"])
    _inline_threads(monkeypatch)
    monkeypatch.setattr(lora_routes, "_run_download_streaming",
                        lambda entries, eid: (True, {"ok": True}))

    client.post("/api/loras/download",
                json={"source": "url", "url": "https://example.com/new.safetensors"})

    cached = _cached_filenames(tmp_path)
    assert "new.safetensors" in cached
    assert "existing.safetensors" in cached


def test_download_concurrent_returns_409(client, monkeypatch) -> None:
    _configure_endpoint()
    lora_routes._download_state["state"] = "running"
    lora_routes._download_state["filename"] = "first.safetensors"
    try:
        r = client.post("/api/loras/download",
                        json={"source": "url", "url": "https://x/a.safetensors"})
        assert r.status_code == 409
        assert "first.safetensors" in r.json()["detail"]
    finally:
        lora_routes._reset_download_state()


def test_download_409_when_no_endpoint(client) -> None:
    r = client.post("/api/loras/download",
                    json={"source": "civitai", "version_id": 1})
    assert r.status_code == 409


def test_download_unknown_source_rejected(client, monkeypatch) -> None:
    _configure_endpoint()
    r = client.post("/api/loras/download", json={"source": "ftp", "url": "ftp://x"})
    assert r.status_code == 400


def test_progress_route_reflects_state(client, monkeypatch) -> None:
    _configure_endpoint()
    _inline_threads(monkeypatch)
    monkeypatch.setattr(lora_routes, "_run_download_streaming",
                        lambda entries, eid: (True, {"ok": True}))

    client.post("/api/loras/download",
                json={"source": "url", "url": "https://x/a.safetensors"})
    r = client.get("/api/loras/download/progress")
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "completed"
    assert body["filename"] == "a.safetensors"
    assert "_meta" not in body  # internal field stripped


def test_progress_route_initial_state_is_idle(client) -> None:
    r = client.get("/api/loras/download/progress")
    assert r.json()["state"] == "idle"


def test_clear_state_resets_after_terminal(client, monkeypatch) -> None:
    _configure_endpoint()
    _inline_threads(monkeypatch)
    monkeypatch.setattr(lora_routes, "_run_download_streaming",
                        lambda entries, eid: (True, {"ok": True}))
    client.post("/api/loras/download",
                json={"source": "url", "url": "https://x/a.safetensors"})

    r = client.post("/api/loras/download/clear")
    assert r.status_code == 200
    assert client.get("/api/loras/download/progress").json()["state"] == "idle"


def test_clear_state_409_while_running(client) -> None:
    lora_routes._download_state["state"] = "running"
    try:
        r = client.post("/api/loras/download/clear")
        assert r.status_code == 409
    finally:
        lora_routes._reset_download_state()


def test_subprocess_failure_transitions_to_error(client, monkeypatch) -> None:
    _configure_endpoint()
    _inline_threads(monkeypatch)
    monkeypatch.setattr(lora_routes, "_run_download_streaming",
                        lambda entries, eid: (False, "boom"))

    r = client.post("/api/loras/download",
                    json={"source": "url", "url": "https://x/a.safetensors"})
    body = r.json()
    assert body["state"] == "error"
    assert "boom" in body["error"]
    # Metadata NOT persisted on real failure
    assert lora_metadata.get("a.safetensors") is None


def test_worker_bug_recovery_treats_no_new_files_as_success_when_volume_has_file(
    client, monkeypatch, tmp_path,
) -> None:
    """Reproduces sgs-worker false-negative: comfy-gen errors with
    'CivitAI download produced no new files' even though aria2 finished and
    the file is on the volume. We verify post-error by listing and treat as
    success if the expected filename is present.
    """
    _configure_endpoint()
    _inline_threads(monkeypatch)
    # Subprocess errors with the worker-bug message
    monkeypatch.setattr(lora_routes, "_run_download_streaming",
                        lambda entries, eid: (False, "CivitAI download produced no new files. stdout: ..."))
    # Post-error list shows the file IS on volume
    monkeypatch.setattr(lora_routes, "_fetch_loras_from_comfygen",
                        lambda eid: ["recovered.safetensors"])

    r = client.post("/api/loras/download",
                    json={"source": "url", "url": "https://x/recovered.safetensors"})
    body = r.json()
    assert body["state"] == "completed"
    assert body["recovered_from_worker_bug"] is True
    # Metadata IS persisted via the recovery path
    assert lora_metadata.get("recovered.safetensors") is not None


def test_worker_bug_recovery_stays_error_when_volume_truly_missing_file(
    client, monkeypatch,
) -> None:
    """Same error message, but the file genuinely isn't on the volume —
    must NOT silently treat as success."""
    _configure_endpoint()
    _inline_threads(monkeypatch)
    monkeypatch.setattr(lora_routes, "_run_download_streaming",
                        lambda entries, eid: (False, "CivitAI download produced no new files"))
    monkeypatch.setattr(lora_routes, "_fetch_loras_from_comfygen",
                        lambda eid: ["something_else.safetensors"])

    r = client.post("/api/loras/download",
                    json={"source": "url", "url": "https://x/missing.safetensors"})
    body = r.json()
    assert body["state"] == "error"
    assert lora_metadata.get("missing.safetensors") is None


# ---- POST /api/loras/set-source ----

def test_set_source_civitai_fetches_metadata(client, monkeypatch, mocker) -> None:
    _configure_endpoint()
    monkeypatch.setattr(config, "CIVITAI_API_KEY", "")
    payload = {
        "id": 555, "modelId": 1, "baseModel": "SDXL",
        "trainedWords": ["wow"],
        "files": [{"primary": True, "name": "existing.safetensors", "sizeKB": 50}],
    }
    mocker.patch.object(civitai_client._requests, "get",
                        return_value=_resp(200, payload))

    r = client.post("/api/loras/set-source",
                    json={"filename": "existing.safetensors", "source": "civitai", "source_id": "555"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["lora"]["source"] == "civitai"
    assert body["lora"]["trigger_words"] == ["wow"]
    assert body["lora"]["base_model"] == "SDXL"


def test_set_source_url_persists_without_fetch(client) -> None:
    _configure_endpoint()
    r = client.post("/api/loras/set-source",
                    json={"filename": "x.safetensors", "source": "url",
                          "url": "https://example.com/x.safetensors"})
    assert r.status_code == 200
    row = lora_metadata.get("x.safetensors")
    assert row["source"] == "url"
    assert row["source_id"] == "https://example.com/x.safetensors"


def test_set_source_civitai_requires_integer_id(client) -> None:
    _configure_endpoint()
    r = client.post("/api/loras/set-source",
                    json={"filename": "x.safetensors", "source": "civitai", "source_id": "not-int"})
    assert r.status_code == 400


def test_set_source_invalid_source_rejected(client) -> None:
    r = client.post("/api/loras/set-source",
                    json={"filename": "x.safetensors", "source": "ftp"})
    assert r.status_code == 400

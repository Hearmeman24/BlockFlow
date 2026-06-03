"""HTTP route tests for /api/models/*.

The generalized Models API is the raw endpoint inventory surface. It mirrors
the LoRA management cold-sync/download/delete behavior, but expands the safe
destination set beyond loras.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import pytest  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend import config, lora_metadata, model_routes, settings_store  # noqa: E402
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
    app.include_router(model_routes.router)
    model_routes._reset_download_state()
    return TestClient(app)


def _configure_endpoint() -> None:
    settings_store.set_endpoint(type="comfygen", endpoint_id="ep-test-123", volume_id="vol-1")


def _seed_cache(tmp_path, payload: dict) -> None:
    (tmp_path / "comfy_gen_info_cache.json").write_text(json.dumps(payload), encoding="utf-8")


def test_allowed_folders_are_the_mvp_contract() -> None:
    assert model_routes.ALLOWED_MODEL_FOLDERS == (
        "diffusion_models",
        "loras",
        "text_encoders",
        "vae",
        "upscale_models",
        "checkpoints",
    )


def test_list_returns_409_when_no_endpoint(client) -> None:
    r = client.get("/api/models")
    assert r.status_code == 409


def test_list_reads_all_allowed_cached_folders_and_reconciles_lora_metadata(client, tmp_path) -> None:
    _configure_endpoint()
    lora_metadata.upsert(
        filename="char.safetensors",
        source="civitai",
        source_id="777",
        base_model="Flux.1 D",
        trigger_words=["char trigger"],
    )
    _seed_cache(tmp_path, {
        "version": 2,
        "samplers": [],
        "schedulers": [],
        "loras": [{
            "filename": "char.safetensors",
            "path": "/runpod-volume/ComfyUI/models/loras/char.safetensors",
            "size_mb": 100.5,
        }],
        "models": {
            "checkpoints": [{
                "filename": "base.safetensors",
                "path": "/runpod-volume/ComfyUI/models/checkpoints/base.safetensors",
                "size_mb": 2048,
            }],
            "controlnet": [{
                "filename": "ignored.safetensors",
                "path": "/runpod-volume/ComfyUI/models/controlnet/ignored.safetensors",
                "size_mb": 1,
            }],
        },
        "fetched_at": time.time(),
    })

    r = client.get("/api/models")

    assert r.status_code == 200
    data = r.json()
    assert data["folders"] == list(model_routes.ALLOWED_MODEL_FOLDERS)
    assert data["stale"] is False
    by_key = {(row["folder"], row["filename"]): row for row in data["models"]}
    assert set(by_key) == {("loras", "char.safetensors"), ("checkpoints", "base.safetensors")}
    lora = by_key[("loras", "char.safetensors")]
    assert lora["source"] == "civitai"
    assert lora["source_id"] == "777"
    assert lora["base_model"] == "Flux.1 D"
    assert lora["trigger_words"] == ["char trigger"]
    assert lora["size_bytes"] == int(100.5 * 1024 * 1024)
    checkpoint = by_key[("checkpoints", "base.safetensors")]
    assert checkpoint["source"] == "unknown"
    assert checkpoint["path"] == "/runpod-volume/ComfyUI/models/checkpoints/base.safetensors"


def test_list_marks_stale_when_cache_missing(client) -> None:
    _configure_endpoint()
    r = client.get("/api/models")
    assert r.status_code == 200
    assert r.json()["models"] == []
    assert r.json()["stale"] is True
    assert r.json()["fetched_at"] is None


def test_list_treats_malformed_fetched_at_as_stale_cache(client, tmp_path) -> None:
    _configure_endpoint()
    _seed_cache(tmp_path, {
        "version": 2,
        "samplers": [],
        "schedulers": [],
        "loras": [],
        "models": {"checkpoints": [{"filename": "base.safetensors"}]},
        "fetched_at": "not-a-timestamp",
    })

    r = client.get("/api/models")

    assert r.status_code == 200
    data = r.json()
    assert data["stale"] is True
    assert data["fetched_at"] is None
    assert data["models"][0]["filename"] == "base.safetensors"


def test_sync_lists_each_allowed_folder_and_writes_cache(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    settings_store.set_credential("runpod_api_key", "rpa_models_sync")
    sidecar = tmp_path / "venv" / "bin" / "comfy-gen"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    sidecar.chmod(0o755)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))

    calls: list[list[str]] = []

    def fake_run(args, **kwargs):
        calls.append(list(args))
        folder = args[2]
        return comfy_gen_fakes.run_result(
            stdout=json.dumps({
                "ok": True,
                "model_type": folder,
                "files": [{
                    "filename": f"{folder}.safetensors",
                    "path": f"/runpod-volume/ComfyUI/models/{folder}/{folder}.safetensors",
                    "size_mb": 1.5,
                }],
            }),
            returncode=0,
        )

    monkeypatch.setattr(model_routes.subprocess, "run", fake_run)

    r = client.post("/api/models/sync")

    assert r.status_code == 200
    assert [call[1:3] for call in calls] == [["list", folder] for folder in model_routes.ALLOWED_MODEL_FOLDERS]
    data = json.loads((tmp_path / "comfy_gen_info_cache.json").read_text(encoding="utf-8"))
    assert data["version"] == 2
    assert data["loras"][0]["filename"] == "loras.safetensors"
    assert data["models"]["checkpoints"][0]["filename"] == "checkpoints.safetensors"
    assert {row["folder"] for row in r.json()["models"]} == set(model_routes.ALLOWED_MODEL_FOLDERS)


def test_sync_preserves_structured_cli_error_from_stdout(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    settings_store.set_credential("runpod_api_key", "rpa_models_sync_error")
    sidecar = tmp_path / "venv" / "bin" / "comfy-gen"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    sidecar.chmod(0o755)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))
    _seed_cache(tmp_path, {
        "version": 2,
        "samplers": [],
        "schedulers": [],
        "loras": [],
        "models": {"checkpoints": [{"filename": "cached.safetensors"}]},
        "fetched_at": 1700000000.0,
    })

    monkeypatch.setattr(
        model_routes.subprocess,
        "run",
        lambda *args, **kwargs: comfy_gen_fakes.run_result(
            stdout=json.dumps({"status": "error", "error": "endpoint not found"}),
            stderr="Listing checkpoints on network volume...\n",
            returncode=1,
        ),
    )

    r = client.post("/api/models/sync")

    assert r.status_code == 502
    assert "endpoint not found" in r.json()["detail"]
    data = json.loads((tmp_path / "comfy_gen_info_cache.json").read_text(encoding="utf-8"))
    assert data["models"]["checkpoints"][0]["filename"] == "cached.safetensors"


def test_download_requires_allowed_destination_folder(client) -> None:
    _configure_endpoint()
    r = client.post("/api/models/download", json={
        "source": "url",
        "url": "https://example.com/model.safetensors",
        "folder": "../checkpoints",
    })
    assert r.status_code == 400
    assert "folder must be one of" in r.json()["detail"]


def test_civitai_download_uses_selected_destination_folder(client, monkeypatch) -> None:
    _configure_endpoint()
    model_routes._inline_threads_for_tests(monkeypatch)
    captured: list[tuple[list[dict], str]] = []
    monkeypatch.setattr(
        model_routes,
        "_run_download_streaming",
        lambda entries, eid: (captured.append((entries, eid)), (True, {"ok": True}))[1],
    )

    r = client.post("/api/models/download", json={
        "source": "civitai",
        "version_id": 12345,
        "folder": "checkpoints",
        "filename": "model.safetensors",
    })

    assert r.status_code == 202
    assert r.json()["state"] == "completed"
    assert captured[0][0] == [{
        "source": "civitai",
        "version_id": 12345,
        "dest": "checkpoints",
        "filename": "model.safetensors",
    }]


def test_civitai_download_without_filename_passes_fallback_filename_to_worker(client, monkeypatch) -> None:
    """If BlockFlow records a fallback filename in state/cache, it must pass
    the same filename to comfy-gen so the endpoint writes the file we cache."""
    _configure_endpoint()
    model_routes._inline_threads_for_tests(monkeypatch)
    captured: list[tuple[list[dict], str]] = []
    monkeypatch.setattr(
        model_routes,
        "_run_download_streaming",
        lambda entries, eid: (captured.append((entries, eid)), (True, {"ok": True}))[1],
    )

    r = client.post("/api/models/download", json={
        "source": "civitai",
        "version_id": 67890,
        "folder": "checkpoints",
    })

    assert r.status_code == 202
    assert r.json()["filename"] == "civitai_67890.safetensors"
    assert captured[0][0] == [{
        "source": "civitai",
        "version_id": 67890,
        "dest": "checkpoints",
        "filename": "civitai_67890.safetensors",
    }]


def test_delete_uses_canonical_paths_and_cleans_only_lora_metadata(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    _seed_cache(tmp_path, {
        "version": 2,
        "samplers": [],
        "schedulers": [],
        "loras": [{"filename": "drop-lora.safetensors"}],
        "models": {"checkpoints": [{"filename": "drop-ckpt.safetensors"}]},
        "fetched_at": 1700000000.0,
    })
    lora_metadata.upsert(filename="drop-lora.safetensors", source="civitai", source_id="1")

    captured: dict[str, object] = {}

    def fake_delete(items, endpoint_id):
        captured["items"] = items
        return [
            {"path": "/runpod-volume/ComfyUI/models/loras/drop-lora.safetensors", "deleted": True},
            {"path": "/runpod-volume/ComfyUI/models/checkpoints/drop-ckpt.safetensors", "deleted": True},
        ]

    monkeypatch.setattr(model_routes, "_delete_subprocess", fake_delete)

    r = client.post("/api/models/delete", json={"items": [
        {"folder": "loras", "filename": "drop-lora.safetensors"},
        {"folder": "checkpoints", "filename": "drop-ckpt.safetensors"},
    ]})

    assert r.status_code == 200
    assert captured["items"] == [
        {"folder": "loras", "filename": "drop-lora.safetensors",
         "path": "/runpod-volume/ComfyUI/models/loras/drop-lora.safetensors"},
        {"folder": "checkpoints", "filename": "drop-ckpt.safetensors",
         "path": "/runpod-volume/ComfyUI/models/checkpoints/drop-ckpt.safetensors"},
    ]
    assert lora_metadata.get("drop-lora.safetensors") is None
    data = json.loads((tmp_path / "comfy_gen_info_cache.json").read_text(encoding="utf-8"))
    assert data["loras"] == []
    assert data["models"]["checkpoints"] == []


def test_delete_partial_failure_keeps_failed_item_in_cache(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    _seed_cache(tmp_path, {
        "version": 2,
        "samplers": [],
        "schedulers": [],
        "loras": [],
        "models": {"checkpoints": [
            {"filename": "ok.safetensors"},
            {"filename": "fail.safetensors"},
        ]},
        "fetched_at": 1700000000.0,
    })

    monkeypatch.setattr(
        model_routes,
        "_delete_subprocess",
        lambda items, endpoint_id: [
            {"path": "/runpod-volume/ComfyUI/models/checkpoints/ok.safetensors", "deleted": True},
            {"path": "/runpod-volume/ComfyUI/models/checkpoints/fail.safetensors",
             "deleted": False, "error": "in use"},
        ],
    )

    r = client.post("/api/models/delete", json={"items": [
        {"folder": "checkpoints", "filename": "ok.safetensors"},
        {"folder": "checkpoints", "filename": "fail.safetensors"},
    ]})

    assert r.status_code == 207
    data = json.loads((tmp_path / "comfy_gen_info_cache.json").read_text(encoding="utf-8"))
    assert [item["filename"] for item in data["models"]["checkpoints"]] == ["fail.safetensors"]


def test_delete_subprocess_surfaces_structured_stdout_error(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    settings_store.set_credential("runpod_api_key", "rpa_delete_structured_error")
    sidecar = tmp_path / "venv" / "bin" / "comfy-gen"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    sidecar.chmod(0o755)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))

    monkeypatch.setattr(
        model_routes.subprocess,
        "run",
        lambda *args, **kwargs: comfy_gen_fakes.run_result(
            stdout=json.dumps({"status": "error", "error": "endpoint not found"}),
            returncode=0,
        ),
    )

    with pytest.raises(HTTPException) as exc:
        model_routes._delete_subprocess([{
            "folder": "checkpoints",
            "filename": "bad.safetensors",
            "path": "/runpod-volume/ComfyUI/models/checkpoints/bad.safetensors",
        }], "ep-test-123")

    assert exc.value.status_code == 502
    assert "endpoint not found" in exc.value.detail


def test_delete_subprocess_reads_final_json_after_status_lines(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    settings_store.set_credential("runpod_api_key", "rpa_delete_mixed_stdout")
    sidecar = tmp_path / "venv" / "bin" / "comfy-gen"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    sidecar.chmod(0o755)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))
    stdout = "\n".join([
        "Deleting models on network volume...",
        json.dumps({"results": [{
            "path": "/runpod-volume/ComfyUI/models/checkpoints/a.safetensors",
            "deleted": True,
        }]}),
    ])
    monkeypatch.setattr(
        model_routes.subprocess,
        "run",
        lambda *args, **kwargs: comfy_gen_fakes.run_result(stdout=stdout, returncode=0),
    )

    result = model_routes._delete_subprocess([{
        "folder": "checkpoints",
        "filename": "a.safetensors",
        "path": "/runpod-volume/ComfyUI/models/checkpoints/a.safetensors",
    }], "ep-test-123")

    assert result[0]["deleted"] is True


def test_delete_route_reports_omitted_requested_items_as_failures(client, monkeypatch) -> None:
    _configure_endpoint()
    monkeypatch.setattr(
        model_routes,
        "_delete_subprocess",
        lambda items, endpoint_id: [{
            "path": "/runpod-volume/ComfyUI/models/checkpoints/a.safetensors",
            "deleted": True,
        }],
    )

    r = client.post("/api/models/delete", json={"items": [
        {"folder": "checkpoints", "filename": "a.safetensors"},
        {"folder": "checkpoints", "filename": "missing.safetensors"},
    ]})

    assert r.status_code == 207
    by_name = {item["filename"]: item for item in r.json()["results"]}
    assert by_name["a.safetensors"]["deleted"] is True
    assert by_name["missing.safetensors"]["deleted"] is False
    assert "no result returned" in by_name["missing.safetensors"]["error"]


def test_delete_route_returns_exactly_one_result_per_requested_item_in_request_order(client, monkeypatch) -> None:
    _configure_endpoint()
    monkeypatch.setattr(
        model_routes,
        "_delete_subprocess",
        lambda items, endpoint_id: [
            {
                "path": "/runpod-volume/ComfyUI/models/checkpoints/extra.safetensors",
                "deleted": True,
            },
            {
                "path": "/runpod-volume/ComfyUI/models/checkpoints/b.safetensors",
                "deleted": False,
                "error": "locked",
            },
            {
                "path": "/runpod-volume/ComfyUI/models/checkpoints/a.safetensors",
                "deleted": True,
            },
        ],
    )

    r = client.post("/api/models/delete", json={"items": [
        {"folder": "checkpoints", "filename": "a.safetensors"},
        {"folder": "checkpoints", "filename": "b.safetensors"},
        {"folder": "checkpoints", "filename": "a.safetensors"},
    ]})

    assert r.status_code == 207
    assert r.json()["results"] == [
        {
            "folder": "checkpoints",
            "filename": "a.safetensors",
            "path": "/runpod-volume/ComfyUI/models/checkpoints/a.safetensors",
            "deleted": True,
            "error": None,
        },
        {
            "folder": "checkpoints",
            "filename": "b.safetensors",
            "path": "/runpod-volume/ComfyUI/models/checkpoints/b.safetensors",
            "deleted": False,
            "error": "locked",
        },
        {
            "folder": "checkpoints",
            "filename": "a.safetensors",
            "path": "/runpod-volume/ComfyUI/models/checkpoints/a.safetensors",
            "deleted": True,
            "error": None,
        },
    ]


def test_download_streaming_surfaces_structured_stdout_error(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    settings_store.set_credential("runpod_api_key", "rpa_download_structured_error")
    sidecar = tmp_path / "venv" / "bin" / "comfy-gen"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    sidecar.chmod(0o755)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))

    class FakePopen:
        returncode = 0
        stderr: list[str] = []

        def __init__(self, *args, **kwargs):
            pass

        def communicate(self, timeout=None):
            return (json.dumps({"status": "error", "error": "download refused"}), "")

    monkeypatch.setattr(model_routes.subprocess, "Popen", FakePopen)

    ok, payload = model_routes._run_download_streaming([{
        "source": "url",
        "url": "https://example.com/bad.safetensors",
        "dest": "checkpoints",
    }], "ep-test-123")

    assert ok is False
    assert "download refused" in payload


def test_download_streaming_reads_final_json_after_status_lines(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    settings_store.set_credential("runpod_api_key", "rpa_download_mixed_stdout")
    sidecar = tmp_path / "venv" / "bin" / "comfy-gen"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    sidecar.chmod(0o755)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))

    class FakePopen:
        returncode = 0
        stderr: list[str] = []

        def __init__(self, *args, **kwargs):
            pass

        def communicate(self, timeout=None):
            return ("Downloading...\n" + json.dumps({"ok": True}), "")

    monkeypatch.setattr(model_routes.subprocess, "Popen", FakePopen)

    ok, payload = model_routes._run_download_streaming([{
        "source": "url",
        "url": "https://example.com/a.safetensors",
        "dest": "checkpoints",
    }], "ep-test-123")

    assert ok is True
    assert payload == {"ok": True}


def test_download_streaming_nonzero_exit_prefers_structured_stdout_error(client, monkeypatch, tmp_path) -> None:
    _configure_endpoint()
    settings_store.set_credential("runpod_api_key", "rpa_download_nonzero_structured")
    sidecar = tmp_path / "venv" / "bin" / "comfy-gen"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    sidecar.chmod(0o755)
    monkeypatch.setenv("BLOCKFLOW_COMFY_GEN_VENV", str(sidecar.parent.parent))

    class FakePopen:
        returncode = 1
        stderr: list[str] = []

        def __init__(self, *args, **kwargs):
            pass

        def communicate(self, timeout=None):
            return ("Downloading...\n" + json.dumps({"status": "error", "error": "worker refused"}), "")

    monkeypatch.setattr(model_routes.subprocess, "Popen", FakePopen)

    ok, payload = model_routes._run_download_streaming([{
        "source": "url",
        "url": "https://example.com/a.safetensors",
        "dest": "checkpoints",
    }], "ep-test-123")

    assert ok is False
    assert payload == "worker refused"


def test_download_rejects_concurrent_submit(client, monkeypatch) -> None:
    _configure_endpoint()

    class NoopThread:
        def __init__(self, target=None, daemon=None, **kwargs):
            self._target = target
        def start(self):
            return None

    monkeypatch.setattr(model_routes.threading, "Thread", NoopThread)
    r1 = client.post("/api/models/download", json={
        "source": "url",
        "url": "https://example.com/a.safetensors",
        "folder": "vae",
    })
    r2 = client.post("/api/models/download", json={
        "source": "url",
        "url": "https://example.com/b.safetensors",
        "folder": "vae",
    })
    assert r1.status_code == 202
    assert r2.status_code == 409


def test_download_progress_and_clear_routes(client) -> None:
    _configure_endpoint()
    model_routes._download_state.update({"state": "completed", "filename": "x.safetensors"})
    assert client.get("/api/models/download/progress").json()["filename"] == "x.safetensors"
    r = client.post("/api/models/download/clear")
    assert r.status_code == 200
    assert client.get("/api/models/download/progress").json()["state"] == "idle"

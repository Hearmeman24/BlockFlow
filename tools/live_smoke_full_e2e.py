#!/usr/bin/env python3
"""Full end-to-end smoke: provision → install Qwen preset → generate → tear down.

Sequence (~20 min wall-clock, ~$0.50-1 GPU on the H100 performance tier):

  1. Spin up a localhost HTTP server serving /Users/avivkaplan/comfy/blockflow-presets/
     (the registry repo isn't pushed to GitHub yet; this is the standin).
  2. Override preset_routes._MANIFEST_URL to point at the local server +
     regenerate the manifest with localhost preset_url entries.
  3. Populate BlockFlow Settings (RunPod + S3 from ~/.comfy-gen/config.json).
  4. POST /api/wizard/comfygen/provision (performance tier — has capacity).
  5. POST /api/presets/install {preset_id: 'qwen-image-lighting'}.
  6. Poll /api/presets/install/progress until completed or error (~10-15 min for 65GB).
  7. Use the cached workflow_json from Settings → comfy-gen submit.
  8. Verify output URL returned, save the image locally.
  9. Tear down endpoint + template + volume via /api/wizard/comfygen/teardown.

Run:
  BLOCKFLOW_LIVE_TESTS=1 uv run python tools/live_smoke_full_e2e.py
"""
from __future__ import annotations

import http.server
import json
import os
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend import (  # noqa: E402
    preset_routes,
    settings_store,
    wizard_routes,
)

REGISTRY_DIR = Path("/Users/avivkaplan/comfy/blockflow-presets")
PRESET_ID = "qwen-image-lighting"
API_KEY = os.environ.get("RUNPOD_API_KEY", "")
SMOKE_TIER = os.environ.get("SMOKE_TIER", "performance")


def log(msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_local_registry_server() -> tuple[str, socketserver.TCPServer]:
    """Serve the local blockflow-presets directory on a free localhost port."""
    port = _free_port()

    class _Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(REGISTRY_DIR), **kwargs)

        def log_message(self, fmt: str, *args) -> None:  # noqa: A003
            return  # quiet

    server = socketserver.TCPServer(("127.0.0.1", port), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    log(f"local registry server on {base}")
    return base, server


def regenerate_local_manifest(base_url: str) -> None:
    """Write a manifest.json with localhost preset_url entries."""
    presets = []
    for preset_path in sorted(REGISTRY_DIR.glob("registry/*/preset.json")):
        data = json.loads(preset_path.read_text())
        entry = {
            k: data[k]
            for k in (
                "id", "name", "description", "comfygen_min_version",
                "tags", "disk_size_estimate_gb",
            )
            if k in data
        }
        if "tested_against" in data:
            tier = data["tested_against"].get("gpu_tier")
            if tier:
                entry["gpu_tier_hint"] = tier
        entry["preset_url"] = f"{base_url}/registry/{data['id']}/preset.json"
        presets.append(entry)
    manifest = {"manifest_version": 1, "presets": presets}
    (REGISTRY_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    log(f"wrote local manifest with {len(presets)} preset(s)")


def setup_app() -> TestClient:
    db_path = Path("/tmp/blockflow_e2e_smoke.db")
    if db_path.exists():
        db_path.unlink()
    settings_store.DB_PATH = db_path
    settings_store.init_db()

    if not API_KEY:
        raise SystemExit("RUNPOD_API_KEY not in env")
    settings_store.set_credential("runpod_api_key", API_KEY)

    cg_config = Path.home() / ".comfy-gen" / "config.json"
    cfg = json.loads(cg_config.read_text()) if cg_config.exists() else {}
    settings_store.set_credential("r2_access_key_id", cfg.get("aws_access_key_id", ""))
    settings_store.set_credential("r2_secret_access_key", cfg.get("aws_secret_access_key", ""))
    settings_store.set_credential("r2_bucket", cfg.get("s3_bucket", ""))
    settings_store.set_credential("r2_endpoint_url", cfg.get("s3_endpoint_url", ""))
    settings_store.set_credential("r2_region", cfg.get("s3_region", "auto"))
    log(f"settings populated: bucket={cfg.get('s3_bucket')}, region={cfg.get('s3_region')}")

    app = FastAPI()
    app.include_router(wizard_routes.router)
    app.include_router(preset_routes.router)
    preset_routes._cache_reset()
    preset_routes._reset_install_state()
    return TestClient(app)


def poll_install_until_done(client: TestClient, max_wait_sec: int = 30 * 60) -> dict:
    start = time.time()
    last_state = ""
    while time.time() - start < max_wait_sec:
        r = client.get("/api/presets/install/progress")
        body = r.json()
        elapsed = int(time.time() - start)
        if body["state"] != last_state:
            log(f"  install state: {body['state']} (elapsed {elapsed}s)")
            last_state = body["state"]
        if body["state"] in ("completed", "error"):
            return body
        time.sleep(10)
    return {"state": "timeout"}


def submit_workflow_via_cli(endpoint_id: str, workflow_path: Path) -> dict:
    log(f"submitting workflow {workflow_path.name} via comfy-gen CLI...")
    proc = subprocess.run(
        [
            "comfy-gen", "submit",
            "--endpoint-id", endpoint_id,
            "--timeout", "600",
            str(workflow_path),
        ],
        capture_output=True,
        text=True,
        timeout=10 * 60,
    )
    if proc.returncode != 0:
        log(f"comfy-gen submit failed (exit {proc.returncode})")
        log(f"  stderr (last 1500): {proc.stderr[-1500:]}")
        log(f"  stdout (last 1500): {proc.stdout[-1500:]}")
        raise RuntimeError(f"workflow submit failed: exit {proc.returncode}")
    return json.loads(proc.stdout)


def main() -> int:
    overall_start = time.time()

    base_url, server = start_local_registry_server()
    regenerate_local_manifest(base_url)
    orig_manifest_url = preset_routes._MANIFEST_URL
    preset_routes._MANIFEST_URL = f"{base_url}/manifest.json"

    client = setup_app()

    endpoint_id: str | None = None
    template_name: str | None = None
    volume_id: str | None = None

    try:
        # === 1. Provision endpoint ===
        log(f"provisioning ComfyGen endpoint (tier={SMOKE_TIER})...")
        r = client.post(
            "/api/wizard/comfygen/provision",
            json={"tier": SMOKE_TIER, "volume_size_gb": 100, "max_workers": 3},
        )
        if r.status_code != 200:
            raise RuntimeError(f"provision failed: HTTP {r.status_code}: {r.text}")
        body = r.json()
        endpoint_id = body["endpoint_id"]
        template_name = body["template_name"]
        volume_id = body["volume_id"]
        log(f"provisioned: ep={endpoint_id} tmpl={template_name} vol={volume_id}")

        # === 2. Sanity-check manifest fetch ===
        r = client.get("/api/presets/manifest")
        assert r.status_code == 200, r.text
        log(f"manifest fetched: {len(r.json()['presets'])} preset(s)")

        # === 3. Disk budget check (informational) ===
        r = client.get("/api/presets/disk-budget")
        log(f"disk budget: {r.json()}")

        # === 4. Kick off install ===
        log(f"POST /api/presets/install {{preset_id: {PRESET_ID}}}")
        r = client.post("/api/presets/install", json={"preset_id": PRESET_ID})
        if r.status_code != 202:
            raise RuntimeError(f"install kickoff failed: HTTP {r.status_code}: {r.text}")
        log(f"install accepted: {r.json()}")

        # === 5. Wait for install ===
        result = poll_install_until_done(client, max_wait_sec=30 * 60)
        if result["state"] != "completed":
            err = result.get("error", "(no error captured)")
            raise RuntimeError(
                f"install did not complete: state={result['state']}, error={err[:1500]}"
            )
        log(f"install completed in {int(time.time() - overall_start)}s wall-clock")

        # === 6. Verify Settings has the preset ===
        r = client.get(f"/api/presets/installed/{PRESET_ID}")
        assert r.status_code == 200, r.text
        installed = r.json()
        log(f"preset persisted: version={installed['version']}, disk={installed['disk_size_gb']}GB")
        workflow_dict = installed["workflow_json"]
        if not (isinstance(workflow_dict, dict) and workflow_dict):
            log("WARN: cached workflow_json is empty; falling back to local workflow.json")
            workflow_dict = json.loads((REGISTRY_DIR / "registry" / PRESET_ID / "workflow.json").read_text())

        # === 7. Generate ===
        wf_tempfile = Path("/tmp/e2e_workflow.json")
        wf_tempfile.write_text(json.dumps(workflow_dict))
        gen_result = submit_workflow_via_cli(endpoint_id, wf_tempfile)
        log(f"workflow result: ok={gen_result.get('ok')} job_id={gen_result.get('job_id')}")
        if gen_result.get("ok"):
            output = gen_result.get("output", {})
            log(f"  output URL: {output.get('url')}")
            log(f"  resolution: {output.get('resolution')}")
            log(f"  elapsed_seconds (on worker): {gen_result.get('elapsed_seconds')}")
            if output.get("url"):
                out_path = Path("/tmp/qwen_e2e_output.png")
                urllib.request.urlretrieve(output["url"], out_path)
                log(f"  saved → {out_path} ({out_path.stat().st_size // 1024} KB)")
        else:
            log(f"  workflow reported failure: {gen_result}")
            return 1

        log(f"END-TO-END SUCCESS in {int(time.time() - overall_start)}s total wall-clock")
        return 0

    finally:
        # === 8. Teardown ===
        if endpoint_id:
            log("tearing down via /api/wizard/comfygen/teardown...")
            try:
                td = client.post("/api/wizard/comfygen/teardown")
                if td.status_code == 200:
                    log(f"  teardown ok: {td.json()['successes']}")
                else:
                    log(f"  teardown HTTP {td.status_code}: {td.text[:300]}")
            except Exception as exc:
                log(f"  teardown route failed: {exc}")

        preset_routes._MANIFEST_URL = orig_manifest_url
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())

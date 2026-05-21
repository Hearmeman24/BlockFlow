#!/usr/bin/env python3
"""End-to-end live smoke for the ComfyGen setup wizard (sgs-ui-wisp-las.2 Stage B.5).

Spins up a real ComfyGen endpoint via BlockFlow's wizard route, runs the
SDXL Turbo example workflow on it, and tears everything down. Real GPU
compute is consumed (expected: ~$0.50–$2 in RunPod credits).

Run:
    BLOCKFLOW_LIVE_TESTS=1 uv run python tools/live_smoke_wizard_e2e.py

Requires RUNPOD_API_KEY in env. Uses comfy-gen CLI for workflow submission
(installed at /opt/homebrew/bin/comfy-gen).

This is NOT a pytest test because it can take 15-25 minutes (cold-start).
Standalone script makes the long-running nature explicit.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend import runpod_api, settings_store, wizard_routes  # noqa: E402

API_KEY = os.environ.get("RUNPOD_API_KEY", "")
EXAMPLE_WORKFLOW = Path("/Users/avivkaplan/src/comfy/remote_comfy_generator/examples/sdxl_turbo_portrait.json")
COLD_START_TIMEOUT_S = 30 * 60  # 30 min upper bound for first cold start
JOB_TIMEOUT_S = 15 * 60          # 15 min for SDXL Turbo workflow to complete


def log(msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def setup_app() -> tuple[TestClient, Path]:
    """Build a FastAPI app with the wizard router + an isolated settings DB."""
    db_path = Path("/tmp/blockflow_live_smoke.db")
    if db_path.exists():
        db_path.unlink()

    settings_store.DB_PATH = db_path
    settings_store.init_db()

    # Real RunPod key; dummy R2 creds (not exercised by the SDXL Turbo path)
    settings_store.set_credential("runpod_api_key", API_KEY)
    settings_store.set_credential("r2_endpoint_url", "https://example.r2.cloudflarestorage.com")
    settings_store.set_credential("r2_access_key_id", "dummy-access-key")
    settings_store.set_credential("r2_secret_access_key", "dummy-secret-key")
    settings_store.set_credential("r2_bucket", "blockflow-live-smoke-bucket")

    app = FastAPI()
    app.include_router(wizard_routes.router)
    return TestClient(app), db_path


def poll_until_ready(client: TestClient, endpoint_id: str) -> None:
    """Wait for at least one worker to be ready (or idle), up to COLD_START_TIMEOUT_S."""
    log(f"polling /health for endpoint {endpoint_id} (cold-start can take 15-20min)...")
    start = time.time()
    last_print = 0.0
    while True:
        elapsed = time.time() - start
        if elapsed > COLD_START_TIMEOUT_S:
            raise TimeoutError(f"endpoint not ready after {COLD_START_TIMEOUT_S}s")

        r = client.get(f"/api/wizard/comfygen/health/{endpoint_id}")
        if r.status_code != 200:
            log(f"  health check returned {r.status_code}: {r.text[:200]}")
        else:
            workers = r.json().get("workers", {})
            if elapsed - last_print > 30:
                log(f"  workers={workers} elapsed={int(elapsed)}s")
                last_print = elapsed
            # Worker is "ready" once the container has spun up. We don't need
            # it to actually be processing — submit will trigger that.
            if workers.get("ready", 0) > 0 or workers.get("idle", 0) > 0:
                log(f"  worker ready after {int(elapsed)}s: {workers}")
                return
            # Also accept "initializing > 0" as a sign the cold-start is in progress;
            # comfy-gen submit will queue the job and wait too.
        time.sleep(15)


def submit_workflow(endpoint_id: str) -> dict:
    """Use comfy-gen CLI to submit the SDXL Turbo workflow against our endpoint."""
    log(f"submitting workflow {EXAMPLE_WORKFLOW.name} to endpoint {endpoint_id}...")
    proc = subprocess.run(
        [
            "comfy-gen", "submit",
            "--endpoint-id", endpoint_id,
            "--timeout", str(JOB_TIMEOUT_S),
            str(EXAMPLE_WORKFLOW),
        ],
        capture_output=True,
        text=True,
        timeout=COLD_START_TIMEOUT_S + JOB_TIMEOUT_S,
    )
    if proc.returncode != 0:
        log(f"  comfy-gen submit failed (exit {proc.returncode}):")
        log(f"  stderr (tail): {proc.stderr[-1500:]}")
        raise RuntimeError(f"workflow submission failed: exit {proc.returncode}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        log(f"  comfy-gen submit returned non-JSON stdout: {proc.stdout[:500]}")
        raise


def main() -> int:
    if not API_KEY:
        log("RUNPOD_API_KEY not set; aborting")
        return 2

    if not EXAMPLE_WORKFLOW.exists():
        log(f"example workflow missing: {EXAMPLE_WORKFLOW}")
        return 2

    client, db_path = setup_app()
    log(f"settings db at {db_path}")

    endpoint_id: str | None = None
    template_name: str | None = None
    volume_id: str | None = None
    overall_start = time.time()

    try:
        # === provision ===
        # Use wizard defaults: tier=budget (low tier per request), but
        # NO max_workers override so the canonical default of 3 applies
        # (ComfyGen=3 + trainer=2 = 5 = RunPod free worker cap).
        log("provisioning ComfyGen endpoint (tier=budget, max_workers=default=3)...")
        r = client.post(
            "/api/wizard/comfygen/provision",
            json={"tier": "budget", "volume_size_gb": 50},
        )
        if r.status_code != 200:
            log(f"provision failed: HTTP {r.status_code}: {r.text}")
            return 1
        body = r.json()
        endpoint_id = body["endpoint_id"]
        template_name = body["template_name"]
        volume_id = body["volume_id"]
        log(f"provisioned: endpoint={endpoint_id} template={body['template_id']} volume={volume_id}")

        # === wait for worker ready ===
        poll_until_ready(client, endpoint_id)

        # === run the workflow ===
        result = submit_workflow(endpoint_id)
        log(f"workflow result: ok={result.get('ok')} job_id={result.get('job_id')}")
        if result.get("ok"):
            output = result.get("output", {})
            log(f"  output URL: {output.get('url')}")
            log(f"  resolution: {output.get('resolution')}")
            log(f"  seed: {output.get('seed')}")
            log(f"  elapsed_seconds (on worker): {result.get('elapsed_seconds')}")
        else:
            log(f"  workflow reported failure: {result}")
            return 1

        log(f"END-TO-END SUCCESS in {int(time.time() - overall_start)}s total wall-clock")
        return 0

    finally:
        # Teardown — best-effort
        if endpoint_id:
            try:
                runpod_api.delete_endpoint(API_KEY, endpoint_id)
                log(f"deleted endpoint {endpoint_id}")
            except Exception as exc:
                log(f"WARN: endpoint cleanup failed: {exc}")

        if template_name:
            for attempt in range(8):
                try:
                    runpod_api.delete_template(API_KEY, template_name=template_name)
                    log(f"deleted template {template_name}")
                    break
                except Exception as exc:
                    if attempt == 7:
                        log(f"WARN: template cleanup failed: {exc}")
                        break
                    time.sleep(8)

        if volume_id:
            for attempt in range(8):
                try:
                    runpod_api.delete_network_volume(API_KEY, volume_id)
                    log(f"deleted volume {volume_id}")
                    break
                except Exception as exc:
                    if attempt == 7:
                        log(f"WARN: volume cleanup failed: {exc}")
                        break
                    time.sleep(5)


if __name__ == "__main__":
    sys.exit(main())

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
# Defaults to a fixture sibling-checked-in next to the smoke runner; override
# via SMOKE_EXAMPLE_WORKFLOW for a local ComfyGen checkout if you have one.
EXAMPLE_WORKFLOW = Path(
    os.environ.get("SMOKE_EXAMPLE_WORKFLOW")
    or (ROOT / "tools" / "fixtures" / "sdxl_turbo_portrait.json")
).expanduser()
COLD_START_TIMEOUT_S = 30 * 60  # 30 min upper bound for first cold start
JOB_TIMEOUT_S = 15 * 60          # 15 min for SDXL Turbo workflow to complete


def log(msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def setup_app() -> tuple[TestClient, Path]:
    """Build a FastAPI app with the wizard router + an isolated settings DB.

    Sources S3/R2 credentials from `~/.comfy-gen/config.json` if present, so
    the worker baked into the new endpoint can actually read/write the
    user's existing bucket (otherwise the SDXL Turbo job fails when it tries
    to upload outputs)."""
    db_path = Path("/tmp/blockflow_live_smoke.db")
    if db_path.exists():
        db_path.unlink()

    settings_store.DB_PATH = db_path
    settings_store.init_db()
    settings_store.set_credential("runpod_api_key", API_KEY)

    # Pull real S3 creds from ComfyGen's existing init config if available.
    # This is smoke-specific behavior — production BlockFlow reads from its
    # own Settings UI; we're just borrowing the user's already-configured
    # creds so the worker has working credentials for the run.
    cg_config = Path.home() / ".comfy-gen" / "config.json"
    if cg_config.exists():
        try:
            cfg = json.loads(cg_config.read_text())
        except Exception:
            cfg = {}
    else:
        cfg = {}

    s3_access = cfg.get("aws_access_key_id") or ""
    s3_secret = cfg.get("aws_secret_access_key") or ""
    s3_bucket = cfg.get("s3_bucket") or ""
    s3_endpoint = cfg.get("s3_endpoint_url") or ""
    s3_region = cfg.get("s3_region") or "auto"

    if s3_access and s3_secret and s3_bucket:
        log(f"[smoke] using ComfyGen's S3 creds (bucket={s3_bucket}, region={s3_region}, endpoint={s3_endpoint or '<AWS default>'})")
    else:
        log("[smoke] WARN: no ComfyGen S3 creds found; falling back to dummies (worker S3 ops will fail)")
        s3_access = "dummy-access-key"
        s3_secret = "dummy-secret-key"
        s3_bucket = "blockflow-live-smoke-bucket"
        s3_endpoint = "https://example.r2.cloudflarestorage.com"
        s3_region = "auto"

    settings_store.set_credential("r2_endpoint_url", s3_endpoint)
    settings_store.set_credential("r2_access_key_id", s3_access)
    settings_store.set_credential("r2_secret_access_key", s3_secret)
    settings_store.set_credential("r2_bucket", s3_bucket)
    settings_store.set_credential("r2_region", s3_region)

    # Also forward CivitAI if configured — some workflows need it to fetch LoRAs
    if cfg.get("civitai_token"):
        settings_store.set_credential("civitai_api_key", cfg["civitai_token"])

    app = FastAPI()
    app.include_router(wizard_routes.router)
    return TestClient(app), db_path


def health_snapshot(client: TestClient, endpoint_id: str) -> dict:
    """One-shot health peek — used for diagnostic logging, not as a gate."""
    r = client.get(f"/api/wizard/comfygen/health/{endpoint_id}")
    if r.status_code != 200:
        return {"error": f"HTTP {r.status_code}: {r.text[:200]}"}
    return r.json().get("workers", {})


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
        log("  ==== full stderr ====")
        log(proc.stderr)
        log("  ==== full stdout ====")
        log(proc.stdout)
        log("  ==== end of comfy-gen submit output ====")
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
        # First attempt: budget (RTX 5090 EU-RO-1). Per user direction, fall
        # back to recommended/performance tiers if budget has no supply.
        tier_fallback = os.environ.get("SMOKE_TIER", "recommended")
        log(f"provisioning ComfyGen endpoint (tier={tier_fallback}, max_workers=default=3)...")
        r = client.post(
            "/api/wizard/comfygen/provision",
            json={"tier": tier_fallback, "volume_size_gb": 50},
        )
        if r.status_code != 200:
            log(f"provision failed: HTTP {r.status_code}: {r.text}")
            return 1
        body = r.json()
        endpoint_id = body["endpoint_id"]
        template_name = body["template_name"]
        volume_id = body["volume_id"]
        log(f"provisioned: endpoint={endpoint_id} template={body['template_id']} volume={volume_id}")

        # === one-shot health snapshot for diagnostic only (no gating) ===
        # workersMin=0 means RunPod doesn't spin up a worker until a job is
        # submitted. Polling for ready BEFORE submit waits forever.
        # comfy-gen submit will queue the job, RunPod cold-starts the worker,
        # job runs. submit polls internally.
        log(f"endpoint health snapshot (pre-submit): {health_snapshot(client, endpoint_id)}")

        # === pre-download SDXL Turbo to the network volume ===
        # Fresh volume has no models; the workflow references
        # sd_xl_turbo_1.0_fp16.safetensors. Download via comfy-gen.
        log("pre-downloading SDXL Turbo to volume via comfy-gen download...")
        dl_proc = subprocess.run(
            [
                "comfy-gen", "download", "url",
                "https://huggingface.co/stabilityai/sdxl-turbo/resolve/main/sd_xl_turbo_1.0_fp16.safetensors",
                "--dest", "checkpoints",
                "--filename", "sd_xl_turbo_1.0_fp16.safetensors",
                "--endpoint-id", endpoint_id,
                "--timeout", "900",
            ],
            capture_output=True,
            text=True,
            timeout=15 * 60,
        )
        if dl_proc.returncode != 0:
            log(f"download failed (exit {dl_proc.returncode}):")
            log(f"  stderr: {dl_proc.stderr[-1500:]}")
            log(f"  stdout: {dl_proc.stdout[-1500:]}")
            raise RuntimeError(f"model download failed: exit {dl_proc.returncode}")
        log(f"download complete: {dl_proc.stdout[:300]}")

        # === run the workflow ===
        log("submitting workflow — model is now on volume, expect ~30s inference")
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

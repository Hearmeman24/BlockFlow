"""Preset installer (sgs-ui-wisp-las.3 Stages A + B).

Routes:
  Stage A (read-only):
    - GET  /api/presets/manifest[?refresh=1]      → fetch registry manifest
    - GET  /api/presets/manifest/{preset_id}      → one preset's full detail
    - GET  /api/presets/installed                 → list installed presets
    - GET  /api/presets/installed/{preset_id}     → one installed preset

  Stage B (install / uninstall):
    - POST /api/presets/install         { preset_id }   → kicks off batch download
    - GET  /api/presets/install/progress             → snapshot of current install
    - POST /api/presets/uninstall/{preset_id}        → drops Settings row

The manifest is fetched from a single public URL (per .3 design grilling):
`https://raw.githubusercontent.com/Hearmeman24/blockflow-presets/main/manifest.json`.
1-hour in-memory cache + on-disk fallback for offline cases.

Install flow (Stage B):
  1. Fetch the full preset.json from manifest[preset_id].preset_url
  2. Pre-check disk space: RunPod gives volume total size; subtract sum of
     installed_presets.disk_size_gb in Settings → free estimate. Reject
     install when preset.disk_size_estimate_gb > free_estimate.
  3. Build a comfy-gen batch download spec, write to a temp file
  4. Spawn `comfy-gen download --batch <file> --endpoint-id <ep>` in a
     daemon thread; track state in module-level _install_state
  5. On success: settings_store.record_installed_preset(...)
  6. Concurrency: one install at a time (409 if busy)
"""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import tempfile
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from curl_cffi import requests as _cffi_requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend import config, preset_resolver, runpod_api, settings_store

router = APIRouter()

# Where to fetch the canonical manifest from.
_MANIFEST_URL = (
    "https://raw.githubusercontent.com/Hearmeman24/blockflow-presets/main/manifest.json"
)
_CACHE_TTL_SEC = 3600  # 1 hour
_HTTP_TIMEOUT_SEC = 15

# Persistent fallback cache (survives process restarts → offline-friendly).
_CACHE_PATH: Path = config.ROOT_DIR / "preset_manifest_cache.json"

# In-memory cache
_cache: dict[str, Any] = {
    "fetched_at": 0.0,
    "manifest": None,
}


def _cache_reset() -> None:
    """Test helper — wipe both layers of cache."""
    _cache["fetched_at"] = 0.0
    _cache["manifest"] = None
    try:
        _CACHE_PATH.unlink(missing_ok=True)
    except OSError:
        pass


def _force_cache_expired() -> None:
    """Test helper — make the in-memory cache look stale without nuking the
    on-disk fallback. Used to simulate TTL expiry."""
    _cache["fetched_at"] = 0.0


def _load_disk_cache() -> dict | None:
    if not _CACHE_PATH.exists():
        return None
    try:
        return json.loads(_CACHE_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def _save_disk_cache(manifest: dict) -> None:
    try:
        _CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _CACHE_PATH.write_text(json.dumps(manifest, indent=2) + "\n")
    except OSError:
        pass  # best-effort; in-memory cache still works


def _cache_is_fresh() -> bool:
    if _cache["manifest"] is None:
        return False
    return (time.time() - _cache["fetched_at"]) < _CACHE_TTL_SEC


def _fetch_manifest() -> dict:
    """Hit the registry URL and return the parsed manifest. Raises on
    network failure or non-JSON response."""
    resp = _cffi_requests.get(_MANIFEST_URL, timeout=_HTTP_TIMEOUT_SEC)
    if resp.status_code >= 400:
        raise RuntimeError(f"registry returned HTTP {resp.status_code}")
    try:
        return resp.json()
    except (ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"registry returned non-JSON: {exc}") from exc


@router.get("/api/presets/manifest")
def get_manifest(refresh: int = 0) -> JSONResponse:
    """Return the registry manifest. Cached in-memory for ~1h; on network
    failure with no cache, returns 502."""
    if not refresh and _cache_is_fresh():
        return JSONResponse(_cache["manifest"])

    try:
        manifest = _fetch_manifest()
    except Exception as exc:
        # Network / parse error. Try the disk fallback so we degrade gracefully.
        # If the in-memory cache is populated (just expired), prefer that —
        # it's at least as fresh as the disk copy.
        fallback = _cache["manifest"] or _load_disk_cache()
        if fallback is not None:
            payload = {**fallback, "cache": "stale", "fetch_error": str(exc)}
            return JSONResponse(payload)
        raise HTTPException(
            status_code=502,
            detail=f"could not reach preset registry: {exc}",
        ) from exc

    # Success — refresh both layers of cache
    _cache["manifest"] = manifest
    _cache["fetched_at"] = time.time()
    _save_disk_cache(manifest)
    return JSONResponse(manifest)


@router.get("/api/presets/installed")
def list_installed() -> JSONResponse:
    rows = settings_store.list_installed_presets()
    # Hydrate workflow NAMES only (not bodies — keeps the list small) so the
    # ComfyGen block dropdown can enumerate one entry per (preset, workflow)
    # without an N+1 detail fetch.
    for row in rows:
        detail = settings_store.get_installed_preset(row["preset_id"])
        workflows = _normalize_stored_workflows(detail["workflow_json"]) if detail else []
        row["workflows"] = [{"name": w.get("name", "Default")} for w in workflows]
    return JSONResponse({"installed": rows})


@router.get("/api/presets/installed/{preset_id}")
def get_installed(preset_id: str) -> JSONResponse:
    row = settings_store.get_installed_preset(preset_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"preset '{preset_id}' is not installed")
    # workflow_json is stored as a string; normalize to the list-of-{name,json}
    # shape so callers don't have to handle the legacy dict form themselves.
    # sgs-ui-fmy: recommendations live inside the same wrapper blob (or empty
    # when the row predates that field).
    return JSONResponse({
        **row,
        "workflow_json": _normalize_stored_workflows(row["workflow_json"]),
        "recommendations": _normalize_stored_recommendations(row["workflow_json"]),
    })


# === Stage B: install + uninstall ============================================

class InstallBody(BaseModel):
    preset_id: str = Field(..., min_length=1)


# Module-level install state (single-install-at-a-time per .3 design call).
# sgs-ui-8ww: state machine extended for the new install-preset CLI flow:
# events drive `files`, `files_done`, `pod_id`; `state` now includes
# "cancelling" / "cancelled".
_install_state: dict[str, Any] = {
    # "idle" | "queued" | "running" | "completed" | "error"
    #   | "cancelling" | "cancelled"
    "state": "idle",
    # sgs-ui-5k7: UI milestone phase, narrower than `state`. Drives the
    # milestone list in the install card.
    #   "idle"      — nothing in flight
    #   "pod_spawn" — POST accepted, pod not yet up (CPU mode only)
    #   "preflight" — pod_spawned, agent validating preset + disk
    #   "download"  — preflight_ok received, downloads underway
    #   "finalize"  — install_done received, writing settings + tearing down
    #   "done"      — settings written, pod deleted
    #   "error"     — any terminal failure (preflight_fail/install_error/etc.)
    #   "cancelled" — user pressed cancel before terminal event
    "phase": "idle",
    "preset_id": None,
    "started_at": None,
    "completed_at": None,
    "files_total": 0,
    "files_done": 0,
    # sgs-ui-5k7: running total of bytes downloaded so far, used as the
    # progress bar numerator. Completed files contribute their actual
    # download_done.bytes; in-flight files contribute (avg_size * percent),
    # where avg_size = total_download_bytes / files_total. Falls back to
    # sum-of-completed when total_download_bytes is unknown.
    "bytes_done": 0,
    "error": None,
    # sgs-ui-wx0: classified failure mode. 'supply_constraint' when RunPod
    # is out of CPU capacity (the only case the UI offers a GPU-fallback
    # button); 'unknown' for everything else (existing raw-error UI).
    "error_kind": None,
    # sgs-ui-wx0: 'cpu' (default, install-preset CLI) or 'gpu' (resurrected
    # pre-8ww `comfy-gen download --batch` path against the comfygen
    # serverless endpoint). Persisted to Settings on success.
    "install_mode": None,
    # sgs-ui-8ww: classification counts are derived live from
    # download_done.cached — `stale_count` retained for the
    # response shape but always zero now (CLI handles eviction internally).
    "cached_count": 0,
    "missing_count": 0,
    "stale_count": 0,
    "total_download_bytes": 0,
    # sgs-ui-8ww: per-file progress entries built from preflight_ok and the
    # download_* event stream. Shape:
    # [{index, path, status: pending|downloading|done, percent, speed,
    #   cached, bytes, sha256}]
    "files": [],
    # sgs-ui-8ww: pod_id from pod_spawned. Surfaces "View pod logs ↗" in
    # the UI when state ends in error.
    "pod_id": None,
    # sgs-ui-hh9: rolling tail (last ~30 lines) of the current subprocess's
    # stderr. Used to be the live UI feed for log lines; under the new CLI
    # stdout carries structured events, so this tail is primarily for
    # diagnostic stderr noise from the CLI itself.
    "log_tail": "",
    # sgs-ui-6ag: when state ends in error/cancelled, the pod is kept alive
    # for INSTALL_FAILURE_POD_GRACE_SEC so the user can view logs / SSH in.
    # ISO timestamp of the scheduled DELETE; null on success or when no
    # pod was ever spawned.
    "pod_delete_at": None,
}

# sgs-ui-6ag: how long to keep the installer pod alive after a failed
# install before tearing it down. 90s is enough to click "View pod logs",
# inspect them in the RunPod console, copy out the stack trace, etc.
# Success path stays immediate (no debugging window needed).
INSTALL_FAILURE_POD_GRACE_SEC = 90
_install_lock = threading.Lock()
# sgs-ui-8ww: handle on the running `comfy-gen install-preset` subprocess
# so the cancel route can SIGINT it. None when no install is in flight.
_install_proc: dict[str, subprocess.Popen | None] = {"proc": None}
# sgs-ui-8ww: per-endpoint network-volume cache so the install handler
# doesn't query RunPod's REST API once per click.
_volume_cache: dict[str, str] = {}

# How many lines of stderr to keep in _install_state["log_tail"]. ~30 lines
# fits a small UI panel; bigger inflates /progress responses unnecessarily.
_LOG_TAIL_MAXLEN = 30


def _reset_install_state() -> None:
    """Test helper."""
    _install_state.update({
        "state": "idle",
        "phase": "idle",
        "preset_id": None,
        "started_at": None,
        "completed_at": None,
        "files_total": 0,
        "files_done": 0,
        "bytes_done": 0,
        "error": None,
        "error_kind": None,
        "install_mode": None,
        "cached_count": 0,
        "missing_count": 0,
        "stale_count": 0,
        "total_download_bytes": 0,
        "files": [],
        "pod_id": None,
        "pod_delete_at": None,
        "log_tail": "",
    })
    _install_proc["proc"] = None
    _volume_cache.clear()


def _schedule_delayed_pod_delete(
    pod_id: str | None,
    delay_sec: int = INSTALL_FAILURE_POD_GRACE_SEC,
) -> None:
    """sgs-ui-6ag: keep the installer pod alive for `delay_sec` after a
    failed install so the user can view RunPod logs / SSH in. Stashes
    pod_delete_at on _install_state for the UI to display, then spawns
    a daemon thread that sleeps and DELETEs.

    No-op when pod_id is falsy (install failed before pod_spawned).
    The installer_pod_sweeper Rule B catches the pod at the 5min orphan
    mark if BlockFlow dies before the timer fires.
    """
    if not pod_id:
        return
    deadline = datetime.now(timezone.utc) + timedelta(seconds=delay_sec)
    _install_state["pod_delete_at"] = deadline.isoformat()

    def _go() -> None:
        time.sleep(delay_sec)
        try:
            from backend import installer_pod_sweeper as _sweeper
            _sweeper.delete_pod_post_install(pod_id)
        except Exception as exc:
            print(f"[preset-install] delayed pod delete failed: {exc}")

    threading.Thread(target=_go, daemon=True, name="installer-pod-grace").start()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _find_manifest_entry(preset_id: str) -> dict | None:
    """Return the manifest entry for preset_id; refresh manifest if empty."""
    manifest = _cache["manifest"]
    if manifest is None or not _cache_is_fresh():
        try:
            manifest = _fetch_manifest()
            _cache["manifest"] = manifest
            _cache["fetched_at"] = time.time()
            _save_disk_cache(manifest)
        except Exception:
            manifest = _cache["manifest"] or _load_disk_cache()
    if not manifest:
        return None
    for entry in manifest.get("presets", []):
        if entry.get("id") == preset_id:
            return entry
    return None


# === sgs-ui-5nn: Step 8 quickstart picker ===================================

def _get_or_fetch_manifest_cached() -> dict | None:
    """Reader used by the wizard quickstart picker. Returns the cached manifest
    if fresh, otherwise attempts a fetch; falls back to in-memory or disk cache
    on network error. Returns None only when no manifest can be produced at
    all."""
    if _cache_is_fresh():
        return _cache["manifest"]
    try:
        manifest = _fetch_manifest()
        _cache["manifest"] = manifest
        _cache["fetched_at"] = time.time()
        _save_disk_cache(manifest)
        return manifest
    except Exception:
        return _cache["manifest"] or _load_disk_cache()


def _fetch_preset_detail_remote(preset_url: str) -> dict:
    resp = _cffi_requests.get(preset_url, timeout=_HTTP_TIMEOUT_SEC)
    if resp.status_code >= 400:
        raise RuntimeError(f"detail fetch HTTP {resp.status_code}")
    return resp.json()


def _preset_uses_civitai(detail: dict) -> bool:
    """True iff any model URL in this preset's detail references civitai.com."""
    for model in detail.get("models") or []:
        url = (model.get("url") or "").lower()
        if "civitai.com" in url:
            return True
    return False


def pick_quickstart_preset() -> dict | None:
    """Walk the manifest in ascending disk_size_estimate_gb order. For each
    candidate, fetch its preset.json and pick the first one whose model URLs
    don't reference CivitAI.

    Returns `{preset_id, name, disk_size_estimate_gb, preset_url}` or None if
    the manifest is unreachable or every preset requires CivitAI.
    """
    manifest = _get_or_fetch_manifest_cached()
    if manifest is None:
        return None
    presets = manifest.get("presets") or []

    sorted_presets = sorted(
        presets, key=lambda p: p.get("disk_size_estimate_gb") or 1_000_000
    )
    for entry in sorted_presets:
        preset_url = entry.get("preset_url")
        if not preset_url:
            continue
        try:
            detail = _fetch_preset_detail_remote(preset_url)
        except Exception:
            continue
        if _preset_uses_civitai(detail):
            continue
        return {
            "preset_id": entry["id"],
            "name": entry.get("name") or entry["id"],
            "disk_size_estimate_gb": entry.get("disk_size_estimate_gb"),
            "preset_url": preset_url,
        }
    return None


@router.get("/api/presets/manifest/{preset_id}")
def get_preset_detail(preset_id: str) -> JSONResponse:
    entry = _find_manifest_entry(preset_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"preset '{preset_id}' not in registry manifest")
    try:
        resp = _cffi_requests.get(entry["preset_url"], timeout=_HTTP_TIMEOUT_SEC)
        if resp.status_code >= 400:
            raise RuntimeError(f"registry returned HTTP {resp.status_code}")
        detail = resp.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"could not fetch preset detail: {exc}") from exc
    return JSONResponse(detail)


def _compute_disk_budget() -> dict[str, Any]:
    """Best-effort: ask RunPod for the ComfyGen volume's total size and
    subtract sum of installed-preset disk_size_gb to estimate free space.
    Not exact (the user may have downloaded models out of band), but a
    sane safety net for the install pre-check."""
    api_key = settings_store.get_credential("runpod_api_key") or ""
    ep = settings_store.get_endpoint("comfygen") or {}
    volume_id = ep.get("volume_id")

    total_gb: int | None = None
    if api_key and volume_id:
        try:
            vol = runpod_api.get_network_volume(api_key, volume_id)
            total_gb = vol.get("size")
        except runpod_api.RunPodAPIError:
            total_gb = None
        except Exception:
            total_gb = None

    used_est_gb = sum(
        (p.get("disk_size_gb") or 0) for p in settings_store.list_installed_presets()
    )
    free_est_gb = (total_gb - used_est_gb) if total_gb is not None else None
    return {
        "total_gb": total_gb,
        "used_estimate_gb": used_est_gb,
        "free_estimate_gb": free_est_gb,
    }


@router.get("/api/presets/disk-budget")
def disk_budget() -> JSONResponse:
    return JSONResponse(_compute_disk_budget())


def _run_comfy_gen_capture(
    args: list[str],
    *,
    log_fp,
    label: str,
    timeout: int,
) -> tuple[int, str, str]:
    """Run a comfy-gen subcommand. Stream stderr to the install log file as
    it arrives (so /preset_install.log stays useful for diagnosis), collect
    stdout, and return (returncode, stdout, stderr_tail).

    Pump BOTH pipes in threads — calling proc.communicate() after a manual
    stderr pump raises EBADF once the pump closes the fd (same bug we fixed
    in ci_live_install.py)."""
    log_fp.write(f"\n--- [{label}] {' '.join(args[:3])} ---\n")
    proc = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    stderr_tail: deque[str] = deque(maxlen=80)
    # sgs-ui-hh9: separate, smaller rolling tail surfaced to /progress (the
    # 80-line stderr_tail above is the on-failure error payload; this one
    # is the live UI feed).
    ui_tail: deque[str] = deque(maxlen=_LOG_TAIL_MAXLEN)
    stdout_chunks: list[str] = []

    def _pump_stderr() -> None:
        assert proc.stderr is not None
        try:
            for line in iter(proc.stderr.readline, ""):
                stderr_tail.append(line)
                ui_tail.append(line)
                # Atomic dict-item write under the GIL — safe to do from the
                # pump thread without locking. The /progress reader sees a
                # consistent snapshot of whatever lines have arrived so far.
                _install_state["log_tail"] = "".join(ui_tail)
                log_fp.write(line)
        except ValueError:
            # Pipe got closed under us — e.g., proc.kill() during a timeout
            # or test teardown after the StringIO is GC'd. Either way, the
            # pump's done.
            pass
        try:
            proc.stderr.close()
        except (OSError, ValueError):
            pass

    def _pump_stdout() -> None:
        assert proc.stdout is not None
        try:
            for line in iter(proc.stdout.readline, ""):
                stdout_chunks.append(line)
        except ValueError:
            pass
        try:
            proc.stdout.close()
        except (OSError, ValueError):
            pass

    t_err = threading.Thread(target=_pump_stderr, daemon=True)
    t_out = threading.Thread(target=_pump_stdout, daemon=True)
    t_err.start()
    t_out.start()

    try:
        returncode = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        returncode = proc.wait()

    t_err.join(timeout=5)
    t_out.join(timeout=5)
    return returncode, "".join(stdout_chunks), "".join(stderr_tail)


def _resolve_volume_for_endpoint(api_key: str, endpoint_id: str) -> str:
    """Look up the network volume attached to a RunPod endpoint via one
    REST call, cache per-endpoint so retries don't re-query.

    Raises HTTPException(400) when the endpoint has no volume attached —
    the new installer can't write without one, and silently failing later
    in the CLI subprocess is a worse UX than failing fast here.
    """
    cached = _volume_cache.get(endpoint_id)
    if cached:
        return cached
    data = runpod_api._rest_get(api_key, f"/endpoints/{endpoint_id}")
    # RunPod's REST shape: volume id sits at the top level on the endpoint
    # object as `networkVolumeId`. Older accounts surface it nested under
    # `workersConfig` / `template`; check both before giving up.
    vol = data.get("networkVolumeId")
    if not vol:
        wc = data.get("workersConfig")
        if isinstance(wc, dict):
            vol = wc.get("networkVolumeId")
    if not vol:
        tpl = data.get("template")
        if isinstance(tpl, dict):
            vol = tpl.get("networkVolumeId")
    if not vol:
        raise HTTPException(
            status_code=400,
            detail=(
                f"endpoint {endpoint_id} has no network volume attached — "
                "attach one before installing presets."
            ),
        )
    _volume_cache[endpoint_id] = vol
    return vol


def _delete_paths(
    paths: list[str],
    *,
    endpoint_id: str,
    log_fp,
) -> dict[str, Any]:
    """Call `comfy-gen delete --batch <paths>`. Returns the parsed response
    dict so callers can inspect per-path errors."""
    if not paths:
        return {"ok": True, "results": []}
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, encoding="utf-8"
    ) as tf:
        json.dump(paths, tf)
        paths_file = tf.name
    try:
        rc, stdout, stderr = _run_comfy_gen_capture(
            [
                "comfy-gen", "delete",
                "--batch", paths_file,
                "--endpoint-id", endpoint_id,
                "--timeout", "300",
            ],
            log_fp=log_fp,
            label="delete",
            timeout=360,
        )
        if rc != 0:
            return {"ok": False, "results": [], "error": stderr[-500:] or "delete failed"}
        try:
            return json.loads(stdout)
        except json.JSONDecodeError:
            return {"ok": False, "results": [], "error": "non-JSON delete output"}
    finally:
        try:
            Path(paths_file).unlink(missing_ok=True)
        except OSError:
            pass


# sgs-ui-8ww: cost recorded against every CPU-installer install. ComfyGen's
# install-preset spawns the cheapest available cpu3c/5c/3g/5g sku; all four
# are billed at $0.06/hr. If the CLI ever exposes the actual selected sku we
# can persist that instead.
_CPU_INSTALLER_COST_PER_HR = 0.06


# sgs-ui-wx0: RunPod's CPU-pod supply ceiling shows up in multiple shapes
# depending on which layer of the CLI raised it. The magic token is
# `SUPPLY_CONSTRAINT` (emitted by comfy-gen install-preset); the human
# phrase 'no CPU instance available' is the older bare-RunPod-error variant.
_SUPPLY_CONSTRAINT_RE = re.compile(r"SUPPLY_CONSTRAINT|no CPU instance available", re.IGNORECASE)


def _classify_error_kind(reason: str | None) -> str:
    """Map a terminal error message to one of {'supply_constraint', 'unknown'}.
    Only SUPPLY_CONSTRAINT failures get the friendly retry + GPU-fallback UI;
    every other failure surfaces the raw reason so real bugs aren't masked."""
    if reason and _SUPPLY_CONSTRAINT_RE.search(reason):
        return "supply_constraint"
    return "unknown"


def _process_install_event(evt: dict) -> dict | None:
    """Apply one SSE event to _install_state. Returns the event itself if
    it's terminal (install_done / install_error / preflight_fail), else None.

    sgs-ui-wx0: also recognizes `{"status": "error", "error": "..."}`,
    the early-exit shape comfy-gen install-preset emits when it bails
    before producing a type-shaped event (e.g. SUPPLY_CONSTRAINT on pod
    spawn). Treated as an install_error at stage='spawn'.
    """
    # sgs-ui-wx0: status-shaped early-exit → coerce to install_error envelope.
    if "type" not in evt and evt.get("status") == "error":
        return {
            "type": "install_error",
            "stage": "spawn",
            "reason": evt.get("error") or "unknown early-exit error",
        }
    etype = evt.get("type")
    if etype == "pod_spawned":
        _install_state["pod_id"] = evt.get("pod_id")
        # sgs-ui-5k7: pod is up; agent now runs preflight.
        _install_state["phase"] = "preflight"
    elif etype == "preflight_ok":
        total = int(evt.get("models_count") or 0)
        _install_state["files_total"] = total
        _install_state["total_download_bytes"] = int(evt.get("total_bytes") or 0)
        _install_state["files"] = [
            {"index": i, "path": None, "status": "pending",
             "percent": 0.0, "speed": None, "cached": False,
             "bytes": None, "sha256": None}
            for i in range(total)
        ]
        # sgs-ui-5k7: preflight complete, downloads begin.
        _install_state["phase"] = "download"
    elif etype == "download_start":
        i = int(evt.get("file_index") or 0)
        files = _install_state["files"]
        if 0 <= i < len(files):
            files[i]["path"] = evt.get("file") or files[i]["path"]
            files[i]["status"] = "downloading"
    elif etype == "download_progress":
        i = int(evt.get("file_index") or 0)
        files = _install_state["files"]
        if 0 <= i < len(files):
            files[i]["percent"] = float(evt.get("percent") or 0.0)
            files[i]["speed"] = evt.get("speed")
            if evt.get("file"):
                files[i]["path"] = evt["file"]
            # sgs-ui-5k7: defensive — progress arriving before download_start
            # (event reordering, dropped packets) should still flip status so
            # the milestone UI and bytes_done estimator see it as in flight.
            if files[i]["status"] == "pending":
                files[i]["status"] = "downloading"
        _recompute_bytes_done()
    elif etype == "download_done":
        i = int(evt.get("file_index") or 0)
        files = _install_state["files"]
        # sgs-ui-kqr: dedupe by file_index. The installer agent has
        # observed paths (already-on-disk-skip + retry) that emit
        # download_done twice for the same index. Without this gate,
        # files_done overshoots files_total ("10/8 files").
        was_done = bool(0 <= i < len(files) and files[i]["status"] == "done")
        if 0 <= i < len(files):
            files[i]["status"] = "done"
            files[i]["percent"] = 100.0
            if evt.get("file"):
                files[i]["path"] = evt["file"]
            files[i]["cached"] = bool(evt.get("cached"))
            files[i]["bytes"] = evt.get("bytes")
            files[i]["sha256"] = evt.get("sha256")
        if not was_done:
            if evt.get("cached"):
                _install_state["cached_count"] += 1
            else:
                _install_state["missing_count"] += 1
            _install_state["files_done"] += 1
        _recompute_bytes_done()
    elif etype in ("install_done", "install_error", "preflight_fail"):
        return evt
    return None


def _recompute_bytes_done() -> None:
    """sgs-ui-5k7: derive _install_state['bytes_done'] from files[].

    Completed files contribute their actual download_done.bytes. In-flight
    files contribute (avg_size * percent/100), where avg_size = total /
    files_total. When total_download_bytes is unknown (preflight_ok with
    total_bytes=0), in-flight files contribute nothing — the bar is
    chunky but accurate.
    """
    files = _install_state["files"]
    if not files:
        _install_state["bytes_done"] = 0
        return
    total = int(_install_state.get("total_download_bytes") or 0)
    n = len(files)
    avg = (total / n) if (total > 0 and n > 0) else 0
    acc = 0.0
    for f in files:
        if f["status"] == "done" and f.get("bytes"):
            acc += int(f["bytes"])
        elif f["status"] == "downloading" and avg:
            acc += avg * (float(f.get("percent") or 0.0) / 100.0)
    _install_state["bytes_done"] = int(acc)




def _run_gpu_install_subprocess(
    *,
    preset_id: str,
    version: str,
    disk_size_gb: int,
    workflow_json_str: str,
    preset_models: list[dict],
    canonical_paths: list[str],
    endpoint_id: str,
) -> None:
    """sgs-ui-wx0: pre-8ww install path — shells out to
    `comfy-gen download --batch <file> --endpoint-id <ep>` against the
    configured ComfyGen serverless endpoint. Used as a fallback when
    RunPod CPU pod capacity is exhausted.

    Progress is opaque (the legacy `download` subcommand returns a final
    JSON result on stdout and per-file lines on stderr); we keep
    `_install_state['log_tail']` live for the UI feed and bump
    `files_done` per stderr line that looks like progress. install_mode
    is persisted as 'gpu' and pod_id stays None (the endpoint isn't a
    pod BlockFlow controls)."""
    log_path = config.ROOT_DIR / "preset_install.log"
    log_fp = log_path.open("a", buffering=1)
    log_fp.write(
        f"\n\n=== {_now_iso()} preset={preset_id} START (GPU fallback) ===\n"
    )

    # src-abj: route through the canonical translator (vendored from
    # comfy-gen's preset_resolver) — handles source aliasing
    # (huggingface→url), civitai version_id extraction, and dest →
    # destination_path conversion. Hand-rolling this payload has produced
    # three separate prod failures.
    batch_spec = preset_resolver.preset_to_download_batch(preset_models)
    files_total = len(batch_spec)
    _install_state["files_total"] = files_total

    batch_path: str | None = None
    proc: subprocess.Popen | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as tf:
            json.dump(batch_spec, tf)
            batch_path = tf.name

        args = [
            "comfy-gen", "download",
            "--batch", batch_path,
            "--endpoint-id", endpoint_id,
            "--timeout", "3600",
        ]
        proc = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        _install_proc["proc"] = proc

        stderr_tail: deque[str] = deque(maxlen=_LOG_TAIL_MAXLEN)
        stdout_chunks: list[str] = []

        def _pump_stderr() -> None:
            assert proc is not None and proc.stderr is not None
            try:
                for line in iter(proc.stderr.readline, ""):
                    stderr_tail.append(line)
                    _install_state["log_tail"] = "".join(stderr_tail)
                    log_fp.write("[stderr] " + line)
                    # Best-effort progress: each '[i/N] downloaded ...'-shaped
                    # line increments files_done.
                    if re.search(r"\[\d+/\d+\]|downloaded\s+", line):
                        if _install_state["files_done"] < files_total:
                            _install_state["files_done"] += 1
            except (ValueError, OSError):
                pass

        def _pump_stdout() -> None:
            assert proc is not None and proc.stdout is not None
            try:
                for line in iter(proc.stdout.readline, ""):
                    stdout_chunks.append(line)
                    log_fp.write("[stdout] " + line)
            except (ValueError, OSError):
                pass

        t_err = threading.Thread(target=_pump_stderr, daemon=True)
        t_out = threading.Thread(target=_pump_stdout, daemon=True)
        t_err.start()
        t_out.start()

        rc = proc.wait(timeout=3660)
        t_err.join(timeout=5)
        t_out.join(timeout=5)

        if _install_state["state"] == "cancelling":
            _install_state.update({
                "state": "cancelled",
                "completed_at": _now_iso(),
                "error": "install cancelled by user",
            })
            return

        if rc != 0:
            err = ("".join(stderr_tail).strip()
                   or "comfy-gen download failed with no stderr output")
            _install_state.update({
                "state": "error",
                "completed_at": _now_iso(),
                "error": err[-3000:] if len(err) > 3000 else err,
                "error_kind": _classify_error_kind(err),
            })
            return

        _install_state["phase"] = "finalize"
        settings_store.record_installed_preset(
            preset_id=preset_id,
            version=version,
            disk_size_gb=disk_size_gb,
            workflow_json=workflow_json_str,
            installed_paths=canonical_paths,
            pod_id=None,
            install_mode="gpu",
            cost_per_hr_at_spawn=None,
        )
        _install_state.update({
            "state": "completed",
            "phase": "done",
            "completed_at": _now_iso(),
            "error": None,
            "error_kind": None,
            "install_mode": "gpu",
            "files_done": files_total,
        })

    except Exception as exc:
        msg = str(exc)[:2000]
        _install_state.update({
            "state": "error",
            "completed_at": _now_iso(),
            "error": msg,
            "error_kind": _classify_error_kind(msg),
        })
    finally:
        log_fp.write(
            f"\n=== {_now_iso()} preset={preset_id} "
            f"state={_install_state['state']} (GPU fallback) ===\n"
        )
        log_fp.flush()
        log_fp.close()
        _install_proc["proc"] = None
        if batch_path:
            try:
                Path(batch_path).unlink(missing_ok=True)
            except OSError:
                pass


def _run_install_subprocess(
    *,
    preset_id: str,
    version: str,
    disk_size_gb: int,
    workflow_json_str: str,
    volume_id: str,
    canonical_paths: list[str],
    civitai_token: str | None,
    hf_token: str | None,
) -> None:
    """Background worker. Spawn `comfy-gen install-preset`, drive
    _install_state from its line-delimited JSON event stream on stdout, and
    persist Settings if and only if install_done.ok is true.

    Stderr is teed to preset_install.log AND to a rolling tail in
    _install_state["log_tail"] for the live UI feed.
    """
    log_path = config.ROOT_DIR / "preset_install.log"
    log_fp = log_path.open("a", buffering=1)
    log_fp.write(f"\n\n=== {_now_iso()} preset={preset_id} START (install-preset CLI) ===\n")

    args = [
        "comfy-gen", "install-preset",
        "--preset-id", preset_id,
        "--volume-id", volume_id,
    ]
    # sgs-ui-h1c.1.4 / sgs-ui-8ef: tokens are passed via env, not argv, so
    # they don't surface in `ps aux` or process listings. comfy-gen reads
    # env first and falls back to deprecated --civitai-token/--hf-token.
    env = os.environ.copy()
    if civitai_token:
        env["COMFY_GEN_CIVITAI_TOKEN"] = civitai_token
    if hf_token:
        env["COMFY_GEN_HF_TOKEN"] = hf_token

    terminal: dict = {}
    proc: subprocess.Popen | None = None
    try:
        proc = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
        )
        _install_proc["proc"] = proc

        stderr_tail: deque[str] = deque(maxlen=_LOG_TAIL_MAXLEN)

        def _pump_stderr() -> None:
            assert proc is not None and proc.stderr is not None
            try:
                for line in iter(proc.stderr.readline, ""):
                    stderr_tail.append(line)
                    _install_state["log_tail"] = "".join(stderr_tail)
                    log_fp.write("[stderr] " + line)
            except (ValueError, OSError):
                pass

        t_err = threading.Thread(target=_pump_stderr, daemon=True)
        t_err.start()

        assert proc.stdout is not None
        for line in iter(proc.stdout.readline, ""):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                evt = json.loads(stripped)
            except json.JSONDecodeError:
                log_fp.write(f"[install] non-JSON stdout line: {stripped[:200]}\n")
                continue
            log_fp.write(stripped + "\n")
            maybe_terminal = _process_install_event(evt)
            if maybe_terminal is not None:
                terminal = maybe_terminal

        rc = proc.wait(timeout=60)
        try:
            proc.stderr.close()  # type: ignore[union-attr]
        except (OSError, ValueError):
            pass
        t_err.join(timeout=5)

        # Cancellation takes precedence over the terminal event — the CLI
        # may have emitted install_error("cancelled") just before exit, but
        # the state machine should reflect "cancelled" specifically.
        if _install_state["state"] == "cancelling":
            # sgs-ui-5k7: keep `phase` at whatever step we were on so the
            # milestone UI can mark THAT step as cancelled (drives the ✗
            # placement). `state` carries the lifecycle status.
            _install_state.update({
                "state": "cancelled",
                "completed_at": _now_iso(),
                "error": "install cancelled by user",
            })
            return

        if terminal.get("type") == "install_done" and terminal.get("ok"):
            # sgs-ui-5k7: writing settings + tearing down the pod takes a
            # second or two; surface it as 'finalize' for the milestone UI.
            _install_state["phase"] = "finalize"
            # The CLI's download_done.file is a basename / partial path; we
            # persist the full canonical paths computed from preset.models
            # so uninstall can hand them to `comfy-gen delete`.
            installed_paths = canonical_paths
            settings_store.record_installed_preset(
                preset_id=preset_id,
                version=version,
                disk_size_gb=disk_size_gb,
                workflow_json=workflow_json_str,
                installed_paths=installed_paths,
                pod_id=_install_state.get("pod_id"),
                install_mode="cpu",
                cost_per_hr_at_spawn=_CPU_INSTALLER_COST_PER_HR,
            )
            _install_state.update({
                "state": "completed",
                "phase": "done",
                "completed_at": _now_iso(),
                "error": None,
                "error_kind": None,
                "install_mode": "cpu",
            })
            # sgs-ui-c7n trigger #2: tear the pod down immediately on
            # success. Idempotent — if the CLI's own DELETE already landed
            # this is a 404 no-op. Local import dodges the circular module
            # graph at import time.
            try:
                from backend import installer_pod_sweeper as _sweeper
                _sweeper.delete_pod_post_install(_install_state.get("pod_id"))
            except Exception as exc:
                print(f"[preset-install] post-install pod delete failed: {exc}")
            return

        # Failure paths.
        if terminal.get("type") == "preflight_fail":
            err = f"preflight failed: {terminal.get('reason') or 'unknown'}"
        elif terminal.get("type") == "install_error":
            stage = terminal.get("stage") or "?"
            err = f"install error at {stage}: {terminal.get('reason') or 'unknown'}"
        elif terminal:
            err = f"unexpected terminal event: {terminal}"
        else:
            tail_hint = ("".join(stderr_tail).strip()[-400:]
                         if stderr_tail else "")
            err = f"subprocess exited rc={rc} with no terminal event"
            if tail_hint:
                err += f" — stderr tail: {tail_hint}"
        # sgs-ui-5k7: leave `phase` unchanged so the UI can show ✗ on the
        # specific milestone where the error happened (preflight vs download).
        _install_state.update({
            "state": "error",
            "completed_at": _now_iso(),
            "error": err[:3000],
            "error_kind": _classify_error_kind(err),
        })
        # sgs-ui-6ag: keep pod alive for INSTALL_FAILURE_POD_GRACE_SEC so
        # the user can grab logs / SSH in. Replaces the immediate delete
        # added by sgs-ui-515 — installer_pod_sweeper Rule B remains the
        # 5-min backstop if BlockFlow dies before the grace timer fires.
        # try/except: scheduling failure must not mask the original install
        # error (the outer except would otherwise overwrite _install_state).
        try:
            _schedule_delayed_pod_delete(_install_state.get("pod_id"))
        except Exception as exc:
            print(f"[preset-install] failed to schedule grace delete: {exc}")

    except Exception as exc:
        msg = str(exc)[:2000]
        _install_state.update({
            "state": "error",
            "completed_at": _now_iso(),
            "error": msg,
            "error_kind": _classify_error_kind(msg),
        })
        # sgs-ui-6ag: same grace window for unexpected exceptions.
        try:
            _schedule_delayed_pod_delete(_install_state.get("pod_id"))
        except Exception as exc2:
            print(f"[preset-install] failed to schedule grace delete: {exc2}")
    finally:
        log_fp.write(
            f"\n=== {_now_iso()} preset={preset_id} "
            f"state={_install_state['state']} ===\n"
        )
        log_fp.flush()
        log_fp.close()
        _install_proc["proc"] = None


def _fetch_workflows_for_preset(preset: dict) -> list[dict]:
    """preset.workflows is a list of entries: each has a `name` (display
    string for the ComfyGen dropdown) and either inline `json` or `url`+
    `sha256`. Returns a list of {name, json} dicts ready to persist.

    Empty list if `workflows` is missing or empty (the install proceeds —
    presets that ship models without workflows are valid, the user just
    has nothing to load in the dropdown)."""
    entries = preset.get("workflows") or []
    out: list[dict] = []
    for entry in entries:
        name = entry.get("name") or "Default"
        # sgs-ui-gb4: author-declared knobs ride alongside the workflow JSON.
        # Only attach when the array is non-empty so legacy / unannotated
        # workflows keep their compact {name, json} shape.
        settings = entry.get("settings")
        # sgs-ui-2hf: author-declared list of workflow node IDs to suppress
        # from the ComfyGen block's auto-detected panels. Same compact-shape
        # convention as `settings` — only attach when non-empty. Coerce IDs
        # to strings (some preset authors write integers; ComfyUI workflow
        # JSON keys are strings, so frontend Set.has comparisons need strings).
        raw_hidden = entry.get("hidden_nodes")
        hidden_nodes = (
            [str(n) for n in raw_hidden if n is not None]
            if isinstance(raw_hidden, list) and raw_hidden
            else None
        )

        def _attach_extras(item: dict) -> dict:
            if isinstance(settings, list) and settings:
                item["settings"] = settings
            if hidden_nodes:
                item["hidden_nodes"] = hidden_nodes
            return item

        if "json" in entry and isinstance(entry["json"], dict):
            out.append(_attach_extras({"name": name, "json": entry["json"]}))
            continue
        url = entry.get("url")
        if not url:
            out.append(_attach_extras({"name": name, "json": {}}))
            continue
        try:
            resp = _cffi_requests.get(url, timeout=_HTTP_TIMEOUT_SEC)
            body = resp.json() if resp.status_code < 400 else {}
        except Exception:
            body = {}
        out.append(_attach_extras({"name": name, "json": body}))
    return out


def _extract_recommendations(preset: dict) -> dict:
    """sgs-ui-fmy: pull preset.recommendations into the canonical
    {global: [...], workflows: {<name>: [...]}} shape. Missing field, wrong
    shapes, or non-string entries are silently dropped — preset authors get
    no validation feedback yet (the registry's preset.schema.json is the
    authoring guardrail). Returns the empty wrapper when nothing usable is
    present so consumers don't need to special-case None."""
    raw = preset.get("recommendations")
    if not isinstance(raw, dict):
        return {"global": [], "workflows": {}}
    global_list = raw.get("global")
    workflow_map = raw.get("workflows")
    return {
        "global": [str(s) for s in global_list if isinstance(s, str)]
                  if isinstance(global_list, list) else [],
        "workflows": {
            str(k): [str(s) for s in v if isinstance(s, str)]
            for k, v in workflow_map.items()
            if isinstance(v, list)
        } if isinstance(workflow_map, dict) else {},
    }


def _normalize_stored_workflows(raw: str | None) -> list[dict]:
    """Read-path tolerance for legacy rows. Pre-sgs-ui-chf rows stored a
    single workflow dict in workflow_json; sgs-ui-chf rows store a list of
    {name, json} entries; sgs-ui-fmy rows store a wrapper
    {workflows: [...], recommendations: {...}}. Always return the list shape
    so consumers (ComfyGen block dropdown, /api/presets/installed/{id}) can
    treat them uniformly."""
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, json.JSONDecodeError):
        return []
    if isinstance(parsed, dict):
        # sgs-ui-fmy wrapper: {workflows: [...], recommendations: {...}}.
        if isinstance(parsed.get("workflows"), list):
            return parsed["workflows"]
        # Legacy: wrap a bare workflow dict as a single 'Default' workflow.
        return [{"name": "Default", "json": parsed}]
    if isinstance(parsed, list):
        return parsed
    return []


def _normalize_stored_recommendations(raw: str | None) -> dict:
    """Read-path for the sgs-ui-fmy `recommendations` field. Returns the
    canonical {global: [...], workflows: {...}} shape regardless of whether
    the row was written before or after the wrapper landed — missing /
    legacy rows surface as empty scopes so the frontend doesn't need to
    special-case absent data."""
    empty = {"global": [], "workflows": {}}
    if not raw:
        return empty
    try:
        parsed = json.loads(raw)
    except (ValueError, json.JSONDecodeError):
        return empty
    if not isinstance(parsed, dict):
        return empty
    recs = parsed.get("recommendations")
    if not isinstance(recs, dict):
        return empty
    global_recs = recs.get("global")
    workflow_recs = recs.get("workflows")
    return {
        "global": [str(s) for s in global_recs] if isinstance(global_recs, list) else [],
        "workflows": {
            str(k): [str(s) for s in v]
            for k, v in workflow_recs.items()
            if isinstance(v, list)
        } if isinstance(workflow_recs, dict) else {},
    }


def _model_uses_civitai(model: dict) -> bool:
    """sgs-ui-41c: detect CivitAI dependencies for the preflight credential
    gate. Trust an explicit source==civitai; otherwise fall back to URL
    hostname match (some legacy preset entries omit `source`)."""
    if (model.get("source") or "").lower() == "civitai":
        return True
    url = (model.get("url") or "").lower()
    return "civitai.com" in url


def _require_credentials_for_preset(preset: dict) -> None:
    """sgs-ui-41c: scan preset.models for sources that require auth, and
    raise a structured 400 if the matching credential is missing. CivitAI
    only for now — HF gating needs a schema-level `gated` flag on models
    (filed as sgs-ui-XXX follow-up) to avoid false positives on the many
    public HF repos referenced by mainstream presets."""
    models = preset.get("models") or []
    needs_civitai = any(_model_uses_civitai(m) for m in models)
    if needs_civitai and not settings_store.get_credential("civitai_api_key"):
        raise HTTPException(
            status_code=400,
            detail={
                "error_kind": "missing_credential",
                "credential": "civitai_api_key",
                "preset_id": preset.get("id"),
                "reason": (
                    "This preset downloads from CivitAI which requires "
                    "authentication. Add a CivitAI API Key in Settings → "
                    "Credentials before installing."
                ),
            },
        )


@router.post("/api/presets/install")
def install_preset(body: InstallBody, mode: str = "cpu") -> JSONResponse:
    """sgs-ui-8ww: shell out to `comfy-gen install-preset` which spawns a
    CPU installer pod, does its own preflight, and streams JSON events
    back. BlockFlow just resolves the volume_id, fetches the workflows for
    the local dropdown, and drives the subprocess.

    sgs-ui-wx0: when `?mode=gpu`, fall back to the pre-8ww
    `comfy-gen download --batch <file> --endpoint-id <ep>` flow against
    the configured ComfyGen serverless endpoint. Used when CPU pod
    capacity is exhausted. Costs ~$1.50/install and is slower; surfaced
    via an inline secondary button in the SUPPLY_CONSTRAINT error card.
    """
    if mode not in ("cpu", "gpu"):
        raise HTTPException(status_code=400, detail=f"invalid mode '{mode}' — must be 'cpu' or 'gpu'")
    api_key = settings_store.get_credential("runpod_api_key")
    if not api_key:
        raise HTTPException(status_code=400, detail="runpod_api_key not configured in Settings")

    ep = settings_store.get_endpoint("comfygen")
    if ep is None or not ep.get("endpoint_id"):
        raise HTTPException(
            status_code=400,
            detail="no ComfyGen endpoint configured — set one up via Settings → Endpoints first",
        )

    entry = _find_manifest_entry(body.preset_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"preset '{body.preset_id}' not in registry manifest")

    # Fetch full preset detail. The CLI re-resolves the preset itself
    # against the registry, but BlockFlow still needs the workflows (cached
    # for the ComfyGen block dropdown) and the version/disk_size fields
    # for the Settings row.
    try:
        detail_resp = _cffi_requests.get(entry["preset_url"], timeout=_HTTP_TIMEOUT_SEC)
        if detail_resp.status_code >= 400:
            raise RuntimeError(f"registry returned HTTP {detail_resp.status_code}")
        preset = detail_resp.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"could not fetch preset detail: {exc}") from exc

    # Resolve which network volume the endpoint writes to. install-preset
    # requires --volume-id; we derive it from the endpoint config rather
    # than asking the user to type it again.
    if ep.get("volume_id"):
        volume_id = ep["volume_id"]
    else:
        # Fall back to the REST API — older endpoints persisted without
        # volume_id in Settings.
        try:
            volume_id = _resolve_volume_for_endpoint(api_key, ep["endpoint_id"])
        except HTTPException:
            raise
        except runpod_api.RunPodAPIError as exc:
            raise HTTPException(status_code=502, detail=f"could not resolve network volume: {exc}") from exc

    workflows = _fetch_workflows_for_preset(preset)
    stored_blob = {
        "workflows": workflows,
        "recommendations": _extract_recommendations(preset),
    }

    # sgs-ui-41c: refuse the install at submit time if the preset pulls
    # from CivitAI but no civitai_api_key is configured. Otherwise the CLI
    # spawns a pod, runs preflight, fails on the first 401 ~3-5 min later,
    # and the user has paid ~2¢ + lost five minutes for a credential gap
    # we could've caught in 0ms here.
    _require_credentials_for_preset(preset)

    # Compute canonical /runpod-volume paths from preset.models — the CLI
    # writes each model to /runpod-volume/ComfyUI/models/<dest>; we need
    # the full paths persisted so uninstall can pass them to
    # `comfy-gen delete --batch`. The CLI's download_done.file event field
    # is a display name only.
    canonical_paths: list[str] = []
    for m in preset.get("models", []) or []:
        dest = m.get("dest") or ""
        if "/" in dest:
            subfolder, filename = dest.split("/", 1)
        else:
            subfolder, filename = "checkpoints", dest
        canonical_paths.append(
            f"/runpod-volume/ComfyUI/models/{subfolder}/{filename}"
        )

    with _install_lock:
        if _install_state["state"] in ("queued", "running", "cancelling"):
            raise HTTPException(
                status_code=409,
                detail=f"another install is in progress: {_install_state['preset_id']}",
            )
        _install_state.update({
            "state": "queued",
            "preset_id": body.preset_id,
            "started_at": _now_iso(),
            "completed_at": None,
            # CLI's preflight_ok overwrites this with the authoritative count.
            "files_total": len(preset.get("models", []) or []),
            "files_done": 0,
            "error": None,
            "error_kind": None,
            "install_mode": None,
            "log_tail": "",
            "cached_count": 0,
            "missing_count": 0,
            "stale_count": 0,
            "total_download_bytes": 0,
            "bytes_done": 0,
            "files": [],
            "pod_id": None,
            # sgs-ui-5k7: UI milestone. CPU mode begins at pod_spawn (we
            # haven't shelled out to comfy-gen yet); GPU mode skips pod
            # spawn entirely so it begins at download.
            "phase": "download" if mode == "gpu" else "pod_spawn",
        })

    # sgs-ui-8ef: UI + every other reader (wizard_routes, settings_validators,
    # civitai_share block) uses 'civitai_api_key'. The old 'civitai_token'
    # key was a typo and meant the credential never reached the installer.
    civitai_token = settings_store.get_credential("civitai_api_key")
    hf_token = settings_store.get_credential("hf_token")

    def _runner() -> None:
        _install_state["state"] = "running"
        if mode == "gpu":
            _run_gpu_install_subprocess(
                preset_id=body.preset_id,
                version=preset.get("comfygen_min_version", "0.0.0"),
                disk_size_gb=preset.get("disk_size_estimate_gb", 0),
                workflow_json_str=json.dumps(stored_blob),
                preset_models=preset.get("models", []) or [],
                canonical_paths=canonical_paths,
                endpoint_id=ep["endpoint_id"],
            )
            return
        _run_install_subprocess(
            preset_id=body.preset_id,
            version=preset.get("comfygen_min_version", "0.0.0"),
            disk_size_gb=preset.get("disk_size_estimate_gb", 0),
            workflow_json_str=json.dumps(stored_blob),
            volume_id=volume_id,
            canonical_paths=canonical_paths,
            civitai_token=civitai_token,
            hf_token=hf_token,
        )

    threading.Thread(target=_runner, daemon=True).start()

    return JSONResponse(
        status_code=202,
        content={
            "preset_id": body.preset_id,
            "state": _install_state["state"],
            "files_total": _install_state["files_total"],
            "started_at": _install_state["started_at"],
        },
    )


@router.get("/api/presets/install/progress")
def install_progress() -> JSONResponse:
    return JSONResponse(dict(_install_state))


@router.post("/api/presets/install/cancel")
def cancel_install() -> JSONResponse:
    """sgs-ui-8ww: SIGINT the running `comfy-gen install-preset` subprocess.
    The CLI catches SIGINT, calls /shutdown on the installer pod, and
    exits cleanly. A 30-second watchdog SIGKILLs if it doesn't.

    Returns 409 if no install is in flight."""
    proc = _install_proc.get("proc")
    current_state = _install_state["state"]
    if proc is None or current_state not in ("queued", "running"):
        raise HTTPException(
            status_code=409,
            detail=f"no install in progress (state={current_state})",
        )
    _install_state["state"] = "cancelling"
    try:
        proc.send_signal(signal.SIGINT)
    except (ProcessLookupError, OSError):
        pass  # Race: process already exited.

    # Capture the specific proc this watchdog is responsible for. If a
    # later install replaces _install_proc["proc"] before the timer
    # fires, we must NOT kill the new one.
    target = proc
    def _watchdog() -> None:
        time.sleep(30)
        if target.poll() is None:
            try:
                target.kill()
            except (ProcessLookupError, OSError):
                pass
    threading.Thread(target=_watchdog, daemon=True).start()

    return JSONResponse({"ok": True, "state": "cancelling", "preset_id": _install_state["preset_id"]})


def refresh_installed_presets() -> dict[str, Any]:
    """Re-fetch each installed preset's metadata from the registry and update
    the locally-stored workflow_json blob (workflows + recommendations +
    workflows[].settings) in place. Models are NOT re-downloaded — they're
    content-addressable by sha256, so the existing files stay valid.
    installed_paths is preserved verbatim.

    Best-effort: a registry that's unreachable, a preset that was archived,
    or a malformed preset.json is logged into the result and the existing
    Settings row is left untouched (so the user doesn't lose their install
    over a transient network blip).

    Used by main.py on startup so that registry-side edits (e.g. a preset
    author adding a workflows[].settings knob) actually propagate to
    already-installed presets without forcing an uninstall + reinstall.
    """
    result: dict[str, Any] = {"refreshed": [], "skipped": [], "errors": []}
    installed = settings_store.list_installed_presets()
    if not installed:
        return result

    # Refresh the manifest cache once for the whole sweep — avoids one HTTP
    # round-trip per installed preset.
    try:
        manifest = _fetch_manifest()
        _cache["manifest"] = manifest
        _cache["fetched_at"] = time.time()
        _save_disk_cache(manifest)
    except Exception as exc:
        # Offline / registry down → fall back to whatever's cached. If even
        # the disk cache is empty we just bail out: nothing to refresh from.
        manifest = _cache["manifest"] or _load_disk_cache()
        if manifest is None:
            result["errors"].append({"scope": "manifest", "error": str(exc)})
            return result

    manifest_index = {
        entry.get("id"): entry
        for entry in manifest.get("presets", []) if entry.get("id")
    }

    for row in installed:
        preset_id = row["preset_id"]
        manifest_entry = manifest_index.get(preset_id)
        if manifest_entry is None:
            # Preset is no longer in the registry — keep the local row as-is.
            # The user may have downloaded a now-yanked preset on purpose.
            result["skipped"].append({"preset_id": preset_id, "reason": "not in manifest"})
            continue
        preset_url = manifest_entry.get("preset_url")
        if not preset_url:
            result["skipped"].append({"preset_id": preset_id, "reason": "manifest entry has no preset_url"})
            continue

        try:
            resp = _cffi_requests.get(preset_url, timeout=_HTTP_TIMEOUT_SEC)
            if resp.status_code >= 400:
                raise RuntimeError(f"HTTP {resp.status_code}")
            preset = resp.json()
        except Exception as exc:
            result["errors"].append({"preset_id": preset_id, "error": str(exc)})
            continue

        # Rebuild the stored blob the same way install does, so the new
        # workflows[].settings field (and any updated recommendations) lands
        # in Settings.
        try:
            workflows = _fetch_workflows_for_preset(preset)
            stored_blob = {
                "workflows": workflows,
                "recommendations": _extract_recommendations(preset),
            }
            existing_detail = settings_store.get_installed_preset(preset_id) or {}
            settings_store.record_installed_preset(
                preset_id=preset_id,
                version=preset.get("comfygen_min_version", row.get("version") or "0.0.0"),
                disk_size_gb=preset.get("disk_size_estimate_gb", row.get("disk_size_gb")),
                workflow_json=json.dumps(stored_blob),
                # Preserve the canonical paths from the original install — a
                # metadata refresh must not nuke uninstall's path list.
                installed_paths=existing_detail.get("installed_paths") or None,
            )
            result["refreshed"].append({"preset_id": preset_id})
        except Exception as exc:
            result["errors"].append({"preset_id": preset_id, "error": f"persist: {exc}"})

    return result


@router.post("/api/presets/refresh-installed")
def refresh_installed_route() -> JSONResponse:
    """Manually trigger a metadata refresh for every installed preset.
    Returns a summary {refreshed, skipped, errors} the UI can surface."""
    return JSONResponse(refresh_installed_presets())


@router.post("/api/presets/uninstall/{preset_id}")
def uninstall(preset_id: str) -> JSONResponse:
    """Uninstall a preset.

    sgs-ui-i7j: actually delete the preset's model files on the volume via
    `comfy-gen delete --batch <paths>` before dropping the Settings row.
    Legacy rows (recorded before this feature shipped) don't have
    installed_paths persisted — for those we just drop the Settings row.
    """
    installed = settings_store.get_installed_preset(preset_id)
    if installed is None:
        raise HTTPException(status_code=404, detail=f"preset '{preset_id}' is not installed")

    paths = installed.get("installed_paths") or []
    if not paths:
        # Legacy row: no paths to delete. Drop the Settings row and return.
        settings_store.remove_installed_preset(preset_id)
        return JSONResponse({
            "ok": True, "preset_id": preset_id,
            "deleted_count": 0, "errors": [],
        })

    # Need an active endpoint to issue the delete against.
    ep = settings_store.get_endpoint("comfygen")
    if ep is None or not ep.get("endpoint_id"):
        raise HTTPException(
            status_code=409,
            detail=(
                "no ComfyGen endpoint configured — can't delete preset files. "
                "Provision an endpoint or clear the preset Settings row manually."
            ),
        )

    log_path = config.ROOT_DIR / "preset_install.log"
    log_fp = log_path.open("a", buffering=1)
    log_fp.write(f"\n\n=== {_now_iso()} uninstall preset={preset_id} ===\n")
    try:
        result = _delete_paths(paths, endpoint_id=ep["endpoint_id"], log_fp=log_fp)
    finally:
        log_fp.flush()
        log_fp.close()

    deleted = [r for r in result.get("results", []) if r.get("deleted")]
    errors = [r for r in result.get("results", []) if not r.get("deleted")]

    if not result.get("ok") or errors:
        # Partial / full failure → don't drop the Settings row; let the user retry.
        return JSONResponse(
            status_code=207,
            content={
                "ok": False, "preset_id": preset_id,
                "deleted_count": len(deleted),
                "errors": errors,
                "error": result.get("error"),
            },
        )

    # All paths deleted (or 'not found' which is fine — already gone).
    settings_store.remove_installed_preset(preset_id)
    return JSONResponse({
        "ok": True, "preset_id": preset_id,
        "deleted_count": len(deleted),
        "errors": [],
    })

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
import subprocess
import tempfile
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from curl_cffi import requests as _cffi_requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend import config, runpod_api, settings_store

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
    return JSONResponse({**row, "workflow_json": _normalize_stored_workflows(row["workflow_json"])})


# === Stage B: install + uninstall ============================================

class InstallBody(BaseModel):
    preset_id: str = Field(..., min_length=1)


# Module-level install state (single-install-at-a-time per .3 design call)
_install_state: dict[str, Any] = {
    "state": "idle",        # "idle" | "queued" | "running" | "completed" | "error"
    "preset_id": None,
    "started_at": None,
    "completed_at": None,
    "files_total": 0,
    "error": None,
    # sgs-ui-zr0: hash pre-flight classification (None until the hash phase
    # runs; non-None means /progress can show the cached/download breakdown)
    "cached_count": 0,
    "missing_count": 0,
    "stale_count": 0,
    "total_download_bytes": 0,
}
_install_lock = threading.Lock()


def _reset_install_state() -> None:
    """Test helper."""
    _install_state.update({
        "state": "idle",
        "preset_id": None,
        "started_at": None,
        "completed_at": None,
        "files_total": 0,
        "error": None,
        "cached_count": 0,
        "missing_count": 0,
        "stale_count": 0,
        "total_download_bytes": 0,
    })


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


def _canonical_path_for_entry(entry: dict) -> str:
    """Build the /runpod-volume path comfy-gen writes each file to. The
    dest+filename split mirrors what the worker's download_handler reassembles
    when deciding cache hits."""
    return f"/runpod-volume/ComfyUI/models/{entry['dest']}/{entry['filename']}"


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
    stdout_chunks: list[str] = []

    def _pump_stderr() -> None:
        assert proc.stderr is not None
        try:
            for line in iter(proc.stderr.readline, ""):
                stderr_tail.append(line)
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


def _hash_existing(
    canonical_paths: list[str],
    *,
    endpoint_id: str,
    log_fp,
) -> dict[str, dict | None]:
    """Call `comfy-gen hash --batch <paths>` and parse the response into
    {path: {sha256, bytes} or None on error/missing}.

    Returns an empty dict if the hash subprocess fails — the install handler
    treats that as 'fall back to download everything', not as a hard error.
    """
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, encoding="utf-8"
    ) as tf:
        json.dump(canonical_paths, tf)
        paths_file = tf.name
    try:
        rc, stdout, stderr = _run_comfy_gen_capture(
            [
                "comfy-gen", "hash",
                "--batch", paths_file,
                "--endpoint-id", endpoint_id,
                "--timeout", "600",
            ],
            log_fp=log_fp,
            label="hash",
            timeout=660,
        )
        if rc != 0:
            log_fp.write(f"\n[hash] FAILED rc={rc} (treating as 'all missing'): {stderr[-500:]}\n")
            return {}
        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError:
            log_fp.write("\n[hash] stdout not valid JSON (treating as 'all missing')\n")
            return {}
        results: dict[str, dict | None] = {}
        for entry in payload.get("files", []):
            path = entry.get("path")
            if not path:
                continue
            sha = entry.get("sha256")
            results[path] = {"sha256": sha, "bytes": entry.get("bytes")} if sha else None
        return results
    finally:
        try:
            Path(paths_file).unlink(missing_ok=True)
        except OSError:
            pass


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


def _run_install_subprocess(
    *,
    preset_id: str,
    version: str,
    disk_size_gb: int,
    workflow_json_str: str,
    batch_spec: list[dict],
    endpoint_id: str,
) -> None:
    """Background worker. Hashes the canonical paths first, classifies each
    entry as cached / missing / stale, deletes stale bytes, downloads only
    what's actually needed, then persists Settings on success."""
    canonical_paths = [_canonical_path_for_entry(e) for e in batch_spec]
    log_path = config.ROOT_DIR / "preset_install.log"
    log_fp = log_path.open("a", buffering=1)
    log_fp.write(f"\n\n=== {_now_iso()} preset={preset_id} START ===\n")
    download_batch_path: str | None = None
    try:
        # === phase 1: hash pre-flight (sgs-ui-zr0) =========================
        # Ask the worker for the sha256 of each canonical path. Missing
        # files come back with null hash; mismatched files come back with a
        # hash that doesn't match preset.json's expected value.
        hash_results = _hash_existing(canonical_paths, endpoint_id=endpoint_id, log_fp=log_fp)

        cached: list[str] = []
        missing: list[tuple[dict, str, int]] = []   # (entry, path, expected_bytes)
        stale: list[tuple[dict, str, int]] = []
        for entry, path in zip(batch_spec, canonical_paths):
            actual = hash_results.get(path) if hash_results else None
            expected_sha = entry.get("sha256")
            expected_bytes = int(entry.get("_expected_bytes") or 0)
            if hash_results and actual and expected_sha and actual["sha256"] == expected_sha:
                cached.append(path)
            elif hash_results and actual:
                # file present, but sha mismatch → stale
                stale.append((entry, path, expected_bytes))
            else:
                # file absent OR hash failed (fall back to "submit")
                missing.append((entry, path, expected_bytes))

        _install_state.update({
            "cached_count": len(cached),
            "missing_count": len(missing),
            "stale_count": len(stale),
            "total_download_bytes": sum(b for _, _, b in missing) + sum(b for _, _, b in stale),
        })

        # === phase 2: evict stale bytes (sgs-ui-i7j) =======================
        if stale:
            stale_paths = [p for _, p, _ in stale]
            log_fp.write(f"\n[install] {len(stale)} stale file(s) to delete: {stale_paths}\n")
            del_result = _delete_paths(stale_paths, endpoint_id=endpoint_id, log_fp=log_fp)
            if not del_result.get("ok"):
                _install_state.update({
                    "state": "error",
                    "completed_at": _now_iso(),
                    "error": f"failed to delete stale files: {del_result.get('error', 'unknown')}",
                })
                return

        # === phase 3: download missing + stale =============================
        reduced_batch = [_strip_internal_fields(e) for e, _, _ in missing + stale]
        if reduced_batch:
            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".json", delete=False, encoding="utf-8"
            ) as tf:
                json.dump(reduced_batch, tf)
                download_batch_path = tf.name

            rc, _stdout, stderr_tail = _run_comfy_gen_capture(
                [
                    "comfy-gen", "download",
                    "--batch", download_batch_path,
                    "--endpoint-id", endpoint_id,
                    "--timeout", "3600",
                ],
                log_fp=log_fp,
                label="download",
                timeout=3600 + 60,
            )
            if rc != 0:
                err = (stderr_tail or "comfy-gen download failed").strip()
                _install_state.update({
                    "state": "error",
                    "completed_at": _now_iso(),
                    "error": err[-3000:] if len(err) > 3000 else err,
                })
                return

        # === phase 4: persist ==============================================
        settings_store.record_installed_preset(
            preset_id=preset_id,
            version=version,
            disk_size_gb=disk_size_gb,
            workflow_json=workflow_json_str,
            installed_paths=canonical_paths,
        )
        _install_state.update({
            "state": "completed",
            "completed_at": _now_iso(),
            "error": None,
        })

    except Exception as exc:
        _install_state.update({
            "state": "error",
            "completed_at": _now_iso(),
            "error": str(exc)[:2000],
        })
    finally:
        log_fp.write(f"\n=== {_now_iso()} preset={preset_id} state={_install_state['state']} ===\n")
        log_fp.flush()
        log_fp.close()
        if download_batch_path:
            try:
                Path(download_batch_path).unlink(missing_ok=True)
            except OSError:
                pass


def _strip_internal_fields(entry: dict) -> dict:
    """Drop underscore-prefixed fields before writing the comfy-gen download
    spec. The CLI doesn't tolerate unknown fields cleanly."""
    return {k: v for k, v in entry.items() if not k.startswith("_")}


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
        if "json" in entry and isinstance(entry["json"], dict):
            out.append({"name": name, "json": entry["json"]})
            continue
        url = entry.get("url")
        if not url:
            out.append({"name": name, "json": {}})
            continue
        try:
            resp = _cffi_requests.get(url, timeout=_HTTP_TIMEOUT_SEC)
            body = resp.json() if resp.status_code < 400 else {}
        except Exception:
            body = {}
        out.append({"name": name, "json": body})
    return out


def _normalize_stored_workflows(raw: str | None) -> list[dict]:
    """Read-path tolerance for legacy rows. Pre-sgs-ui-chf rows stored a
    single workflow dict in workflow_json; new rows store a list of
    {name, json} entries. Always return the list shape so consumers
    (ComfyGen block dropdown, /api/presets/installed/{id}) can treat
    them uniformly."""
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, json.JSONDecodeError):
        return []
    if isinstance(parsed, dict):
        # Legacy: wrap as a single 'Default' workflow.
        return [{"name": "Default", "json": parsed}]
    if isinstance(parsed, list):
        return parsed
    return []


@router.post("/api/presets/install")
def install_preset(body: InstallBody) -> JSONResponse:
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

    # Fetch full preset detail (models + workflow URL)
    try:
        detail_resp = _cffi_requests.get(entry["preset_url"], timeout=_HTTP_TIMEOUT_SEC)
        if detail_resp.status_code >= 400:
            raise RuntimeError(f"registry returned HTTP {detail_resp.status_code}")
        preset = detail_resp.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"could not fetch preset detail: {exc}") from exc

    # Disk pre-check (best-effort; RunPod knows volume size, Settings knows
    # what we've already installed — see _compute_disk_budget).
    budget = _compute_disk_budget()
    need_gb = preset.get("disk_size_estimate_gb", 0)
    free_est = budget.get("free_estimate_gb")
    if free_est is not None and need_gb > free_est:
        raise HTTPException(
            status_code=400,
            detail=(
                f"insufficient disk: preset needs {need_gb} GB, "
                f"~{free_est} GB free on the ComfyGen volume "
                f"(total {budget['total_gb']} GB, est. used {budget['used_estimate_gb']} GB). "
                "Uninstall presets or resize the volume."
            ),
        )

    # Concurrency: one install at a time
    with _install_lock:
        if _install_state["state"] in ("queued", "running"):
            raise HTTPException(
                status_code=409,
                detail=f"another install is in progress: {_install_state['preset_id']}",
            )
        # Build the comfy-gen batch download spec from preset.models
        batch_spec: list[dict[str, Any]] = []
        for m in preset.get("models", []):
            dest = m.get("dest", "")
            # dest is in the form "subfolder/filename" — comfy-gen wants them
            # split: --dest <subfolder>, --filename <filename>. Batch entries
            # use the same {dest, filename} shape.
            if "/" in dest:
                subfolder, filename = dest.split("/", 1)
            else:
                subfolder, filename = "checkpoints", dest
            entry = {
                "source": m.get("source", "url") if m.get("source") in ("civitai", "url") else "url",
                "url": m["url"],
                "dest": subfolder,
                "filename": filename,
            }
            # Forward the preset's expected sha256 so the worker's
            # download_handler can do content-addressable dedup (skip aria2c
            # when a file at the target path already hashes to this value).
            if m.get("sha256"):
                entry["sha256"] = m["sha256"]
            # zr0: stash the expected byte size on the entry so the hash
            # pre-flight can compute total_download_bytes for the UI. The
            # underscore prefix marks it as not-for-the-CLI; _strip_internal_fields
            # drops it before the spec is written.
            size_gb = m.get("size_gb")
            if size_gb is not None:
                entry["_expected_bytes"] = int(float(size_gb) * (1024 ** 3))
            batch_spec.append(entry)

        # Fetch each workflow JSON (inline or URL) so they're cached locally
        # for the ComfyGen block dropdown to apply later. Multiple workflows
        # per preset is the canonical shape (sgs-ui-chf); the list keeps the
        # author-supplied display names ('I2V', 'V2V', 'Default', etc.).
        workflows = _fetch_workflows_for_preset(preset)

        _install_state.update({
            "state": "queued",
            "preset_id": body.preset_id,
            "started_at": _now_iso(),
            "completed_at": None,
            "files_total": len(batch_spec),
            "error": None,
        })

    # Kick off the subprocess in a daemon thread so the HTTP response
    # returns immediately.
    def _runner() -> None:
        _install_state["state"] = "running"
        _run_install_subprocess(
            preset_id=body.preset_id,
            version=preset.get("comfygen_min_version", "0.0.0"),
            disk_size_gb=preset.get("disk_size_estimate_gb", 0),
            workflow_json_str=json.dumps(workflows),
            batch_spec=batch_spec,
            endpoint_id=ep["endpoint_id"],
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

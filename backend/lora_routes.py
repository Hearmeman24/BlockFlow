"""HTTP routes for the LoRA management page (sgs-ui-eqc.1 + .5).

GET    /api/loras                       list LoRAs (volume + metadata, reconciled)
POST   /api/loras/sync                  explicit refresh: re-runs `comfy-gen list loras`
POST   /api/loras/download              kick off async download (returns 202)
GET    /api/loras/download/progress     poll current download state
POST   /api/loras/download/clear        reset terminal state for next submit
POST   /api/loras/delete                batch delete with per-file results
POST   /api/loras/set-source            backfill source metadata for an existing LoRA

Returns 409 when no ComfyGen endpoint is configured (matches preset_routes).

Download runs in a background thread (one at a time). The route returns 202
immediately with the queued state; the UI polls /download/progress every 2s
to render live percentage + log tail. Mirrors the preset_routes installer.
"""
from __future__ import annotations

import collections
import contextlib
import json
import re
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend import civitai_client, comfy_gen_cli, config, lora_metadata, settings_store

router = APIRouter()

LORA_DEST_DIR = "/runpod-volume/ComfyUI/models/loras"
_SUBPROCESS_TIMEOUT_SEC = 120  # `comfy-gen list loras` can cold-start ~50s
_DOWNLOAD_TIMEOUT_SEC = 30 * 60  # CivitAI/HF downloads can take many minutes
CACHE_STALE_AFTER_SEC = 24 * 3600  # 24h — matches the ComfyGen block cache TTL
_LOG_TAIL_MAXLEN = 30
_ARIA_PCT_RE = re.compile(r"\((\d+)%\)")
_cache_lock = threading.Lock()

# ---- Async download state machine ----
# state: "idle" → "queued" → "running" → "completed" | "error"
# One download at a time; concurrent submits get a 409 with the in-flight name.
_download_lock = threading.Lock()
_download_state: dict[str, Any] = {
    "state": "idle",
    "filename": None,
    "source": None,
    "source_id": None,
    "started_at": None,
    "completed_at": None,
    "progress_percent": None,
    "log_tail": "",
    "error": None,
    "elapsed_seconds": None,
    "recovered_from_worker_bug": False,
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _reset_download_state() -> None:
    _download_state.update({
        "state": "idle",
        "filename": None,
        "source": None,
        "source_id": None,
        "started_at": None,
        "completed_at": None,
        "progress_percent": None,
        "log_tail": "",
        "error": None,
        "elapsed_seconds": None,
        "recovered_from_worker_bug": False,
    })
    # Drop internal carry-over fields too
    for k in [k for k in _download_state if k.startswith("_")]:
        _download_state.pop(k, None)


def _public_download_state() -> dict[str, Any]:
    """Strip internal underscore-prefixed fields before returning to the UI."""
    return {k: v for k, v in _download_state.items() if not k.startswith("_")}


# ---- Pydantic ----

class DownloadRequest(BaseModel):
    source: str = Field(description="'civitai' | 'url'")
    version_id: int | None = None
    url: str | None = None
    filename: str | None = None
    base_model: str | None = None


class DeleteRequest(BaseModel):
    filenames: list[str]


class SetSourceRequest(BaseModel):
    filename: str
    source: str
    source_id: str | None = None
    url: str | None = None


# ---- Helpers (monkeypatched in tests) ----

def _endpoint_id_or_409() -> str:
    ep = settings_store.get_endpoint("comfygen")
    if ep is None or not ep.get("endpoint_id"):
        raise HTTPException(
            status_code=409,
            detail="no ComfyGen endpoint configured — set one up via Settings → Endpoints first",
        )
    return str(ep["endpoint_id"])


@contextlib.contextmanager
def _comfy_gen_subprocess_env(endpoint_id: str | None = None):
    """Build env for comfy-gen subprocesses from BlockFlow Settings.

    comfy-gen still reads RunPod auth from its own config/env layer. BlockFlow's
    canonical credential source is Settings, so bridge it at the subprocess
    boundary while keeping the secret out of argv.
    """
    try:
        with comfy_gen_cli.settings_subprocess_env(endpoint_id=endpoint_id) as env:
            yield env
    except comfy_gen_cli.ComfyGenConfigurationError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc


def _read_cached_loras() -> tuple[list[str], float | None]:
    """Read the shared comfy_gen info cache file. Returns (filenames, fetched_at).

    Same file the ComfyGen block reads/writes — avoids divergent caches.
    Missing file or unparseable returns ([], None).
    """
    path = config.COMFY_GEN_INFO_CACHE_PATH
    if not path.exists():
        return ([], None)
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return ([], None)
    fetched_at = data.get("fetched_at")
    # Pre-v2 caches stored flat filename strings under "loras" — reject
    # those so the next sync repopulates with rich {filename, path,
    # size_mb} objects.
    if data.get("version") != 2:
        return ([], float(fetched_at) if fetched_at else None)
    loras = data.get("loras") or []
    names = [item["filename"] for item in loras
             if isinstance(item, dict) and "filename" in item]
    return (names, float(fetched_at) if fetched_at else None)


def _write_cached_loras(filenames: list[str], fetched_at: float | None = None) -> None:
    """Update the shared cache file's `loras` field, preserving other keys.

    Called after a successful download/delete so the next GET shows fresh
    state without paying the cold-pod cost of a real `comfy-gen list loras`.

    Cache schema v2 stores objects {filename, path, size_mb} rather than
    flat strings. Since this writer only knows filenames, rich metadata
    for surviving files is preserved by reading the existing cache; new
    filenames get stub objects (filename only) until the next full sync
    repopulates path + size_mb.
    """
    path = config.COMFY_GEN_INFO_CACHE_PATH
    with _cache_lock:
        data: dict[str, Any] = {}
        if path.exists():
            try:
                data = json.loads(path.read_text())
            except (json.JSONDecodeError, OSError):
                data = {}

        # Index any existing rich objects so we can preserve them across
        # filename-only updates.
        prior = data.get("loras") if data.get("version") == 2 else []
        prior_by_name: dict[str, dict[str, Any]] = {}
        if isinstance(prior, list):
            for item in prior:
                if isinstance(item, dict) and "filename" in item:
                    prior_by_name[item["filename"]] = item

        merged = [prior_by_name.get(name, {"filename": name})
                  for name in sorted(set(filenames))]

        data["version"] = 2
        data["loras"] = merged
        if fetched_at is not None:
            data["fetched_at"] = fetched_at
        data.setdefault("samplers", [])
        data.setdefault("schedulers", [])
        data.setdefault("fetched_at", time.time())
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False))


def _fetch_loras_from_comfygen(endpoint_id: str) -> list[str]:
    """Invoke `comfy-gen list loras` and return filenames.

    Cold-path: takes 50-90s on a cold CPU pod. Only called from explicit
    /sync, never from GET. Updates the shared cache file as a side effect.

    `comfy-gen list` always emits JSON on stdout; the response shape is
    {ok, model_type, files: [{filename, path, size_mb}], ...}.
    """
    try:
        comfy_gen = comfy_gen_cli.resolve_comfy_gen()
    except comfy_gen_cli.ComfyGenNotFound as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    with _comfy_gen_subprocess_env(endpoint_id) as env:
        proc = subprocess.run(
            comfy_gen.command("list", "loras", "--endpoint-id", endpoint_id),
            capture_output=True, text=True, timeout=_SUBPROCESS_TIMEOUT_SEC,
            env=env,
        )
    if proc.returncode != 0:
        raise HTTPException(
            status_code=502,
            detail=f"comfy-gen list loras failed: {(proc.stderr or proc.stdout).strip()[:500]}",
        )
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail=f"comfy-gen returned invalid JSON: {exc}") from exc
    files = data.get("files") if isinstance(data, dict) else None
    if not isinstance(files, list):
        return []
    out: list[str] = []
    for item in files:
        if isinstance(item, dict) and item.get("filename"):
            out.append(str(item["filename"]))
        elif isinstance(item, str):
            out.append(item)
    _write_cached_loras(out, fetched_at=time.time())
    return out


def _delete_subprocess(filenames: list[str], endpoint_id: str) -> list[dict[str, Any]]:
    """Invoke `comfy-gen delete --batch <file>` and return per-file results.

    The CLI reads the batch payload from a JSON file (not stdin), so we
    write a tempfile and pass its path. Output is always JSON on stdout.
    """
    paths = [f"{LORA_DEST_DIR}/{f}" for f in filenames]
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False, encoding="utf-8") as tf:
        json.dump(paths, tf)
        batch_file = tf.name
    try:
        try:
            comfy_gen = comfy_gen_cli.resolve_comfy_gen()
        except comfy_gen_cli.ComfyGenNotFound as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        with _comfy_gen_subprocess_env(endpoint_id) as env:
            proc = subprocess.run(
                comfy_gen.command("delete", "--batch", batch_file, "--endpoint-id", endpoint_id),
                capture_output=True, text=True, timeout=_SUBPROCESS_TIMEOUT_SEC,
                env=env,
            )
    finally:
        try:
            Path(batch_file).unlink(missing_ok=True)
        except OSError:
            pass
    if proc.returncode != 0 and not proc.stdout.strip():
        raise HTTPException(
            status_code=502,
            detail=f"comfy-gen delete failed: {(proc.stderr or '').strip()[:500]}",
        )
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail=f"comfy-gen returned invalid JSON: {exc}") from exc
    results = data.get("results") if isinstance(data, dict) else data
    return results if isinstance(results, list) else []


def _run_download_streaming(
    entries: list[dict[str, Any]], endpoint_id: str,
) -> tuple[bool, Any]:
    """Run `comfy-gen download --batch <file>` with live stderr streaming.

    Returns (ok, payload):
      - (True, parsed_json_dict)  on subprocess success
      - (False, error_message)    on subprocess failure / timeout / non-JSON

    Side effect: updates `_download_state["log_tail"]` and
    `_download_state["progress_percent"]` as aria2 emits lines.
    Tests monkeypatch this whole function to bypass the real subprocess.
    """
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False, encoding="utf-8") as tf:
        json.dump(entries, tf)
        batch_file = tf.name
    tail: collections.deque[str] = collections.deque(maxlen=_LOG_TAIL_MAXLEN)

    def _pump(stream) -> None:
        for line in stream:
            stripped = line.rstrip("\n")
            tail.append(stripped)
            _download_state["log_tail"] = "\n".join(tail)
            m = _ARIA_PCT_RE.search(stripped)
            if m:
                try:
                    _download_state["progress_percent"] = int(m.group(1))
                except ValueError:
                    pass

    try:
        try:
            comfy_gen = comfy_gen_cli.resolve_comfy_gen()
        except comfy_gen_cli.ComfyGenNotFound as exc:
            return (False, str(exc))
        try:
            env_ctx = _comfy_gen_subprocess_env(endpoint_id)
            with env_ctx as env:
                proc = subprocess.Popen(
                    comfy_gen.command("download", "--batch", batch_file, "--endpoint-id", endpoint_id),
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                    env=env,
                )
                pump = threading.Thread(target=_pump, args=(proc.stderr,), daemon=True)
                pump.start()
                try:
                    stdout, _stderr = proc.communicate(timeout=_DOWNLOAD_TIMEOUT_SEC)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    return (False, f"comfy-gen download timed out after {_DOWNLOAD_TIMEOUT_SEC}s")
                pump.join(timeout=2)
                if proc.returncode != 0:
                    return (False, ((stdout or "").strip() or "comfy-gen download failed")[:1000])
                try:
                    return (True, json.loads(stdout))
                except json.JSONDecodeError as exc:
                    return (False, f"non-JSON output from comfy-gen: {exc}")
        except HTTPException as exc:
            return (False, str(exc.detail))
    finally:
        try:
            Path(batch_file).unlink(missing_ok=True)
        except OSError:
            pass


# ---- Routes ----

@router.get("/api/loras")
def list_loras_route() -> JSONResponse:
    """Fast path: serves the cached volume listing merged with DB metadata.

    Does NOT shell out to comfy-gen. Returns `stale: true` and `fetched_at: null`
    when no cache has been built yet, signaling the UI to trigger /sync.
    """
    _endpoint_id_or_409()
    filenames, fetched_at = _read_cached_loras()
    reconciled = lora_metadata.reconcile(filenames)
    stale = fetched_at is None or (time.time() - fetched_at) > CACHE_STALE_AFTER_SEC
    return JSONResponse({
        "loras": reconciled["merged"],
        "pruned": reconciled["pruned"],
        "fetched_at": fetched_at,
        "stale": stale,
    })


@router.post("/api/loras/sync")
def sync_loras_route() -> JSONResponse:
    """Cold path: shells out to `comfy-gen list loras`, then reconciles.

    Updates the shared comfy_gen cache file as a side effect, so the
    ComfyGen block dropdown also benefits.
    """
    endpoint_id = _endpoint_id_or_409()
    filenames = _fetch_loras_from_comfygen(endpoint_id)
    reconciled = lora_metadata.reconcile(filenames)
    return JSONResponse({
        "loras": reconciled["merged"],
        "pruned": reconciled["pruned"],
        "fetched_at": time.time(),
        "stale": False,
    })


@router.post("/api/loras/delete")
def delete_loras_route(body: DeleteRequest) -> JSONResponse:
    endpoint_id = _endpoint_id_or_409()
    if not body.filenames:
        raise HTTPException(status_code=400, detail="filenames must be non-empty")

    results = _delete_subprocess(body.filenames, endpoint_id)
    deleted_filenames: list[str] = []
    out: list[dict[str, Any]] = []
    for r in results:
        path = str(r.get("path", ""))
        fname = path.rsplit("/", 1)[-1] if path else ""
        deleted = bool(r.get("deleted"))
        out.append({
            "filename": fname,
            "deleted": deleted,
            "error": r.get("error"),
        })
        if deleted and fname:
            deleted_filenames.append(fname)
    if deleted_filenames:
        lora_metadata.delete_many(deleted_filenames)
        cached, fetched_at = _read_cached_loras()
        remaining = [f for f in cached if f not in set(deleted_filenames)]
        _write_cached_loras(remaining, fetched_at=fetched_at)

    all_ok = all(r["deleted"] for r in out)
    status = 200 if all_ok else 207
    return JSONResponse({"results": out}, status_code=status)


@router.post("/api/loras/download")
def download_lora_route(body: DownloadRequest) -> JSONResponse:
    """Kick off an async download. Returns 202 with the queued state.

    Validation + CivitAI metadata fetch happen inline (cheap, fast). The
    subprocess + post-success metadata persist happens on a background
    thread; UI polls /download/progress for status.
    """
    endpoint_id = _endpoint_id_or_409()

    with _download_lock:
        if _download_state["state"] in ("queued", "running"):
            raise HTTPException(
                status_code=409,
                detail=f"another download is in progress: {_download_state['filename']}",
            )

        # Inline validation + metadata fetch (fast — sub-second on success path)
        if body.source == "civitai":
            if body.version_id is None:
                raise HTTPException(status_code=400, detail="civitai source requires version_id")
            meta: civitai_client.CivitAIVersionMetadata | None = None
            try:
                meta = civitai_client.fetch_version_metadata(
                    body.version_id, api_key=config.CIVITAI_API_KEY,
                )
            except Exception:
                meta = None  # graceful — proceed without enrichment
            filename = body.filename \
                or (meta.primary_file_name if meta else None) \
                or f"civitai_{body.version_id}.safetensors"
            entry = {"source": "civitai", "version_id": body.version_id, "dest": "loras"}
            source = "civitai"
            source_id = str(body.version_id)
        elif body.source == "url":
            if not body.url:
                raise HTTPException(status_code=400, detail="url source requires url")
            host = (urlparse(body.url).hostname or "").lower()
            source = "hf" if host.endswith("huggingface.co") else "url"
            source_id = body.url
            filename = body.filename or _filename_from_url(body.url)
            entry = {"source": "url", "url": body.url, "dest": "loras", "filename": filename}
            meta = None
        else:
            raise HTTPException(status_code=400, detail=f"unknown source: {body.source!r}")

        # Seed the state machine; stash internal carry-over fields for the runner.
        _reset_download_state()
        _download_state.update({
            "state": "queued",
            "filename": filename,
            "source": source,
            "source_id": source_id,
            "started_at": _now_iso(),
            "progress_percent": 0,
            "_entry": entry,
            "_endpoint_id": endpoint_id,
            "_meta": meta,
            "_base_model_override": body.base_model,
        })

        threading.Thread(target=_download_runner, daemon=True).start()

    return JSONResponse(_public_download_state(), status_code=202)


def _download_runner() -> None:
    """Background runner: invoke subprocess, persist metadata on success,
    apply worker-bug recovery on the specific 'no new files' false-negative.
    """
    _download_state["state"] = "running"
    start_time = time.time()
    filename = _download_state["filename"]
    source = _download_state["source"]
    source_id = _download_state["source_id"]
    endpoint_id = _download_state.get("_endpoint_id")
    entry = _download_state.get("_entry")
    meta = _download_state.get("_meta")
    base_model_override = _download_state.get("_base_model_override")

    try:
        ok, payload = _run_download_streaming([entry], endpoint_id)

        if ok:
            _finalize_download_success(filename, source, source_id, meta,
                                       base_model_override, start_time)
            return

        # Worker false-negative recovery (sgs-worker bug):
        # `_download_civitai` raises "CivitAI download produced no new files"
        # when its before/after-listing diff doesn't see the new filename,
        # even though aria2 actually delivered the file. Verify by re-listing
        # and treat as success if our expected filename is now on the volume.
        err_msg = str(payload)
        if "no new files" in err_msg.lower():
            try:
                current = _fetch_loras_from_comfygen(endpoint_id)
                if filename in current:
                    _download_state["recovered_from_worker_bug"] = True
                    _finalize_download_success(filename, source, source_id, meta,
                                               base_model_override, start_time)
                    return
            except Exception:
                pass  # fall through to error below

        _download_state.update({
            "state": "error",
            "error": err_msg,
            "completed_at": _now_iso(),
            "elapsed_seconds": time.time() - start_time,
        })
    except Exception as exc:
        _download_state.update({
            "state": "error",
            "error": f"{type(exc).__name__}: {exc}"[:500],
            "completed_at": _now_iso(),
            "elapsed_seconds": time.time() - start_time,
        })


def _finalize_download_success(
    filename: str,
    source: str,
    source_id: str,
    meta: civitai_client.CivitAIVersionMetadata | None,
    base_model_override: str | None,
    start_time: float,
) -> None:
    size_bytes = (
        int(meta.primary_file_size_kb * 1024)
        if meta and meta.primary_file_size_kb else None
    )
    lora_metadata.upsert(
        filename=filename,
        source=source,
        source_id=source_id,
        base_model=(meta.base_model if meta else None) or base_model_override,
        trigger_words=(meta.trigger_words if meta else []),
        size_bytes=size_bytes,
    )
    _append_to_cache(filename)
    _download_state.update({
        "state": "completed",
        "progress_percent": 100,
        "completed_at": _now_iso(),
        "elapsed_seconds": time.time() - start_time,
    })


@router.get("/api/loras/download/progress")
def download_progress_route() -> JSONResponse:
    return JSONResponse(_public_download_state())


@router.post("/api/loras/download/clear")
def clear_download_state_route() -> JSONResponse:
    """Drop terminal state so the next submit can run. 409 if still active."""
    with _download_lock:
        if _download_state["state"] in ("queued", "running"):
            raise HTTPException(
                status_code=409,
                detail=f"download still in progress: {_download_state['filename']}",
            )
        _reset_download_state()
    return JSONResponse({"ok": True})


def _append_to_cache(filename: str) -> None:
    cached, fetched_at = _read_cached_loras()
    if filename not in set(cached):
        _write_cached_loras([*cached, filename], fetched_at=fetched_at)


def _filename_from_url(url: str) -> str:
    path = urlparse(url).path
    name = path.rsplit("/", 1)[-1] or "download.safetensors"
    return name


@router.post("/api/loras/set-source")
def set_source_route(body: SetSourceRequest) -> JSONResponse:
    if body.source not in lora_metadata.VALID_SOURCES:
        raise HTTPException(status_code=400, detail=f"invalid source: {body.source!r}")

    base_model: str | None = None
    trigger_words: list[str] = []
    source_id = body.source_id or body.url

    if body.source == "civitai":
        if not body.source_id:
            raise HTTPException(status_code=400, detail="civitai source requires source_id (version_id)")
        try:
            vid = int(body.source_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="civitai source_id must be an integer version_id") from exc
        try:
            meta = civitai_client.fetch_version_metadata(vid, api_key=config.CIVITAI_API_KEY)
            base_model = meta.base_model
            trigger_words = meta.trigger_words
        except Exception:
            pass  # graceful: persist source linkage even if metadata fetch fails

    lora_metadata.upsert(
        filename=body.filename,
        source=body.source,
        source_id=source_id,
        base_model=base_model,
        trigger_words=trigger_words,
    )
    row = lora_metadata.get(body.filename)
    return JSONResponse({"ok": True, "lora": row})

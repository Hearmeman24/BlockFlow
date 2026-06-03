"""HTTP routes for generalized endpoint model management.

GET    /api/models                       list cached model files across allowed folders
POST   /api/models/sync                  refresh every allowed folder from comfy-gen
POST   /api/models/download              kick off async download to a selected folder
GET    /api/models/download/progress     poll current download state
POST   /api/models/download/clear        reset terminal state for next submit
POST   /api/models/delete                batch delete with per-file results

The route intentionally stays a thin orchestrator. comfy-gen and the endpoint
own CivitAI/HF/direct download behavior; BlockFlow validates the destination
folder, starts the job, tracks progress, and keeps the local inventory cache in
sync.
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

from backend import comfy_gen_cli, config, lora_metadata, settings_store
from backend.lora_routes import (
    CACHE_STALE_AFTER_SEC,
    _comfy_gen_error_message,
    _loads_comfy_gen_stdout,
)

router = APIRouter()

ALLOWED_MODEL_FOLDERS = (
    "diffusion_models",
    "loras",
    "text_encoders",
    "vae",
    "upscale_models",
    "checkpoints",
)

_DEST_ROOT = "/runpod-volume/ComfyUI/models"
_SUBPROCESS_TIMEOUT_SEC = 120
_DOWNLOAD_TIMEOUT_SEC = 30 * 60
_LOG_TAIL_MAXLEN = 30
_ARIA_PCT_RE = re.compile(r"\((\d+)%\)")
_cache_lock = threading.Lock()
_download_lock = threading.Lock()
_download_state: dict[str, Any] = {
    "state": "idle",
    "folder": None,
    "filename": None,
    "source": None,
    "source_id": None,
    "started_at": None,
    "completed_at": None,
    "progress_percent": None,
    "log_tail": "",
    "error": None,
    "elapsed_seconds": None,
}


class ModelDownloadRequest(BaseModel):
    source: str = Field(description="'civitai' | 'url'")
    folder: str
    version_id: int | None = None
    url: str | None = None
    filename: str | None = None
    base_model: str | None = None


class ModelDeleteItem(BaseModel):
    folder: str
    filename: str


class ModelDeleteRequest(BaseModel):
    items: list[ModelDeleteItem]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _reset_download_state() -> None:
    _download_state.update({
        "state": "idle",
        "folder": None,
        "filename": None,
        "source": None,
        "source_id": None,
        "started_at": None,
        "completed_at": None,
        "progress_percent": None,
        "log_tail": "",
        "error": None,
        "elapsed_seconds": None,
    })
    for k in [k for k in _download_state if k.startswith("_")]:
        _download_state.pop(k, None)


def _public_download_state() -> dict[str, Any]:
    return {k: v for k, v in _download_state.items() if not k.startswith("_")}


def _inline_threads_for_tests(monkeypatch) -> None:
    """Test helper: make model_routes.threading.Thread execute inline."""
    class InlineThread:
        def __init__(self, target=None, daemon=None, **kwargs):
            self._target = target

        def start(self):
            if self._target:
                self._target()

        def join(self, timeout=None):
            pass

    monkeypatch.setattr(threading, "Thread", InlineThread)


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
    try:
        with comfy_gen_cli.settings_subprocess_env(endpoint_id=endpoint_id) as env:
            yield env
    except comfy_gen_cli.ComfyGenConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _validate_folder(folder: str) -> str:
    if folder not in ALLOWED_MODEL_FOLDERS:
        raise HTTPException(
            status_code=400,
            detail=f"folder must be one of: {', '.join(ALLOWED_MODEL_FOLDERS)}",
        )
    return folder


def _validate_filename(filename: str) -> str:
    clean = filename.strip()
    if not clean or "/" in clean or "\\" in clean or clean in {".", ".."}:
        raise HTTPException(status_code=400, detail="filename must be a single model file name")
    return clean


def _canonical_path(folder: str, filename: str) -> str:
    return f"{_DEST_ROOT}/{_validate_folder(folder)}/{_validate_filename(filename)}"


def _read_cache_file() -> tuple[dict[str, Any], float | None]:
    path = config.COMFY_GEN_INFO_CACHE_PATH
    if not path.exists():
        return ({}, None)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return ({}, None)
    if not isinstance(data, dict):
        return ({}, None)
    fetched_at = data.get("fetched_at")
    try:
        parsed_fetched_at = float(fetched_at) if fetched_at is not None else None
    except (TypeError, ValueError):
        parsed_fetched_at = None
    return (data, parsed_fetched_at)


def _details_from_cache(data: dict[str, Any], folder: str) -> list[dict[str, Any]]:
    if data.get("version") != 2:
        return []
    raw = data.get("loras") if folder == "loras" else (data.get("models") or {}).get(folder)
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if isinstance(item, dict) and item.get("filename"):
            out.append(dict(item))
        elif isinstance(item, str):
            out.append({"filename": item})
    return out


def _model_row_from_detail(folder: str, detail: dict[str, Any]) -> dict[str, Any]:
    filename = str(detail["filename"])
    path = str(detail.get("path") or _canonical_path(folder, filename))
    size_bytes = None
    if detail.get("size_bytes") is not None:
        size_bytes = int(detail["size_bytes"])
    elif detail.get("size_mb") is not None:
        size_bytes = int(float(detail["size_mb"]) * 1024 * 1024)
    return {
        "folder": folder,
        "filename": filename,
        "path": path,
        "source": "unknown",
        "source_id": None,
        "base_model": None,
        "trigger_words": [],
        "size_bytes": size_bytes,
        "downloaded_at": None,
        "updated_at": None,
    }


def _cached_models_response() -> tuple[list[dict[str, Any]], list[str], float | None]:
    data, fetched_at = _read_cache_file()
    rows: list[dict[str, Any]] = []
    pruned: list[str] = []
    for folder in ALLOWED_MODEL_FOLDERS:
        details = _details_from_cache(data, folder)
        if folder == "loras":
            detail_by_name = {str(d["filename"]): d for d in details}
            reconciled = lora_metadata.reconcile(list(detail_by_name))
            pruned.extend(reconciled["pruned"])
            for lora in reconciled["merged"]:
                row = _model_row_from_detail(folder, detail_by_name.get(lora["filename"], {"filename": lora["filename"]}))
                row.update({
                    "source": lora["source"],
                    "source_id": lora["source_id"],
                    "base_model": lora["base_model"],
                    "trigger_words": lora["trigger_words"],
                    "downloaded_at": lora["downloaded_at"],
                    "updated_at": lora["updated_at"],
                    "size_bytes": lora["size_bytes"] if lora["size_bytes"] is not None else row["size_bytes"],
                })
                rows.append(row)
        else:
            rows.extend(_model_row_from_detail(folder, d) for d in details)
    return (rows, pruned, fetched_at)


def _write_cached_models(folder_details: dict[str, list[dict[str, Any]]], fetched_at: float | None = None) -> None:
    with _cache_lock:
        path = config.COMFY_GEN_INFO_CACHE_PATH
        data: dict[str, Any] = {}
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                data = {}

        data["version"] = 2
        data.setdefault("samplers", [])
        data.setdefault("schedulers", [])
        data["loras"] = folder_details.get("loras", _details_from_cache(data, "loras"))
        models = data.get("models") if isinstance(data.get("models"), dict) else {}
        for folder in ALLOWED_MODEL_FOLDERS:
            if folder == "loras":
                continue
            models[folder] = folder_details.get(folder, _details_from_cache(data, folder))
        data["models"] = models
        if fetched_at is not None:
            data["fetched_at"] = fetched_at
        data.setdefault("fetched_at", time.time())
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _extract_files(data: Any) -> list[dict[str, Any]]:
    files = data.get("files") if isinstance(data, dict) else None
    if not isinstance(files, list):
        return []
    out: list[dict[str, Any]] = []
    for item in files:
        if isinstance(item, dict) and item.get("filename"):
            out.append(dict(item))
        elif isinstance(item, str):
            out.append({"filename": item})
    return out


def _list_folder_from_comfygen(folder: str, endpoint_id: str) -> list[dict[str, Any]]:
    _validate_folder(folder)
    try:
        comfy_gen = comfy_gen_cli.resolve_comfy_gen()
    except comfy_gen_cli.ComfyGenNotFound as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    with _comfy_gen_subprocess_env(endpoint_id) as env:
        proc = subprocess.run(
            comfy_gen.command("list", folder, "--endpoint-id", endpoint_id),
            capture_output=True, text=True, timeout=_SUBPROCESS_TIMEOUT_SEC, env=env,
        )
    data: Any | None = None
    parse_error: json.JSONDecodeError | None = None
    if proc.stdout.strip():
        try:
            data = _loads_comfy_gen_stdout(proc.stdout)
        except json.JSONDecodeError as exc:
            parse_error = exc
    if data is not None:
        message = _comfy_gen_error_message(data)
        if message is not None:
            raise HTTPException(status_code=502, detail=f"comfy-gen list {folder} failed: {message}")
    if proc.returncode != 0:
        raise HTTPException(
            status_code=502,
            detail=f"comfy-gen list {folder} failed: {(proc.stderr or proc.stdout).strip()[:500]}",
        )
    if data is None:
        if parse_error is not None:
            raise HTTPException(status_code=502, detail=f"comfy-gen returned invalid JSON: {parse_error}") from parse_error
        raise HTTPException(status_code=502, detail="comfy-gen returned empty output")
    return _extract_files(data)


def _sync_all_folders(endpoint_id: str) -> dict[str, list[dict[str, Any]]]:
    return {folder: _list_folder_from_comfygen(folder, endpoint_id) for folder in ALLOWED_MODEL_FOLDERS}


def _delete_subprocess(items: list[dict[str, str]], endpoint_id: str) -> list[dict[str, Any]]:
    paths = [item["path"] for item in items]
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
                capture_output=True, text=True, timeout=_SUBPROCESS_TIMEOUT_SEC, env=env,
            )
    finally:
        try:
            Path(batch_file).unlink(missing_ok=True)
        except OSError:
            pass
    if proc.returncode != 0 and not proc.stdout.strip():
        raise HTTPException(status_code=502, detail=f"comfy-gen delete failed: {(proc.stderr or '').strip()[:500]}")
    try:
        data = _loads_comfy_gen_stdout(proc.stdout)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail=f"comfy-gen returned invalid JSON: {exc}") from exc
    message = _comfy_gen_error_message(data)
    if message is not None:
        raise HTTPException(status_code=502, detail=f"comfy-gen delete failed: {message}")
    results = data.get("results") if isinstance(data, dict) else data
    return results if isinstance(results, list) else []


def _run_download_streaming(entries: list[dict[str, Any]], endpoint_id: str) -> tuple[bool, Any]:
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
            with _comfy_gen_subprocess_env(endpoint_id) as env:
                proc = subprocess.Popen(
                    comfy_gen.command("download", "--batch", batch_file, "--endpoint-id", endpoint_id),
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
                )
                pump = threading.Thread(target=_pump, args=(proc.stderr,), daemon=True)
                pump.start()
                try:
                    stdout, _stderr = proc.communicate(timeout=_DOWNLOAD_TIMEOUT_SEC)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    return (False, f"comfy-gen download timed out after {_DOWNLOAD_TIMEOUT_SEC}s")
                pump.join(timeout=2)
                try:
                    data = _loads_comfy_gen_stdout(stdout)
                except json.JSONDecodeError as exc:
                    if proc.returncode != 0:
                        return (False, ((stdout or "").strip() or "comfy-gen download failed")[:1000])
                    return (False, f"non-JSON output from comfy-gen: {exc}")
                message = _comfy_gen_error_message(data)
                if message is not None:
                    return (False, message)
                if proc.returncode != 0:
                    return (False, ((stdout or "").strip() or "comfy-gen download failed")[:1000])
                return (True, data)
        except HTTPException as exc:
            return (False, str(exc.detail))
    finally:
        try:
            Path(batch_file).unlink(missing_ok=True)
        except OSError:
            pass


def _filename_from_url(url: str) -> str:
    path = urlparse(url).path
    return path.rsplit("/", 1)[-1] or "download.safetensors"


def _append_to_cache(folder: str, filename: str) -> None:
    data, fetched_at = _read_cache_file()
    details = {f: _details_from_cache(data, f) for f in ALLOWED_MODEL_FOLDERS}
    existing = {str(item["filename"]) for item in details[folder] if item.get("filename")}
    if filename not in existing:
        details[folder].append({"filename": filename, "path": _canonical_path(folder, filename)})
    _write_cached_models(details, fetched_at=fetched_at)


def _remove_deleted_from_cache(deleted: list[tuple[str, str]]) -> None:
    if not deleted:
        return
    data, fetched_at = _read_cache_file()
    details = {f: _details_from_cache(data, f) for f in ALLOWED_MODEL_FOLDERS}
    by_folder: dict[str, set[str]] = {}
    for folder, filename in deleted:
        by_folder.setdefault(folder, set()).add(filename)
    for folder, names in by_folder.items():
        details[folder] = [item for item in details[folder] if str(item.get("filename")) not in names]
    _write_cached_models(details, fetched_at=fetched_at)


@router.get("/api/models")
def list_models_route() -> JSONResponse:
    _endpoint_id_or_409()
    rows, pruned, fetched_at = _cached_models_response()
    stale = fetched_at is None or (time.time() - fetched_at) > CACHE_STALE_AFTER_SEC
    return JSONResponse({
        "folders": list(ALLOWED_MODEL_FOLDERS),
        "models": rows,
        "pruned": pruned,
        "fetched_at": fetched_at,
        "stale": stale,
    })


@router.post("/api/models/sync")
def sync_models_route() -> JSONResponse:
    endpoint_id = _endpoint_id_or_409()
    fetched_at = time.time()
    folder_details = _sync_all_folders(endpoint_id)
    _write_cached_models(folder_details, fetched_at=fetched_at)
    rows, pruned, _ = _cached_models_response()
    return JSONResponse({
        "folders": list(ALLOWED_MODEL_FOLDERS),
        "models": rows,
        "pruned": pruned,
        "fetched_at": fetched_at,
        "stale": False,
    })


@router.post("/api/models/delete")
def delete_models_route(body: ModelDeleteRequest) -> JSONResponse:
    endpoint_id = _endpoint_id_or_409()
    if not body.items:
        raise HTTPException(status_code=400, detail="items must be non-empty")
    items = [
        {"folder": _validate_folder(item.folder),
         "filename": _validate_filename(item.filename),
         "path": _canonical_path(item.folder, item.filename)}
        for item in body.items
    ]
    results = _delete_subprocess(items, endpoint_id)
    deleted: list[tuple[str, str]] = []
    out: list[dict[str, Any]] = []
    input_paths = {item["path"] for item in items}
    result_by_path: dict[str, dict[str, Any]] = {}
    for r in results:
        path = str(r.get("path", ""))
        if path in input_paths and path not in result_by_path:
            result_by_path[path] = r
    for item in items:
        r = result_by_path.get(item["path"])
        if r is None:
            out.append({
                "folder": item["folder"],
                "filename": item["filename"],
                "path": item["path"],
                "deleted": False,
                "error": "no result returned by comfy-gen delete",
            })
            continue
        ok = bool(r.get("deleted"))
        out.append({
            "folder": item["folder"],
            "filename": item["filename"],
            "path": item["path"],
            "deleted": ok,
            "error": r.get("error"),
        })
        if ok:
            deleted.append((item["folder"], item["filename"]))
    if deleted:
        lora_deleted = [filename for folder, filename in deleted if folder == "loras"]
        if lora_deleted:
            lora_metadata.delete_many(lora_deleted)
        _remove_deleted_from_cache(deleted)
    all_ok = all(r["deleted"] for r in out)
    return JSONResponse({"results": out}, status_code=200 if all_ok else 207)


def _folder_from_path(path: str) -> str | None:
    prefix = f"{_DEST_ROOT}/"
    if not path.startswith(prefix):
        return None
    folder = path[len(prefix):].split("/", 1)[0]
    return folder if folder in ALLOWED_MODEL_FOLDERS else None


@router.post("/api/models/download")
def download_model_route(body: ModelDownloadRequest) -> JSONResponse:
    endpoint_id = _endpoint_id_or_409()
    folder = _validate_folder(body.folder)
    with _download_lock:
        if _download_state["state"] in ("queued", "running"):
            raise HTTPException(status_code=409, detail=f"another download is in progress: {_download_state['filename']}")
        if body.source == "civitai":
            if body.version_id is None:
                raise HTTPException(status_code=400, detail="civitai source requires version_id")
            filename = _validate_filename(body.filename or f"civitai_{body.version_id}.safetensors")
            entry: dict[str, Any] = {
                "source": "civitai",
                "version_id": body.version_id,
                "dest": folder,
                "filename": filename,
            }
            source = "civitai"
            source_id = str(body.version_id)
        elif body.source == "url":
            if not body.url:
                raise HTTPException(status_code=400, detail="url source requires url")
            filename = _validate_filename(body.filename or _filename_from_url(body.url))
            entry = {"source": "url", "url": body.url, "dest": folder, "filename": filename}
            host = (urlparse(body.url).hostname or "").lower()
            source = "hf" if host.endswith("huggingface.co") else "url"
            source_id = body.url
        else:
            raise HTTPException(status_code=400, detail=f"unknown source: {body.source!r}")

        _reset_download_state()
        _download_state.update({
            "state": "queued",
            "folder": folder,
            "filename": filename,
            "source": source,
            "source_id": source_id,
            "started_at": _now_iso(),
            "progress_percent": 0,
            "_entry": entry,
            "_endpoint_id": endpoint_id,
            "_base_model_override": body.base_model,
        })
        threading.Thread(target=_download_runner, daemon=True).start()
    return JSONResponse(_public_download_state(), status_code=202)


def _download_runner() -> None:
    _download_state["state"] = "running"
    start_time = time.time()
    folder = _download_state["folder"]
    filename = _download_state["filename"]
    source = _download_state["source"]
    source_id = _download_state["source_id"]
    entry = _download_state.get("_entry")
    endpoint_id = _download_state.get("_endpoint_id")
    base_model_override = _download_state.get("_base_model_override")
    try:
        ok, payload = _run_download_streaming([entry], endpoint_id)
        if not ok:
            _download_state.update({
                "state": "error",
                "error": str(payload),
                "completed_at": _now_iso(),
                "elapsed_seconds": time.time() - start_time,
            })
            return
        _append_to_cache(folder, filename)
        if folder == "loras":
            lora_metadata.upsert(
                filename=filename,
                source=source,
                source_id=source_id,
                base_model=base_model_override,
                trigger_words=[],
            )
        _download_state.update({
            "state": "completed",
            "progress_percent": 100,
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


@router.get("/api/models/download/progress")
def download_progress_route() -> JSONResponse:
    return JSONResponse(_public_download_state())


@router.post("/api/models/download/clear")
def clear_download_state_route() -> JSONResponse:
    with _download_lock:
        if _download_state["state"] in ("queued", "running"):
            raise HTTPException(status_code=409, detail=f"download still in progress: {_download_state['filename']}")
        _reset_download_state()
    return JSONResponse({"ok": True})

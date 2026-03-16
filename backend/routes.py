from __future__ import annotations

import json
import random
import string
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from backend import config, db, media_meta

router = APIRouter()


@router.get("/api/feature-flags")
def feature_flags() -> JSONResponse:
    return JSONResponse({"advanced": config.ADVANCED_MODE})


FLOW_SUFFIX = ".flow.json"
JSON_SUFFIX = ".json"


def _normalize_flow_name(raw_name: str) -> str:
    name = str(raw_name or "").strip()
    if not name:
        raise ValueError("flow name is required")

    # Accept pasted filename/path, but persist by basename only.
    name = name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if name.endswith(FLOW_SUFFIX):
        name = name[: -len(FLOW_SUFFIX)]
    elif name.endswith(JSON_SUFFIX):
        name = name[: -len(JSON_SUFFIX)]
    name = name.strip()

    if not name:
        raise ValueError("flow name is required")
    if name in {".", ".."} or "/" in name or "\\" in name:
        raise ValueError("invalid flow name")
    return name


def _flow_path_for_name(flow_name: str) -> tuple[str, Path]:
    normalized = _normalize_flow_name(flow_name)
    preferred = config.FLOWS_DIR / f"{normalized}{FLOW_SUFFIX}"
    legacy = config.FLOWS_DIR / f"{normalized}{JSON_SUFFIX}"

    if preferred.exists():
        return normalized, preferred
    if legacy.exists():
        return normalized, legacy
    return normalized, preferred


@router.get("/api/flows")
def api_flows_list() -> JSONResponse:
    best_by_name: dict[str, tuple[Path, int, float]] = {}
    for path in config.FLOWS_DIR.iterdir():
        if not path.is_file():
            continue
        if not (path.name.endswith(FLOW_SUFFIX) or path.name.endswith(JSON_SUFFIX)):
            continue
        try:
            name = _normalize_flow_name(path.name)
        except ValueError:
            continue

        rank = 1 if path.name.endswith(FLOW_SUFFIX) else 0
        mtime = path.stat().st_mtime
        existing = best_by_name.get(name)
        if not existing or rank > existing[1] or (rank == existing[1] and mtime > existing[2]):
            best_by_name[name] = (path, rank, mtime)

    flows: list[dict[str, Any]] = []
    for name in sorted(best_by_name.keys(), key=str.lower):
        path = best_by_name[name][0]
        stat = path.stat()
        flows.append(
            {
                "name": name,
                "filename": path.name,
                "updated_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                "size_bytes": stat.st_size,
            }
        )

    return JSONResponse({"ok": True, "flows": flows})


@router.get("/api/flows/{flow_name}")
def api_flows_get(flow_name: str) -> JSONResponse:
    try:
        normalized, path = _flow_path_for_name(flow_name)
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    if not path.exists():
        return JSONResponse({"ok": False, "error": "flow not found"}, status_code=404)

    try:
        flow = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"failed reading flow: {e}"}, status_code=500)

    return JSONResponse({"ok": True, "name": normalized, "filename": path.name, "flow": flow})


@router.post("/api/flows")
def api_flows_save(payload: dict[str, Any]) -> JSONResponse:
    try:
        normalized, path = _flow_path_for_name(str(payload.get("name") or ""))
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    flow = payload.get("flow")
    if not isinstance(flow, dict):
        return JSONResponse({"ok": False, "error": "flow must be a JSON object"}, status_code=400)

    overwritten = path.exists()
    try:
        config.FLOWS_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(flow, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"failed saving flow: {e}"}, status_code=500)

    return JSONResponse(
        {
            "ok": True,
            "name": normalized,
            "filename": path.name,
            "overwritten": overwritten,
        }
    )


@router.get("/api/runs")
def api_runs_list(limit: int = Query(50), offset: int = Query(0), favorited: bool = Query(False)) -> JSONResponse:
    total = db.count_runs(favorited_only=favorited)
    runs = db.list_runs(limit=limit, offset=offset, favorited_only=favorited)
    return JSONResponse({"ok": True, "runs": runs, "total": total, "limit": limit, "offset": offset})


@router.get("/api/runs/{run_id}")
def api_run_one(run_id: str) -> JSONResponse:
    run = db.get_run(run_id)
    if not run:
        return JSONResponse({"ok": False, "error": "run not found"}, status_code=404)
    return JSONResponse({"ok": True, "run": run})


@router.post("/api/runs")
def api_runs_create(payload: dict[str, Any]) -> JSONResponse:
    required = ("id", "name", "status", "flow_snapshot", "block_results", "created_at")
    missing = [k for k in required if k not in payload]
    if missing:
        return JSONResponse({"ok": False, "error": f"missing fields: {', '.join(missing)}"}, status_code=400)
    db.save_run(payload)
    return JSONResponse({"ok": True})


@router.patch("/api/runs/{run_id}/favorite")
def api_run_toggle_favorite(run_id: str) -> JSONResponse:
    result = db.toggle_run_favorited(run_id)
    if result is None:
        return JSONResponse({"ok": False, "error": "run not found"}, status_code=404)
    return JSONResponse({"ok": True, "favorited": result})


@router.delete("/api/runs/{run_id}")
def api_run_delete(run_id: str) -> JSONResponse:
    deleted = db.delete_run(run_id)
    if not deleted:
        return JSONResponse({"ok": False, "error": "run not found"}, status_code=404)
    return JSONResponse({"ok": True})


@router.get("/api/file-metadata/{filename:path}")
def api_file_metadata(filename: str) -> JSONResponse:
    """Read embedded generation metadata from an output file."""
    local_file = config.LOCAL_OUTPUT_DIR / filename
    if not local_file.exists():
        return JSONResponse({"ok": False, "error": "File not found"}, status_code=404)
    meta = media_meta.read_metadata(local_file)
    if not meta:
        return JSONResponse({"ok": False, "has_meta": False})
    return JSONResponse({"ok": True, "has_meta": True, "meta": meta})


# ---------------------------------------------------------------------------
# Prompt library
# ---------------------------------------------------------------------------

_prompt_library_lock = threading.Lock()


def _read_prompt_library() -> list[dict[str, Any]]:
    path = config.PROMPT_LIBRARY_PATH
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return data
        return []
    except Exception:
        return []


def _write_prompt_library(prompts: list[dict[str, Any]]) -> None:
    config.PROMPT_LIBRARY_PATH.write_text(
        json.dumps(prompts, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )


@router.get("/api/prompt-library")
def api_prompt_library_list() -> JSONResponse:
    with _prompt_library_lock:
        prompts = _read_prompt_library()
    return JSONResponse({"ok": True, "prompts": prompts})


@router.post("/api/prompt-library")
def api_prompt_library_create(payload: dict[str, Any]) -> JSONResponse:
    name = payload.get("name")
    ptype = payload.get("type")
    content = payload.get("content")

    if not name or not isinstance(name, str):
        return JSONResponse({"ok": False, "error": "name is required"}, status_code=400)
    if ptype not in ("system", "user"):
        return JSONResponse({"ok": False, "error": "type must be 'system' or 'user'"}, status_code=400)
    if not content or not isinstance(content, str):
        return JSONResponse({"ok": False, "error": "content is required"}, status_code=400)

    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    prompt: dict[str, Any] = {
        "id": f"prompt-{int(time.time())}-{suffix}",
        "name": name,
        "type": ptype,
        "content": content,
        "created_at": datetime.now(tz=timezone.utc).isoformat(),
    }

    with _prompt_library_lock:
        prompts = _read_prompt_library()
        prompts.append(prompt)
        _write_prompt_library(prompts)

    return JSONResponse({"ok": True, "prompt": prompt})


@router.delete("/api/prompt-library/{prompt_id}")
def api_prompt_library_delete(prompt_id: str) -> JSONResponse:
    with _prompt_library_lock:
        prompts = _read_prompt_library()
        new_prompts = [p for p in prompts if p.get("id") != prompt_id]
        if len(new_prompts) == len(prompts):
            return JSONResponse({"ok": False, "error": "prompt not found"}, status_code=404)
        _write_prompt_library(new_prompts)
    return JSONResponse({"ok": True})

from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from backend import config, db

EXECUTOR: ThreadPoolExecutor = None  # type: ignore[assignment]
JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()
LORA_CACHE_LOCK = threading.Lock()
LORA_CACHE: dict[str, Any] = {
    "ts": 0.0,
    "high": [],
    "low": [],
}
WRITER_SETTINGS_LOCK = threading.Lock()
WRITER_SETTINGS: dict[str, Any] = {
    "system_prompt": config.DEFAULT_WRITER_SYSTEM_PROMPT,
    "model": config.DEFAULT_WRITER_MODEL,
    "temperature": config.DEFAULT_WRITER_TEMPERATURE,
    "max_tokens": config.DEFAULT_WRITER_MAX_TOKENS,
}
OPENROUTER_MODELS_CACHE_LOCK = threading.Lock()
OPENROUTER_MODELS_CACHE: dict[str, Any] = {
    "ts": 0.0,
    "models": [],
}


def _persist_jobs_locked() -> None:
    """Persist all jobs atomically. Call this only while holding JOBS_LOCK."""
    try:
        tmp_path = config.JOB_HISTORY_PATH.with_suffix(".json.tmp")
        with tmp_path.open("w", encoding="utf-8") as f:
            json.dump(JOBS, f, ensure_ascii=True, sort_keys=True)
        tmp_path.replace(config.JOB_HISTORY_PATH)
    except Exception as e:
        print(f"[job-history] failed to persist {config.JOB_HISTORY_PATH}: {e}")


def _load_jobs_from_disk() -> None:
    if not config.JOB_HISTORY_PATH.exists():
        return

    try:
        raw = json.loads(config.JOB_HISTORY_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return
    except Exception as e:
        print(f"[job-history] failed to parse {config.JOB_HISTORY_PATH}: {e}")
        return

    loaded = 0
    migrated = 0
    now = time.time()
    terminal_statuses = {"COMPLETED", "COMPLETED_WITH_WARNING", "FAILED", "CANCELLED", "TIMED_OUT"}
    to_migrate: list[dict] = []

    with JOBS_LOCK:
        for job_id, record in raw.items():
            if not isinstance(job_id, str) or not isinstance(record, dict):
                continue
            rec = dict(record)
            rec.setdefault("job_id", job_id)
            rec.setdefault("created_at", now)
            rec.setdefault("updated_at", now)
            status = str(rec.get("status", "")).upper()
            if status in terminal_statuses:
                to_migrate.append(rec)
            else:
                JOBS[job_id] = rec
                loaded += 1

    # Migrate terminal jobs to SQLite
    for rec in to_migrate:
        try:
            db.save_job(rec)
            migrated += 1
        except Exception as e:
            print(f"[job-history] failed to migrate job {rec.get('job_id')}: {e}")
            # Keep in memory as fallback
            with JOBS_LOCK:
                JOBS[rec["job_id"]] = rec
                loaded += 1

    # Rewrite JSON to contain only active jobs
    if to_migrate:
        with JOBS_LOCK:
            _persist_jobs_locked()

    print(f"[job-history] loaded {loaded} active jobs, migrated {migrated} to SQLite")


def _persist_writer_settings_locked() -> None:
    try:
        tmp_path = config.PROMPT_WRITER_SETTINGS_PATH.with_suffix(".json.tmp")
        with tmp_path.open("w", encoding="utf-8") as f:
            json.dump(WRITER_SETTINGS, f, ensure_ascii=True, sort_keys=True, indent=2)
        tmp_path.replace(config.PROMPT_WRITER_SETTINGS_PATH)
    except Exception as e:
        print(f"[writer-settings] failed to persist {config.PROMPT_WRITER_SETTINGS_PATH}: {e}")


def _load_writer_settings_from_disk() -> None:
    if not config.PROMPT_WRITER_SETTINGS_PATH.exists():
        return
    try:
        raw = json.loads(config.PROMPT_WRITER_SETTINGS_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return
    except Exception as e:
        print(f"[writer-settings] failed to parse {config.PROMPT_WRITER_SETTINGS_PATH}: {e}")
        return

    with WRITER_SETTINGS_LOCK:
        if "system_prompt" in raw:
            WRITER_SETTINGS["system_prompt"] = str(raw.get("system_prompt") or "")
        if "model" in raw:
            WRITER_SETTINGS["model"] = str(raw.get("model") or "")
        if "temperature" in raw:
            try:
                WRITER_SETTINGS["temperature"] = float(raw.get("temperature"))
            except Exception:
                pass
        if "max_tokens" in raw:
            try:
                WRITER_SETTINGS["max_tokens"] = int(raw.get("max_tokens"))
            except Exception:
                pass
    print(f"[writer-settings] loaded {config.PROMPT_WRITER_SETTINGS_PATH}")


def _get_writer_settings() -> dict[str, Any]:
    with WRITER_SETTINGS_LOCK:
        return dict(WRITER_SETTINGS)


def _update_writer_settings(**updates: Any) -> dict[str, Any]:
    with WRITER_SETTINGS_LOCK:
        if "system_prompt" in updates:
            WRITER_SETTINGS["system_prompt"] = str(updates.get("system_prompt") or "")
        if "model" in updates:
            WRITER_SETTINGS["model"] = str(updates.get("model") or "")
        if "temperature" in updates:
            try:
                WRITER_SETTINGS["temperature"] = float(updates.get("temperature"))
            except Exception:
                pass
        if "max_tokens" in updates:
            try:
                WRITER_SETTINGS["max_tokens"] = max(1, int(updates.get("max_tokens")))
            except Exception:
                pass
        _persist_writer_settings_locked()
        return dict(WRITER_SETTINGS)


def init() -> None:
    """Initialize state: create executor, load persisted data from disk.

    Must be called once at application startup (from main.py), NOT at import time.
    """
    global EXECUTOR
    EXECUTOR = ThreadPoolExecutor(max_workers=max(1, config.MAX_PARALLEL_WORKERS))
    _load_jobs_from_disk()
    _load_writer_settings_from_disk()
    db.init_db()

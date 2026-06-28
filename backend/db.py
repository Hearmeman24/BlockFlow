from __future__ import annotations

import json
import sqlite3
import threading
from typing import Any

from backend import config

DB_PATH = config.RUN_HISTORY_DB_PATH
_lock = threading.Lock()


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


TERMINAL_JOB_STATUSES = {"COMPLETED", "COMPLETED_WITH_WARNING", "FAILED", "CANCELLED", "TIMED_OUT"}


def init_db() -> None:
    with _lock:
        conn = _get_conn()
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                status TEXT NOT NULL,
                duration_ms INTEGER,
                flow_snapshot TEXT NOT NULL,
                block_results TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        # Migration: add favorited column if missing
        cols = [row[1] for row in conn.execute("PRAGMA table_info(runs)").fetchall()]
        if "favorited" not in cols:
            conn.execute("ALTER TABLE runs ADD COLUMN favorited INTEGER NOT NULL DEFAULT 0")
            conn.commit()

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                job_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        conn.commit()
        conn.close()
    print(f"[run-history] database ready at {DB_PATH}")


def save_run(run: dict[str, Any]) -> None:
    with _lock:
        conn = _get_conn()
        conn.execute(
            """
            INSERT OR REPLACE INTO runs (id, name, status, duration_ms, flow_snapshot, block_results, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run["id"],
                run["name"],
                run["status"],
                run.get("duration_ms"),
                json.dumps(run["flow_snapshot"], ensure_ascii=True),
                json.dumps(run["block_results"], ensure_ascii=True),
                run["created_at"],
            ),
        )
        conn.commit()
        conn.close()


_PRIMARY_KIND_PRIORITY = ("lora", "loras", "dataset", "video", "image", "prompt")


def _looks_like_trained_lora(value: Any) -> bool:
    """LoRA Selector emits {name, strength} per entry; LoRA Train emits
    {filename, url, noise_variant}. Only the trained shape is an actual
    downloadable artifact — Selector outputs are workflow config, not files."""
    if not isinstance(value, list) or not value:
        return False
    head = value[0]
    if not isinstance(head, dict):
        return False
    return bool(head.get("url")) or bool(head.get("filename"))


def _primary_media_kind(block_results: list[dict[str, Any]]) -> str:
    """Mirror frontend findPrimaryArtifact, then bucket into video/image/dataset/lora/other."""
    for kind in _PRIMARY_KIND_PRIORITY:
        for br in reversed(block_results):
            for out in (br.get("outputs") or {}).values():
                if out.get("kind") != kind:
                    continue
                if kind in ("lora", "loras"):
                    # Only count it as a "lora" artifact when it's a trained
                    # downloadable LoRA — not a LoRA Selector workflow config.
                    if not _looks_like_trained_lora(out.get("value")):
                        continue
                    return "lora"
                if kind in ("video", "image", "dataset"):
                    return kind
                return "other"
    return "other"


def _run_matches_prompt(block_results: list[dict[str, Any]], needle: str) -> bool:
    """True if any block's metadata output contains the needle in its `prompt` field."""
    needle = needle.lower()
    for br in block_results:
        for out in (br.get("outputs") or {}).values():
            if out.get("kind") != "metadata":
                continue
            value = out.get("value")
            metas = value if isinstance(value, list) else [value]
            for m in metas:
                if isinstance(m, dict):
                    p = m.get("prompt")
                    if isinstance(p, str) and needle in p.lower():
                        return True
    return False


def list_runs(
    limit: int = 50,
    offset: int = 0,
    favorited_only: bool = False,
    media_kind: str | None = None,
    prompt_query: str | None = None,
    hide_partial: bool = False,
    source: str | None = None,
) -> list[dict[str, Any]]:
    if not media_kind and not prompt_query and not hide_partial and not source:
        conn = _get_conn()
        if favorited_only:
            rows = conn.execute(
                "SELECT * FROM runs WHERE favorited = 1 ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM runs ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        conn.close()
        return [_row_to_dict(r) for r in rows]

    filtered = _filtered_runs(favorited_only, media_kind, prompt_query, hide_partial, source)
    return filtered[offset : offset + limit]


def count_runs(
    favorited_only: bool = False,
    media_kind: str | None = None,
    prompt_query: str | None = None,
    hide_partial: bool = False,
    source: str | None = None,
) -> int:
    if not media_kind and not prompt_query and not hide_partial and not source:
        conn = _get_conn()
        if favorited_only:
            row = conn.execute("SELECT COUNT(*) AS count FROM runs WHERE favorited = 1").fetchone()
        else:
            row = conn.execute("SELECT COUNT(*) AS count FROM runs").fetchone()
        conn.close()
        return int(row["count"]) if row else 0

    return len(_filtered_runs(favorited_only, media_kind, prompt_query, hide_partial, source))


# MCP-generated runs use this id prefix (see mcp_server / comfy_gen batch upsert).
_MCP_RUN_PREFIX = "run-mcp-"


def _filtered_runs(
    favorited_only: bool,
    media_kind: str | None,
    prompt_query: str | None,
    hide_partial: bool,
    source: str | None = None,
) -> list[dict[str, Any]]:
    """Load candidate rows and apply Python-side filters. Returns newest-first."""
    conn = _get_conn()
    if favorited_only:
        rows = conn.execute(
            "SELECT * FROM runs WHERE favorited = 1 ORDER BY created_at DESC"
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM runs ORDER BY created_at DESC").fetchall()
    conn.close()

    out: list[dict[str, Any]] = []
    for r in rows:
        d = _row_to_dict(r)
        is_mcp = str(d.get("id", "")).startswith(_MCP_RUN_PREFIX)
        if source == "mcp" and not is_mcp:
            continue
        if source == "pipeline" and is_mcp:
            continue
        if hide_partial and str(d.get("status", "")).lower() in {"partial", "failed"}:
            continue
        br = d.get("block_results") or []
        if media_kind and _primary_media_kind(br) != media_kind:
            continue
        if prompt_query and not _run_matches_prompt(br, prompt_query):
            continue
        out.append(d)
    return out


def get_run(run_id: str) -> dict[str, Any] | None:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    conn.close()
    return _row_to_dict(row) if row else None


def delete_run(run_id: str) -> bool:
    with _lock:
        conn = _get_conn()
        cursor = conn.execute("DELETE FROM runs WHERE id = ?", (run_id,))
        conn.commit()
        deleted = cursor.rowcount > 0
        conn.close()
    return deleted


def toggle_run_favorited(run_id: str) -> bool | None:
    """Toggle the favorited flag on a run. Returns new value, or None if not found."""
    with _lock:
        conn = _get_conn()
        row = conn.execute("SELECT favorited FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not row:
            conn.close()
            return None
        new_val = 0 if row["favorited"] else 1
        conn.execute("UPDATE runs SET favorited = ? WHERE id = ?", (new_val, run_id))
        conn.commit()
        conn.close()
    return bool(new_val)


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    d = dict(row)
    d["flow_snapshot"] = json.loads(d["flow_snapshot"])
    d["block_results"] = json.loads(d["block_results"])
    d["favorited"] = bool(d.get("favorited", 0))
    return d


# ---- Job persistence ----

def save_job(job: dict[str, Any]) -> None:
    with _lock:
        conn = _get_conn()
        conn.execute(
            """
            INSERT OR REPLACE INTO jobs (job_id, status, data, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                job["job_id"],
                job.get("status", "UNKNOWN"),
                json.dumps(job, ensure_ascii=True, default=str),
                job.get("created_at", 0),
                job.get("updated_at", 0),
            ),
        )
        conn.commit()
        conn.close()


def get_job(job_id: str) -> dict[str, Any] | None:
    conn = _get_conn()
    row = conn.execute("SELECT data FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
    conn.close()
    if not row:
        return None
    return json.loads(row["data"])


def list_jobs(limit: int = 100, offset: int = 0, status: str | None = None) -> list[dict[str, Any]]:
    conn = _get_conn()
    if status:
        rows = conn.execute(
            "SELECT data FROM jobs WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
            (status, limit, offset),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT data FROM jobs ORDER BY updated_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    conn.close()
    return [json.loads(r["data"]) for r in rows]


def count_jobs() -> int:
    conn = _get_conn()
    row = conn.execute("SELECT COUNT(*) AS count FROM jobs").fetchone()
    conn.close()
    return int(row["count"]) if row else 0


def prune_runs_older_than(retention_days: int) -> int:
    """Delete non-favorited runs older than `retention_days` days.

    Returns the number of rows deleted. A negative `retention_days` value
    is treated as invalid input and is a no-op (defensive against config
    bugs silently wiping user data).
    """
    from datetime import datetime, timedelta, timezone

    if retention_days < 0:
        return 0

    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    cutoff_iso = cutoff.isoformat()

    with _lock:
        conn = _get_conn()
        cursor = conn.execute(
            "DELETE FROM runs WHERE favorited = 0 AND created_at < ?",
            (cutoff_iso,),
        )
        deleted = cursor.rowcount
        conn.commit()
        conn.close()
    return int(deleted)

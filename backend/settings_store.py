"""Settings store: credentials, endpoint configs, and app preferences.

Backed by the same sqlite file as `backend.db` (run_history.db). Three
additional tables coexist with the existing `runs` table:

  - `settings_credentials`: name → value (API keys, R2 creds)
  - `settings_endpoints`: type → endpoint config (ComfyGen, AIO trainer)
  - `settings_app_prefs`: name → value (output dir, retention policy)

Pure repository functions: no HTTP, no validation. Validation is a separate
concern (Stage 2 — settings_routes). Callers serialize any non-string values
themselves (e.g. integers stored as strings in app_prefs).
"""
from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend import config

# Same file as backend.db.DB_PATH — settings tables coexist with `runs`.
DB_PATH: Path = config.ROOT_DIR / "run_history.db"

_lock = threading.Lock()

# Endpoint columns in the order the row tuple is consumed/returned.
_ENDPOINT_COLS: tuple[str, ...] = (
    "endpoint_id",
    "volume_id",
    "template_id",
    "gpu_tier",
    "volume_size_gb",
    "max_workers",
    "provisioned_at",
)


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def init_db() -> None:
    """Create the settings tables if absent. Idempotent."""
    with _lock:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = _get_conn()
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS settings_credentials (
                    name TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS settings_endpoints (
                    type TEXT PRIMARY KEY,
                    endpoint_id TEXT NOT NULL,
                    volume_id TEXT,
                    template_id TEXT,
                    gpu_tier TEXT,
                    volume_size_gb INTEGER,
                    max_workers INTEGER,
                    provisioned_at TEXT,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS settings_app_prefs (
                    name TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )
            conn.commit()
        finally:
            conn.close()


# === credentials ============================================================

def set_credential(name: str, value: str) -> None:
    with _lock:
        conn = _get_conn()
        try:
            conn.execute(
                """
                INSERT INTO settings_credentials (name, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                """,
                (name, value, _now()),
            )
            conn.commit()
        finally:
            conn.close()


def get_credential(name: str) -> str | None:
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT value FROM settings_credentials WHERE name = ?", (name,)
        ).fetchone()
    finally:
        conn.close()
    return row["value"] if row else None


def get_credential_updated_at(name: str) -> str | None:
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT updated_at FROM settings_credentials WHERE name = ?", (name,)
        ).fetchone()
    finally:
        conn.close()
    return row["updated_at"] if row else None


def list_credentials() -> list[str]:
    conn = _get_conn()
    try:
        rows = conn.execute(
            "SELECT name FROM settings_credentials ORDER BY name"
        ).fetchall()
    finally:
        conn.close()
    return [r["name"] for r in rows]


def delete_credential(name: str) -> None:
    with _lock:
        conn = _get_conn()
        try:
            conn.execute("DELETE FROM settings_credentials WHERE name = ?", (name,))
            conn.commit()
        finally:
            conn.close()


# === endpoints ==============================================================

def set_endpoint(
    type: str,
    *,
    endpoint_id: str,
    volume_id: str | None = None,
    template_id: str | None = None,
    gpu_tier: str | None = None,
    volume_size_gb: int | None = None,
    max_workers: int | None = None,
    provisioned_at: str | None = None,
) -> None:
    """Upsert an endpoint row. Optional fields default to NULL — fields not
    supplied on update are reset to NULL (full-row replace semantics)."""
    with _lock:
        conn = _get_conn()
        try:
            conn.execute(
                """
                INSERT INTO settings_endpoints
                    (type, endpoint_id, volume_id, template_id, gpu_tier,
                     volume_size_gb, max_workers, provisioned_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(type) DO UPDATE SET
                    endpoint_id=excluded.endpoint_id,
                    volume_id=excluded.volume_id,
                    template_id=excluded.template_id,
                    gpu_tier=excluded.gpu_tier,
                    volume_size_gb=excluded.volume_size_gb,
                    max_workers=excluded.max_workers,
                    provisioned_at=excluded.provisioned_at,
                    updated_at=excluded.updated_at
                """,
                (
                    type,
                    endpoint_id,
                    volume_id,
                    template_id,
                    gpu_tier,
                    volume_size_gb,
                    max_workers,
                    provisioned_at,
                    _now(),
                ),
            )
            conn.commit()
        finally:
            conn.close()


def get_endpoint(type: str) -> dict[str, Any] | None:
    conn = _get_conn()
    try:
        row = conn.execute(
            f"""
            SELECT type, {", ".join(_ENDPOINT_COLS)}
            FROM settings_endpoints WHERE type = ?
            """,
            (type,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return {key: row[key] for key in ("type", *_ENDPOINT_COLS)}


def list_endpoints() -> list[str]:
    conn = _get_conn()
    try:
        rows = conn.execute(
            "SELECT type FROM settings_endpoints ORDER BY type"
        ).fetchall()
    finally:
        conn.close()
    return [r["type"] for r in rows]


def delete_endpoint(type: str) -> None:
    with _lock:
        conn = _get_conn()
        try:
            conn.execute("DELETE FROM settings_endpoints WHERE type = ?", (type,))
            conn.commit()
        finally:
            conn.close()


# === app_prefs ==============================================================

def set_app_pref(name: str, value: str) -> None:
    with _lock:
        conn = _get_conn()
        try:
            conn.execute(
                """
                INSERT INTO settings_app_prefs (name, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                """,
                (name, value, _now()),
            )
            conn.commit()
        finally:
            conn.close()


def get_app_pref(name: str, default: str | None = None) -> str | None:
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT value FROM settings_app_prefs WHERE name = ?", (name,)
        ).fetchone()
    finally:
        conn.close()
    return row["value"] if row else default

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

import json
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
    "template_name",
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

                -- sgs-ui-5nn: cache the most recent validation result per
                -- service name (NOT per credential — a validator like 'r2'
                -- depends on 4 credentials but produces one verdict). Cleared
                -- when any underlying credential value changes.
                CREATE TABLE IF NOT EXISTS settings_credential_validations (
                    name TEXT PRIMARY KEY,
                    ok INTEGER NOT NULL,
                    error TEXT,
                    validated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS settings_endpoints (
                    type TEXT PRIMARY KEY,
                    endpoint_id TEXT NOT NULL,
                    volume_id TEXT,
                    template_id TEXT,
                    template_name TEXT,
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

                -- sgs-ui-wisp-las.3 Stage A: track which presets the user has
                -- installed onto the ComfyGen network volume. workflow_json
                -- is cached locally so the ComfyGen block dropdown doesn't
                -- have to re-fetch the registry on every render.
                CREATE TABLE IF NOT EXISTS settings_installed_presets (
                    preset_id TEXT PRIMARY KEY,
                    version TEXT NOT NULL,
                    disk_size_gb INTEGER,
                    workflow_json TEXT NOT NULL,
                    installed_paths TEXT,
                    pod_id TEXT,
                    install_mode TEXT,
                    cost_per_hr_at_spawn REAL,
                    installed_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )
            # Migration: settings_endpoints originally didn't have template_name.
            # Required by the wizard tear-down path; add if missing.
            cols = {row[1] for row in conn.execute("PRAGMA table_info(settings_endpoints)").fetchall()}
            if "template_name" not in cols:
                conn.execute("ALTER TABLE settings_endpoints ADD COLUMN template_name TEXT")
            # Migration (sgs-ui-i7j): settings_installed_presets gained
            # installed_paths so uninstall can hand the canonical paths to
            # `comfy-gen delete` instead of leaving files orphaned on the
            # volume. Backfill is implicit — old rows surface as [] on read.
            ip_cols = {row[1] for row in conn.execute("PRAGMA table_info(settings_installed_presets)").fetchall()}
            if "installed_paths" not in ip_cols:
                conn.execute("ALTER TABLE settings_installed_presets ADD COLUMN installed_paths TEXT")
            # sgs-ui-8ww: record which CPU pod ran the install + its hourly
            # rate so the UI can show a post-install cost summary.
            if "pod_id" not in ip_cols:
                conn.execute("ALTER TABLE settings_installed_presets ADD COLUMN pod_id TEXT")
            if "install_mode" not in ip_cols:
                conn.execute("ALTER TABLE settings_installed_presets ADD COLUMN install_mode TEXT")
            if "cost_per_hr_at_spawn" not in ip_cols:
                conn.execute("ALTER TABLE settings_installed_presets ADD COLUMN cost_per_hr_at_spawn REAL")
            conn.commit()
        finally:
            conn.close()


# === credentials ============================================================

def set_credential(name: str, value: str) -> None:
    with _lock:
        conn = _get_conn()
        try:
            # Detect whether the value actually changed. If so, drop any
            # cached validations that depend on this credential — stale
            # 'valid' state must not survive a key rotation.
            prior_row = conn.execute(
                "SELECT value FROM settings_credentials WHERE name = ?", (name,)
            ).fetchone()
            value_changed = prior_row is None or prior_row["value"] != value

            conn.execute(
                """
                INSERT INTO settings_credentials (name, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                """,
                (name, value, _now()),
            )

            if value_changed:
                # Imported here to avoid a circular import at module load
                # (settings_validators imports settings_store).
                from backend import settings_validators as _v
                affected_services = [
                    svc for svc, fields in _v.VALIDATOR_CREDENTIALS.items() if name in fields
                ]
                for svc in affected_services:
                    conn.execute(
                        "DELETE FROM settings_credential_validations WHERE name = ?",
                        (svc,),
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
            # Also clear any cached validations that depended on this credential.
            from backend import settings_validators as _v
            affected_services = [
                svc for svc, fields in _v.VALIDATOR_CREDENTIALS.items() if name in fields
            ]
            for svc in affected_services:
                conn.execute(
                    "DELETE FROM settings_credential_validations WHERE name = ?",
                    (svc,),
                )
            conn.commit()
        finally:
            conn.close()


# === credential validation cache (sgs-ui-5nn) ===============================

def set_credential_validation(name: str, result: dict[str, Any]) -> None:
    """Persist the most recent validation result for a validator (e.g. 'runpod',
    'r2', 'civitai'). `name` is the validator service name, NOT a credential
    name — a validator like 'r2' depends on multiple credentials but produces
    one verdict.

    `result` must include keys: `ok`, `error` (optional), `validated_at`.
    """
    ok = 1 if result.get("ok") else 0
    error = result.get("error")
    validated_at = result.get("validated_at") or _now()
    with _lock:
        conn = _get_conn()
        try:
            conn.execute(
                """
                INSERT INTO settings_credential_validations (name, ok, error, validated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    ok=excluded.ok, error=excluded.error, validated_at=excluded.validated_at
                """,
                (name, ok, error, validated_at),
            )
            conn.commit()
        finally:
            conn.close()


def get_credential_validation(name: str) -> dict[str, Any] | None:
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT ok, error, validated_at FROM settings_credential_validations WHERE name = ?",
            (name,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return {
        "ok": bool(row["ok"]),
        "error": row["error"],
        "validated_at": row["validated_at"],
    }


def list_credential_validations() -> dict[str, dict[str, Any]]:
    conn = _get_conn()
    try:
        rows = conn.execute(
            "SELECT name, ok, error, validated_at FROM settings_credential_validations"
        ).fetchall()
    finally:
        conn.close()
    return {
        r["name"]: {"ok": bool(r["ok"]), "error": r["error"], "validated_at": r["validated_at"]}
        for r in rows
    }


# === endpoints ==============================================================

def set_endpoint(
    type: str,
    *,
    endpoint_id: str,
    volume_id: str | None = None,
    template_id: str | None = None,
    template_name: str | None = None,
    gpu_tier: str | None = None,
    volume_size_gb: int | None = None,
    max_workers: int | None = None,
    provisioned_at: str | None = None,
) -> None:
    """Upsert an endpoint row. Optional fields default to NULL — fields not
    supplied on update are reset to NULL (full-row replace semantics).

    `template_name` is REQUIRED for future tear-down (RunPod's deleteTemplate
    mutation takes the NAME, not the ID). The wizard route persists it on
    every successful provisioning.
    """
    with _lock:
        conn = _get_conn()
        try:
            conn.execute(
                """
                INSERT INTO settings_endpoints
                    (type, endpoint_id, volume_id, template_id, template_name, gpu_tier,
                     volume_size_gb, max_workers, provisioned_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(type) DO UPDATE SET
                    endpoint_id=excluded.endpoint_id,
                    volume_id=excluded.volume_id,
                    template_id=excluded.template_id,
                    template_name=excluded.template_name,
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
                    template_name,
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


# === installed presets (sgs-ui-wisp-las.3 Stage A) ==========================

def record_installed_preset(
    *,
    preset_id: str,
    version: str,
    workflow_json: str,
    disk_size_gb: int | None = None,
    installed_paths: list[str] | None = None,
    pod_id: str | None = None,
    install_mode: str | None = None,
    cost_per_hr_at_spawn: float | None = None,
) -> None:
    """Upsert an installed-preset row. workflow_json is stored as a string
    (the caller stringifies the dict) so the table stays opaque to schema
    drift in the preset spec. installed_paths is the canonical list of
    /runpod-volume paths created by this install — handed to `comfy-gen
    delete` on uninstall. pod_id / install_mode / cost_per_hr_at_spawn
    (sgs-ui-8ww) capture which CPU installer pod did the work so the UI can
    surface a post-install cost summary."""
    now = _now()
    paths_json = json.dumps(installed_paths) if installed_paths else None
    with _lock:
        conn = _get_conn()
        try:
            conn.execute(
                """
                INSERT INTO settings_installed_presets
                    (preset_id, version, disk_size_gb, workflow_json,
                     installed_paths, pod_id, install_mode,
                     cost_per_hr_at_spawn, installed_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(preset_id) DO UPDATE SET
                    version=excluded.version,
                    disk_size_gb=excluded.disk_size_gb,
                    workflow_json=excluded.workflow_json,
                    installed_paths=excluded.installed_paths,
                    pod_id=excluded.pod_id,
                    install_mode=excluded.install_mode,
                    cost_per_hr_at_spawn=excluded.cost_per_hr_at_spawn,
                    updated_at=excluded.updated_at
                """,
                (preset_id, version, disk_size_gb, workflow_json, paths_json,
                 pod_id, install_mode, cost_per_hr_at_spawn, now, now),
            )
            conn.commit()
        finally:
            conn.close()


def list_installed_presets() -> list[dict]:
    """List all installed presets WITHOUT the workflow_json blob (the blob
    can be large; callers fetch it via get_installed_preset for one row)."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            """
            SELECT preset_id, version, disk_size_gb, installed_at, updated_at
            FROM settings_installed_presets
            ORDER BY preset_id
            """
        ).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


def get_installed_preset(preset_id: str) -> dict | None:
    """Fetch one installed preset including its cached workflow_json."""
    conn = _get_conn()
    try:
        row = conn.execute(
            """
            SELECT preset_id, version, disk_size_gb, workflow_json,
                   installed_paths, pod_id, install_mode,
                   cost_per_hr_at_spawn, installed_at, updated_at
            FROM settings_installed_presets
            WHERE preset_id = ?
            """,
            (preset_id,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    d = dict(row)
    raw = d.get("installed_paths")
    d["installed_paths"] = json.loads(raw) if raw else []
    return d


def get_installed_preset_by_pod_id(pod_id: str) -> dict | None:
    """sgs-ui-c7n: reverse lookup used by the installer-pod sweeper to
    classify a live RunPod pod as 'tracked + completed' (DELETE immediately)
    vs 'untracked' (DELETE after the orphan age threshold).

    Only successful installs land in this table — failed/cancelled installs
    leave no row behind, so a pod with no matching preset_id row and no
    in-process state is the sweeper's 'orphan' case.
    """
    if not pod_id:
        return None
    conn = _get_conn()
    try:
        row = conn.execute(
            """
            SELECT preset_id, version, disk_size_gb, pod_id, install_mode,
                   cost_per_hr_at_spawn, installed_at, updated_at
            FROM settings_installed_presets
            WHERE pod_id = ?
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            (pod_id,),
        ).fetchone()
    finally:
        conn.close()
    return dict(row) if row else None


def remove_installed_preset(preset_id: str) -> bool:
    """Drop the row. Returns True if a row was deleted."""
    with _lock:
        conn = _get_conn()
        try:
            cur = conn.execute(
                "DELETE FROM settings_installed_presets WHERE preset_id = ?",
                (preset_id,),
            )
            conn.commit()
        finally:
            conn.close()
    return cur.rowcount > 0

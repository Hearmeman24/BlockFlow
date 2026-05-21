"""Tests for run-history pruning (sgs-ui-wisp-las.1 Stage 6).

The App tab's "retention" setting drives a `prune_runs_older_than(days)`
function in backend.db that deletes runs whose created_at is older than the
cutoff. v1 ships the function; scheduling (cron / on-launch hook) is a
follow-up.

Tests use the existing run-history schema; assertions hit the DB directly
to verify rows are actually removed (build green ≠ feature works).
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import db  # noqa: E402


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    db_path = tmp_path / "prune_test.db"
    monkeypatch.setattr(db, "DB_PATH", db_path)
    db.init_db()
    return db


def _insert_run(temp_db, *, created_at: datetime, favorited: bool = False) -> str:
    run_id = str(uuid.uuid4())
    record = {
        "id": run_id,
        "name": f"run-{run_id[:8]}",
        "status": "COMPLETED",
        "duration_ms": 1000,
        "flow_snapshot": {},
        "block_results": {},
        "created_at": created_at.isoformat(),
    }
    temp_db.save_run(record)
    if favorited:
        # save_run() doesn't write the favorited column (it's set later via a
        # separate API in prod). For tests, twiddle it directly.
        conn = temp_db._get_conn()
        conn.execute("UPDATE runs SET favorited = 1 WHERE id = ?", (run_id,))
        conn.commit()
        conn.close()
    return run_id


def test_prune_removes_runs_older_than_cutoff(temp_db):
    now = datetime.now(timezone.utc)
    old_id = _insert_run(temp_db, created_at=now - timedelta(days=100))
    recent_id = _insert_run(temp_db, created_at=now - timedelta(days=5))

    deleted = temp_db.prune_runs_older_than(retention_days=30)

    assert deleted == 1
    # Recent run still present
    assert temp_db.get_run(recent_id) is not None
    # Old run removed
    assert temp_db.get_run(old_id) is None


def test_prune_with_no_old_runs_returns_zero(temp_db):
    now = datetime.now(timezone.utc)
    _insert_run(temp_db, created_at=now - timedelta(days=1))

    deleted = temp_db.prune_runs_older_than(retention_days=30)

    assert deleted == 0


def test_prune_on_empty_db_returns_zero(temp_db):
    deleted = temp_db.prune_runs_older_than(retention_days=30)
    assert deleted == 0


def test_prune_with_zero_days_deletes_everything(temp_db):
    """retention_days=0 means 'keep nothing'."""
    now = datetime.now(timezone.utc)
    _insert_run(temp_db, created_at=now - timedelta(days=1))
    _insert_run(temp_db, created_at=now - timedelta(days=100))

    deleted = temp_db.prune_runs_older_than(retention_days=0)

    assert deleted == 2


def test_prune_does_not_delete_favorited_runs(temp_db):
    """Favorited runs are explicitly preserved past the retention window."""
    now = datetime.now(timezone.utc)
    old_fav_id = _insert_run(temp_db, created_at=now - timedelta(days=500), favorited=True)
    old_plain_id = _insert_run(temp_db, created_at=now - timedelta(days=500))

    deleted = temp_db.prune_runs_older_than(retention_days=30)

    assert deleted == 1
    assert temp_db.get_run(old_fav_id) is not None  # favorited survives
    assert temp_db.get_run(old_plain_id) is None    # plain is pruned


def test_prune_with_negative_days_is_a_noop(temp_db):
    """Defensive: a negative retention shouldn't delete the entire history.

    Treat it as 'invalid input, do nothing' so a configuration bug doesn't
    silently wipe user data."""
    now = datetime.now(timezone.utc)
    _insert_run(temp_db, created_at=now - timedelta(days=1))
    _insert_run(temp_db, created_at=now - timedelta(days=100))

    deleted = temp_db.prune_runs_older_than(retention_days=-1)

    assert deleted == 0


def test_prune_respects_cutoff_window(temp_db):
    """A run slightly newer than the cutoff survives; one older is deleted.

    Tests the comparison direction (< vs >) without depending on exact
    boundary semantics (which would race with clock movement during the
    test)."""
    now = datetime.now(timezone.utc)
    just_inside_id = _insert_run(temp_db, created_at=now - timedelta(days=29, hours=23))
    just_outside_id = _insert_run(temp_db, created_at=now - timedelta(days=30, hours=1))

    deleted = temp_db.prune_runs_older_than(retention_days=30)

    assert deleted == 1
    assert temp_db.get_run(just_inside_id) is not None
    assert temp_db.get_run(just_outside_id) is None

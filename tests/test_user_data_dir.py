"""sgs-ui-5ni: user data lives outside ROOT_DIR.

Pre-fix: every user-data file (prompt_library.json, run_history.db, flows/,
output/, …) was rooted at backend.config.ROOT_DIR. Each git worktree got
its own isolated copy, and switching the running app between worktrees
silently swapped in fresh empty state.

Post-fix: a single USER_DATA_DIR (platform default + BLOCKFLOW_DATA_DIR
override) holds all user state. A one-shot migration moves legacy files
out of ROOT_DIR on first launch, with a breadcrumb so it doesn't re-run.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import config as _config_module  # noqa: E402

# === resolve_user_data_dir ===================================================

def test_resolve_user_data_dir_honors_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("BLOCKFLOW_DATA_DIR", str(tmp_path / "custom"))
    out = _config_module.resolve_user_data_dir()
    assert out == tmp_path / "custom"


def test_resolve_user_data_dir_honors_blockflow_home(monkeypatch, tmp_path):
    monkeypatch.delenv("BLOCKFLOW_DATA_DIR", raising=False)
    monkeypatch.setenv("BLOCKFLOW_HOME", str(tmp_path / "portable"))
    out = _config_module.resolve_user_data_dir()
    assert out == tmp_path / "portable"


def test_resolve_user_data_dir_prefers_data_dir_over_home(monkeypatch, tmp_path):
    monkeypatch.setenv("BLOCKFLOW_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("BLOCKFLOW_HOME", str(tmp_path / "home"))
    out = _config_module.resolve_user_data_dir()
    assert out == tmp_path / "data"


def test_resolve_user_data_dir_darwin_default(monkeypatch):
    monkeypatch.delenv("BLOCKFLOW_DATA_DIR", raising=False)
    monkeypatch.delenv("BLOCKFLOW_HOME", raising=False)
    monkeypatch.setattr(sys, "platform", "darwin")
    out = _config_module.resolve_user_data_dir()
    assert out == Path.home() / "Library" / "Application Support" / "BlockFlow"


def test_resolve_user_data_dir_linux_default_uses_xdg(monkeypatch, tmp_path):
    monkeypatch.delenv("BLOCKFLOW_DATA_DIR", raising=False)
    monkeypatch.delenv("BLOCKFLOW_HOME", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    monkeypatch.setattr(sys, "platform", "linux")
    out = _config_module.resolve_user_data_dir()
    assert out == tmp_path / "xdg" / "blockflow"


def test_resolve_user_data_dir_linux_default_no_xdg(monkeypatch):
    monkeypatch.delenv("BLOCKFLOW_DATA_DIR", raising=False)
    monkeypatch.delenv("BLOCKFLOW_HOME", raising=False)
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    monkeypatch.setattr(sys, "platform", "linux")
    out = _config_module.resolve_user_data_dir()
    assert out == Path.home() / ".local" / "share" / "blockflow"


def test_resolve_user_data_dir_windows_default_uses_localappdata(monkeypatch, tmp_path):
    monkeypatch.delenv("BLOCKFLOW_DATA_DIR", raising=False)
    monkeypatch.delenv("BLOCKFLOW_HOME", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "AppData" / "Local"))
    monkeypatch.setattr(sys, "platform", "win32")
    out = _config_module.resolve_user_data_dir()
    assert out == tmp_path / "AppData" / "Local" / "BlockFlow"


def test_resolve_user_data_dir_windows_default_no_localappdata(monkeypatch):
    """When LOCALAPPDATA is somehow unset (broken environment, msys, etc.),
    fall through to the conventional ~/AppData/Local/blockflow."""
    monkeypatch.delenv("BLOCKFLOW_DATA_DIR", raising=False)
    monkeypatch.delenv("BLOCKFLOW_HOME", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.setattr(sys, "platform", "win32")
    out = _config_module.resolve_user_data_dir()
    assert out == Path.home() / "AppData" / "Local" / "BlockFlow"


# === migrate_legacy_user_data ================================================

@pytest.fixture
def legacy_and_target(tmp_path):
    """Two isolated dirs for testing the migration in vitro."""
    legacy = tmp_path / "legacy_root"
    target = tmp_path / "user_data"
    legacy.mkdir()
    target.mkdir()
    return legacy, target


def test_migration_moves_legacy_files(legacy_and_target):
    legacy, target = legacy_and_target
    (legacy / "prompt_library.json").write_text('[{"id":"x"}]')
    (legacy / "run_history.db").write_bytes(b"SQLITE format 3\x00" + b"\x00" * 100)
    (legacy / "job_history.json").write_text("{}")
    (legacy / "flows").mkdir()
    (legacy / "flows" / "a.json").write_text("{}")

    _config_module.migrate_legacy_user_data(legacy_root=legacy, user_data_dir=target)

    # Files moved
    assert (target / "prompt_library.json").exists()
    assert (target / "run_history.db").exists()
    assert (target / "job_history.json").exists()
    assert (target / "flows" / "a.json").exists()
    # Originals gone
    assert not (legacy / "prompt_library.json").exists()
    assert not (legacy / "flows").exists()
    # Breadcrumb written
    assert (target / ".migrated_from_root").exists()


def test_migration_does_not_clobber_existing_target(legacy_and_target):
    """If the target already has data, the legacy file is left alone."""
    legacy, target = legacy_and_target
    (legacy / "prompt_library.json").write_text('"legacy"')
    (target / "prompt_library.json").write_text('"existing"')

    _config_module.migrate_legacy_user_data(legacy_root=legacy, user_data_dir=target)

    # Target untouched; legacy still present (won't auto-delete to be safe).
    assert (target / "prompt_library.json").read_text() == '"existing"'
    assert (legacy / "prompt_library.json").read_text() == '"legacy"'


def test_migration_is_idempotent_via_breadcrumb(legacy_and_target):
    """Breadcrumb file prevents re-running the migration."""
    legacy, target = legacy_and_target
    (target / ".migrated_from_root").write_text("already done")
    (legacy / "prompt_library.json").write_text('"never-touched"')

    _config_module.migrate_legacy_user_data(legacy_root=legacy, user_data_dir=target)

    # Migration short-circuited: legacy file still present, target absent.
    assert (legacy / "prompt_library.json").exists()
    assert not (target / "prompt_library.json").exists()


def test_migration_treats_empty_target_dir_as_migratable(legacy_and_target):
    """config.py mkdirs FLOWS_DIR / LOCAL_OUTPUT_DIR at import time. The
    migration must still move the legacy dir's CONTENTS even though the
    target dir already exists empty."""
    legacy, target = legacy_and_target
    (legacy / "flows").mkdir()
    (legacy / "flows" / "real-pipeline.json").write_text("{}")
    (target / "flows").mkdir()  # empty stub, like config.py would create

    _config_module.migrate_legacy_user_data(legacy_root=legacy, user_data_dir=target)

    assert (target / "flows" / "real-pipeline.json").exists()
    assert not (legacy / "flows").exists()


def test_migration_merges_target_dir_with_empty_stub_subdirs(legacy_and_target):
    """Real case from sgs-ui-5ni rollout: target/output/ exists with empty
    stub subdirs (fx/, datasets/, lora_jobs/) created by custom_blocks at
    import time. Migration must still move the legacy output content into
    place, merging per-entry rather than treating the whole target as 'non-
    empty and untouchable'."""
    legacy, target = legacy_and_target
    (legacy / "output").mkdir()
    (legacy / "output" / "gen-001.png").write_bytes(b"PNG")
    (legacy / "output" / "fx").mkdir()
    (legacy / "output" / "fx" / "_luts").mkdir()
    (legacy / "output" / "fx" / "_luts" / "warm.cube").write_text("LUT")
    (target / "output").mkdir()
    (target / "output" / "fx").mkdir()         # empty stub from custom_blocks
    (target / "output" / "datasets").mkdir()   # empty stub
    (target / "output" / "lora_jobs").mkdir()  # empty stub

    _config_module.migrate_legacy_user_data(legacy_root=legacy, user_data_dir=target)

    # Real content moved in.
    assert (target / "output" / "gen-001.png").read_bytes() == b"PNG"
    # Conflict resolution: legacy/output/fx/ existed but target/output/fx/
    # also existed (empty). Per-item merge keeps the existing target dir;
    # the legacy fx/ content stays behind (no clobber).
    assert (target / "output" / "fx").is_dir()
    # Stub-only target subdirs that the legacy didn't touch stay put.
    assert (target / "output" / "datasets").is_dir()


def test_migration_preserves_conflicting_target_files(legacy_and_target):
    """When a per-entry conflict happens (legacy file vs same-name target
    file), the legacy entry is left in place and the legacy parent dir is
    NOT removed (so the user can reconcile manually)."""
    legacy, target = legacy_and_target
    (legacy / "flows").mkdir()
    (legacy / "flows" / "legacy.json").write_text('"legacy"')
    (legacy / "flows" / "shared.json").write_text('"legacy-shared"')
    (target / "flows").mkdir()
    (target / "flows" / "shared.json").write_text('"target-shared"')

    _config_module.migrate_legacy_user_data(legacy_root=legacy, user_data_dir=target)

    # Non-conflicting legacy item moved in.
    assert (target / "flows" / "legacy.json").read_text() == '"legacy"'
    # Conflicting target file untouched.
    assert (target / "flows" / "shared.json").read_text() == '"target-shared"'
    # Conflicting legacy file stays behind for manual reconciliation.
    assert (legacy / "flows" / "shared.json").exists()
    # Legacy dir not removed — still has the conflicting file in it.
    assert (legacy / "flows").exists()


def test_migration_handles_missing_legacy_files(legacy_and_target):
    """No legacy files at all → migration is a no-op + breadcrumb written."""
    legacy, target = legacy_and_target
    _config_module.migrate_legacy_user_data(legacy_root=legacy, user_data_dir=target)
    assert (target / ".migrated_from_root").exists()
    # No spurious files created in target
    assert sorted(p.name for p in target.iterdir()) == [".migrated_from_root"]


# === module-level paths route through USER_DATA_DIR ==========================

def test_user_data_paths_resolve_under_user_data_dir():
    """All user-data paths must live under USER_DATA_DIR, not ROOT_DIR.
    Code-asset paths (custom_blocks, private_blocks, .env) stay at ROOT_DIR.
    LOCAL_OUTPUT_DIR is excluded because Settings may intentionally override
    it to an arbitrary writable directory."""
    udd = _config_module.USER_DATA_DIR
    rdr = _config_module.ROOT_DIR

    for attr in (
        "FLOWS_DIR",
        "JOB_HISTORY_PATH",
        "PROMPT_WRITER_SETTINGS_PATH",
        "PROMPT_LIBRARY_PATH",
        "COMFY_GEN_INFO_CACHE_PATH",
        "RUN_HISTORY_DB_PATH",
        "PRESET_MANIFEST_CACHE_PATH",
        "PRESET_INSTALL_LOG_PATH",
    ):
        p = Path(getattr(_config_module, attr))
        assert p.is_relative_to(udd), f"{attr}={p} should be under USER_DATA_DIR={udd}"
        # And NOT directly inside the repo root (would be the bug).
        assert not p.is_relative_to(rdr) or udd.is_relative_to(rdr), (
            f"{attr}={p} is still under ROOT_DIR={rdr}"
        )


def test_db_modules_share_user_data_db_path():
    """Every module that opens run_history.db must point at the SAME file."""
    from backend import db as backend_db
    from backend import lora_metadata, settings_store

    target = _config_module.RUN_HISTORY_DB_PATH
    assert Path(backend_db.DB_PATH) == target
    assert Path(settings_store.DB_PATH) == target
    assert Path(lora_metadata.DB_PATH) == target

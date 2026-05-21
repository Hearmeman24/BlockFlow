"""Tests for the backend block-sidecar overlay loader (sgs-ui-wisp-las.8).

The loader discovers + mounts `backend.block.py` sidecars from:
  - `custom_blocks/` (always)
  - `private_blocks/` (optional overlay)

Slug collisions across the two dirs raise. Blocks with only a frontend entry
(no backend.block.py) are silently skipped — they're frontend-only.

Each test uses a fresh temp dir + fresh FastAPI app to avoid cross-test
pollution. Assertions hit real routes via TestClient: build green ≠ feature
works; the route must actually respond.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.main import load_block_sidecars  # noqa: E402

SIDECAR_BODY = """\
from fastapi import APIRouter

router = APIRouter()

@router.get("/ping")
def ping():
    return {"ok": True, "slug": "{slug}"}
"""


def _make_block(root: Path, slug: str, with_backend: bool = True) -> None:
    block_dir = root / slug
    block_dir.mkdir(parents=True)
    # Always create a frontend entry — the frontend codegen requires it, and
    # the backend loader skips dirs without one only via the frontend codegen;
    # the backend loader itself ignores frontend.block.tsx. We include it for
    # realism.
    (block_dir / "frontend.block.tsx").write_text(f"export const blockDef = {{ slug: '{slug}' }}\n")
    if with_backend:
        (block_dir / "backend.block.py").write_text(SIDECAR_BODY.replace("{slug}", slug))


@pytest.fixture
def fresh_app() -> FastAPI:
    return FastAPI()


# --- Single-dir baseline (regression: existing custom_blocks behavior) ------

def test_loads_block_from_custom_blocks_only(tmp_path: Path, fresh_app: FastAPI) -> None:
    custom = tmp_path / "custom_blocks"
    custom.mkdir()
    _make_block(custom, "blk_a")

    loaded = load_block_sidecars(fresh_app, [(custom, "custom_blocks")])

    assert loaded == ["blk_a"]

    # Route actually responds — not just "no exception raised"
    client = TestClient(fresh_app)
    r = client.get("/api/blocks/blk_a/ping")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "slug": "blk_a"}


def test_missing_dir_is_treated_as_empty(tmp_path: Path, fresh_app: FastAPI) -> None:
    """A non-existent dir doesn't crash the loader."""
    missing = tmp_path / "never_created"
    loaded = load_block_sidecars(fresh_app, [(missing, "custom_blocks")])
    assert loaded == []


def test_empty_dir_loads_nothing(tmp_path: Path, fresh_app: FastAPI) -> None:
    custom = tmp_path / "custom_blocks"
    custom.mkdir()
    loaded = load_block_sidecars(fresh_app, [(custom, "custom_blocks")])
    assert loaded == []


def test_frontend_only_block_is_skipped(tmp_path: Path, fresh_app: FastAPI) -> None:
    custom = tmp_path / "custom_blocks"
    custom.mkdir()
    _make_block(custom, "frontend_only", with_backend=False)

    loaded = load_block_sidecars(fresh_app, [(custom, "custom_blocks")])

    assert loaded == []
    client = TestClient(fresh_app)
    assert client.get("/api/blocks/frontend_only/ping").status_code == 404


# --- private_blocks overlay (new behavior) ----------------------------------

def test_private_blocks_dir_missing_is_fine(tmp_path: Path, fresh_app: FastAPI) -> None:
    """No private_blocks/ on disk → loader behaves identically to single-dir."""
    custom = tmp_path / "custom_blocks"
    custom.mkdir()
    _make_block(custom, "pub_only")

    private = tmp_path / "private_blocks"  # not created

    loaded = load_block_sidecars(fresh_app, [(custom, "custom_blocks"), (private, "private_blocks")])

    assert loaded == ["pub_only"]


def test_empty_private_blocks_dir_is_fine(tmp_path: Path, fresh_app: FastAPI) -> None:
    custom = tmp_path / "custom_blocks"
    private = tmp_path / "private_blocks"
    custom.mkdir()
    private.mkdir()
    _make_block(custom, "pub_block")

    loaded = load_block_sidecars(fresh_app, [(custom, "custom_blocks"), (private, "private_blocks")])
    assert loaded == ["pub_block"]


def test_private_block_route_mounts_at_standard_prefix(tmp_path: Path, fresh_app: FastAPI) -> None:
    """A private block's route is reachable at the same `/api/blocks/<slug>/...` prefix as a public one.

    The consumer never sees a difference between custom and private — that's
    the whole point of the overlay.
    """
    custom = tmp_path / "custom_blocks"
    private = tmp_path / "private_blocks"
    custom.mkdir()
    private.mkdir()
    _make_block(custom, "pub_block")
    _make_block(private, "priv_block")

    loaded = load_block_sidecars(fresh_app, [(custom, "custom_blocks"), (private, "private_blocks")])

    assert sorted(loaded) == ["priv_block", "pub_block"]

    client = TestClient(fresh_app)
    r_pub = client.get("/api/blocks/pub_block/ping")
    r_priv = client.get("/api/blocks/priv_block/ping")

    assert r_pub.status_code == 200
    assert r_pub.json() == {"ok": True, "slug": "pub_block"}
    assert r_priv.status_code == 200
    assert r_priv.json() == {"ok": True, "slug": "priv_block"}


def test_loaded_slugs_sorted_across_both_dirs(tmp_path: Path, fresh_app: FastAPI) -> None:
    custom = tmp_path / "custom_blocks"
    private = tmp_path / "private_blocks"
    custom.mkdir()
    private.mkdir()
    _make_block(custom, "z_pub")
    _make_block(custom, "m_pub")
    _make_block(private, "a_priv")

    loaded = load_block_sidecars(fresh_app, [(custom, "custom_blocks"), (private, "private_blocks")])

    assert loaded == ["a_priv", "m_pub", "z_pub"]


def test_private_block_frontend_only_is_skipped(tmp_path: Path, fresh_app: FastAPI) -> None:
    """Same skip rule applies to private_blocks/: no backend.block.py → no mount."""
    custom = tmp_path / "custom_blocks"
    private = tmp_path / "private_blocks"
    custom.mkdir()
    private.mkdir()
    _make_block(custom, "pub_block")
    _make_block(private, "priv_frontend_only", with_backend=False)
    _make_block(private, "priv_with_backend")

    loaded = load_block_sidecars(fresh_app, [(custom, "custom_blocks"), (private, "private_blocks")])

    assert sorted(loaded) == ["priv_with_backend", "pub_block"]


# --- Slug collision (the safety-critical case) ------------------------------

def test_slug_collision_across_dirs_raises(tmp_path: Path, fresh_app: FastAPI) -> None:
    custom = tmp_path / "custom_blocks"
    private = tmp_path / "private_blocks"
    custom.mkdir()
    private.mkdir()
    _make_block(custom, "dup_slug")
    _make_block(private, "dup_slug")

    with pytest.raises(RuntimeError, match="dup_slug"):
        load_block_sidecars(fresh_app, [(custom, "custom_blocks"), (private, "private_blocks")])


def test_collision_error_names_both_source_dirs(tmp_path: Path, fresh_app: FastAPI) -> None:
    custom = tmp_path / "custom_blocks"
    private = tmp_path / "private_blocks"
    custom.mkdir()
    private.mkdir()
    _make_block(custom, "dup")
    _make_block(private, "dup")

    with pytest.raises(RuntimeError) as exc_info:
        load_block_sidecars(fresh_app, [(custom, "custom_blocks"), (private, "private_blocks")])

    msg = str(exc_info.value)
    assert "custom_blocks" in msg
    assert "private_blocks" in msg
    assert "dup" in msg


def test_collision_throws_before_any_route_mounts(tmp_path: Path, fresh_app: FastAPI) -> None:
    """If a collision is detected, NO sidecars get mounted (all-or-nothing).

    Otherwise a partial mount would leave the app in a half-broken state where
    some routes work and some don't, confusing debugging.
    """
    custom = tmp_path / "custom_blocks"
    private = tmp_path / "private_blocks"
    custom.mkdir()
    private.mkdir()
    _make_block(custom, "unique_pub")
    _make_block(custom, "dup")
    _make_block(private, "unique_priv")
    _make_block(private, "dup")

    with pytest.raises(RuntimeError):
        load_block_sidecars(fresh_app, [(custom, "custom_blocks"), (private, "private_blocks")])

    # No routes should have been added
    client = TestClient(fresh_app)
    assert client.get("/api/blocks/unique_pub/ping").status_code == 404
    assert client.get("/api/blocks/unique_priv/ping").status_code == 404


# --- Sidecar contract enforcement (regression on existing behavior) ---------

def test_sidecar_without_router_export_raises(tmp_path: Path, fresh_app: FastAPI) -> None:
    custom = tmp_path / "custom_blocks"
    custom.mkdir()
    bad = custom / "bad_block"
    bad.mkdir()
    (bad / "frontend.block.tsx").write_text("export const blockDef = { slug: 'bad_block' }\n")
    # Backend file exists but doesn't export `router`
    (bad / "backend.block.py").write_text("# no router export\n")

    with pytest.raises(RuntimeError, match="router"):
        load_block_sidecars(fresh_app, [(custom, "custom_blocks")])


def test_sidecar_import_error_propagates_with_context(tmp_path: Path, fresh_app: FastAPI) -> None:
    """If sidecar import fails (e.g. syntax error), the error names the offending block."""
    custom = tmp_path / "custom_blocks"
    custom.mkdir()
    broken = custom / "broken_block"
    broken.mkdir()
    (broken / "frontend.block.tsx").write_text("export const blockDef = { slug: 'broken_block' }\n")
    (broken / "backend.block.py").write_text("this is not valid python\n")

    with pytest.raises(RuntimeError, match="broken_block"):
        load_block_sidecars(fresh_app, [(custom, "custom_blocks")])

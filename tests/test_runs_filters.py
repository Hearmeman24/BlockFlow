"""Tests for the artifacts filters: primary media kind and prompt-contains search.

Targets backend/db.py helpers and the /api/runs route end-to-end against a
temp sqlite DB.
"""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import db  # noqa: E402


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    """Point db at a fresh sqlite file and init schema."""
    db_path = tmp_path / "test_runs.db"
    monkeypatch.setattr(db, "DB_PATH", db_path)
    db.init_db()
    yield db


def _make_run(
    *,
    name: str = "test",
    status: str = "completed",
    outputs: dict[str, dict] | None = None,
    favorited: bool = False,
    created_at: str = "2026-01-01T00:00:00Z",
    extra_blocks: list[dict] | None = None,
) -> dict:
    """Build a minimal run dict. `outputs` lives in the single block."""
    blocks = [
        {
            "block_index": 0,
            "block_label": "Block A",
            "block_type": "generation",
            "status": "ok",
            "outputs": outputs or {},
        }
    ]
    if extra_blocks:
        blocks.extend(extra_blocks)
    return {
        "id": str(uuid.uuid4()),
        "name": name,
        "status": status,
        "duration_ms": 1000,
        "flow_snapshot": {"blocks": []},
        "block_results": blocks,
        "created_at": created_at,
        "favorited": 1 if favorited else 0,
    }


# ---------- _primary_media_kind ----------

class TestPrimaryMediaKind:
    def test_video_when_only_video_present(self):
        blocks = [{"outputs": {"o": {"kind": "video", "value": "x.mp4"}}}]
        assert db._primary_media_kind(blocks) == "video"

    def test_image_when_only_image_present(self):
        blocks = [{"outputs": {"o": {"kind": "image", "value": "x.png"}}}]
        assert db._primary_media_kind(blocks) == "image"

    def test_video_takes_priority_over_image(self):
        blocks = [
            {"outputs": {"o": {"kind": "image", "value": "x.png"}}},
            {"outputs": {"o": {"kind": "video", "value": "x.mp4"}}},
        ]
        assert db._primary_media_kind(blocks) == "video"

    def test_prompt_only_run_is_other(self):
        blocks = [{"outputs": {"o": {"kind": "prompt", "value": "hi"}}}]
        assert db._primary_media_kind(blocks) == "other"

    def test_audio_only_run_is_other(self):
        blocks = [{"outputs": {"o": {"kind": "audio", "value": "x.wav"}}}]
        assert db._primary_media_kind(blocks) == "other"

    def test_no_outputs_is_other(self):
        assert db._primary_media_kind([{"outputs": {}}]) == "other"
        assert db._primary_media_kind([]) == "other"

    def test_missing_outputs_key_is_other(self):
        assert db._primary_media_kind([{}]) == "other"


# ---------- _run_matches_prompt ----------

class TestRunMatchesPrompt:
    def _meta_block(self, **fields) -> dict:
        return {"outputs": {"m": {"kind": "metadata", "value": fields}}}

    def test_substring_match_on_prompt(self):
        blocks = [self._meta_block(prompt="a cinematic shot of a cat")]
        assert db._run_matches_prompt(blocks, "cat") is True
        assert db._run_matches_prompt(blocks, "dog") is False

    def test_case_insensitive(self):
        blocks = [self._meta_block(prompt="A Cinematic Shot")]
        assert db._run_matches_prompt(blocks, "cinematic") is True
        assert db._run_matches_prompt(blocks, "CINEMATIC") is True

    def test_does_not_match_negative_prompt(self):
        """Decision: prompt search hits metadata.prompt only, not negative_prompt."""
        blocks = [self._meta_block(prompt="a cat", negative_prompt="dog")]
        assert db._run_matches_prompt(blocks, "dog") is False

    def test_does_not_match_other_string_fields(self):
        """Don't match the `model` field or arbitrary text outputs."""
        blocks = [
            self._meta_block(prompt="cat", model="wan22-special"),
            {"outputs": {"t": {"kind": "text", "value": "wan22-special"}}},
        ]
        assert db._run_matches_prompt(blocks, "wan22") is False

    def test_metadata_value_can_be_list(self):
        """When automation produces multiple metadata entries per block."""
        block = {
            "outputs": {
                "m": {
                    "kind": "metadata",
                    "value": [{"prompt": "alpha"}, {"prompt": "beta"}],
                }
            }
        }
        assert db._run_matches_prompt([block], "alpha") is True
        assert db._run_matches_prompt([block], "beta") is True
        assert db._run_matches_prompt([block], "gamma") is False

    def test_no_metadata_block_no_match(self):
        blocks = [{"outputs": {"o": {"kind": "video", "value": "x.mp4"}}}]
        assert db._run_matches_prompt(blocks, "anything") is False

    def test_non_string_prompt_ignored(self):
        blocks = [self._meta_block(prompt=42)]
        assert db._run_matches_prompt(blocks, "42") is False


# ---------- list_runs / count_runs integration ----------

class TestListAndCountFilters:
    def test_unfiltered_returns_all_ordered_by_created_desc(self, temp_db):
        temp_db.save_run(_make_run(name="oldest", created_at="2026-01-01T00:00:00Z"))
        temp_db.save_run(_make_run(name="newest", created_at="2026-03-01T00:00:00Z"))
        temp_db.save_run(_make_run(name="middle", created_at="2026-02-01T00:00:00Z"))

        rows = temp_db.list_runs(limit=10, offset=0)
        assert [r["name"] for r in rows] == ["newest", "middle", "oldest"]
        assert temp_db.count_runs() == 3

    def test_media_kind_filter_video(self, temp_db):
        temp_db.save_run(_make_run(
            name="video-run",
            outputs={"o": {"kind": "video", "value": "x.mp4"}},
        ))
        temp_db.save_run(_make_run(
            name="image-run",
            outputs={"o": {"kind": "image", "value": "x.png"}},
        ))
        temp_db.save_run(_make_run(
            name="prompt-run",
            outputs={"o": {"kind": "prompt", "value": "hi"}},
        ))

        videos = temp_db.list_runs(limit=10, offset=0, media_kind="video")
        assert [r["name"] for r in videos] == ["video-run"]
        assert temp_db.count_runs(media_kind="video") == 1

        others = temp_db.list_runs(limit=10, offset=0, media_kind="other")
        assert [r["name"] for r in others] == ["prompt-run"]
        assert temp_db.count_runs(media_kind="other") == 1

    def test_prompt_query_filter(self, temp_db):
        temp_db.save_run(_make_run(
            name="cat-run",
            outputs={"m": {"kind": "metadata", "value": {"prompt": "a cat"}}},
        ))
        temp_db.save_run(_make_run(
            name="dog-run",
            outputs={"m": {"kind": "metadata", "value": {"prompt": "a dog"}}},
        ))

        matches = temp_db.list_runs(limit=10, offset=0, prompt_query="cat")
        assert [r["name"] for r in matches] == ["cat-run"]
        assert temp_db.count_runs(prompt_query="cat") == 1

    def test_combined_media_kind_and_prompt_query(self, temp_db):
        temp_db.save_run(_make_run(
            name="cat-video",
            outputs={
                "v": {"kind": "video", "value": "x.mp4"},
                "m": {"kind": "metadata", "value": {"prompt": "a cat"}},
            },
        ))
        temp_db.save_run(_make_run(
            name="cat-image",
            outputs={
                "i": {"kind": "image", "value": "x.png"},
                "m": {"kind": "metadata", "value": {"prompt": "a cat"}},
            },
        ))
        temp_db.save_run(_make_run(
            name="dog-video",
            outputs={
                "v": {"kind": "video", "value": "x.mp4"},
                "m": {"kind": "metadata", "value": {"prompt": "a dog"}},
            },
        ))

        result = temp_db.list_runs(
            limit=10, offset=0, media_kind="video", prompt_query="cat"
        )
        assert [r["name"] for r in result] == ["cat-video"]
        assert temp_db.count_runs(media_kind="video", prompt_query="cat") == 1

    def test_favorited_combines_with_filters(self, temp_db):
        # Two cat videos, only one favorited.
        temp_db.save_run(_make_run(
            name="cat-fav",
            favorited=True,
            outputs={
                "v": {"kind": "video", "value": "x.mp4"},
                "m": {"kind": "metadata", "value": {"prompt": "cat"}},
            },
        ))
        # Favorite-toggle persists via separate code path; emulate via save_run + toggle.
        cat_other = _make_run(
            name="cat-plain",
            outputs={
                "v": {"kind": "video", "value": "x.mp4"},
                "m": {"kind": "metadata", "value": {"prompt": "cat"}},
            },
        )
        temp_db.save_run(cat_other)
        # save_run doesn't persist `favorited`; flip the favorited one manually.
        import sqlite3
        conn = sqlite3.connect(str(temp_db.DB_PATH))
        conn.execute(
            "UPDATE runs SET favorited = 1 WHERE name = ?", ("cat-fav",)
        )
        conn.commit()
        conn.close()

        fav_cats = temp_db.list_runs(
            limit=10, offset=0, favorited_only=True, prompt_query="cat"
        )
        assert [r["name"] for r in fav_cats] == ["cat-fav"]
        assert temp_db.count_runs(favorited_only=True, prompt_query="cat") == 1

    def test_pagination_applies_after_filter(self, temp_db):
        for i in range(5):
            temp_db.save_run(_make_run(
                name=f"vid-{i}",
                outputs={"v": {"kind": "video", "value": f"{i}.mp4"}},
                created_at=f"2026-01-0{i + 1}T00:00:00Z",
            ))
        # 1 non-matching run interleaved
        temp_db.save_run(_make_run(
            name="not-video",
            outputs={"o": {"kind": "image", "value": "x.png"}},
            created_at="2026-01-10T00:00:00Z",
        ))

        page1 = temp_db.list_runs(limit=2, offset=0, media_kind="video")
        page2 = temp_db.list_runs(limit=2, offset=2, media_kind="video")
        assert [r["name"] for r in page1] == ["vid-4", "vid-3"]
        assert [r["name"] for r in page2] == ["vid-2", "vid-1"]
        assert temp_db.count_runs(media_kind="video") == 5

    def test_unfiltered_path_uses_sql_pagination(self, temp_db):
        """Sanity: unfiltered fast path returns same as filtered path."""
        for i in range(3):
            temp_db.save_run(_make_run(
                name=f"run-{i}",
                outputs={"v": {"kind": "video", "value": f"{i}.mp4"}},
                created_at=f"2026-01-0{i + 1}T00:00:00Z",
            ))
        rows = temp_db.list_runs(limit=2, offset=0)
        assert [r["name"] for r in rows] == ["run-2", "run-1"]

    def test_hide_partial_excludes_partial_and_failed_from_count_and_rows(self, temp_db):
        temp_db.save_run(_make_run(
            name="completed-run",
            status="completed",
            created_at="2026-01-03T00:00:00Z",
        ))
        temp_db.save_run(_make_run(
            name="partial-run",
            status="partial",
            created_at="2026-01-02T00:00:00Z",
        ))
        temp_db.save_run(_make_run(
            name="failed-run",
            status="failed",
            created_at="2026-01-01T00:00:00Z",
        ))

        rows = temp_db.list_runs(limit=10, offset=0, hide_partial=True)

        assert [r["name"] for r in rows] == ["completed-run"]
        assert temp_db.count_runs(hide_partial=True) == 1

    def test_hide_partial_pagination_applies_after_status_filter(self, temp_db):
        temp_db.save_run(_make_run(name="done-1", status="completed", created_at="2026-01-01T00:00:00Z"))
        temp_db.save_run(_make_run(name="partial", status="partial", created_at="2026-01-02T00:00:00Z"))
        temp_db.save_run(_make_run(name="done-2", status="completed", created_at="2026-01-03T00:00:00Z"))
        temp_db.save_run(_make_run(name="failed", status="failed", created_at="2026-01-04T00:00:00Z"))
        temp_db.save_run(_make_run(name="done-3", status="completed", created_at="2026-01-05T00:00:00Z"))

        page1 = temp_db.list_runs(limit=2, offset=0, hide_partial=True)
        page2 = temp_db.list_runs(limit=2, offset=2, hide_partial=True)

        assert [r["name"] for r in page1] == ["done-3", "done-2"]
        assert [r["name"] for r in page2] == ["done-1"]
        assert temp_db.count_runs(hide_partial=True) == 3

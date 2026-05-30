"""Pure parser for user-supplied CivitAI references.

Accepts: full model+version URL, model-only URL (needs latest-version lookup),
and bare integer (treated as version_id). Anything else is rejected.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import pytest  # noqa: E402

from backend.civitai_client import CivitAIRefError, parse_civitai_ref  # noqa: E402


def test_full_url_with_model_version_id_extracts_version() -> None:
    ref = parse_civitai_ref("https://civitai.com/models/12345?modelVersionId=67890")
    assert ref.version_id == 67890
    assert ref.model_id == 12345
    assert ref.needs_latest_lookup is False


def test_full_url_with_extra_query_params_still_works() -> None:
    ref = parse_civitai_ref("https://civitai.com/models/12345?modelVersionId=67890&type=Model")
    assert ref.version_id == 67890


def test_model_only_url_marks_for_latest_lookup() -> None:
    ref = parse_civitai_ref("https://civitai.com/models/12345")
    assert ref.version_id is None
    assert ref.model_id == 12345
    assert ref.needs_latest_lookup is True


def test_model_only_url_with_slug_after_id() -> None:
    """civitai URLs sometimes carry a slug, e.g. /models/12345/my-lora-name."""
    ref = parse_civitai_ref("https://civitai.com/models/12345/my-lora-name")
    assert ref.model_id == 12345
    assert ref.needs_latest_lookup is True


def test_raw_integer_treated_as_version_id() -> None:
    ref = parse_civitai_ref("67890")
    assert ref.version_id == 67890
    assert ref.model_id is None
    assert ref.needs_latest_lookup is False


def test_raw_integer_with_whitespace_is_stripped() -> None:
    ref = parse_civitai_ref("  67890  ")
    assert ref.version_id == 67890


def test_civitai_red_alias_accepted() -> None:
    """civitai.red is the project's NSFW-tolerant mirror — same backend, same
    model IDs, same API. The user routinely shares .red URLs (e.g. the WAN
    SVI workflow), so the parser must accept them."""
    ref = parse_civitai_ref(
        "https://civitai.red/models/2653749/wan-22-svi-4-passes-25-second-videos"
    )
    assert ref.model_id == 2653749
    assert ref.needs_latest_lookup is True


def test_http_scheme_also_accepted() -> None:
    """Don't be a stickler about https vs http — just route to canonical."""
    ref = parse_civitai_ref("http://civitai.com/models/12345?modelVersionId=67890")
    assert ref.version_id == 67890


def test_rejects_non_civitai_host() -> None:
    with pytest.raises(CivitAIRefError):
        parse_civitai_ref("https://example.com/models/12345")


def test_rejects_url_without_model_id() -> None:
    with pytest.raises(CivitAIRefError):
        parse_civitai_ref("https://civitai.com/models/")


def test_rejects_non_integer_model_id() -> None:
    with pytest.raises(CivitAIRefError):
        parse_civitai_ref("https://civitai.com/models/abc")


def test_rejects_empty_string() -> None:
    with pytest.raises(CivitAIRefError):
        parse_civitai_ref("")


def test_rejects_huggingface_url() -> None:
    with pytest.raises(CivitAIRefError):
        parse_civitai_ref("https://huggingface.co/foo/bar")


def test_rejects_negative_integer() -> None:
    with pytest.raises(CivitAIRefError):
        parse_civitai_ref("-1")


def test_rejects_zero() -> None:
    with pytest.raises(CivitAIRefError):
        parse_civitai_ref("0")

"""Tests for civitai_client.fetch_version_by_hash — used by the CivitAI Share
HITL gate to resolve detected SHA256 hashes to a real model+version on CivitAI
before asking the user to approve.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


from backend import civitai_client  # noqa: E402


def _resp(status: int, body: dict) -> MagicMock:
    m = MagicMock()
    m.status_code = status
    m.json.return_value = body
    if status >= 400:
        m.raise_for_status.side_effect = RuntimeError(f"http {status}")
    else:
        m.raise_for_status.return_value = None
    return m


def test_fetch_by_hash_returns_version_metadata(mocker) -> None:
    payload = {
        "id": 67890,
        "modelId": 12345,
        "name": "v2",
        "baseModel": "Flux.1 D",
        "files": [{"primary": True, "name": "char_v2.safetensors", "sizeKB": 100.0}],
        "model": {"name": "WAN 2.2 SVI 4 Passes", "type": "Workflows"},
    }
    mocker.patch.object(
        civitai_client._requests, "get", return_value=_resp(200, payload)
    )
    meta = civitai_client.fetch_version_by_hash("a" * 64)
    assert meta is not None
    assert meta.version_id == 67890
    assert meta.model_id == 12345
    assert meta.name == "v2"
    # New fields: model title + type from the nested `model` object.
    # CivitAI's by-hash response carries the *version* name at `name` and
    # the human model title at `model.name` — UI needs the title to be
    # useful (showing "v2" instead of "WAN 2.2 SVI" gave the user no info).
    assert meta.model_name == "WAN 2.2 SVI 4 Passes"
    assert meta.model_type == "Workflows"


def test_fetch_by_hash_handles_missing_model_block(mocker) -> None:
    """Older payloads / odd responses may omit the nested `model` object —
    don't crash, just leave model_name/model_type None."""
    payload = {"id": 1, "modelId": 2, "name": "v1", "files": []}
    mocker.patch.object(
        civitai_client._requests, "get", return_value=_resp(200, payload)
    )
    meta = civitai_client.fetch_version_by_hash("a" * 64)
    assert meta is not None
    assert meta.model_name is None
    assert meta.model_type is None


def test_fetch_by_hash_404_returns_none(mocker) -> None:
    """A 404 from /model-versions/by-hash is the common 'not on CivitAI' case
    for local-only LoRAs. The HITL gate needs to render those rows as
    'Unknown — not on CivitAI', not crash the whole resolve batch."""

    class _HTTPError(Exception):
        def __init__(self) -> None:
            self.response = MagicMock(status_code=404)

    bad = MagicMock()
    bad.status_code = 404
    bad.raise_for_status.side_effect = _HTTPError()
    mocker.patch.object(civitai_client._requests, "get", return_value=bad)

    result = civitai_client.fetch_version_by_hash("b" * 64)
    assert result is None


def test_fetch_by_hash_uppercases_lowercase_sha(mocker) -> None:
    """CivitAI's by-hash endpoint is case-insensitive in practice, but we
    normalise to lower so cache keys / dedupe in callers stay consistent."""
    payload = {"id": 1, "modelId": 2, "files": []}
    get_mock = mocker.patch.object(
        civitai_client._requests, "get", return_value=_resp(200, payload)
    )
    civitai_client.fetch_version_by_hash("ABCD" + "0" * 60)
    url = get_mock.call_args[0][0]
    assert "abcd" + "0" * 60 in url

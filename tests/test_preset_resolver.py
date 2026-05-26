"""src-abj: BlockFlow's GPU-fallback installer used to hand-roll the
`comfy-gen download --batch` payload, which dropped per-source translation
(civitai version_id extraction, huggingface→url alias) and produced a
recurring class of prod failures. These tests pin down the canonical
translator vendored from comfy-gen's serverless-runtime/preset_resolver.
"""
from __future__ import annotations

import pytest

from backend.preset_resolver import preset_to_download_batch


def test_url_source_emits_destination_path():
    """source=url entries must use destination_path (full <subfolder>/<file>)
    so the worker's _split_destination_path splits correctly — never bare
    dest with a slash."""
    out = preset_to_download_batch([
        {
            "source": "url",
            "url": "https://hf.co/org/repo/resolve/main/m.safetensors",
            "dest": "text_encoders/m.safetensors",
            "sha256": "a" * 64,
        }
    ])
    assert out == [{
        "source": "url",
        "url": "https://hf.co/org/repo/resolve/main/m.safetensors",
        "destination_path": "text_encoders/m.safetensors",
        "sha256": "a" * 64,
    }]


def test_huggingface_source_aliased_to_url():
    """The preset schema uses source=huggingface; the worker only knows
    'url' and 'civitai'. The translator must downgrade to url."""
    out = preset_to_download_batch([
        {
            "source": "huggingface",
            "url": "https://hf.co/x/m.safetensors",
            "dest": "checkpoints/m.safetensors",
            "sha256": "b" * 64,
        }
    ])
    assert out[0]["source"] == "url"
    assert out[0]["destination_path"] == "checkpoints/m.safetensors"


def test_default_source_is_url_when_omitted():
    out = preset_to_download_batch([
        {"url": "https://x/m.safetensors", "dest": "loras/m.safetensors", "sha256": "c" * 64}
    ])
    assert out[0]["source"] == "url"


def test_civitai_extracts_version_id_and_splits_dest():
    """src-abj root cause: source=civitai without version_id crashed the
    worker. Version_id must be parsed from the CivitAI download URL and
    dest split into subfolder + filename."""
    out = preset_to_download_batch([
        {
            "source": "civitai",
            "url": "https://civitai.com/api/download/models/456789",
            "dest": "loras/cool_style.safetensors",
            "sha256": "d" * 64,
        }
    ])
    assert out == [{
        "source": "civitai",
        "version_id": "456789",
        "dest": "loras",
        "filename": "cool_style.safetensors",
        "sha256": "d" * 64,
    }]


def test_civitai_url_without_version_id_raises():
    with pytest.raises(ValueError, match="civitai source"):
        preset_to_download_batch([
            {
                "source": "civitai",
                "url": "https://civitai.com/models/12345",
                "dest": "loras/x.safetensors",
                "sha256": "0" * 64,
            }
        ])


def test_mixed_sources_preserve_order():
    out = preset_to_download_batch([
        {"source": "huggingface", "url": "https://hf.co/a", "dest": "vae/a.safetensors", "sha256": "1" * 64},
        {"source": "civitai", "url": "https://civitai.com/api/download/models/111",
         "dest": "loras/b.safetensors", "sha256": "2" * 64},
        {"source": "url", "url": "https://x/c", "dest": "clip/c.safetensors", "sha256": "3" * 64},
    ])
    assert [e["source"] for e in out] == ["url", "civitai", "url"]
    assert out[1]["version_id"] == "111"
    assert out[2]["destination_path"] == "clip/c.safetensors"


def test_dest_without_slash_defaults_to_checkpoints_subfolder():
    """Defensive: a bare filename in dest should land under checkpoints/
    (matches the legacy GPU-install hand-rolled behavior)."""
    out = preset_to_download_batch([
        {"source": "url", "url": "https://x/m.safetensors", "dest": "m.safetensors", "sha256": "f" * 64}
    ])
    assert out[0]["destination_path"] == "checkpoints/m.safetensors"


def test_underscore_prefixed_fields_dropped():
    """Internal fields like _civitai_metadata must not leak into the CLI
    payload (the CLI rejects unknown keys)."""
    out = preset_to_download_batch([
        {
            "source": "url",
            "url": "https://x/m.safetensors",
            "dest": "vae/m.safetensors",
            "sha256": "e" * 64,
            "_internal_note": "do-not-send",
        }
    ])
    assert "_internal_note" not in out[0]


def test_missing_dest_raises():
    with pytest.raises(ValueError, match="missing dest"):
        preset_to_download_batch([{"source": "url", "url": "https://x"}])

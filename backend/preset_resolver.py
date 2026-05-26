"""Canonical translator from BlockFlow preset.models to comfy-gen
`download --batch` payload shape.

Vendored from comfy-gen's serverless-runtime/preset_resolver.py — see
src-abj. The GPU-fallback installer (preset_routes._run_gpu_install_subprocess)
shells out to `comfy-gen download --batch` against an existing serverless
endpoint and MUST translate raw preset entries through this function;
forwarding raw preset.models has produced three separate prod failures
(src-b6b dest/path conflation; huggingface/civitai source aliasing).
"""
from __future__ import annotations

import re

_CIVITAI_VID_RE = re.compile(r"civitai\.com/api/download/models/(\d+)")


def preset_to_download_batch(models: list[dict]) -> list[dict]:
    """Translate raw preset.models entries into the download_handler shape.

    Default source is `url` (aria2c URL fetch); `huggingface` is aliased to
    `url`. When a model declares `source: 'civitai'`, the URL is parsed for
    its version_id and the entry is rewritten into the authenticated CivitAI
    shape the worker's download_handler expects:
        {source, version_id, dest, filename, sha256}

    URL/huggingface entries emit `destination_path` (which the handler splits
    via _split_destination_path) — never bare `dest` with a full file path.

    Underscore-prefixed fields are dropped (the CLI rejects unknown keys).
    """
    out: list[dict] = []
    for raw in models:
        m = {k: v for k, v in raw.items() if not k.startswith("_")}
        source = m.get("source", "url")
        dest = m.get("dest") or ""
        if not dest:
            raise ValueError(f"preset model entry missing dest: {m!r}")
        if source == "civitai":
            mo = _CIVITAI_VID_RE.search(m.get("url") or "")
            if not mo:
                raise ValueError(
                    f"civitai source for {dest!r} requires URL matching "
                    f"civitai.com/api/download/models/<version_id>: "
                    f"got {m.get('url')!r}"
                )
            subfolder, _, filename = dest.partition("/")
            if not filename:
                subfolder, filename = "checkpoints", subfolder
            out.append({
                "source": "civitai",
                "version_id": mo.group(1),
                "dest": subfolder,
                "filename": filename,
                "sha256": m.get("sha256", ""),
            })
        else:
            out.append({
                "source": "url",
                "url": m.get("url", ""),
                "destination_path": (
                    dest if "/" in dest else f"checkpoints/{dest}"
                ),
                "sha256": m.get("sha256", ""),
            })
    return out

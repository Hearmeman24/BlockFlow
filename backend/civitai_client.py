"""CivitAI URL parsing + public API client for LoRA metadata.

Used by the LoRA management page (sgs-ui-eqc) to resolve user-supplied
references into a downloadable version_id and to enrich downloaded files
with trigger words and base model.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, urlparse

import curl_cffi.requests as _requests


class CivitAIRefError(ValueError):
    """User-supplied CivitAI reference could not be parsed."""


@dataclass(frozen=True)
class CivitAIRef:
    version_id: int | None
    model_id: int | None
    needs_latest_lookup: bool


def parse_civitai_ref(raw: str) -> CivitAIRef:
    """Parse a user-supplied CivitAI reference.

    Accepted forms:
      - Full URL with versionId: https://civitai.com/models/<mid>?modelVersionId=<vid>
      - Model-only URL (latest version will be looked up): https://civitai.com/models/<mid>[/slug]
      - Bare positive integer: treated as version_id
    """
    if not isinstance(raw, str):
        raise CivitAIRefError("ref must be a string")
    s = raw.strip()
    if not s:
        raise CivitAIRefError("ref is empty")

    if s.isdigit() or (s.startswith("-") and s[1:].isdigit()):
        try:
            n = int(s)
        except ValueError as exc:
            raise CivitAIRefError(f"invalid integer: {s!r}") from exc
        if n <= 0:
            raise CivitAIRefError("version_id must be a positive integer")
        return CivitAIRef(version_id=n, model_id=None, needs_latest_lookup=False)

    parsed = urlparse(s)
    if parsed.scheme not in ("http", "https"):
        raise CivitAIRefError(f"unsupported scheme: {parsed.scheme!r}")
    host = (parsed.hostname or "").lower()
    # civitai.red is the project's NSFW-tolerant mirror — same backend, same
    # model IDs. Accept both hosts and their subdomains.
    accepted = ("civitai.com", "civitai.red")
    if host not in accepted and not any(host.endswith("." + h) for h in accepted):
        raise CivitAIRefError(f"not a civitai URL (host={host!r})")

    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) < 2 or parts[0] != "models":
        raise CivitAIRefError("URL path must start with /models/<id>")
    try:
        model_id = int(parts[1])
    except ValueError as exc:
        raise CivitAIRefError(f"model id must be an integer, got {parts[1]!r}") from exc
    if model_id <= 0:
        raise CivitAIRefError("model id must be positive")

    qs = parse_qs(parsed.query)
    vid_raw = (qs.get("modelVersionId") or [None])[0]
    if vid_raw is not None:
        try:
            vid = int(vid_raw)
        except ValueError as exc:
            raise CivitAIRefError(f"modelVersionId must be an integer, got {vid_raw!r}") from exc
        if vid <= 0:
            raise CivitAIRefError("modelVersionId must be positive")
        return CivitAIRef(version_id=vid, model_id=model_id, needs_latest_lookup=False)

    return CivitAIRef(version_id=None, model_id=model_id, needs_latest_lookup=True)


# ---- API client ----

CIVITAI_API_BASE = "https://civitai.com/api/v1"


@dataclass(frozen=True)
class CivitAIVersionMetadata:
    version_id: int
    model_id: int | None
    # `name` here is the *version* label ("v1.0", "Base"). Model title is on
    # `model_name`. The two differ on CivitAI's API and the UI almost always
    # wants the title — code that displays a single string should prefer
    # `model_name or name`.
    name: str | None
    base_model: str | None
    trigger_words: list[str]
    primary_file_name: str | None
    primary_file_size_kb: float | None
    download_url: str | None
    # Nested model fields — populated when the response carries `model: {...}`.
    model_name: str | None = None
    model_type: str | None = None


def fetch_version_metadata(version_id: int, api_key: str = "") -> CivitAIVersionMetadata:
    """Fetch metadata for a specific model version. Raises on HTTP error.

    Anonymous when api_key is empty (public metadata is unauthenticated)."""
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    resp = _requests.get(
        f"{CIVITAI_API_BASE}/model-versions/{version_id}", headers=headers, timeout=15
    )
    resp.raise_for_status()
    data = resp.json()
    return _version_metadata_from_payload(data, fallback_version_id=version_id)


def fetch_version_by_hash(
    sha256: str, api_key: str = ""
) -> CivitAIVersionMetadata | None:
    """Look up a model version by file SHA256. Returns None on 404 (the
    common 'this LoRA isn't on CivitAI' case) so callers can render an
    'Unknown' row instead of aborting a whole batch."""
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    sha = sha256.lower()
    resp = _requests.get(
        f"{CIVITAI_API_BASE}/model-versions/by-hash/{sha}",
        headers=headers,
        timeout=15,
    )
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    data = resp.json()
    return _version_metadata_from_payload(data, fallback_version_id=int(data.get("id") or 0))


def fetch_latest_version_for_model(model_id: int, api_key: str = "") -> CivitAIVersionMetadata:
    """Fetch the model's latest published version. Raises on HTTP error."""
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    resp = _requests.get(f"{CIVITAI_API_BASE}/models/{model_id}", headers=headers, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    versions = data.get("modelVersions") or []
    if not versions:
        raise CivitAIRefError(f"model {model_id} has no published versions")
    head = versions[0]
    # /api/v1/models/<id> puts the model name + type at the OUTER level and
    # nested version objects don't carry a `model` block. Synthesize one so
    # _version_metadata_from_payload picks up the title.
    if "model" not in head:
        head = dict(head)
        head["model"] = {"name": data.get("name"), "type": data.get("type")}
    return _version_metadata_from_payload(head, fallback_version_id=int(head.get("id") or 0))


def _version_metadata_from_payload(
    data: dict[str, Any], fallback_version_id: int
) -> CivitAIVersionMetadata:
    files = data.get("files") or []
    primary = next((f for f in files if f.get("primary")), files[0] if files else {})
    model_block = data.get("model") or {}
    return CivitAIVersionMetadata(
        version_id=int(data.get("id") or fallback_version_id),
        model_id=(int(data["modelId"]) if data.get("modelId") is not None else None),
        name=data.get("name"),
        base_model=data.get("baseModel"),
        trigger_words=list(data.get("trainedWords") or []),
        primary_file_name=primary.get("name"),
        primary_file_size_kb=(
            float(primary["sizeKB"]) if primary and primary.get("sizeKB") is not None else None
        ),
        download_url=(primary.get("downloadUrl") or data.get("downloadUrl")),
        model_name=(model_block.get("name") if isinstance(model_block, dict) else None),
        model_type=(model_block.get("type") if isinstance(model_block, dict) else None),
    )

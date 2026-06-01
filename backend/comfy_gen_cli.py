from __future__ import annotations

import contextlib
import json
import os
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Mapping

OVERRIDE_ENV = "BLOCKFLOW_COMFY_GEN_BIN"
VENV_ENV = "BLOCKFLOW_COMFY_GEN_VENV"


class ComfyGenNotFound(RuntimeError):
    """Raised when the ComfyGen CLI cannot be resolved."""


class ComfyGenConfigurationError(RuntimeError):
    """Raised when Settings lacks credentials needed by comfy-gen."""


@dataclass(frozen=True)
class ResolvedComfyGen:
    path: Path
    mode: str

    def command(self, *args: str) -> list[str]:
        return [str(self.path), *args]


def _is_windows(platform: str | None) -> bool:
    return (platform or sys.platform).startswith("win")


def _venv_cli_path(venv_path: Path, *, platform: str | None = None) -> Path:
    if _is_windows(platform):
        return venv_path / "Scripts" / "comfy-gen.exe"
    return venv_path / "bin" / "comfy-gen"


def _executable(path: Path) -> Path | None:
    expanded = path.expanduser()
    if expanded.is_file() and os.access(expanded, os.X_OK):
        return expanded
    return None


def resolve_comfy_gen(*, platform: str | None = None) -> ResolvedComfyGen:
    override = os.environ.get(OVERRIDE_ENV, "").strip()
    if override:
        path = _executable(Path(override))
        if path:
            return ResolvedComfyGen(path=path, mode="override")
        raise ComfyGenNotFound(f"{OVERRIDE_ENV} points to a non-executable file: {override}")

    venv = os.environ.get(VENV_ENV, "").strip()
    if venv:
        path = _executable(_venv_cli_path(Path(venv), platform=platform))
        if path:
            return ResolvedComfyGen(path=path, mode="sidecar")
        raise ComfyGenNotFound(f"{VENV_ENV} does not contain an executable comfy-gen CLI: {venv}")

    path_from_env = shutil.which("comfy-gen")
    if path_from_env:
        return ResolvedComfyGen(path=Path(path_from_env), mode="path")

    raise ComfyGenNotFound(
        "comfy-gen CLI not found. Set BLOCKFLOW_COMFY_GEN_BIN, provide "
        "BLOCKFLOW_COMFY_GEN_VENV, or install comfy-gen on PATH."
    )


@contextlib.contextmanager
def settings_subprocess_env(
    *,
    endpoint_id: str | None = None,
    extra_env: Mapping[str, str | None] | None = None,
    require_runpod: bool = True,
) -> Iterator[dict[str, str]]:
    """Return a subprocess env where comfy-gen reads BlockFlow Settings.

    comfy-gen's own config file has higher priority than environment variables.
    To keep Settings/SQLite canonical, create an isolated temporary HOME with a
    generated comfy-gen config instead of depending only on RUNPOD_API_KEY.
    """
    from backend import settings_store

    runpod_key = (settings_store.get_credential("runpod_api_key") or "").strip()
    if require_runpod and not runpod_key:
        raise ComfyGenConfigurationError("runpod_api_key not configured in Settings → Credentials")

    ep = settings_store.get_endpoint("comfygen") or {}
    resolved_endpoint_id = (endpoint_id or str(ep.get("endpoint_id") or "")).strip()

    cfg = _settings_comfy_gen_config(runpod_key=runpod_key, endpoint_id=resolved_endpoint_id)
    env = os.environ.copy()
    for key, value in (extra_env or {}).items():
        if value:
            env[key] = value
        else:
            env.pop(key, None)

    with tempfile.TemporaryDirectory(prefix="blockflow-comfy-gen-") as tmp:
        home = Path(tmp)
        cfg_dir = home / ".comfy-gen"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "config.json").write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")

        env["HOME"] = str(home)
        env["USERPROFILE"] = str(home)
        if runpod_key:
            env["RUNPOD_API_KEY"] = runpod_key
        if resolved_endpoint_id:
            env["RUNPOD_ENDPOINT_ID"] = resolved_endpoint_id

        yield env


def _settings_comfy_gen_config(*, runpod_key: str, endpoint_id: str) -> dict[str, object]:
    from backend import settings_store

    mapping = {
        "runpod_api_key": runpod_key,
        "endpoint_id": endpoint_id,
        "aws_access_key_id": settings_store.get_credential("r2_access_key_id") or "",
        "aws_secret_access_key": settings_store.get_credential("r2_secret_access_key") or "",
        "s3_bucket": settings_store.get_credential("r2_bucket") or "",
        "s3_region": settings_store.get_credential("r2_region") or "auto",
        "s3_endpoint_url": settings_store.get_credential("r2_endpoint_url") or "",
        "civitai_token": settings_store.get_credential("civitai_api_key") or "",
    }
    return {key: value for key, value in mapping.items() if value}

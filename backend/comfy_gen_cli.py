from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

OVERRIDE_ENV = "BLOCKFLOW_COMFY_GEN_BIN"
VENV_ENV = "BLOCKFLOW_COMFY_GEN_VENV"


class ComfyGenNotFound(RuntimeError):
    """Raised when the ComfyGen CLI cannot be resolved."""


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

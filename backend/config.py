from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

APP_TITLE = "BlockFlow"
ROOT_DIR = Path(__file__).resolve().parent.parent


# === sgs-ui-5ni: user data lives outside the running checkout =================
#
# Before sgs-ui-5ni every user-data file (prompt_library.json, run_history.db,
# flows/, output/, …) was rooted at ROOT_DIR. Each git worktree got its own
# isolated copy, and launching the app from a worktree silently swapped in
# fresh empty state. Now resolved to a stable platform location and migrated
# from the legacy ROOT_DIR layout on first launch.

def resolve_user_data_dir() -> Path:
    """Resolution order:
      1. $BLOCKFLOW_DATA_DIR (explicit override; respected verbatim).
      2. $BLOCKFLOW_HOME (portable product home; respected verbatim).
      3. macOS:   ~/Library/Application Support/BlockFlow
      3. Linux:   $XDG_DATA_HOME/blockflow if set, else ~/.local/share/blockflow
      4. Windows: %LOCALAPPDATA%\\BlockFlow if set, else ~/AppData/Local/BlockFlow
                  (LOCALAPPDATA is machine-local — right choice for a multi-GB
                  SQLite DB; APPDATA would sync via Windows roaming profiles.)
      5. Other:   ~/.blockflow (catch-all so worktrees don't fragment).
    """
    explicit = os.environ.get("BLOCKFLOW_DATA_DIR")
    if explicit:
        return Path(explicit).expanduser()
    home = os.environ.get("BLOCKFLOW_HOME")
    if home:
        return Path(home).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "BlockFlow"
    if sys.platform.startswith("linux"):
        xdg = os.environ.get("XDG_DATA_HOME")
        if xdg:
            return Path(xdg) / "blockflow"
        return Path.home() / ".local" / "share" / "blockflow"
    if sys.platform == "win32" or sys.platform.startswith("cygwin"):
        local_appdata = os.environ.get("LOCALAPPDATA")
        if local_appdata:
            return Path(local_appdata) / "BlockFlow"
        return Path.home() / "AppData" / "Local" / "BlockFlow"
    return Path.home() / ".blockflow"


def ensure_directory(path: Path) -> Path:
    """Create path, replacing a dangling symlink with a real directory.

    Users can move output storage to external volumes. If that volume is
    later unmounted, the configured output directory may be a dangling
    symlink; Path.mkdir(exist_ok=True) raises FileExistsError in that case.
    """
    try:
        path.mkdir(parents=True, exist_ok=True)
    except FileExistsError:
        if path.is_symlink() and not path.exists():
            print(f"[config] {path} is a dangling symlink; replacing with a local directory")
            path.unlink()
            path.mkdir(parents=True, exist_ok=True)
        else:
            raise
    return path


# Files that lived under ROOT_DIR before sgs-ui-5ni and must follow the user
# across worktrees / checkouts. List comprehension keeps the migration loop
# below in lockstep with the path constants below.
_LEGACY_USER_FILES: tuple[str, ...] = (
    "prompt_library.json",
    "prompt_writer_settings.json",
    "job_history.json",
    "comfy_gen_info_cache.json",
    "run_history.db",
    "preset_manifest_cache.json",
    "preset_install.log",
)
_LEGACY_USER_DIRS: tuple[str, ...] = (
    "flows",
    "output",
)
_MIGRATION_BREADCRUMB = ".migrated_from_root"


def migrate_legacy_user_data(*, legacy_root: Path, user_data_dir: Path) -> None:
    """One-shot migration from the pre-sgs-ui-5ni layout. Idempotent via a
    breadcrumb file in the target dir.

    Safety rules:
      - Never clobber a target that already exists — the legacy file is left
        on disk so the user can reconcile manually.
      - The breadcrumb is written even when no legacy data was found, so
        we don't re-scan ROOT_DIR forever on every launch.
    """
    user_data_dir.mkdir(parents=True, exist_ok=True)
    breadcrumb = user_data_dir / _MIGRATION_BREADCRUMB
    if breadcrumb.exists():
        return

    for name in _LEGACY_USER_FILES:
        legacy = legacy_root / name
        current = user_data_dir / name
        if legacy.exists() and not current.exists():
            shutil.move(str(legacy), str(current))

    for name in _LEGACY_USER_DIRS:
        legacy = legacy_root / name
        current = user_data_dir / name
        if not legacy.is_dir():
            continue
        if not current.exists():
            shutil.move(str(legacy), str(current))
            continue
        # Target exists — merge legacy contents into it, never clobber.
        # Important: a stub target (created by config.py's import-time mkdir
        # plus subdirs added by custom_blocks on import) counts as "non-empty"
        # but holds no real user data. Merging item-by-item is the right
        # semantic: each legacy entry lands at target/<name> only when there's
        # no existing entry there, so real user data is preserved either way.
        for item in legacy.iterdir():
            target_item = current / item.name
            if target_item.exists():
                continue  # conflict — leave legacy item alone
            shutil.move(str(item), str(target_item))
        # Best-effort cleanup of the now-(probably-)empty legacy dir.
        try:
            legacy.rmdir()
        except OSError:
            pass  # legacy still has conflicts in it — leave for owner

    breadcrumb.write_text(
        "sgs-ui-5ni one-shot migration marker — delete to re-run migration.\n",
        encoding="utf-8",
    )


USER_DATA_DIR = resolve_user_data_dir()
ensure_directory(USER_DATA_DIR)
# Migration is NOT run at import time on purpose: pytest collection imports
# backend.config and would otherwise trigger the side-effecting move against
# the user's real ~/Library/Application Support/blockflow on first test run.
# main.py calls migrate_legacy_user_data(...) once at process startup.

LOCAL_OUTPUT_DIR = USER_DATA_DIR / "output"
ensure_directory(LOCAL_OUTPUT_DIR)


def resolve_local_output_dir(*, default: Path, store) -> Path:
    """sgs-ui-se7: honor the Settings → App tab `output_dir` pref so the
    user can park generated artifacts on a different volume (e.g. an
    external SSD) without symlinking.

    Returns the override only when it's an existing, writable directory.
    Anything else — unset, empty string, missing path, file at that path,
    read-only dir — silently falls back to the default and logs a warning.
    The store is duck-typed to avoid a circular import (settings_store
    imports config); callers pass `backend.settings_store` from main.py.
    """
    raw = store.get_app_pref("output_dir") if store is not None else None
    if not raw:
        return default
    override = Path(raw).expanduser()
    if not override.exists():
        print(f"[config] output_dir override {override} does not exist; using default")
        return default
    if not override.is_dir():
        print(f"[config] output_dir override {override} is not a directory; using default")
        return default
    if not os.access(override, os.W_OK):
        print(f"[config] output_dir override {override} is not writable; using default")
        return default
    return override


FLOWS_DIR = USER_DATA_DIR / "flows"
ensure_directory(FLOWS_DIR)
JOB_HISTORY_PATH = USER_DATA_DIR / "job_history.json"
PROMPT_WRITER_SETTINGS_PATH = USER_DATA_DIR / "prompt_writer_settings.json"
PROMPT_LIBRARY_PATH = USER_DATA_DIR / "prompt_library.json"
RUN_HISTORY_DB_PATH = USER_DATA_DIR / "run_history.db"
PRESET_MANIFEST_CACHE_PATH = USER_DATA_DIR / "preset_manifest_cache.json"
RUNTIME_MANIFEST_CACHE_PATH = USER_DATA_DIR / "runtime_manifest_cache.json"
PRESET_INSTALL_LOG_PATH = USER_DATA_DIR / "preset_install.log"


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = val


_load_env_file(ROOT_DIR / ".env")

RUNPOD_API_KEY = os.getenv("RUNPOD_API_KEY", "")
RUNPOD_ENDPOINT_ID = os.getenv("RUNPOD_ENDPOINT_ID", "")
RUNPOD_API_BASE = os.getenv("RUNPOD_API_BASE", "https://api.runpod.ai/v2")

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_API_BASE = os.getenv("OPENROUTER_API_BASE", "https://openrouter.ai/api/v1")
OPENROUTER_SITE_URL = os.getenv("OPENROUTER_SITE_URL", "").strip()
OPENROUTER_APP_NAME = os.getenv("OPENROUTER_APP_NAME", APP_TITLE).strip()
OPENROUTER_MODEL_CACHE_TTL_SEC = int(os.getenv("OPENROUTER_MODEL_CACHE_TTL_SEC", "300"))

DEFAULT_WRITER_SYSTEM_PROMPT = os.getenv("DEFAULT_WRITER_SYSTEM_PROMPT", """You are an expert Cinematic Prompt Engineer for high-end AI video generation. Your goal is to transform a vague user concept into a hyper-realistic, 8–10 second continuous cinematic shot portraying an intimate, adult moment in a woman's life.
1. Stylistic Translation
Translate user-defined directors, eras, or movements into concrete cinematic mechanics. Style must influence lens choice, lighting physics, color grading, camera behavior, environmental atmosphere, and emotional pacing. Do not reference style superficially — embody it through visual execution.
2. Continuous Single Shot
The video must be one uninterrupted take in a single location and timeframe. No cuts, no montage, no time jumps, no spatial transitions. The camera may evolve its movement but must remain physically continuous.
3. Controlled Escalation
Structure the shot with a subtle progression:
Opening beat (establishing mood and framing)
Middle beat (heightened intimacy or tension)
Final beat (shift, reveal, or unresolved stillness)
4. Movement & Action Rules
Allow 4–6 distinct physical actions maximum.
At least one action must involve interaction with the environment (fabric, furniture, light, smoke, surface tension, etc.).
Avoid chaotic choreography or rapid sequencing. Movement should feel deliberate and paced across the full 8–10 seconds.
5. Grounded Physicality
Focus on micro-textures, material tension, environmental reactions, and realistic body physics. Describe how light behaves, how fabric folds, how skin responds to heat or pressure. Avoid brand-heavy naming unless essential to the era.
6. Sensual Framing
Convey intimacy through composition, lighting, and proximity rather than graphic detail. Lean toward subtle explicitness (revealing, shifting fabric, breath, posture tension) without graphic acts.
7. Output Format
One dense paragraph
800–1200 characters
Plain text only
No metadata, no tags""")
DEFAULT_WRITER_MODEL = os.getenv("DEFAULT_WRITER_MODEL", "")
DEFAULT_WRITER_TEMPERATURE = float(os.getenv("DEFAULT_WRITER_TEMPERATURE", "0.6"))
DEFAULT_WRITER_MAX_TOKENS = int(os.getenv("DEFAULT_WRITER_MAX_TOKENS", "100000"))
PROMPT_WRITER_FANOUT_MAX_VARIANTS = int(os.getenv("PROMPT_WRITER_FANOUT_MAX_VARIANTS", "48"))
PROMPT_WRITER_FANOUT_MAX_PARALLEL = int(os.getenv("PROMPT_WRITER_FANOUT_MAX_PARALLEL", "4"))

DEFAULT_WIDTH = int(os.getenv("DEFAULT_WIDTH", "832"))
DEFAULT_HEIGHT = int(os.getenv("DEFAULT_HEIGHT", "480"))
DEFAULT_FRAMES = int(os.getenv("DEFAULT_FRAMES", "81"))
DEFAULT_FPS = int(os.getenv("DEFAULT_FPS", "16"))
DEFAULT_FIXED_SEED = int(os.getenv("DEFAULT_FIXED_SEED", "42"))
DEFAULT_NEGATIVE_PROMPT = os.getenv("DEFAULT_NEGATIVE_PROMPT", "")

# Named-LoRA defaults used by private blocks (generation, wan_22_image_to_video).
# Public OSS build defaults are empty; private deployments supply via env.
DEFAULT_NAMED_LORA = os.getenv("DEFAULT_NAMED_LORA", "")
DEFAULT_NAMED_LORA_BRANCH = os.getenv("DEFAULT_NAMED_LORA_BRANCH", "low")
DEFAULT_NAMED_LORA_STRENGTH = float(os.getenv("DEFAULT_NAMED_LORA_STRENGTH", "1.0"))

POLL_INTERVAL_SEC = float(os.getenv("RUNPOD_POLL_INTERVAL_SEC", "4"))
POLL_TIMEOUT_SEC = int(os.getenv("RUNPOD_POLL_TIMEOUT_SEC", "2400"))
HTTP_TIMEOUT_SEC = int(os.getenv("RUNPOD_HTTP_TIMEOUT_SEC", "60"))
MAX_PARALLEL_WORKERS = int(os.getenv("APP_MAX_PARALLEL_WORKERS", "6"))
MAX_PARALLEL_PER_REQUEST = int(os.getenv("APP_MAX_PARALLEL_PER_REQUEST", "6"))
MAX_INITIAL_JOBS = int(os.getenv("APP_MAX_INITIAL_JOBS", "200"))

LORA_SOURCE_SSH_TARGET = os.getenv("LORA_SOURCE_SSH_TARGET", "").strip()
LORA_SOURCE_SSH_KEY = os.path.expanduser(os.getenv("LORA_SOURCE_SSH_KEY", "~/.ssh/id_ed25519"))
LORA_SOURCE_HIGH_DIR = os.getenv("LORA_SOURCE_HIGH_DIR", "/workspace/loras/high")
LORA_SOURCE_LOW_DIR = os.getenv("LORA_SOURCE_LOW_DIR", "/workspace/loras/low")
LORA_SSH_CONNECT_TIMEOUT_SEC = int(os.getenv("LORA_SSH_CONNECT_TIMEOUT_SEC", "12"))
LORA_LIST_CACHE_TTL_SEC = int(os.getenv("LORA_LIST_CACHE_TTL_SEC", "30"))

Z_IMAGE_LORA_SOURCE_SSH_TARGET = os.getenv("Z_IMAGE_LORA_SOURCE_SSH_TARGET", LORA_SOURCE_SSH_TARGET).strip()
Z_IMAGE_LORA_SOURCE_SSH_KEY = os.path.expanduser(os.getenv("Z_IMAGE_LORA_SOURCE_SSH_KEY", LORA_SOURCE_SSH_KEY))
Z_IMAGE_LORA_SOURCE_DIR = os.getenv("Z_IMAGE_LORA_SOURCE_DIR", "/runpod-volume/loras/z-image")
Z_IMAGE_LORA_SSH_CONNECT_TIMEOUT_SEC = int(
    os.getenv("Z_IMAGE_LORA_SSH_CONNECT_TIMEOUT_SEC", str(LORA_SSH_CONNECT_TIMEOUT_SEC))
)
Z_IMAGE_LORA_LIST_CACHE_TTL_SEC = int(os.getenv("Z_IMAGE_LORA_LIST_CACHE_TTL_SEC", str(LORA_LIST_CACHE_TTL_SEC)))
QWEN_IMAGE_ALWAYS_ON_LORA = os.getenv("QWEN_IMAGE_ALWAYS_ON_LORA", "Qwen-Image-Lightning-8steps-V1.0.safetensors").strip()

COMFY_GEN_INFO_CACHE_PATH = USER_DATA_DIR / "comfy_gen_info_cache.json"

ADVANCED_MODE = os.getenv("SGS_ADVANCED", "").strip().lower() in ("1", "true", "yes")

CIVITAI_API_KEY = os.getenv("CIVITAI_API_KEY", "")
OUTPUT_DIR = LOCAL_OUTPUT_DIR

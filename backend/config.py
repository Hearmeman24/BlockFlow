from __future__ import annotations

import os
from pathlib import Path

APP_TITLE = "BlockFlow"
ROOT_DIR = Path(__file__).resolve().parent.parent
LOCAL_OUTPUT_DIR = ROOT_DIR / "output"
LOCAL_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
FLOWS_DIR = ROOT_DIR / "flows"
FLOWS_DIR.mkdir(parents=True, exist_ok=True)
JOB_HISTORY_PATH = ROOT_DIR / "job_history.json"
PROMPT_WRITER_SETTINGS_PATH = ROOT_DIR / "prompt_writer_settings.json"


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
PROMPT_WRITER_FANOUT_MAX_VARIANTS = int(os.getenv("PROMPT_WRITER_FANOUT_MAX_VARIANTS", "8"))
PROMPT_WRITER_FANOUT_MAX_PARALLEL = int(os.getenv("PROMPT_WRITER_FANOUT_MAX_PARALLEL", "4"))

DEFAULT_WIDTH = int(os.getenv("DEFAULT_WIDTH", "832"))
DEFAULT_HEIGHT = int(os.getenv("DEFAULT_HEIGHT", "480"))
DEFAULT_FRAMES = int(os.getenv("DEFAULT_FRAMES", "81"))
DEFAULT_FPS = int(os.getenv("DEFAULT_FPS", "16"))
DEFAULT_FIXED_SEED = int(os.getenv("DEFAULT_FIXED_SEED", "42"))
DEFAULT_NEGATIVE_PROMPT = os.getenv("DEFAULT_NEGATIVE_PROMPT", "")

DEFAULT_DANIELLA_LORA = os.getenv("DEFAULT_DANIELLA_LORA", "Daniella01_low_V2.safetensors")
DEFAULT_DANIELLA_BRANCH = os.getenv("DEFAULT_DANIELLA_BRANCH", "low")
DEFAULT_DANIELLA_STRENGTH = float(os.getenv("DEFAULT_DANIELLA_STRENGTH", "1.0"))

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

ADVANCED_MODE = os.getenv("SGS_ADVANCED", "").strip().lower() in ("1", "true", "yes")

CIVITAI_API_KEY = os.getenv("CIVITAI_API_KEY", "")
OUTPUT_DIR = LOCAL_OUTPUT_DIR

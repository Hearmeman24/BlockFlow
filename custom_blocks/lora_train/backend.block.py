"""LoRA Training block — RunPod AIO trainer (Wan 2.2 / Qwen / Z-Image).

Ports the dataset-zip -> S3 upload -> RunPod serverless submit + poll flow from
hearmemanai_lora_training_app_v2 into a self-contained sgs-ui block.

Jobs run in a background thread on the FastAPI process; their state is also
mirrored to disk so the UI can navigate away during the 30+ min training run
and reconnect via /status/{job_id}.
"""
from __future__ import annotations

import io
import json
import math
import logging
import re
import time
import threading
import urllib.error
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from backend import config

log = logging.getLogger(__name__)
router = APIRouter()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SUPPORTED_MODELS = ("wan2.2", "qwen_image", "z_image")
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
TARGET_PIXELS = 1_500_000  # 1.5MP — matches reference trainer

POLL_INTERVAL_SEC = 15
POLL_TIMEOUT_SEC = 7200  # 2h
HTTP_TIMEOUT_SEC = 60

LORA_JOBS_DIR = config.LOCAL_OUTPUT_DIR / "lora_jobs"
LORA_JOBS_DIR.mkdir(parents=True, exist_ok=True)
LORA_REGISTRY_PATH = config.LOCAL_OUTPUT_DIR / "lora_registry.json"

DATASETS_DIR = config.LOCAL_OUTPUT_DIR / "datasets"

# Resolve aux env vars (S3 + RunPod LoRA endpoint) lazily so config.py doesn't
# have to know about every block sidecar.
import os

def _env(*keys: str, default: str = "") -> str:
    for k in keys:
        v = os.getenv(k)
        if v:
            return v
    return default


RUNPOD_LORA_ENDPOINT_ID = _env("RUNPOD_LORA_ENDPOINT_ID", default="7cimkii50xunxw")
AWS_ACCESS_KEY_ID = _env("AWS_ACCESS_KEY_ID")
AWS_SECRET_ACCESS_KEY = _env("AWS_SECRET_ACCESS_KEY")
# Reference uses AWS_REGION; sgs-ui's existing .env uses S3_REGION. Accept both.
AWS_REGION = _env("AWS_REGION", "S3_REGION", default="us-east-1")
S3_BUCKET = _env("S3_BUCKET_NAME", "S3_BUCKET", default="hearmeman-loras")


# ---------------------------------------------------------------------------
# Per-model defaults (mirrors reference defaults)
# ---------------------------------------------------------------------------

MODEL_DEFAULTS: dict[str, dict[str, Any]] = {
    "wan2.2": {
        "epochs": 80,
        "rank": 32,
        "lr": 2e-5,
        "save_every_n_epochs": 10,
    },
    "qwen_image": {
        "epochs": 80,
        "rank": 32,
        "lr": 2e-4,
        "save_every_n_epochs": 20,
    },
    "z_image": {
        "epochs": 80,
        "rank": 32,
        "lr": 2e-4,
        "save_every_n_epochs": 10,
    },
}


def _build_config_overrides(model_type: str, overrides: dict[str, Any]) -> dict[str, Any]:
    """Map flat UI overrides to the trainer's dot-notation config keys.

    Only emit a key if the user actually changed it from the default
    (matches the reference's behavior in LoraTrainingPage.tsx:119-146).
    """
    if model_type not in MODEL_DEFAULTS:
        return {}
    defaults = MODEL_DEFAULTS[model_type]
    out: dict[str, Any] = {}
    def add(key: str, override_key: str, cast):
        if override_key in overrides:
            try:
                v = cast(overrides[override_key])
            except Exception:
                return
            if v != defaults.get(key.split(".")[-1]) and v != defaults.get(key):
                out[key] = v
    add("epochs", "epochs", int)
    add("adapter.rank", "rank", int)
    add("optimizer.lr", "lr", float)
    add("save_every_n_epochs", "save_every_n_epochs", int)
    if "num_repeats" in overrides and overrides["num_repeats"]:
        try:
            out["dataset.num_repeats"] = int(overrides["num_repeats"])
        except Exception:
            pass
    return out


# ---------------------------------------------------------------------------
# Dataset preparation
# ---------------------------------------------------------------------------


def _resize_image(img, target_pixels: int = TARGET_PIXELS):
    from PIL import Image  # noqa
    w, h = img.size
    if w * h <= target_pixels:
        return img
    scale = math.sqrt(target_pixels / (w * h))
    return img.resize((round(w * scale), round(h * scale)), Image.Resampling.LANCZOS)


def _image_to_bytes(img, original_suffix: str) -> tuple[bytes, str]:
    from PIL import Image  # noqa
    buf = io.BytesIO()
    if original_suffix.lower() == ".png":
        img.save(buf, format="PNG", optimize=True)
        return buf.getvalue(), ".png"
    if img.mode in ("RGBA", "P", "LA"):
        img = img.convert("RGB")
    img.save(buf, format="JPEG", quality=98, subsampling=0)
    return buf.getvalue(), ".jpg"


def _create_dataset_zip(
    dataset_dir: Path,
    output_zip: Path,
    trigger_word: str,
    auto_caption: bool,
) -> tuple[int, int]:
    """Zip up images (resized to 1.5MP) + .txt captions.

    Returns (image_count, caption_count). When `auto_caption` is True and a
    given image has no matching .txt, the trigger word is written as the
    caption — minimal but valid for LoRA character training.
    """
    from PIL import Image  # noqa
    images = 0
    captions = 0
    with zipfile.ZipFile(output_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        # Pre-index captions
        caption_files: dict[str, Path] = {}
        for p in dataset_dir.iterdir():
            if p.is_file() and p.suffix.lower() == ".txt":
                caption_files[p.stem] = p

        for p in sorted(dataset_dir.iterdir()):
            if not p.is_file() or p.name.startswith("."):
                continue
            if p.name.lower() in {"reference.png", "reference_image.png", "reference_image.jpg", "reference_image.jpeg", "manifest.json", "prompts.json"}:
                continue
            if p.suffix.lower() in IMAGE_EXTS:
                img = Image.open(p)
                img = _resize_image(img)
                img_bytes, new_ext = _image_to_bytes(img, p.suffix)
                arc_stem = p.stem
                zf.writestr(arc_stem + new_ext, img_bytes)
                images += 1
                # Companion caption: existing .txt or auto-generated
                cap_path = caption_files.get(arc_stem)
                if cap_path is not None:
                    zf.write(cap_path, arc_stem + ".txt")
                    captions += 1
                elif auto_caption:
                    zf.writestr(arc_stem + ".txt", trigger_word + "\n")
                    captions += 1
    return images, captions


# ---------------------------------------------------------------------------
# S3 upload
# ---------------------------------------------------------------------------


def _upload_zip_to_s3(zip_path: Path, dataset_name: str) -> str:
    if not (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY):
        raise RuntimeError("AWS credentials missing — set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in .env")
    import boto3
    client = boto3.client(
        "s3",
        aws_access_key_id=AWS_ACCESS_KEY_ID,
        aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
        region_name=AWS_REGION,
    )
    key = f"training-datasets/{re.sub(r'[^a-zA-Z0-9_-]', '-', dataset_name)}_{uuid.uuid4().hex[:8]}.zip"
    body = zip_path.read_bytes()
    client.put_object(Bucket=S3_BUCKET, Key=key, Body=body, ContentType="application/zip")
    url = client.generate_presigned_url(
        "get_object",
        Params={"Bucket": S3_BUCKET, "Key": key},
        ExpiresIn=7 * 24 * 60 * 60,  # 7 days
    )
    return url


# ---------------------------------------------------------------------------
# RunPod
# ---------------------------------------------------------------------------


def _runpod_submit(api_key: str, payload: dict[str, Any]) -> str:
    url = f"{config.RUNPOD_API_BASE.rstrip('/')}/{RUNPOD_LORA_ENDPOINT_ID}/run"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    rid = data.get("id") or data.get("job_id")
    if not rid:
        raise RuntimeError(f"RunPod /run returned no id: {data}")
    return str(rid)


def _runpod_status(api_key: str, runpod_job_id: str) -> dict[str, Any]:
    url = f"{config.RUNPOD_API_BASE.rstrip('/')}/{RUNPOD_LORA_ENDPOINT_ID}/status/{runpod_job_id}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _runpod_cancel(api_key: str, runpod_job_id: str) -> None:
    url = f"{config.RUNPOD_API_BASE.rstrip('/')}/{RUNPOD_LORA_ENDPOINT_ID}/cancel/{runpod_job_id}"
    req = urllib.request.Request(url, method="POST", headers={"Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as _:
            return
    except Exception as exc:
        log.warning("[lora_train] remote cancel %s failed: %s", runpod_job_id, exc)


def _extract_progress(output: Any) -> str:
    if isinstance(output, str):
        return output.strip()
    if isinstance(output, dict):
        for k in ("status", "message", "progress", "stage"):
            v = output.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
        pct = output.get("percent")
        if pct is not None:
            return f"{pct}%"
    return ""


_EPOCH_PAT = re.compile(r"epoch\s*[:=]?\s*(\d+)\s*/\s*(\d+)", re.IGNORECASE)
_STEP_PAT = re.compile(r"step\s*[:=]?\s*(\d+)\s*/\s*(\d+)", re.IGNORECASE)


def _parse_epoch_step(text: str) -> tuple[int | None, int | None, int | None, int | None]:
    e_done = e_total = s_done = s_total = None
    m = _EPOCH_PAT.search(text)
    if m:
        e_done, e_total = int(m.group(1)), int(m.group(2))
    m = _STEP_PAT.search(text)
    if m:
        s_done, s_total = int(m.group(1)), int(m.group(2))
    return e_done, e_total, s_done, s_total


def _extract_results(output: Any) -> list[dict[str, str]]:
    """Pull a list of {filename, url, noise_variant} from a completed output dict.

    Accepts both `output_files` + `presigned_urls` (preferred) and a bare
    `presigned_urls` array (fallback). Some trainers nest the output one level
    deeper in `output.output`.
    """
    if not isinstance(output, dict):
        return []
    inner = output.get("output") if isinstance(output.get("output"), dict) else output
    files = inner.get("output_files") if isinstance(inner, dict) else None
    urls = inner.get("presigned_urls") if isinstance(inner, dict) else None
    results: list[dict[str, str]] = []
    if isinstance(files, list) and files:
        for i, entry in enumerate(files):
            if not isinstance(entry, dict):
                continue
            filename = str(entry.get("filename") or "")
            noise_variant = str(entry.get("noise_variant") or "")
            url = ""
            if isinstance(urls, list) and i < len(urls) and isinstance(urls[i], str):
                url = urls[i]
            if not url:
                url = str(entry.get("url") or "")
            if filename:
                results.append({"filename": filename, "url": url, "noise_variant": noise_variant})
        if results:
            return results
    if isinstance(urls, list):
        for url in urls:
            if isinstance(url, str) and url:
                fn = url.split("/")[-1].split("?")[0] or "lora.safetensors"
                results.append({"filename": fn, "url": url, "noise_variant": ""})
    return results


# ---------------------------------------------------------------------------
# Job state — in-memory + disk mirror
# ---------------------------------------------------------------------------

JOBS_LOCK = threading.Lock()
JOBS: dict[str, dict[str, Any]] = {}


def _job_path(job_id: str) -> Path:
    return LORA_JOBS_DIR / f"{job_id}.json"


def _persist(job_id: str) -> None:
    with JOBS_LOCK:
        rec = JOBS.get(job_id)
        if rec is None:
            return
        snap = {k: v for k, v in rec.items() if k != "_thread"}
    try:
        _job_path(job_id).write_text(json.dumps(snap, indent=2, default=str), encoding="utf-8")
    except Exception as exc:
        log.warning("[lora_train] persist %s failed: %s", job_id, exc)


def _append_log(job_id: str, line: str, *, also_print: bool = True) -> None:
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    entry = f"[{ts}] {line}"
    with JOBS_LOCK:
        rec = JOBS.get(job_id)
        if rec is None:
            return
        logs: list[str] = rec.setdefault("logs", [])
        logs.append(entry)
        # cap at last 500 lines to keep memory bounded
        if len(logs) > 500:
            del logs[: len(logs) - 500]
        rec["last_log_at"] = time.time()
    if also_print:
        print(f"[lora_train {job_id[:8]}] {line}", flush=True)
    _persist(job_id)


def _set(job_id: str, **fields: Any) -> None:
    with JOBS_LOCK:
        rec = JOBS.get(job_id)
        if rec is None:
            return
        rec.update(fields)
    _persist(job_id)


def _load_disk_jobs() -> None:
    """Re-hydrate in-memory job records from disk on startup."""
    if not LORA_JOBS_DIR.exists():
        return
    for p in sorted(LORA_JOBS_DIR.glob("*.json")):
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(rec, dict) and rec.get("job_id"):
                # Anything left RUNNING on disk after a restart we mark as
                # ORPHANED — the polling thread is gone. The user can re-submit.
                if rec.get("status") == "RUNNING":
                    rec["status"] = "ORPHANED"
                    rec["error"] = (rec.get("error") or "") + " (backend restarted mid-run)"
                JOBS[rec["job_id"]] = rec
        except Exception as exc:
            log.warning("[lora_train] failed to load %s: %s", p.name, exc)


_load_disk_jobs()


def _registry_append(entry: dict[str, Any]) -> None:
    try:
        data = []
        if LORA_REGISTRY_PATH.exists():
            data = json.loads(LORA_REGISTRY_PATH.read_text(encoding="utf-8"))
            if not isinstance(data, list):
                data = []
        data.insert(0, entry)
        LORA_REGISTRY_PATH.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
    except Exception as exc:
        log.warning("[lora_train] registry append failed: %s", exc)


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------


def _run_training(job_id: str, api_key: str, dataset_dir: Path, trigger_word: str,
                  model_type: str, config_overrides: dict[str, Any],
                  dataset_name: str, auto_caption: bool) -> None:
    started = time.time()
    tmp_zip: Path | None = None
    try:
        _append_log(job_id, f"Preparing dataset '{dataset_name}' for model={model_type}")
        tmp_zip = LORA_JOBS_DIR / f"{job_id}_dataset.zip"
        n_img, n_cap = _create_dataset_zip(dataset_dir, tmp_zip, trigger_word, auto_caption)
        _append_log(job_id, f"Zipped {n_img} images ({n_cap} captions, auto={auto_caption})")
        if n_img == 0:
            raise RuntimeError("Dataset has no images")

        _append_log(job_id, f"Uploading {tmp_zip.stat().st_size // 1024} KB to s3://{S3_BUCKET}/training-datasets/")
        dataset_url = _upload_zip_to_s3(tmp_zip, dataset_name)
        _set(job_id, dataset_zip_url=dataset_url)
        _append_log(job_id, "Dataset uploaded; submitting RunPod job")

        payload = {
            "input": {
                "model_type": model_type,
                "dataset_zip_url": dataset_url,
                "trigger_word": trigger_word,
            }
        }
        if config_overrides:
            payload["input"]["config_overrides"] = config_overrides

        remote_id = _runpod_submit(api_key, payload)
        _set(job_id, remote_job_id=remote_id)
        _append_log(job_id, f"RunPod job submitted: {remote_id}")

        # Poll loop
        deadline = started + POLL_TIMEOUT_SEC
        while True:
            with JOBS_LOCK:
                if JOBS.get(job_id, {}).get("cancel_requested"):
                    _runpod_cancel(api_key, remote_id)
                    _set(job_id, status="CANCELLED", ended_at=time.time())
                    _append_log(job_id, "Cancelled by user")
                    return
            if time.time() > deadline:
                _runpod_cancel(api_key, remote_id)
                raise TimeoutError(f"Training exceeded {POLL_TIMEOUT_SEC}s")

            try:
                data = _runpod_status(api_key, remote_id)
            except Exception as exc:
                _append_log(job_id, f"poll error (will retry): {exc}")
                time.sleep(POLL_INTERVAL_SEC)
                continue

            status_str = str(data.get("status") or "UNKNOWN").upper()
            output = data.get("output")
            msg = _extract_progress(output) or status_str

            # The reference trainer emits a structured progress dict —
            # {epoch, total_epochs, step, total_steps, percent, stage, loss}.
            # Prefer those fields over regex-parsing the message string.
            fields: dict[str, Any] = {"last_progress": msg, "remote_status": status_str}
            if isinstance(output, dict):
                def _as_int(v: Any) -> int | None:
                    try: return int(v)
                    except (TypeError, ValueError): return None
                def _as_float(v: Any) -> float | None:
                    try: return float(v)
                    except (TypeError, ValueError): return None
                v = _as_int(output.get("epoch"));          v is not None and fields.update(epoch_done=v)
                v = _as_int(output.get("total_epochs"));   v is not None and fields.update(epoch_total=v)
                v = _as_int(output.get("step"));           v is not None and fields.update(step_done=v)
                v = _as_int(output.get("total_steps"));    v is not None and fields.update(step_total=v)
                v = _as_float(output.get("percent"));      v is not None and fields.update(percent=v)
                v = _as_float(output.get("loss"));         v is not None and fields.update(loss=v)
                stage = output.get("stage")
                if isinstance(stage, str): fields["stage"] = stage
                # Accumulate (step, loss) series for the live sparkline.
                loss_val = _as_float(output.get("loss"))
                step_val = _as_int(output.get("step"))
                if loss_val is not None and step_val is not None:
                    with JOBS_LOCK:
                        rec = JOBS.get(job_id)
                        if rec is not None:
                            series: list[dict[str, float]] = rec.setdefault("loss_series", [])
                            if not series or series[-1].get("step") != step_val:
                                series.append({"step": step_val, "loss": loss_val})
                                # cap memory — keep last 1000 points
                                if len(series) > 1000:
                                    del series[: len(series) - 1000]
            # Fall back to regex on the textual message if the structured
            # fields weren't provided (e.g. an older trainer build).
            if "epoch_done" not in fields or "epoch_total" not in fields:
                e_done, e_total, s_done, s_total = _parse_epoch_step(msg)
                if e_done is not None and "epoch_done" not in fields: fields["epoch_done"] = e_done
                if e_total is not None and "epoch_total" not in fields: fields["epoch_total"] = e_total
                if s_done is not None and "step_done" not in fields: fields["step_done"] = s_done
                if s_total is not None and "step_total" not in fields: fields["step_total"] = s_total

            with JOBS_LOCK:
                rec = JOBS.get(job_id)
                if rec is None:
                    return
                last_progress = rec.get("last_progress")
            if msg != last_progress:
                _append_log(job_id, f"[{status_str}] {msg}")
            _set(job_id, **fields)

            if status_str == "COMPLETED":
                results = _extract_results(output)
                _set(job_id, status="COMPLETED", results=results, ended_at=time.time())
                _append_log(job_id, f"Training completed — {len(results)} LoRA file(s)")
                _registry_append({
                    "job_id": job_id,
                    "model_type": model_type,
                    "trigger_word": trigger_word,
                    "dataset_id": dataset_name,
                    "remote_job_id": remote_id,
                    "files": results,
                    "trained_at": datetime.now(timezone.utc).isoformat(),
                })
                return
            if status_str in ("FAILED", "CANCELLED", "TIMED_OUT"):
                # RunPod can stash the real failure in three places:
                #   - top-level `error` (most trainer crashes land here)
                #   - output.error / output.message (structured handler errors)
                #   - output as a bare string
                err = str(data.get("error") or "").strip()
                if not err:
                    if isinstance(output, dict):
                        err = str(output.get("error") or output.get("message") or "")
                    elif isinstance(output, str):
                        err = output
                _set(job_id, status="FAILED", error=err or status_str, ended_at=time.time())
                _append_log(job_id, f"Training {status_str}: {err[:400]}")
                return

            time.sleep(POLL_INTERVAL_SEC)

    except Exception as exc:
        log.exception("[lora_train] job %s crashed", job_id)
        _set(job_id, status="FAILED", error=str(exc), ended_at=time.time())
        _append_log(job_id, f"Crashed: {exc}")
    finally:
        if tmp_zip is not None and tmp_zip.exists():
            try:
                tmp_zip.unlink()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Dataset resolution
# ---------------------------------------------------------------------------


def _resolve_dataset_dir(spec: dict[str, Any] | None, folder_id: str | None) -> tuple[Path, str]:
    """Return (path, friendly_name) for the dataset to train on.

    Accepts either a `DatasetValue`-shaped dict (with `images: [/outputs/datasets/<folder>/img_001.png, ...]`)
    or an explicit folder name under `output/datasets/`.
    """
    if spec and isinstance(spec, dict):
        images = spec.get("images") or []
        if isinstance(images, list) and images:
            first = images[0]
            if isinstance(first, str) and first.startswith("/outputs/datasets/"):
                folder = first[len("/outputs/datasets/"):].split("/", 1)[0]
                p = DATASETS_DIR / folder
                if p.is_dir():
                    return p, str(spec.get("name") or folder)
    if folder_id:
        safe = re.sub(r"[^a-zA-Z0-9_.-]", "", folder_id)
        p = DATASETS_DIR / safe
        if p.is_dir():
            return p, safe
    raise ValueError(
        "No dataset selected. Connect a Dataset Create block upstream, or pick an existing dataset folder."
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/health")
def health() -> JSONResponse:
    return JSONResponse({
        "ok": True,
        "runpod_key_present": bool(config.RUNPOD_API_KEY),
        "aws_creds_present": bool(AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY),
        "s3_bucket": S3_BUCKET,
        "lora_endpoint_id": RUNPOD_LORA_ENDPOINT_ID,
        "supported_models": list(SUPPORTED_MODELS),
        "model_defaults": MODEL_DEFAULTS,
    })


@router.get("/datasets")
def list_datasets() -> JSONResponse:
    """List on-disk datasets under output/datasets/ for the internal selector."""
    out: list[dict[str, Any]] = []
    if DATASETS_DIR.exists():
        for folder in sorted(DATASETS_DIR.iterdir()):
            if not folder.is_dir():
                continue
            imgs = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS)
            captions = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() == ".txt"]
            thumb_urls = [f"/outputs/datasets/{folder.name}/{p.name}" for p in imgs[:4]]
            out.append({
                "id": folder.name,
                "name": folder.name,
                "image_count": len(imgs),
                "caption_count": len(captions),
                "thumb_url": thumb_urls[0] if thumb_urls else None,
                "thumb_urls": thumb_urls,
            })
    return JSONResponse({"ok": True, "datasets": out})


@router.post("/run")
async def run(request: Request) -> JSONResponse:
    body = await request.json()
    model_type = str(body.get("model_type") or "").strip()
    trigger_word = str(body.get("trigger_word") or "").strip()
    overrides = body.get("overrides") or {}
    dataset_spec = body.get("dataset") if isinstance(body.get("dataset"), dict) else None
    dataset_folder = body.get("dataset_folder")
    auto_caption = bool(body.get("auto_caption", True))

    if model_type not in SUPPORTED_MODELS:
        return JSONResponse({"ok": False, "error": f"model_type must be one of {list(SUPPORTED_MODELS)}"}, status_code=400)
    if not trigger_word:
        return JSONResponse({"ok": False, "error": "trigger_word is required"}, status_code=400)
    if not config.RUNPOD_API_KEY:
        return JSONResponse({"ok": False, "error": "RUNPOD_API_KEY not set"}, status_code=400)
    if not (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY):
        return JSONResponse({"ok": False, "error": "AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY required for S3 upload"}, status_code=400)

    try:
        dataset_dir, dataset_name = _resolve_dataset_dir(dataset_spec, dataset_folder)
    except ValueError as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

    cfg = _build_config_overrides(model_type, overrides if isinstance(overrides, dict) else {})

    job_id = uuid.uuid4().hex
    rec = {
        "job_id": job_id,
        "model_type": model_type,
        "trigger_word": trigger_word,
        "dataset_name": dataset_name,
        "dataset_path": str(dataset_dir),
        "status": "RUNNING",
        "logs": [],
        "results": [],
        "epoch_done": None,
        "epoch_total": int(overrides.get("epochs") or MODEL_DEFAULTS[model_type]["epochs"]),
        "step_done": None,
        "step_total": None,
        "loss_series": [],
        "started_at": time.time(),
        "ended_at": None,
        "error": "",
        "cancel_requested": False,
        "remote_job_id": "",
        "dataset_zip_url": "",
        "config_overrides": cfg,
        "auto_caption": auto_caption,
    }
    with JOBS_LOCK:
        JOBS[job_id] = rec
    _persist(job_id)
    _append_log(job_id, f"Created training job for model={model_type} trigger='{trigger_word}'")

    t = threading.Thread(
        target=_run_training,
        args=(job_id, config.RUNPOD_API_KEY, dataset_dir, trigger_word, model_type, cfg, dataset_name, auto_caption),
        daemon=True,
    )
    t.start()
    with JOBS_LOCK:
        JOBS[job_id]["_thread"] = t

    return JSONResponse({"ok": True, "job_id": job_id})


@router.get("/status/{job_id}")
def status(job_id: str) -> JSONResponse:
    with JOBS_LOCK:
        rec = JOBS.get(job_id)
        if not rec:
            return JSONResponse({"ok": False, "error": "job not found"}, status_code=404)
        snap = {k: v for k, v in rec.items() if k != "_thread"}
    return JSONResponse({"ok": True, "job": snap})


@router.post("/cancel/{job_id}")
def cancel(job_id: str) -> JSONResponse:
    with JOBS_LOCK:
        rec = JOBS.get(job_id)
        if not rec:
            return JSONResponse({"ok": False, "error": "job not found"}, status_code=404)
        rec["cancel_requested"] = True
    return JSONResponse({"ok": True})


@router.get("/jobs")
def list_jobs() -> JSONResponse:
    with JOBS_LOCK:
        snap = [
            {k: v for k, v in rec.items() if k not in ("_thread", "logs")}
            for rec in JOBS.values()
        ]
    snap.sort(key=lambda r: r.get("started_at") or 0, reverse=True)
    return JSONResponse({"ok": True, "jobs": snap})


# ---------------------------------------------------------------------------
# ComfyGen upload — push a completed LoRA to a ComfyGen serverless endpoint
# so it becomes available on that endpoint's network volume.
# ---------------------------------------------------------------------------


def _comfygen_default_endpoint() -> str:
    """The endpoint id the comfy_gen block defaults to (RUNPOD_ENDPOINT_ID)."""
    return (os.getenv("RUNPOD_ENDPOINT_ID", "") or config.RUNPOD_ENDPOINT_ID or "").strip()


@router.get("/comfygen-config")
def comfygen_config() -> JSONResponse:
    return JSONResponse({
        "ok": True,
        "default_endpoint_id": _comfygen_default_endpoint(),
        "runpod_key_present": bool(config.RUNPOD_API_KEY),
    })


@router.post("/upload-to-comfygen/{job_id}")
async def upload_to_comfygen(job_id: str, request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    endpoint_id = (str(body.get("endpoint_id") or "").strip()) or _comfygen_default_endpoint()
    dest = str(body.get("dest") or "loras").strip() or "loras"

    if not endpoint_id:
        return JSONResponse({"ok": False, "error": "endpoint_id required (param or RUNPOD_ENDPOINT_ID env)"}, status_code=400)
    if not config.RUNPOD_API_KEY:
        return JSONResponse({"ok": False, "error": "RUNPOD_API_KEY not set"}, status_code=400)

    with JOBS_LOCK:
        rec = JOBS.get(job_id)
    if not rec:
        return JSONResponse({"ok": False, "error": "training job not found"}, status_code=404)
    if rec.get("status") != "COMPLETED":
        return JSONResponse({"ok": False, "error": f"training job status is {rec.get('status')}, must be COMPLETED"}, status_code=400)

    results = rec.get("results") or []
    files_total = sum(1 for r in results if r.get("filename"))
    downloads = [
        {"source": "url", "url": r.get("url"), "dest": dest, "filename": r.get("filename")}
        for r in results
        if r.get("url") and r.get("filename")
    ]
    if not downloads:
        if files_total > 0:
            return JSONResponse({
                "ok": False,
                "error": (
                    f"Trainer produced {files_total} file(s) but no S3 URLs "
                    "(presigned_urls was empty). The RunPod LoRA endpoint worker is "
                    "missing AWS S3 credentials in its environment — set "
                    "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET and "
                    "S3_REGION on the RunPod endpoint so the trainer can upload "
                    "outputs. Without that the LoRA only exists on the trainer "
                    "worker's local volume and ComfyGen can't fetch it."
                ),
            }, status_code=400)
        return JSONResponse({"ok": False, "error": "no LoRA files available to upload"}, status_code=400)

    url = f"{config.RUNPOD_API_BASE.rstrip('/')}/{endpoint_id}/run"
    payload = {"input": {"command": "download", "downloads": downloads}}
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config.RUNPOD_API_KEY}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode(errors="replace")[:600]
        return JSONResponse({"ok": False, "error": f"ComfyGen endpoint HTTP {e.code}: {body_text}"}, status_code=502)
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"failed to reach ComfyGen endpoint: {e}"}, status_code=502)

    remote_id = str(data.get("id") or data.get("job_id") or "").strip()
    if not remote_id:
        return JSONResponse({"ok": False, "error": f"ComfyGen returned no job id: {data}"}, status_code=502)

    upload_rec = {
        "endpoint_id": endpoint_id,
        "dest": dest,
        "remote_job_id": remote_id,
        "downloads": downloads,
        "submitted_at": time.time(),
        "status": "RUNNING",
        "last_status": "IN_QUEUE",
    }
    _set(job_id, comfygen_upload=upload_rec)
    _append_log(job_id, f"Submitted ComfyGen upload to endpoint={endpoint_id} ({len(downloads)} file(s)): {remote_id}")
    return JSONResponse({"ok": True, "remote_job_id": remote_id, "endpoint_id": endpoint_id, "files": len(downloads)})


@router.get("/upload-status/{job_id}")
def upload_status(job_id: str) -> JSONResponse:
    with JOBS_LOCK:
        rec = JOBS.get(job_id)
    if not rec:
        return JSONResponse({"ok": False, "error": "training job not found"}, status_code=404)
    upload = rec.get("comfygen_upload")
    if not upload:
        return JSONResponse({"ok": False, "error": "no ComfyGen upload submitted for this job"}, status_code=404)

    endpoint_id = upload["endpoint_id"]
    remote_id = upload["remote_job_id"]
    # Don't re-poll a terminal status.
    if upload.get("status") in ("COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"):
        return JSONResponse({"ok": True, "upload": upload})

    url = f"{config.RUNPOD_API_BASE.rstrip('/')}/{endpoint_id}/status/{remote_id}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {config.RUNPOD_API_KEY}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        upload["poll_error"] = str(e)
        return JSONResponse({"ok": True, "upload": upload})

    status_str = str(data.get("status") or "UNKNOWN").upper()
    upload["last_status"] = status_str
    out = data.get("output")
    if isinstance(out, dict):
        upload["last_message"] = (
            out.get("message") or out.get("status") or out.get("progress") or ""
        )
        # When the ComfyGen worker reports per-file results, surface them.
        files_out = out.get("files") or out.get("downloaded") or []
        if isinstance(files_out, list) and files_out:
            upload["completed_files"] = files_out
    elif isinstance(out, str):
        upload["last_message"] = out
    if status_str in ("COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"):
        upload["status"] = status_str
        upload["ended_at"] = time.time()
        if status_str == "FAILED":
            err = ""
            if isinstance(out, dict):
                err = str(out.get("error") or out.get("message") or "")
            elif isinstance(out, str):
                err = out
            upload["error"] = str(data.get("error") or err or status_str)
    _set(job_id, comfygen_upload=upload)
    return JSONResponse({"ok": True, "upload": upload})


@router.get("/registry")
def registry() -> JSONResponse:
    """Local registry of completed training runs."""
    if not LORA_REGISTRY_PATH.exists():
        return JSONResponse({"ok": True, "loras": []})
    try:
        data = json.loads(LORA_REGISTRY_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            data = []
    except Exception as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=500)
    return JSONResponse({"ok": True, "loras": data})

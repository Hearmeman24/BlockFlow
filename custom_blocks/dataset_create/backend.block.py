from __future__ import annotations

import asyncio
import json
import random
import re
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from backend import config

router = APIRouter()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

NANO_BANANA_ENDPOINT = "google-nano-banana-2-edit"
DEFAULT_CONCURRENCY = 10
DEFAULT_TIMEOUT_SEC = 900
POLL_INITIAL_SEC = 2.0
POLL_MAX_SEC = 10.0
POLL_BACKOFF = 1.4
MAX_REFERENCE_IMAGES = 14

DATASETS_DIR = config.LOCAL_OUTPUT_DIR / "datasets"
DATASETS_DIR.mkdir(parents=True, exist_ok=True)

PROMPT_PACKS_DIR = config.ROOT_DIR / "prompt_packs"

ALLOWED_QUALITY = {"1k", "2k", "4k"}
ALLOWED_ASPECT = {"1:1", "9:16", "16:9", "4:3", "3:4", "3:2", "2:3"}

# ---------------------------------------------------------------------------
# Prompt-pack registry (one JSON per pack under prompt_packs/)
# ---------------------------------------------------------------------------


def _load_pack(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"[dataset_create] skipping invalid pack {path.name}: {exc}", flush=True)
        return None
    if not isinstance(data, dict):
        return None
    pid = str(data.get("id") or path.stem).strip()
    prompts = data.get("prompts") or []
    if not isinstance(prompts, list):
        prompts = []
    prompts = [str(p) for p in prompts if isinstance(p, str) and p.strip()]
    return {
        "id": pid,
        "title": str(data.get("title") or pid),
        "description": str(data.get("description") or ""),
        "category": str(data.get("category") or "scene"),
        "mode": str(data.get("mode") or "random"),
        "tags": [str(t) for t in (data.get("tags") or []) if isinstance(t, str)],
        "prompt_count": len(prompts),
        "prompts": prompts,
    }


def _list_packs(include_prompts: bool = False) -> list[dict[str, Any]]:
    if not PROMPT_PACKS_DIR.exists():
        return []
    packs: list[dict[str, Any]] = []
    for path in sorted(PROMPT_PACKS_DIR.glob("*.json")):
        pack = _load_pack(path)
        if pack is None:
            continue
        if not include_prompts:
            pack = {k: v for k, v in pack.items() if k != "prompts"}
        packs.append(pack)
    return packs


# ---------------------------------------------------------------------------
# Job state (in-memory only — datasets are persisted to disk on completion)
# ---------------------------------------------------------------------------

JOBS_LOCK = Lock()
JOBS: dict[str, dict[str, Any]] = {}


def _slugify(name: str) -> str:
    base = re.sub(r"[^a-zA-Z0-9_-]+", "-", name.strip()).strip("-")
    return base.lower() or "dataset"


def _new_job_record(name: str, total: int, manifest_seed: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    job_id = uuid.uuid4().hex
    record: dict[str, Any] = {
        "job_id": job_id,
        "status": "RUNNING",  # RUNNING | COMPLETED | FAILED | CANCELLED | PARTIAL
        "name": name,
        "total": total,
        "completed": 0,
        "failed": 0,
        "failed_indices": [],
        "partial_images": [],          # ordered, slot=index -> {url|null, prompt, aspect_ratio}
        "remote_job_ids": {},          # index -> runpod job id
        "started_at": time.time(),
        "ended_at": None,
        "error": "",
        "dataset": None,               # populated when COMPLETED / PARTIAL
        "manifest_seed": manifest_seed,
        "cancel_requested": False,
        "dataset_dir": "",
    }
    with JOBS_LOCK:
        JOBS[job_id] = record
    return job_id, record


def _job_snapshot(job_id: str) -> dict[str, Any] | None:
    with JOBS_LOCK:
        rec = JOBS.get(job_id)
        if not rec:
            return None
        # Shallow copy with derived fields
        snap = {k: v for k, v in rec.items() if k not in ("manifest_seed",)}
        # Only expose the count of partials, not the (large) prompt strings, for the snapshot
        snap["partial_images"] = list(rec["partial_images"])
        return snap


# ---------------------------------------------------------------------------
# RunPod calls
# ---------------------------------------------------------------------------


def _build_aspect_for_index(aspect_ratios: list[str], idx: int) -> str:
    if not aspect_ratios:
        return "1:1"
    return aspect_ratios[idx % len(aspect_ratios)]


async def _submit_runpod_job(
    api_key: str,
    prompt: str,
    aspect_ratio: str,
    quality: str,
    references: list[str],
) -> str:
    """POST /run and return the remote job id."""
    url = f"{config.RUNPOD_API_BASE.rstrip('/')}/{NANO_BANANA_ENDPOINT}/run"
    payload = {
        "input": {
            "prompt": prompt,
            "images": references,
            "resolution": quality,
            "aspect_ratio": aspect_ratio,
            "enable_safety_checker": False,
        }
    }
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

    def _send() -> dict[str, Any]:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))

    data = await asyncio.to_thread(_send)
    remote_id = data.get("id") or data.get("job_id") or ""
    if not remote_id:
        raise RuntimeError(f"RunPod /run returned no id: {data}")
    return str(remote_id)


async def _poll_runpod_job(
    api_key: str,
    remote_id: str,
    cancel_check: callable,
    timeout_sec: int = DEFAULT_TIMEOUT_SEC,
) -> str:
    """Poll RunPod /status until COMPLETED, return the output image URL."""
    url = f"{config.RUNPOD_API_BASE.rstrip('/')}/{NANO_BANANA_ENDPOINT}/status/{remote_id}"
    req_headers = {"Authorization": f"Bearer {api_key}"}
    interval = POLL_INITIAL_SEC
    deadline = time.monotonic() + timeout_sec
    while True:
        if cancel_check():
            raise asyncio.CancelledError()
        if time.monotonic() > deadline:
            raise TimeoutError(f"RunPod job {remote_id} exceeded {timeout_sec}s")

        def _fetch() -> dict[str, Any]:
            r = urllib.request.Request(url, method="GET", headers=req_headers)
            with urllib.request.urlopen(r, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))

        try:
            data = await asyncio.to_thread(_fetch)
        except urllib.error.HTTPError as exc:
            # transient — backoff and try again
            print(f"[dataset_create] poll {remote_id} HTTP {exc.code}: {exc.reason}", flush=True)
            data = {"status": "IN_QUEUE"}
        except Exception as exc:
            print(f"[dataset_create] poll {remote_id} error: {exc}", flush=True)
            data = {"status": "IN_QUEUE"}

        status = (data.get("status") or "").upper()
        if status == "COMPLETED":
            # nano-banana-2-edit returns the URL at top level under `output.result` OR
            # at the response root as `result`. Try both.
            output = data.get("output")
            img_url = _extract_image_url(output) if output else ""
            if not img_url:
                # Top-level result fallback
                top_result = data.get("result")
                if isinstance(top_result, str) and top_result.startswith("http"):
                    img_url = top_result
            if not img_url:
                raise RuntimeError(f"COMPLETED but no image in output: {data}")
            return img_url
        if status in ("FAILED", "CANCELLED", "TIMED_OUT"):
            raise RuntimeError(f"RunPod job {remote_id} status={status}: {data.get('error') or data}")

        await asyncio.sleep(interval)
        interval = min(POLL_MAX_SEC, interval * POLL_BACKOFF)


def _extract_image_url(output: Any) -> str:
    """Pull the first image URL from a variety of RunPod output shapes."""
    if isinstance(output, str) and output.startswith("http"):
        return output
    if isinstance(output, list):
        for item in output:
            url = _extract_image_url(item)
            if url:
                return url
        return ""
    if isinstance(output, dict):
        for key in ("image_url", "url", "output_url", "result"):
            v = output.get(key)
            if isinstance(v, str) and v.startswith("http"):
                return v
        images = output.get("images") or output.get("output") or output.get("data")
        if images is not None:
            return _extract_image_url(images)
    return ""


async def _cancel_remote(api_key: str, remote_id: str) -> None:
    url = f"{config.RUNPOD_API_BASE.rstrip('/')}/{NANO_BANANA_ENDPOINT}/cancel/{remote_id}"
    req = urllib.request.Request(url, method="POST", headers={"Authorization": f"Bearer {api_key}"})

    def _send() -> None:
        try:
            with urllib.request.urlopen(req, timeout=30) as _:
                return
        except Exception as exc:
            print(f"[dataset_create] remote cancel {remote_id} failed: {exc}", flush=True)

    await asyncio.to_thread(_send)


# ---------------------------------------------------------------------------
# Download + persistence
# ---------------------------------------------------------------------------


def _download_to(path: Path, url: str) -> None:
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=max(config.HTTP_TIMEOUT_SEC, 120)) as resp:
        with path.open("wb") as f:
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                f.write(chunk)


def _save_manifest(dataset_dir: Path, manifest: dict[str, Any]) -> None:
    (dataset_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# Job runner
# ---------------------------------------------------------------------------


async def _run_one(
    sem: asyncio.Semaphore,
    job_id: str,
    api_key: str,
    idx: int,
    prompt: str,
    aspect_ratio: str,
    quality: str,
    references: list[str],
    dataset_dir: Path,
) -> dict[str, Any]:
    """Submit + poll a single RunPod job; download result to disk."""

    def _is_cancelled() -> bool:
        with JOBS_LOCK:
            rec = JOBS.get(job_id)
            return bool(rec and rec.get("cancel_requested"))

    async with sem:
        if _is_cancelled():
            return {"index": idx, "ok": False, "error": "cancelled", "prompt": prompt,
                    "aspect_ratio": aspect_ratio, "url": None, "local_url": None}

        try:
            remote_id = await _submit_runpod_job(api_key, prompt, aspect_ratio, quality, references)
        except Exception as exc:
            return {"index": idx, "ok": False, "error": f"submit failed: {exc}",
                    "prompt": prompt, "aspect_ratio": aspect_ratio, "url": None, "local_url": None}

        with JOBS_LOCK:
            rec = JOBS.get(job_id)
            if rec is not None:
                rec["remote_job_ids"][idx] = remote_id

        try:
            image_url = await _poll_runpod_job(api_key, remote_id, _is_cancelled)
        except asyncio.CancelledError:
            # Best-effort cancel of remote job
            await _cancel_remote(api_key, remote_id)
            return {"index": idx, "ok": False, "error": "cancelled", "prompt": prompt,
                    "aspect_ratio": aspect_ratio, "url": None, "local_url": None}
        except Exception as exc:
            return {"index": idx, "ok": False, "error": str(exc), "prompt": prompt,
                    "aspect_ratio": aspect_ratio, "url": None, "local_url": None}

        # Download to dataset folder
        ext = image_url.rsplit(".", 1)[-1].split("?")[0].lower()
        if ext not in ("png", "jpg", "jpeg", "webp"):
            ext = "png"
        filename = f"img_{idx + 1:03d}.{ext}"
        out_path = dataset_dir / filename
        try:
            await asyncio.to_thread(_download_to, out_path, image_url)
        except Exception as exc:
            return {"index": idx, "ok": True, "error": f"download failed: {exc}",
                    "prompt": prompt, "aspect_ratio": aspect_ratio,
                    "url": image_url, "local_url": None}

        rel_url = f"/outputs/datasets/{dataset_dir.name}/{filename}"

        # Live-update partial_images so the frontend can stream thumbs
        with JOBS_LOCK:
            rec = JOBS.get(job_id)
            if rec is not None:
                rec["completed"] += 1
                # ensure list is big enough
                while len(rec["partial_images"]) <= idx:
                    rec["partial_images"].append(None)
                rec["partial_images"][idx] = {
                    "index": idx,
                    "url": rel_url,
                    "remote_url": image_url,
                    "prompt": prompt,
                    "aspect_ratio": aspect_ratio,
                }

        return {"index": idx, "ok": True, "url": image_url, "local_url": rel_url,
                "prompt": prompt, "aspect_ratio": aspect_ratio, "error": None}


async def _run_dataset_job(
    job_id: str,
    api_key: str,
    name: str,
    quality: str,
    aspect_ratios: list[str],
    image_count: int,
    prompts: list[str],
    references: list[str],
    pack_ids: list[str],
    concurrency: int,
    dataset_dir: Path,
) -> None:
    sem = asyncio.Semaphore(max(1, min(concurrency, DEFAULT_CONCURRENCY)))

    # Reserve slots in partial_images
    with JOBS_LOCK:
        rec = JOBS.get(job_id)
        if rec is None:
            return
        rec["partial_images"] = [None] * image_count

    tasks = []
    for idx in range(image_count):
        if idx >= len(prompts):
            break
        ar = _build_aspect_for_index(aspect_ratios, idx)
        tasks.append(asyncio.create_task(
            _run_one(sem, job_id, api_key, idx, prompts[idx], ar, quality, references, dataset_dir)
        ))

    results = await asyncio.gather(*tasks, return_exceptions=False)

    # Build manifest
    image_urls = [r["local_url"] for r in results if r.get("ok") and r.get("local_url")]
    failed_indices = [r["index"] for r in results if not r.get("ok")]
    prompt_log = [
        {
            "index": r["index"],
            "prompt": r["prompt"],
            "aspect_ratio": r["aspect_ratio"],
            "ok": r["ok"],
            "error": r.get("error"),
        }
        for r in sorted(results, key=lambda x: x["index"])
    ]

    manifest = {
        "provider": "nano-banana-runpod",
        "quality": quality,
        "aspect_ratios": aspect_ratios,
        "prompt_pack_ids": pack_ids,
        "prompts": prompt_log,
        "reference_image_urls": references,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "count": len(image_urls),
        "failed_indices": failed_indices,
    }
    _save_manifest(dataset_dir, manifest)

    with JOBS_LOCK:
        rec = JOBS.get(job_id)
        if rec is None:
            return
        cancelled = rec.get("cancel_requested")
        if cancelled and not image_urls:
            rec["status"] = "CANCELLED"
        elif failed_indices and image_urls:
            rec["status"] = "PARTIAL"
        elif failed_indices and not image_urls:
            rec["status"] = "FAILED"
            rec["error"] = "; ".join({r["error"] for r in results if r.get("error")})[:500]
        else:
            rec["status"] = "COMPLETED"
        rec["failed"] = len(failed_indices)
        rec["failed_indices"] = failed_indices
        rec["ended_at"] = time.time()
        rec["dataset"] = {
            "kind": "dataset",
            "id": job_id,
            "name": name,
            "images": image_urls,
            "manifest": manifest,
        }


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


@router.get("/health")
def health() -> JSONResponse:
    packs = _list_packs(include_prompts=False)
    return JSONResponse({
        "ok": True,
        "runpod_key_present": bool(config.RUNPOD_API_KEY),
        "prompt_pack_count": len(packs),
        "endpoint": NANO_BANANA_ENDPOINT,
    })


@router.get("/prompt-packs")
def prompt_packs() -> JSONResponse:
    return JSONResponse({"ok": True, "packs": _list_packs(include_prompts=False)})


@router.get("/prompt-packs/{pack_id}")
def prompt_pack(pack_id: str) -> JSONResponse:
    safe = re.sub(r"[^a-zA-Z0-9_.-]", "", pack_id)
    path = PROMPT_PACKS_DIR / f"{safe}.json"
    if not path.exists():
        return JSONResponse({"ok": False, "error": "pack not found"}, status_code=404)
    pack = _load_pack(path)
    return JSONResponse({"ok": True, "pack": pack})


def _sample_prompts(pack_ids: list[str], count: int, seed: int | None) -> list[str]:
    rng = random.Random(seed)
    pool: list[str] = []
    for pack in _list_packs(include_prompts=True):
        if pack["id"] in pack_ids:
            pool.extend(pack["prompts"])
    if not pool:
        return []
    out: list[str] = []
    for _ in range(count):
        out.append(rng.choice(pool))
    return out


@router.post("/run")
async def run(request: Request) -> JSONResponse:
    body = await request.json()
    name = str(body.get("name") or "").strip() or f"dataset_{int(time.time())}"
    quality = str(body.get("quality") or "1k").lower()
    aspect_ratios = body.get("aspect_ratios") or ["1:1"]
    image_count = int(body.get("image_count") or 10)
    pack_ids = body.get("pack_ids") or []
    references = body.get("reference_image_urls") or []
    api_key = str(body.get("runpod_api_key") or config.RUNPOD_API_KEY or "").strip()
    concurrency = int(body.get("concurrency") or DEFAULT_CONCURRENCY)
    seed = body.get("seed")
    custom_prompts = body.get("custom_prompts") or []

    # ---- validate ----
    if quality not in ALLOWED_QUALITY:
        return JSONResponse({"ok": False, "error": f"quality must be one of {sorted(ALLOWED_QUALITY)}"}, status_code=400)
    if not isinstance(aspect_ratios, list) or not aspect_ratios:
        return JSONResponse({"ok": False, "error": "aspect_ratios must be a non-empty list"}, status_code=400)
    for ar in aspect_ratios:
        if ar not in ALLOWED_ASPECT:
            return JSONResponse({"ok": False, "error": f"unsupported aspect_ratio {ar!r}"}, status_code=400)
    if image_count < 1 or image_count > 1000:
        return JSONResponse({"ok": False, "error": "image_count must be 1..1000"}, status_code=400)
    if not isinstance(references, list) or not references:
        return JSONResponse({"ok": False, "error": "reference_image_urls required (at least 1)"}, status_code=400)
    if len(references) > MAX_REFERENCE_IMAGES:
        return JSONResponse({"ok": False, "error": f"max {MAX_REFERENCE_IMAGES} reference images"}, status_code=400)
    if not api_key:
        return JSONResponse({"ok": False, "error": "RunPod API key required (not in .env and not provided)"}, status_code=400)
    if not pack_ids and not custom_prompts:
        return JSONResponse({"ok": False, "error": "at least one prompt pack or custom_prompts is required"}, status_code=400)

    # ---- sample prompts ----
    prompts: list[str] = []
    if custom_prompts:
        prompts.extend([str(p) for p in custom_prompts if isinstance(p, str) and p.strip()])
    if pack_ids:
        prompts.extend(_sample_prompts(pack_ids, image_count, seed if isinstance(seed, int) else None))
    if not prompts:
        return JSONResponse({"ok": False, "error": "no prompts available from selected packs"}, status_code=400)
    # Trim to image_count
    rng = random.Random(seed if isinstance(seed, int) else None)
    if len(prompts) > image_count:
        prompts = rng.sample(prompts, image_count)
    while len(prompts) < image_count:
        prompts.append(rng.choice(prompts))

    # ---- prepare disk ----
    slug = _slugify(name)
    job_id = uuid.uuid4().hex
    folder_name = f"{slug}_{job_id[:8]}"
    dataset_dir = DATASETS_DIR / folder_name
    dataset_dir.mkdir(parents=True, exist_ok=True)
    (dataset_dir / ".meta").mkdir(exist_ok=True)

    # ---- record + spawn ----
    record: dict[str, Any] = {
        "job_id": job_id,
        "status": "RUNNING",
        "name": name,
        "total": image_count,
        "completed": 0,
        "failed": 0,
        "failed_indices": [],
        "partial_images": [None] * image_count,
        "remote_job_ids": {},
        "started_at": time.time(),
        "ended_at": None,
        "error": "",
        "dataset": None,
        "cancel_requested": False,
        "dataset_dir": str(dataset_dir),
    }
    with JOBS_LOCK:
        JOBS[job_id] = record

    asyncio.create_task(_run_dataset_job(
        job_id=job_id,
        api_key=api_key,
        name=name,
        quality=quality,
        aspect_ratios=aspect_ratios,
        image_count=image_count,
        prompts=prompts,
        references=references[:MAX_REFERENCE_IMAGES],
        pack_ids=pack_ids,
        concurrency=concurrency,
        dataset_dir=dataset_dir,
    ))

    return JSONResponse({"ok": True, "job_id": job_id, "total": image_count, "dataset_dir": str(dataset_dir.name)})


@router.get("/status/{job_id}")
def status(job_id: str) -> JSONResponse:
    snap = _job_snapshot(job_id)
    if not snap:
        return JSONResponse({"ok": False, "error": "job not found"}, status_code=404)
    return JSONResponse({"ok": True, "job": snap})


@router.post("/cancel/{job_id}")
def cancel(job_id: str) -> JSONResponse:
    with JOBS_LOCK:
        rec = JOBS.get(job_id)
        if not rec:
            return JSONResponse({"ok": False, "error": "job not found"}, status_code=404)
        rec["cancel_requested"] = True
    return JSONResponse({"ok": True})


@router.get("/datasets")
def list_datasets() -> JSONResponse:
    """List all on-disk datasets (manifest summaries)."""
    datasets: list[dict[str, Any]] = []
    if not DATASETS_DIR.exists():
        return JSONResponse({"ok": True, "datasets": []})
    for folder in sorted(DATASETS_DIR.iterdir()):
        if not folder.is_dir():
            continue
        manifest_path = folder / "manifest.json"
        if not manifest_path.exists():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        image_files = sorted([
            f"/outputs/datasets/{folder.name}/{p.name}"
            for p in folder.iterdir()
            if p.is_file() and p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")
        ])
        datasets.append({
            "id": folder.name,
            "name": folder.name.rsplit("_", 1)[0],
            "folder": folder.name,
            "image_count": len(image_files),
            "thumb_urls": image_files[:4],
            "manifest": manifest,
        })
    return JSONResponse({"ok": True, "datasets": datasets})


@router.get("/datasets/{folder_name}")
def get_dataset(folder_name: str) -> JSONResponse:
    safe = re.sub(r"[^a-zA-Z0-9_.-]", "", folder_name)
    folder = DATASETS_DIR / safe
    if not folder.exists() or not folder.is_dir():
        return JSONResponse({"ok": False, "error": "dataset not found"}, status_code=404)
    manifest_path = folder / "manifest.json"
    manifest = {}
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            manifest = {}
    image_files = sorted([
        f"/outputs/datasets/{folder.name}/{p.name}"
        for p in folder.iterdir()
        if p.is_file() and p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")
    ])
    return JSONResponse({
        "ok": True,
        "dataset": {
            "kind": "dataset",
            "id": folder.name,
            "name": manifest.get("name") or folder.name,
            "images": image_files,
            "manifest": manifest,
        },
    })


@router.get("/datasets/{folder_name}/caption-status")
def dataset_caption_status(folder_name: str) -> JSONResponse:
    """Report how many images in the dataset have a matching .txt caption file."""
    safe = re.sub(r"[^a-zA-Z0-9_.-]", "", folder_name)
    folder = DATASETS_DIR / safe
    if not folder.exists() or not folder.is_dir():
        return JSONResponse({"ok": False, "error": "dataset not found"}, status_code=404)
    image_stems = [
        p.stem
        for p in folder.iterdir()
        if p.is_file() and p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")
    ]
    total = len(image_stems)
    captioned = sum(1 for stem in image_stems if (folder / f"{stem}.txt").exists())
    return JSONResponse({
        "ok": True,
        "total": total,
        "captioned": captioned,
        "ready": total > 0 and captioned == total,
    })

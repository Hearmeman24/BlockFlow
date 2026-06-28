from __future__ import annotations

import asyncio
import copy
import json
import os
import random
import re
import subprocess
import tempfile
import threading
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from backend import comfy_gen_cli, config, db, media_meta, services, state

router = APIRouter()


# ---------------------------------------------------------------------------
# comfy-gen cache (samplers, schedulers, loras)
# ---------------------------------------------------------------------------

_CACHE_SCHEMA_VERSION = 2

_cache: dict[str, Any] = {
    "samplers": [], "schedulers": [],
    "loras": [],           # filenames only — legacy projection for existing consumers
    "lora_details": [],    # full {filename, path, size_mb} objects (v2)
    "fetched_at": 0,
}


def _read_cache_from_disk() -> None:
    """Load cached data from disk into memory (no CLI calls).

    Pre-v2 caches stored LoRAs as a flat list of filename strings, losing
    `path` and `size_mb`. Those caches are rejected for the loras section
    so the next `comfy-gen info` refresh repopulates with rich objects.
    Samplers/schedulers are version-agnostic and load regardless.
    """
    cache_path = config.COMFY_GEN_INFO_CACHE_PATH
    if not cache_path.exists():
        return
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
        if data.get("samplers"):
            _cache["samplers"] = data["samplers"]
        if data.get("schedulers"):
            _cache["schedulers"] = data["schedulers"]
        if data.get("version") == _CACHE_SCHEMA_VERSION:
            details = [item for item in (data.get("loras") or [])
                       if isinstance(item, dict) and "filename" in item]
            _cache["lora_details"] = details
            _cache["loras"] = [d["filename"] for d in details]
        if data.get("fetched_at"):
            _cache["fetched_at"] = data["fetched_at"]
    except Exception:
        pass


def _save_cache_to_disk() -> None:
    config.COMFY_GEN_INFO_CACHE_PATH.write_text(
        json.dumps({
            "version": _CACHE_SCHEMA_VERSION,
            "samplers": _cache["samplers"],
            "schedulers": _cache["schedulers"],
            "loras": _cache["lora_details"],
            "fetched_at": _cache["fetched_at"],
        }, indent=2) + "\n",
        encoding="utf-8",
    )


# Load from disk at import time (no CLI calls)
_read_cache_from_disk()


@router.get("/cache")
def get_cache() -> JSONResponse:
    """Return cached samplers, schedulers, and loras.

    Re-reads the disk cache on every call so out-of-band writes (e.g. the
    LoRA management page's delete/download in sgs-ui-eqc) propagate to the
    block's dropdown without requiring a full refresh.
    """
    _read_cache_from_disk()
    return JSONResponse({
        "ok": True,
        "samplers": _cache["samplers"],
        "schedulers": _cache["schedulers"],
        "loras": _cache["loras"],
        "fetched_at": _cache["fetched_at"],
    })


_refresh_state: dict[str, Any] = {"running": False, "status": "", "error": "", "done": False}
_refresh_lock = threading.Lock()


def _run_refresh(cmd: list[str]) -> None:
    """Run comfy-gen info in a thread, streaming stderr lines to _refresh_state."""
    try:
        with comfy_gen_cli.settings_subprocess_env() as env:
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
            )
            # Stream stderr for live status
            assert proc.stderr is not None
            for line in proc.stderr:
                line = line.strip()
                if line:
                    _refresh_state["status"] = line
            proc.wait(timeout=90)

            if proc.returncode != 0:
                stdout = proc.stdout.read() if proc.stdout else ""
                _refresh_state["error"] = stdout.strip() or "comfy-gen info failed"
                _refresh_state["done"] = True
                _refresh_state["running"] = False
                return

            stdout = proc.stdout.read() if proc.stdout else ""
            data = json.loads(stdout)
            if not data.get("ok"):
                _refresh_state["error"] = data.get("error", "comfy-gen info returned not ok")
                _refresh_state["done"] = True
                _refresh_state["running"] = False
                return

            _cache["samplers"] = data.get("samplers", [])
            _cache["schedulers"] = data.get("schedulers", [])
            loras = data.get("loras", [])
            details = [item for item in loras
                       if isinstance(item, dict) and "filename" in item]
            _cache["lora_details"] = details
            _cache["loras"] = [item["filename"] for item in details]
            _cache["fetched_at"] = time.time()
            _save_cache_to_disk()
            _refresh_state["status"] = f"Done — {len(_cache['samplers'])} samplers, {len(_cache['schedulers'])} schedulers, {len(_cache['loras'])} loras"

    except subprocess.TimeoutExpired:
        _refresh_state["error"] = "comfy-gen info timed out (90s)"
        if proc:
            proc.kill()
    except Exception as e:
        _refresh_state["error"] = str(e)
    finally:
        _refresh_state["done"] = True
        _refresh_state["running"] = False


@router.post("/refresh-cache")
def refresh_cache(payload: dict[str, Any] = {}) -> JSONResponse:
    """Start comfy-gen info in background, returns immediately."""
    with _refresh_lock:
        if _refresh_state["running"]:
            return JSONResponse({"ok": True, "already_running": True})

        try:
            comfy_gen = comfy_gen_cli.resolve_comfy_gen()
        except comfy_gen_cli.ComfyGenNotFound as exc:
            return JSONResponse({"ok": False, "error": str(exc)})

        eid = str(payload.get("endpoint_id", "")).strip() or config.RUNPOD_ENDPOINT_ID or ""
        cmd = comfy_gen.command("info")
        if eid:
            cmd.extend(["--endpoint-id", eid])

        _refresh_state["running"] = True
        _refresh_state["done"] = False
        _refresh_state["error"] = ""
        _refresh_state["status"] = "Starting comfy-gen info..."

        t = threading.Thread(target=_run_refresh, args=(cmd,), daemon=True)
        t.start()

    return JSONResponse({"ok": True, "started": True})


@router.get("/refresh-status")
def refresh_status() -> JSONResponse:
    """Poll refresh progress."""
    return JSONResponse({
        "ok": True,
        "running": _refresh_state["running"],
        "done": _refresh_state["done"],
        "status": _refresh_state["status"],
        "error": _refresh_state["error"],
        # Include cache data when done so frontend can update in one call
        **({
            "samplers": _cache["samplers"],
            "schedulers": _cache["schedulers"],
            "loras": _cache["loras"],
            "fetched_at": _cache["fetched_at"],
        } if _refresh_state["done"] and not _refresh_state["error"] else {}),
    })


# ---- Model download ----

_download_state: dict[str, Any] = {"running": False, "status": "", "error": "", "done": False}
_download_lock = threading.Lock()



def _run_download(cmd: list[str]) -> None:
    """Run comfy-gen download in a thread, streaming stderr lines to _download_state."""
    try:
        with comfy_gen_cli.settings_subprocess_env() as env:
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
            )
            assert proc.stderr is not None
            for line in proc.stderr:
                line = line.strip()
                if line:
                    _download_state["status"] = line
            proc.wait(timeout=1200)  # 20 min timeout for large models

            stdout = proc.stdout.read() if proc.stdout else ""
            print(f"[comfy-gen] Download stdout: {stdout[:1000]}", flush=True)
            print(f"[comfy-gen] Download returncode: {proc.returncode}", flush=True)
            if proc.returncode != 0:
                _download_state["error"] = stdout.strip() or "comfy-gen download failed"
            else:
                try:
                    data = json.loads(stdout)
                    if data.get("ok") is not False:
                        files = data.get("files", data.get("downloaded", []))
                        count = len(files) if isinstance(files, list) else _download_state.get("total", 0)
                        if count == 0:
                            count = _download_state.get("total", 1)
                        _download_state["status"] = f"Downloaded {count} model(s)"
                    else:
                        _download_state["error"] = data.get("error", "Download returned not ok")
                except (json.JSONDecodeError, ValueError):
                    _download_state["status"] = "Download completed"

    except subprocess.TimeoutExpired:
        _download_state["error"] = "Download timed out (20 min)"
        if proc:
            proc.kill()
    except Exception as e:
        _download_state["error"] = str(e)
    finally:
        _download_state["done"] = True
        _download_state["running"] = False


@router.post("/download-models")
def download_models(payload: dict[str, Any] = {}) -> JSONResponse:
    """Start comfy-gen download --batch in background."""
    with _download_lock:
        if _download_state["running"]:
            return JSONResponse({"ok": True, "already_running": True})

        try:
            comfy_gen = comfy_gen_cli.resolve_comfy_gen()
        except comfy_gen_cli.ComfyGenNotFound as exc:
            return JSONResponse({"ok": False, "error": str(exc)})

        models = payload.get("models", [])
        if not models:
            return JSONResponse({"ok": False, "error": "No models to download"})

        eid = str(payload.get("endpoint_id", "")).strip() or config.RUNPOD_ENDPOINT_ID or ""

        # Build batch JSON file
        batch: list[dict[str, str]] = []
        for m in models:
            url = m.get("download_url", "")
            if not url:
                continue
            save_path = m.get("save_path", "default")
            dest = save_path if save_path and save_path != "default" else "checkpoints"
            entry: dict[str, str] = {"source": "url", "url": url, "dest": dest}
            filename = m.get("filename", "")
            if filename:
                entry["filename"] = filename
            batch.append(entry)

        if not batch:
            return JSONResponse({"ok": False, "error": "No downloadable models (missing URLs)"})

        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
        json.dump(batch, tmp)
        tmp.close()

        cmd = comfy_gen.command("download", "--batch", tmp.name)
        if eid:
            cmd.extend(["--endpoint-id", eid])

        _download_state["running"] = True
        _download_state["done"] = False
        _download_state["error"] = ""
        _download_state["status"] = f"Starting download of {len(batch)} model(s)..."
        _download_state["total"] = len(batch)

        print(f"[comfy-gen] Download command: {' '.join(cmd)}", flush=True)

        t = threading.Thread(target=_run_download, args=(cmd,), daemon=True)
        t.start()

    return JSONResponse({"ok": True, "started": True, "count": len(batch)})


@router.get("/download-status")
def download_status() -> JSONResponse:
    """Poll download progress."""
    return JSONResponse({
        "ok": True,
        "running": _download_state["running"],
        "done": _download_state["done"],
        "status": _download_state["status"],
        "error": _download_state["error"],
    })


@router.get("/health")
def health_check() -> JSONResponse:
    """Check if comfy-gen CLI is installed and reachable."""
    try:
        comfy_gen = comfy_gen_cli.resolve_comfy_gen()
    except comfy_gen_cli.ComfyGenNotFound as exc:
        return JSONResponse({"ok": False, "error": str(exc)})
    try:
        result = subprocess.run(
            comfy_gen.command("--help"),
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return JSONResponse({"ok": False, "error": f"comfy-gen --help exited with code {result.returncode}"})
    except Exception as exc:
        return JSONResponse({"ok": False, "error": str(exc)})
    return JSONResponse({"ok": True, "path": str(comfy_gen.path), "mode": comfy_gen.mode})




# ---- Workflow parsing ----

_IMAGE_OUTPUT_NODES = {"SaveImage", "PreviewImage", "SaveAnimatedWEBP"}
_VIDEO_OUTPUT_NODES = {"VHS_VideoCombine", "SaveVideo"}


def _detect_output_type(workflow: dict[str, Any]) -> str:
    """Detect whether the workflow outputs image, video, or both."""
    has_image = False
    has_video = False
    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type", "")
        if class_type in _IMAGE_OUTPUT_NODES:
            has_image = True
        elif class_type in _VIDEO_OUTPUT_NODES:
            has_video = True
    if has_video and has_image:
        return "both"
    if has_video:
        return "video"
    if has_image:
        return "image"
    return "unknown"


def _detect_load_nodes(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    """Find LoadImage and VHS_LoadVideo nodes in a workflow."""
    nodes = []
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type", "")
        if class_type == "LoadImage":
            nodes.append({
                "node_id": node_id,
                "class_type": class_type,
                "field": "image",
                "current_value": node.get("inputs", {}).get("image", ""),
            })
        elif class_type in ("VHS_LoadVideo", "LoadVideo"):
            nodes.append({
                "node_id": node_id,
                "class_type": class_type,
                "field": "video",
                "current_value": node.get("inputs", {}).get("video", ""),
            })
    return nodes


def _resolve_input(workflow: dict[str, Any], value: Any) -> Any:
    """Follow a wired input reference [node_id, output_index] to its literal value."""
    if not isinstance(value, list) or len(value) != 2:
        return value
    src_id, _ = value
    src_node = workflow.get(str(src_id))
    if not isinstance(src_node, dict):
        return value
    src_inputs = src_node.get("inputs", {})
    # Primitive nodes store their value in a "value" field
    if "value" in src_inputs:
        return src_inputs["value"]
    return value


def _detect_ksamplers(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    """Find KSampler nodes with their steps/cfg/seed/denoise/sampler/scheduler values.

    Supports:
    - KSampler / KSamplerAdvanced (standard nodes with all params inline)
    - SamplerCustomAdvanced (modular: wires to KSamplerSelect, CFGGuider, RandomNoise, etc.)
    - SamplerCustom (modular but with inline cfg + noise_seed; sampler/sigmas wired)
    """
    samplers = []

    # Standard KSampler nodes
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type", "")
        if class_type not in ("KSampler", "KSamplerAdvanced"):
            continue
        inputs = node.get("inputs", {})
        meta_title = node.get("_meta", {}).get("title", "")
        entry: dict[str, Any] = {
            "node_id": node_id,
            "class_type": class_type,
        }
        if meta_title and meta_title != class_type:
            entry["label"] = meta_title
        steps = _resolve_input(workflow, inputs.get("steps"))
        if isinstance(steps, (int, float)):
            entry["steps"] = int(steps)
        cfg = _resolve_input(workflow, inputs.get("cfg"))
        if isinstance(cfg, (int, float)):
            entry["cfg"] = cfg
        seed = _resolve_input(workflow, inputs.get("seed"))
        if isinstance(seed, (int, float)):
            entry["seed"] = int(seed)
        denoise = _resolve_input(workflow, inputs.get("denoise"))
        if isinstance(denoise, (int, float)):
            entry["denoise"] = round(float(denoise), 3)
        sampler_name = inputs.get("sampler_name")
        if isinstance(sampler_name, str):
            entry["sampler_name"] = sampler_name
        scheduler = inputs.get("scheduler")
        if isinstance(scheduler, str):
            entry["scheduler"] = scheduler
        samplers.append(entry)

    # SamplerCustomAdvanced nodes — trace wired inputs to find sampler/cfg/seed
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") != "SamplerCustomAdvanced":
            continue
        inputs = node.get("inputs", {})
        meta_title = node.get("_meta", {}).get("title", "")
        entry: dict[str, Any] = {
            "node_id": node_id,
            "class_type": "SamplerCustomAdvanced",
        }
        if meta_title and meta_title != "SamplerCustomAdvanced":
            entry["label"] = meta_title

        # Trace sampler input → KSamplerSelect node (has sampler_name)
        sampler_ref = inputs.get("sampler")
        if isinstance(sampler_ref, list) and len(sampler_ref) >= 2:
            sampler_node = workflow.get(str(sampler_ref[0]), {})
            if sampler_node.get("class_type") == "KSamplerSelect":
                sn = sampler_node.get("inputs", {}).get("sampler_name")
                if isinstance(sn, str):
                    entry["sampler_name"] = sn
                # Use the KSamplerSelect node_id for sampler_name overrides
                entry["_sampler_select_node"] = str(sampler_ref[0])

        # Trace guider input → CFGGuider (has cfg)
        guider_ref = inputs.get("guider")
        if isinstance(guider_ref, list) and len(guider_ref) >= 2:
            guider_node = workflow.get(str(guider_ref[0]), {})
            if guider_node.get("class_type") in ("CFGGuider", "DualCFGGuider", "BasicGuider"):
                cfg_val = guider_node.get("inputs", {}).get("cfg")
                cfg_resolved = _resolve_input(workflow, cfg_val)
                if isinstance(cfg_resolved, (int, float)):
                    entry["cfg"] = cfg_resolved
                entry["_guider_node"] = str(guider_ref[0])

        # Trace noise input → RandomNoise (has noise_seed)
        noise_ref = inputs.get("noise")
        if isinstance(noise_ref, list) and len(noise_ref) >= 2:
            noise_node = workflow.get(str(noise_ref[0]), {})
            if noise_node.get("class_type") == "RandomNoise":
                seed_val = noise_node.get("inputs", {}).get("noise_seed")
                seed_resolved = _resolve_input(workflow, seed_val)
                if isinstance(seed_resolved, (int, float)):
                    entry["seed"] = int(seed_resolved)
                entry["_noise_node"] = str(noise_ref[0])

        # Trace sigmas input → any node with steps/scheduler fields
        sigmas_ref = inputs.get("sigmas")
        if isinstance(sigmas_ref, list) and len(sigmas_ref) >= 2:
            sigmas_node = workflow.get(str(sigmas_ref[0]), {})
            sched_inputs = sigmas_node.get("inputs", {})
            has_target = False
            scheduler_val = sched_inputs.get("scheduler")
            if isinstance(scheduler_val, str):
                entry["scheduler"] = scheduler_val
                has_target = True
            steps_val = _resolve_input(workflow, sched_inputs.get("steps"))
            if isinstance(steps_val, (int, float)):
                entry["steps"] = int(steps_val)
                has_target = True
            if has_target:
                entry["_sigmas_node"] = str(sigmas_ref[0])

        # Build override map: tells frontend which node_id.field to target for each param
        override_map: dict[str, str] = {}
        if "_sampler_select_node" in entry:
            override_map["sampler_name"] = f"{entry.pop('_sampler_select_node')}.sampler_name"
        if "_guider_node" in entry:
            override_map["cfg"] = f"{entry.pop('_guider_node')}.cfg"
        if "_noise_node" in entry:
            override_map["seed"] = f"{entry.pop('_noise_node')}.noise_seed"
        if "_sigmas_node" in entry:
            sigmas_id = entry.pop("_sigmas_node")
            override_map["steps"] = f"{sigmas_id}.steps"
            override_map["scheduler"] = f"{sigmas_id}.scheduler"
        if override_map:
            entry["override_map"] = override_map

        samplers.append(entry)

    # ClownsharKSampler_Beta nodes — all params inline, RES4LYF-specific enums
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") != "ClownsharKSampler_Beta":
            continue
        inputs = node.get("inputs", {})
        meta_title = node.get("_meta", {}).get("title", "")
        entry: dict[str, Any] = {
            "node_id": node_id,
            "class_type": "ClownsharKSampler_Beta",
        }
        if meta_title and meta_title != "ClownsharKSampler_Beta":
            entry["label"] = meta_title
        steps = _resolve_input(workflow, inputs.get("steps"))
        if isinstance(steps, (int, float)):
            entry["steps"] = int(steps)
        cfg = _resolve_input(workflow, inputs.get("cfg"))
        if isinstance(cfg, (int, float)):
            entry["cfg"] = cfg
        # seed from "seed" field — NOT noise_seed. Must emit seed=0 (no truthiness check).
        seed_raw = inputs.get("seed")
        seed_resolved = _resolve_input(workflow, seed_raw)
        if isinstance(seed_resolved, (int, float)):
            entry["seed"] = int(seed_resolved)
        denoise = _resolve_input(workflow, inputs.get("denoise"))
        if isinstance(denoise, (int, float)):
            entry["denoise"] = round(float(denoise), 3)
        sampler_name = inputs.get("sampler_name")
        if isinstance(sampler_name, str):
            entry["sampler_name"] = sampler_name
        scheduler = inputs.get("scheduler")
        if isinstance(scheduler, str):
            entry["scheduler"] = scheduler
        # Attach curated RES4LYF option lists so the frontend uses the correct
        # namespace instead of the generic KSampler enum.  Presence of these
        # fields on the entry is the frontend discriminator (see DESIGN.md).
        entry["sampler_options"] = _union(CLOWNSHARK_SAMPLERS, [sampler_name] if isinstance(sampler_name, str) else [])
        entry["scheduler_options"] = _union(CLOWNSHARK_SCHEDULERS, [scheduler] if isinstance(scheduler, str) else [])
        samplers.append(entry)

    # SamplerCustom nodes — inline cfg/noise_seed, wired sampler/sigmas
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") != "SamplerCustom":
            continue
        inputs = node.get("inputs", {})
        meta_title = node.get("_meta", {}).get("title", "")
        entry: dict[str, Any] = {
            "node_id": node_id,
            "class_type": "SamplerCustom",
        }
        if meta_title and meta_title != "SamplerCustom":
            entry["label"] = meta_title

        override_map: dict[str, str] = {}

        # Inline cfg
        cfg_val = _resolve_input(workflow, inputs.get("cfg"))
        if isinstance(cfg_val, (int, float)):
            entry["cfg"] = cfg_val
            override_map["cfg"] = f"{node_id}.cfg"

        # noise_seed: inline literal, or wired through Primitive/Seed nodes.
        seed_raw = inputs.get("noise_seed")
        seed_val = _resolve_input(workflow, seed_raw)
        if isinstance(seed_val, (int, float)):
            entry["seed"] = int(seed_val)
            override_map["seed"] = f"{node_id}.noise_seed"
        elif isinstance(seed_raw, list):
            # Wired noise_seed (e.g. ← PrimitiveInt ← Seed (rgthree)). Walk to the
            # literal source so the override targets a real field, not the dead
            # `<sampler>.seed` fallback. Samplers sharing a source dedupe to one
            # seed at randomize time.
            src = _find_upstream_source(workflow, seed_raw, value_keys=_SEED_VALUE_KEYS)
            if src:
                walked = _walk_upstream_value(workflow, seed_raw, value_keys=_SEED_VALUE_KEYS)
                if walked is not None:
                    entry["seed"] = int(walked)
                override_map["seed"] = f"{src[0]}.{src[1]}"

        # Trace sampler input → KSamplerSelect (if applicable); other sampler
        # nodes (SamplerLCM, etc.) have no sampler_name and are skipped here
        sampler_ref = inputs.get("sampler")
        if isinstance(sampler_ref, list) and len(sampler_ref) >= 2:
            sampler_node = workflow.get(str(sampler_ref[0]), {})
            if sampler_node.get("class_type") == "KSamplerSelect":
                sn = sampler_node.get("inputs", {}).get("sampler_name")
                if isinstance(sn, str):
                    entry["sampler_name"] = sn
                    override_map["sampler_name"] = f"{sampler_ref[0]}.sampler_name"

        # Trace sigmas input → scheduler node (BasicScheduler etc.)
        sigmas_ref = inputs.get("sigmas")
        if isinstance(sigmas_ref, list) and len(sigmas_ref) >= 2:
            sigmas_node = workflow.get(str(sigmas_ref[0]), {})
            sched_inputs = sigmas_node.get("inputs", {})
            sigmas_id = str(sigmas_ref[0])
            scheduler_val = sched_inputs.get("scheduler")
            if isinstance(scheduler_val, str):
                entry["scheduler"] = scheduler_val
                override_map["scheduler"] = f"{sigmas_id}.scheduler"
            steps_val = _resolve_input(workflow, sched_inputs.get("steps"))
            if isinstance(steps_val, (int, float)):
                entry["steps"] = int(steps_val)
                override_map["steps"] = f"{sigmas_id}.steps"
            denoise_val = _resolve_input(workflow, sched_inputs.get("denoise"))
            if isinstance(denoise_val, (int, float)):
                entry["denoise"] = round(float(denoise_val), 3)
                override_map["denoise"] = f"{sigmas_id}.denoise"

        if override_map:
            entry["override_map"] = override_map

        samplers.append(entry)

    return samplers


_KNOWN_LATENT_NODES = {
    "EmptyLatentImage", "SDXLEmptyLatentSizePicker+",
    "EmptyLTXVLatentVideo", "EmptySD3LatentImage",
    "EmptyFlux2LatentImage",
    "WanAnimateToVideo", "WanImageToVideo",
}

# ---------------------------------------------------------------------------
# ClownsharKSampler_Beta curated sampler / scheduler lists (O3 — IN v1)
#
# These are the RES4LYF-namespace enums.  Standard ComfyUI sampler names
# (euler, dpmpp_2m, …) are a different namespace and must NOT be offered.
# The current node value is always unioned in at detection time, so a future
# RES4LYF sampler not yet listed here will still appear for that node.
#
# Source of truth: RES4LYF (github.com/ClownsharkBatwing/RES4LYF).
#   Samplers   = beta/rk_coefficients_beta.py RK_SAMPLER_NAMES_BETA_FOLDERS,
#                the folder-prefixed form ClownsharKSampler_Beta shows by
#                default. process_sampler_name() strips the folder, so these
#                are accepted regardless of the node's display-category setting.
#   Schedulers = comfy.samplers SCHEDULER_NAMES + RES4LYF's bong_tangent + beta57
#                (added in RES4LYF/__init__.py).
# ---------------------------------------------------------------------------
CLOWNSHARK_SAMPLERS: list[str] = [
    "none",
    "multistep/res_2m",
    "multistep/res_3m",
    "multistep/dpmpp_2m",
    "multistep/dpmpp_3m",
    "multistep/abnorsett_2m",
    "multistep/abnorsett_3m",
    "multistep/abnorsett_4m",
    "multistep/deis_2m",
    "multistep/deis_3m",
    "multistep/deis_4m",
    "exponential/res_2s_rkmk2e",
    "exponential/res_2s",
    "exponential/res_2s_stable",
    "exponential/res_3s",
    "exponential/res_3s_non-monotonic",
    "exponential/res_3s_alt",
    "exponential/res_3s_cox_matthews",
    "exponential/res_3s_lie",
    "exponential/res_3s_sunstar",
    "exponential/res_3s_strehmel_weiner",
    "exponential/res_4s_krogstad",
    "exponential/res_4s_krogstad_alt",
    "exponential/res_4s_strehmel_weiner",
    "exponential/res_4s_strehmel_weiner_alt",
    "exponential/res_4s_cox_matthews",
    "exponential/res_4s_cfree4",
    "exponential/res_4s_friedli",
    "exponential/res_4s_minchev",
    "exponential/res_4s_munthe-kaas",
    "exponential/res_5s",
    "exponential/res_5s_hochbruck-ostermann",
    "exponential/res_6s",
    "exponential/res_8s",
    "exponential/res_8s_alt",
    "exponential/res_10s",
    "exponential/res_15s",
    "exponential/res_16s",
    "exponential/etdrk2_2s",
    "exponential/etdrk3_a_3s",
    "exponential/etdrk3_b_3s",
    "exponential/etdrk4_4s",
    "exponential/etdrk4_4s_alt",
    "exponential/dpmpp_2s",
    "exponential/dpmpp_sde_2s",
    "exponential/dpmpp_3s",
    "exponential/lawson2a_2s",
    "exponential/lawson2b_2s",
    "exponential/lawson4_4s",
    "exponential/lawson41-gen_4s",
    "exponential/lawson41-gen-mod_4s",
    "exponential/ddim",
    "hybrid/pec423_2h2s",
    "hybrid/pec433_2h3s",
    "hybrid/abnorsett2_1h2s",
    "hybrid/abnorsett3_2h2s",
    "hybrid/abnorsett4_3h2s",
    "hybrid/lawson42-gen-mod_1h4s",
    "hybrid/lawson43-gen-mod_2h4s",
    "hybrid/lawson44-gen-mod_3h4s",
    "hybrid/lawson45-gen-mod_4h4s",
    "linear/ralston_2s",
    "linear/ralston_3s",
    "linear/ralston_4s",
    "linear/midpoint_2s",
    "linear/heun_2s",
    "linear/heun_3s",
    "linear/houwen-wray_3s",
    "linear/kutta_3s",
    "linear/ssprk3_3s",
    "linear/ssprk4_4s",
    "linear/rk38_4s",
    "linear/rk4_4s",
    "linear/rk5_7s",
    "linear/rk6_7s",
    "linear/bogacki-shampine_4s",
    "linear/bogacki-shampine_7s",
    "linear/dormand-prince_6s",
    "linear/dormand-prince_13s",
    "linear/tsi_7s",
    "linear/euler",
    "diag_implicit/irk_exp_diag_2s",
    "diag_implicit/kraaijevanger_spijker_2s",
    "diag_implicit/qin_zhang_2s",
    "diag_implicit/pareschi_russo_2s",
    "diag_implicit/pareschi_russo_alt_2s",
    "diag_implicit/crouzeix_2s",
    "diag_implicit/crouzeix_3s",
    "diag_implicit/crouzeix_3s_alt",
    "fully_implicit/gauss-legendre_2s",
    "fully_implicit/gauss-legendre_3s",
    "fully_implicit/gauss-legendre_4s",
    "fully_implicit/gauss-legendre_4s_alternating_a",
    "fully_implicit/gauss-legendre_4s_ascending_a",
    "fully_implicit/gauss-legendre_4s_alt",
    "fully_implicit/gauss-legendre_5s",
    "fully_implicit/gauss-legendre_5s_ascending",
    "fully_implicit/radau_ia_2s",
    "fully_implicit/radau_ia_3s",
    "fully_implicit/radau_iia_2s",
    "fully_implicit/radau_iia_3s",
    "fully_implicit/radau_iia_3s_alt",
    "fully_implicit/radau_iia_5s",
    "fully_implicit/radau_iia_7s",
    "fully_implicit/radau_iia_9s",
    "fully_implicit/radau_iia_11s",
    "fully_implicit/lobatto_iiia_2s",
    "fully_implicit/lobatto_iiia_3s",
    "fully_implicit/lobatto_iiia_4s",
    "fully_implicit/lobatto_iiib_2s",
    "fully_implicit/lobatto_iiib_3s",
    "fully_implicit/lobatto_iiib_4s",
    "fully_implicit/lobatto_iiic_2s",
    "fully_implicit/lobatto_iiic_3s",
    "fully_implicit/lobatto_iiic_4s",
    "fully_implicit/lobatto_iiic_star_2s",
    "fully_implicit/lobatto_iiic_star_3s",
    "fully_implicit/lobatto_iiid_2s",
    "fully_implicit/lobatto_iiid_3s",
]

CLOWNSHARK_SCHEDULERS: list[str] = [
    "simple",
    "sgm_uniform",
    "karras",
    "exponential",
    "ddim_uniform",
    "beta",
    "normal",
    "linear_quadratic",
    "kl_optimal",
    "bong_tangent",
    "beta57",
]


def _union(base: list[str], extras: list[str]) -> list[str]:
    """Return base with any extras not already present appended, preserving order."""
    seen = set(base)
    result = list(base)
    for x in extras:
        if x and x not in seen:
            seen.add(x)
            result.append(x)
    return result


# ---------------------------------------------------------------------------
# MoE pair detection
# ---------------------------------------------------------------------------

# Pass-through latent node types the upstream walk may traverse.  v1: empty
# (direct wire only required).  Extend with evidence (e.g. LatentUpscale that
# does not meaningfully change the latent) in a follow-up bead.
_LATENT_PASSTHROUGH: frozenset[str] = frozenset()

# Supported MoE families (same class_type on both experts)
_MOE_FAMILIES = frozenset({"KSamplerAdvanced", "ClownsharKSampler_Beta"})


def _chain_links_directly(workflow: dict[str, Any], low_id: str, high_id: str) -> bool:
    """Return True if the LOW sampler's latent_image is a DIRECT ["high_id", 0] wire.

    v1: direct-only (no passthrough walk).  _LATENT_PASSTHROUGH is reserved for
    follow-up when a concrete passthrough use-case appears.
    """
    low_node = workflow.get(str(low_id))
    if not isinstance(low_node, dict):
        return False
    latent_ref = low_node.get("inputs", {}).get("latent_image")
    if not isinstance(latent_ref, list) or len(latent_ref) != 2:
        return False
    return str(latent_ref[0]) == str(high_id) and latent_ref[1] == 0


def _ksa_boundary_ok(high_inputs: dict, low_inputs: dict) -> bool:
    """Check KSamplerAdvanced boundary signals (signal-3 in DESIGN.md).

    HIGH: add_noise=="enable" AND end_at_step in [1, steps-1].
    LOW:  add_noise=="disable" AND start_at_step == HIGH.end_at_step.
    """
    if high_inputs.get("add_noise") != "enable":
        return False
    if low_inputs.get("add_noise") != "disable":
        return False
    steps = high_inputs.get("steps")
    end_at = high_inputs.get("end_at_step")
    if not isinstance(steps, (int, float)) or not isinstance(end_at, (int, float)):
        return False
    steps = int(steps)
    end_at = int(end_at)
    if end_at < 1 or end_at >= steps:
        return False
    start_at = low_inputs.get("start_at_step")
    if not isinstance(start_at, (int, float)):
        return False
    return int(start_at) == end_at


def _clownshark_boundary_ok(high_inputs: dict, low_inputs: dict) -> bool:
    """Check ClownsharKSampler_Beta boundary signals (signal-3 in DESIGN.md).

    HIGH: sampler_mode=="standard" AND steps_to_run in [1, steps-1].
    LOW:  sampler_mode=="resample".
    """
    if high_inputs.get("sampler_mode") != "standard":
        return False
    if low_inputs.get("sampler_mode") != "resample":
        return False
    steps = high_inputs.get("steps")
    run = high_inputs.get("steps_to_run")
    if not isinstance(steps, (int, float)) or not isinstance(run, (int, float)):
        return False
    steps = int(steps)
    run = int(run)
    return 1 <= run <= steps - 1


def _detect_moe_pairs(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    """Find MoE sampler pairs (KSamplerAdvanced or ClownsharKSampler_Beta).

    Returns a list of dicts per DESIGN.md "MoE pair output dict" — one entry
    per detected pair.  A pair requires ALL three signals (DESIGN "Detection
    contract"):
      1. Same class_type in a supported MoE family.
      2. LOW.latent_image is a DIRECT ["high", 0] wire (v1: no passthrough).
      3. Family-specific boundary signals are present and well-formed.

    If direction (signal-2) and marker (signal-3) disagree, the pair is
    rejected — no guessing.  If a same-family connected component has size != 2,
    no pair is emitted for that component (handles 3+ chains conservatively).
    Two independent pairs in one workflow both emit.
    """
    pairs: list[dict[str, Any]] = []

    # Collect all supported-family nodes grouped by class_type
    by_family: dict[str, list[str]] = {}
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type", "")
        if ct in _MOE_FAMILIES:
            by_family.setdefault(ct, []).append(node_id)

    for family, node_ids in by_family.items():
        # Build the chain graph within this family: which node feeds which via
        # latent_image?  Each node in this family that directly receives from
        # another family node is a "LOW"; the feeder is "HIGH".
        family_set = set(node_ids)

        # Find direct chain links within the family
        # links: list of (high_id, low_id)
        links: list[tuple[str, str]] = []
        for low_id in node_ids:
            low_node = workflow.get(str(low_id))
            if not isinstance(low_node, dict):
                continue
            latent_ref = low_node.get("inputs", {}).get("latent_image")
            if not isinstance(latent_ref, list) or len(latent_ref) != 2:
                continue
            high_id = str(latent_ref[0])
            if high_id in family_set and latent_ref[1] == 0:
                links.append((high_id, low_id))

        # Build adjacency: who is fed by whom (same-family only)
        # feeds[X] = set of Y where X feeds Y (X is HIGH for Y)
        feeds: dict[str, set[str]] = {nid: set() for nid in node_ids}
        is_low: set[str] = set()
        for hi, lo in links:
            feeds[hi].add(lo)
            is_low.add(lo)

        # Connected components in the undirected version of the chain graph
        # (we need to check component size before pairing)
        adj: dict[str, set[str]] = {nid: set() for nid in node_ids}
        for hi, lo in links:
            adj[hi].add(lo)
            adj[lo].add(hi)

        visited: set[str] = set()

        def _component(start: str) -> set[str]:
            comp: set[str] = set()
            stack = [start]
            while stack:
                cur = stack.pop()
                if cur in comp:
                    continue
                comp.add(cur)
                stack.extend(adj[cur] - comp)
            return comp

        for nid in node_ids:
            if nid in visited:
                continue
            comp = _component(nid)
            visited.update(comp)

            # Only pair when the connected component has exactly two members
            # (one source, one sink).  3+ → no pair (O1 deferred).
            if len(comp) != 2:
                continue

            # Extract the single link within this 2-node component
            comp_links = [(hi, lo) for hi, lo in links if hi in comp and lo in comp]
            if len(comp_links) != 1:
                continue
            high_id, low_id = comp_links[0]

            high_node = workflow.get(str(high_id), {})
            low_node = workflow.get(str(low_id), {})
            high_inputs = high_node.get("inputs", {})
            low_inputs = low_node.get("inputs", {})

            # Signal-3: family-specific boundary check
            if family == "KSamplerAdvanced":
                if not _ksa_boundary_ok(high_inputs, low_inputs):
                    continue
                # Direction-marker consistency: signal-2 says high_id is feeder,
                # signal-3 confirms add_noise=enable on high.  Already checked above.
                split = int(high_inputs["end_at_step"])
                split_targets = {
                    f"{high_id}.end_at_step": "split",
                    f"{low_id}.start_at_step": "split",
                }
                owned_keys = [
                    f"{high_id}.steps", f"{low_id}.steps",
                    f"{high_id}.end_at_step", f"{low_id}.start_at_step",
                ]
            else:  # ClownsharKSampler_Beta
                if not _clownshark_boundary_ok(high_inputs, low_inputs):
                    continue
                split = int(high_inputs["steps_to_run"])
                split_targets = {
                    f"{high_id}.steps_to_run": "split",
                }
                owned_keys = [
                    f"{high_id}.steps", f"{low_id}.steps",
                    f"{high_id}.steps_to_run",
                ]

            high_steps = int(high_inputs.get("steps", 0))
            low_steps = int(low_inputs.get("steps", 0))
            steps_mismatch = high_steps != low_steps

            meta_title = high_node.get("_meta", {}).get("title", "")
            label: str | None = None
            if meta_title and meta_title not in ("KSamplerAdvanced", "ClownsharKSampler_Beta"):
                label = meta_title

            pair: dict[str, Any] = {
                "family": family,
                "high_node_id": high_id,
                "low_node_id": low_id,
                "total": high_steps,
                "split": split,
                "steps_mismatch": steps_mismatch,
                "total_targets": [f"{high_id}.steps", f"{low_id}.steps"],
                "split_targets": split_targets,
                "owned_keys": owned_keys,
            }
            if label is not None:
                pair["label"] = label

            pairs.append(pair)

    return pairs

_PRIMITIVE_TYPES = {"PrimitiveInt", "PrimitiveFloat", "Primitive int [Crystools]"}

# Literal-bearing field names a seed wire can terminate in, in priority order:
# Seed (rgthree) / Seed nodes use `seed`, RandomNoise uses `noise_seed`,
# PrimitiveInt uses `value`.
_SEED_VALUE_KEYS = ("seed", "noise_seed", "value")


def _next_upstream_refs(inputs: dict[str, Any], prefer_keys: tuple[str, ...]) -> list[list]:
    """Wired (list) inputs to follow upstream. When prefer_keys is set and the
    node carries a matching wired input (e.g. a resize node with both 'width' and
    'height'), follow ONLY that dimension so width/height don't conflate. Falls
    back to all wired inputs when no preferred key is present (e.g. an aspect-ratio
    switch whose inputs are ANY/IF_TRUE/IF_FALSE)."""
    wired = [v for v in inputs.values() if isinstance(v, list) and len(v) >= 2]
    if prefer_keys:
        preferred = [v for k, v in inputs.items()
                     if k in prefer_keys and isinstance(v, list) and len(v) >= 2]
        if preferred:
            return preferred
    return wired


def _walk_upstream_value(workflow: dict[str, Any], wired_ref: list, max_depth: int = 8,
                         prefer_keys: tuple[str, ...] = (),
                         value_keys: tuple[str, ...] = ("value",)) -> int | float | None:
    """Follow a wired input upstream to find its literal numeric value.

    Handles chains like: EmptyLTXVLatentVideo.width ← ComfyMathExpression ← PrimitiveInt,
    or SamplerCustom.noise_seed ← PrimitiveInt ← Seed (rgthree).
    prefer_keys biases the walk toward the matching dimension at each hop;
    value_keys are the literal-bearing fields to terminate on (e.g. `value` for
    dimensions, `seed`/`noise_seed`/`value` for seeds).
    Returns None if no literal value is found within max_depth hops.
    """
    seen: set[str] = set()
    queue: list[tuple[str, int]] = []

    # wired_ref is [node_id, output_index]
    if isinstance(wired_ref, list) and len(wired_ref) >= 2:
        queue.append((str(wired_ref[0]), 0))

    while queue:
        node_id, depth = queue.pop(0)
        if depth > max_depth or node_id in seen:
            continue
        seen.add(node_id)

        node = workflow.get(node_id)
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs", {})

        # Terminate on the first literal-bearing field, in priority order.
        for vk in value_keys:
            if vk in inputs and isinstance(inputs[vk], (int, float)):
                return inputs[vk]

        # Follow wired inputs upstream — biased toward the matching dimension.
        for val in _next_upstream_refs(inputs, prefer_keys):
            queue.append((str(val[0]), depth + 1))

    return None


def _detect_resolution_nodes(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    """Detect nodes with width/height resolution values.

    Three-step approach:
    1. Known latent nodes with literal width/height values.
    2. Known latent nodes with wired width/height — walk upstream to find source values.
       The upstream source node becomes the override target (e.g. PrimitiveInt "Width").
    3. Other nodes with literal width/height values.
    """
    results: list[dict[str, Any]] = []
    found_ids: set[str] = set()

    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type", "")
        inputs = node.get("inputs", {})
        title = node.get("_meta", {}).get("title", "")

        # Check for width/height or width_override/height_override
        w_key = "width_override" if "width_override" in inputs else "width" if "width" in inputs else None
        h_key = "height_override" if "height_override" in inputs else "height" if "height" in inputs else None
        if not w_key or not h_key:
            continue

        w_val = inputs[w_key]
        h_val = inputs[h_key]
        w_wired = isinstance(w_val, list)
        h_wired = isinstance(h_val, list)

        is_known = class_type in _KNOWN_LATENT_NODES or class_type.startswith("SDXLEmptyLatent")

        # For known latent nodes with wired values, walk upstream to find source
        if is_known and (w_wired or h_wired):
            upstream_w = _walk_upstream_value(workflow, w_val, prefer_keys=("width", "width_override")) if w_wired else None
            upstream_h = _walk_upstream_value(workflow, h_val, prefer_keys=("height", "height_override")) if h_wired else None
            literal_w = int(w_val) if not w_wired and isinstance(w_val, (int, float)) else None
            literal_h = int(h_val) if not h_wired and isinstance(h_val, (int, float)) else None

            resolved_w = literal_w if literal_w is not None else (int(upstream_w) if upstream_w is not None else None)
            resolved_h = literal_h if literal_h is not None else (int(upstream_h) if upstream_h is not None else None)

            if resolved_w is not None or resolved_h is not None:
                # Find the actual source nodes for overriding
                w_source = _find_upstream_source(workflow, w_val, prefer_keys=("width", "width_override")) if w_wired else None
                h_source = _find_upstream_source(workflow, h_val, prefer_keys=("height", "height_override")) if h_wired else None

                entry: dict[str, Any] = {
                    "node_id": node_id,
                    "class_type": class_type,
                    "label": title or class_type,
                    "category": "latent",
                }
                if resolved_w is not None:
                    entry["width"] = resolved_w
                if resolved_h is not None:
                    entry["height"] = resolved_h

                # If source is a different node (e.g. PrimitiveInt), record override targets
                if w_source and w_source[0] != node_id:
                    entry["width_source_node"] = w_source[0]
                    entry["width_source_field"] = w_source[1]
                if h_source and h_source[0] != node_id:
                    entry["height_source_node"] = h_source[0]
                    entry["height_source_field"] = h_source[1]

                results.append(entry)
                found_ids.add(node_id)
                continue

        # Skip if both are wired (and not a known latent — handled above)
        if w_wired and h_wired:
            continue

        entry = {
            "node_id": node_id,
            "class_type": class_type,
            "label": title or class_type,
            "category": "latent" if is_known else "other",
        }
        if not w_wired and isinstance(w_val, (int, float)):
            entry["width"] = int(w_val)
        if not h_wired and isinstance(h_val, (int, float)):
            entry["height"] = int(h_val)

        results.append(entry)
        found_ids.add(node_id)

    return results


def _find_upstream_source(workflow: dict[str, Any], wired_ref: list, max_depth: int = 8,
                          prefer_keys: tuple[str, ...] = (),
                          value_keys: tuple[str, ...] = ("value",)) -> tuple[str, str] | None:
    """Find the upstream source node and field that holds a literal numeric value.

    prefer_keys biases the walk toward the matching dimension at each hop, so a
    resize node carrying both width+height routes to the right source primitive.
    value_keys are the literal-bearing fields to terminate on (e.g. `value` for
    dimensions, `seed`/`noise_seed`/`value` for seeds).
    Returns (node_id, field_name) of the node whose value should be overridden.
    """
    seen: set[str] = set()
    queue: list[tuple[str, int]] = []

    if isinstance(wired_ref, list) and len(wired_ref) >= 2:
        queue.append((str(wired_ref[0]), 0))

    while queue:
        node_id, depth = queue.pop(0)
        if depth > max_depth or node_id in seen:
            continue
        seen.add(node_id)

        node = workflow.get(node_id)
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs", {})

        # Terminate on the first node carrying a literal in a value_keys field.
        for vk in value_keys:
            if vk in inputs and isinstance(inputs[vk], (int, float)):
                return (node_id, vk)

        # Follow wired inputs upstream — biased toward the matching dimension.
        for val in _next_upstream_refs(inputs, prefer_keys):
            queue.append((str(val[0]), depth + 1))

    return None


_FRAME_COUNT_FIELDS = {"length", "frames_number", "num_frames", "video_frames"}

_FRAME_COUNT_NODES = {
    "EmptyLTXVLatentVideo", "LTXVEmptyLatentAudio",
    "WanImageToVideo", "WanAnimateToVideoEnhanced",
    "EmptyMochiLatentVideo", "EmptyHunyuanLatentVideo",
    "EmptyCosmosLatentVideo",
}


def _detect_frame_count(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    """Detect frame/length count fields in video workflows.

    Looks for known video latent nodes with frame count fields.
    When the value is wired, walks upstream to find the source literal.
    """
    results: list[dict[str, Any]] = []
    seen_sources: set[str] = set()

    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type", "")
        if class_type not in _FRAME_COUNT_NODES:
            continue
        inputs = node.get("inputs", {})
        title = node.get("_meta", {}).get("title", "")

        for field_name in _FRAME_COUNT_FIELDS:
            if field_name not in inputs:
                continue
            val = inputs[field_name]
            is_wired = isinstance(val, list)

            if is_wired:
                resolved = _walk_upstream_value(workflow, val)
                source = _find_upstream_source(workflow, val)
                if resolved is not None and source is not None:
                    # Deduplicate — multiple nodes may wire from the same source
                    source_key = f"{source[0]}.{source[1]}"
                    if source_key in seen_sources:
                        continue
                    seen_sources.add(source_key)
                    source_node = workflow.get(source[0], {})
                    source_title = source_node.get("_meta", {}).get("title", "")
                    results.append({
                        "node_id": node_id,
                        "class_type": class_type,
                        "label": source_title or title or class_type,
                        "field": field_name,
                        "value": int(resolved),
                        "source_node": source[0],
                        "source_field": source[1],
                    })
            elif isinstance(val, (int, float)):
                results.append({
                    "node_id": node_id,
                    "class_type": class_type,
                    "label": title or class_type,
                    "field": field_name,
                    "value": int(val),
                })

    return results


_LORA_CLASS_TYPES = {"LoraLoader", "LoraLoaderModelOnly"}
_POWER_LORA_CLASS_TYPE = "Power Lora Loader (rgthree)"


def _detect_lora_nodes(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    """Detect LoRA loader nodes and their current settings.

    Returns list of {node_id, class_type, label, lora_name, strength_model, strength_clip?}
    for regular loaders, and {node_id, lora_key, class_type, label, lora_name, strength_model,
    on, is_power} for each lora_N entry in Power Lora Loader (rgthree) nodes. All entries are
    ordered by their chain position (follows model input wiring).
    """
    # Collect one entry per node-level chain participant (for ordering); power nodes
    # contribute a single chain slot but expand to N rows below.
    lora_nodes: dict[str, dict[str, Any]] = {}
    # Power rows are stored per (node_id, lora_key) so they can be expanded after ordering.
    power_rows: dict[str, list[dict[str, Any]]] = {}  # node_id -> list of row dicts

    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type", "")
        inputs = node.get("inputs", {})
        title = node.get("_meta", {}).get("title", "")

        if class_type in _LORA_CLASS_TYPES:
            entry: dict[str, Any] = {
                "node_id": node_id,
                "class_type": class_type,
                "label": title or class_type,
                "lora_name": inputs.get("lora_name", ""),
            }
            sm = inputs.get("strength_model")
            if isinstance(sm, (int, float)):
                entry["strength_model"] = round(float(sm), 3)
            sc = inputs.get("strength_clip")
            if isinstance(sc, (int, float)) and class_type == "LoraLoader":
                entry["strength_clip"] = round(float(sc), 3)
            model_input = inputs.get("model")
            if isinstance(model_input, list) and len(model_input) >= 2:
                entry["_model_source"] = str(model_input[0])
            lora_nodes[node_id] = entry

        elif class_type == _POWER_LORA_CLASS_TYPE:
            # Collect per-lora_N rows; store a chain-level placeholder for ordering.
            rows: list[dict[str, Any]] = []
            for key, val in inputs.items():
                if not (key.startswith("lora_") and key[5:].isdigit()):
                    continue
                if not isinstance(val, dict):
                    continue
                # Must have at least the 'lora' field to be a real lora entry
                if "lora" not in val:
                    continue
                raw_strength = val.get("strength", 1)
                strength_model = round(float(raw_strength), 3) if isinstance(raw_strength, (int, float)) else 1.0
                row: dict[str, Any] = {
                    "node_id": node_id,
                    "lora_key": key,
                    "class_type": class_type,
                    "label": title or class_type,
                    "lora_name": val.get("lora", ""),
                    "strength_model": strength_model,
                    "on": bool(val.get("on", True)),
                    "is_power": True,
                }
                rows.append(row)
            if rows:
                # Sort rows by lora_N index so lora_1 < lora_2 < ...
                rows.sort(key=lambda r: int(r["lora_key"][5:]))
                power_rows[node_id] = rows
                # Chain placeholder — carries model source for ordering; power rows inherit chain_id
                placeholder: dict[str, Any] = {"node_id": node_id, "_is_power_placeholder": True}
                model_input = inputs.get("model")
                if isinstance(model_input, list) and len(model_input) >= 2:
                    placeholder["_model_source"] = str(model_input[0])
                lora_nodes[node_id] = placeholder

    # Order by chain: start from nodes whose model source is not another LoRA
    all_lora_ids = set(lora_nodes.keys())
    ordered: list[dict[str, Any]] = []
    remaining = dict(lora_nodes)

    # Find roots (LoRAs whose model source is not another LoRA in the set)
    roots = [nid for nid, n in remaining.items()
             if n.get("_model_source") not in all_lora_ids]
    placed: set[str] = set()
    chain_id = 0
    for root in roots:
        current: str | None = root
        chain_assigned = False
        while current and current in remaining and current not in placed:
            node_entry = remaining[current]
            placed.add(current)
            if node_entry.get("_is_power_placeholder"):
                # Expand to one row per lora_N, all sharing this chain_id
                for row in power_rows.get(current, []):
                    row_copy = dict(row)
                    row_copy["chain_id"] = chain_id
                    ordered.append(row_copy)
            else:
                clean = {k: v for k, v in node_entry.items() if not k.startswith("_")}
                clean["chain_id"] = chain_id
                ordered.append(clean)
            chain_assigned = True
            current = next(
                (nid for nid, n in remaining.items()
                 if n.get("_model_source") == current and nid not in placed),
                None,
            )
        if chain_assigned:
            chain_id += 1

    # Add any remaining (disconnected) nodes — each gets its own chain_id
    for nid, node_entry in remaining.items():
        if nid not in placed:
            if node_entry.get("_is_power_placeholder"):
                for row in power_rows.get(nid, []):
                    row_copy = dict(row)
                    row_copy["chain_id"] = chain_id
                    ordered.append(row_copy)
            else:
                clean = {k: v for k, v in node_entry.items() if not k.startswith("_")}
                clean["chain_id"] = chain_id
                ordered.append(clean)
            chain_id += 1

    return ordered


def _apply_power_lora_overrides(workflow: dict, entries: list[dict]) -> dict:
    """Apply Power Lora Loader overrides by direct workflow mutation.

    Each entry: {node_id, lora_key, on, lora, strength, add?: true}.
    For a normal entry, mutates workflow[node_id]["inputs"][lora_key] in place
    (preserving any extra keys). For add:true, inserts a new lora_key only if
    that key does not already exist in the node. Skips gracefully if the node
    is missing or is not a Power Lora Loader node.
    """
    for entry in entries:
        node_id = str(entry.get("node_id", ""))
        lora_key = str(entry.get("lora_key", ""))
        node = workflow.get(node_id)
        if not node or not isinstance(node, dict):
            continue
        if node.get("class_type") != _POWER_LORA_CLASS_TYPE:
            continue
        inputs = node.setdefault("inputs", {})
        is_add = bool(entry.get("add"))
        if is_add:
            # Reallocate to the next free lora_N index on collision rather than
            # silently dropping the entry (e.g. when a lora_N with no 'lora' field
            # occupies a slot that escaped detection).
            if lora_key in inputs:
                existing_ns = {
                    int(k[5:]) for k in inputs
                    if k.startswith("lora_") and k[5:].isdigit()
                }
                n = 1
                while n in existing_ns:
                    n += 1
                lora_key = f"lora_{n}"
            inputs[lora_key] = {
                "on": bool(entry.get("on", True)),
                "lora": str(entry.get("lora", "")),
                "strength": float(entry.get("strength", 1.0)),
            }
        else:
            existing = inputs.get(lora_key)
            if isinstance(existing, dict):
                # Merge — preserve any unknown extra keys
                existing["on"] = bool(entry.get("on", True))
                existing["lora"] = str(entry.get("lora", existing.get("lora", "")))
                existing["strength"] = float(entry.get("strength", existing.get("strength", 1.0)))
            else:
                inputs[lora_key] = {
                    "on": bool(entry.get("on", True)),
                    "lora": str(entry.get("lora", "")),
                    "strength": float(entry.get("strength", 1.0)),
                }
    return workflow


_REF_VIDEO_NODES = {"VHS_LoadVideo"}
_REF_VIDEO_FIELDS = {
    "frame_load_cap": "Frames",
    "force_rate": "FPS",
    "skip_first_frames": "Skip First",
    "select_every_nth": "Every Nth",
}


def _detect_reference_video(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    """Detect reference video loader nodes and their overridable controls."""
    results: list[dict[str, Any]] = []
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type", "")
        if class_type not in _REF_VIDEO_NODES:
            continue
        inputs = node.get("inputs", {})
        title = node.get("_meta", {}).get("title", "")

        controls: list[dict[str, Any]] = []
        for field, display_name in _REF_VIDEO_FIELDS.items():
            val = inputs.get(field)
            if isinstance(val, (int, float)):
                controls.append({
                    "field": field,
                    "label": display_name,
                    "value": val,
                })

        if controls:
            results.append({
                "node_id": node_id,
                "class_type": class_type,
                "label": title or class_type,
                "controls": controls,
            })
    return results


def _is_used_as_negative(workflow: dict[str, Any], source_node_id: str) -> bool:
    """Check if a node's output is used as negative conditioning.

    BFS downstream from the source.  When we reach a node via a 'positive'
    or 'negative' input we record that fact but do NOT continue following
    through that node (those are terminal for our purposes).  We only keep
    following through non-conditioning connections (e.g. 'conditioning',
    'samples', etc.) so intermediate passthrough nodes are handled.

    Returns True only if we find a 'negative' hit without any 'positive' hit.
    """
    visited: set[str] = set()
    queue = [source_node_id]
    has_negative = False
    has_positive = False

    while queue:
        nid = queue.pop()
        if nid in visited:
            continue
        visited.add(nid)
        for other_id, other_node in workflow.items():
            if not isinstance(other_node, dict):
                continue
            for input_name, input_val in other_node.get("inputs", {}).items():
                if isinstance(input_val, list) and len(input_val) == 2 and str(input_val[0]) == nid:
                    if input_name == "negative":
                        has_negative = True
                        # Don't follow further — this is a terminal
                    elif input_name == "positive":
                        has_positive = True
                        # Don't follow further — this is a terminal
                    else:
                        # Passthrough connection — keep following
                        queue.append(other_id)

    return has_negative and not has_positive


_TEXT_INPUT_NAMES = {
    "text", "prompt", "string", "message", "caption", "description",
    "system_prompt", "user_message", "user_message_box", "instruction",
}


def _is_text_input(name: str, value: str) -> bool:
    """Heuristic: is this a meaningful text field worth overriding?"""
    name_lower = name.lower()
    # Match known text-related input names
    for tn in _TEXT_INPUT_NAMES:
        if tn in name_lower:
            return True
    # Also include any long string (likely prose, not config)
    if len(value) > 50:
        # But skip things that look like paths or keys
        if value.startswith("/") or value.startswith("sk-") or value.startswith("http"):
            return False
        return True
    return False


def _extract_override_prompt(
    output_data: dict[str, Any], overrides: dict[str, str] | None
) -> str:
    """Resolve the prompt to record for THIS job's artifact metadata.

    A text OVERRIDE wins — it is the prompt actually submitted for this specific
    job. comfy-gen's returned `prompt` is read from the workflow JSON's node text,
    which is SHARED across a batch that varies the prompt only via per-job --override
    flags; preferring it mis-records the same prompt for every image in the batch
    (sgs-ui-* batch-prompt bug). Falls back to the returned prompt only when no text
    override was sent (prompt baked into the workflow).

    Uses the SAME heuristic as detection (_is_text_input) so a manual prompt in any
    text field — `value`, `string`, prose, not just `text` — is captured, and picks
    the longest match (the prose, not a short config value like a sampler name).
    """
    if overrides:
        text_vals = [
            v for k, v in overrides.items()
            if isinstance(v, str) and v.strip() and _is_text_input(k.rsplit(".", 1)[-1], v)
        ]
        if text_vals:
            return max(text_vals, key=len)
    return output_data.get("prompt", "")


def _walk_upstream_text(
    workflow: dict[str, Any],
    start_node_id: str,
    start_input: str,
    seen: set[tuple[str, str]],
    max_depth: int = 8,
) -> list[dict[str, Any]]:
    """Walk upstream from a wired text input, collecting literal text fields.

    Follows wires through intermediate nodes (prompt generators, string
    processors, etc.) until it finds literal text values worth overriding.
    """
    results: list[dict[str, Any]] = []
    # BFS queue: (node_id, input_name_that_is_wired, depth)
    queue: list[tuple[str, str, int]] = [(start_node_id, start_input, 0)]
    visited: set[str] = set()

    while queue:
        node_id, wired_input, depth = queue.pop(0)
        if depth > max_depth or node_id in visited:
            continue
        visited.add(node_id)

        node = workflow.get(node_id)
        if not isinstance(node, dict):
            continue

        wired_val = node.get("inputs", {}).get(wired_input)
        if not isinstance(wired_val, list) or len(wired_val) != 2:
            continue

        upstream_id = str(wired_val[0])
        upstream_node = workflow.get(upstream_id)
        if not isinstance(upstream_node, dict):
            continue

        up_title = upstream_node.get("_meta", {}).get("title", "")
        up_class = upstream_node.get("class_type", "")
        found_literal = False

        # PrimitiveStringMultiline always has a text "value" field
        is_primitive_string = up_class in ("PrimitiveStringMultiline", "PrimitiveString")

        for inp_name, inp_val in upstream_node.get("inputs", {}).items():
            is_text = _is_text_input(inp_name, inp_val if isinstance(inp_val, str) else "")
            # For primitive string nodes, "value" is always a text field
            if is_primitive_string and inp_name == "value" and isinstance(inp_val, str):
                is_text = True
            if isinstance(inp_val, str) and is_text:
                key = (upstream_id, inp_name)
                if key in seen:
                    continue
                seen.add(key)
                results.append({
                    "node_id": upstream_id,
                    "input_name": inp_name,
                    "current_value": inp_val,
                    "label": up_title or up_class or f"Node #{upstream_id}",
                    "field_name": inp_name,
                })
                found_literal = True
            elif isinstance(inp_val, list) and len(inp_val) == 2 and _is_text_input(inp_name, ""):
                # Text-like input that is itself wired — follow it deeper
                queue.append((upstream_id, inp_name, depth + 1))

        # If no literal text found on this node, follow all text-like wired inputs
        if not found_literal:
            for inp_name, inp_val in upstream_node.get("inputs", {}).items():
                if isinstance(inp_val, list) and len(inp_val) == 2:
                    # Heuristic: follow inputs that could carry text
                    name_lower = inp_name.lower()
                    is_text_wire = any(tn in name_lower for tn in _TEXT_INPUT_NAMES)
                    if is_text_wire and (upstream_id, inp_name) not in visited:
                        queue.append((upstream_id, inp_name, depth + 1))

    return results


def _detect_text_overrides(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    """Find overridable text fields from CLIPTextEncode nodes and upstream.

    Walks upstream through wired text inputs recursively to find literal
    text values, even through intermediate nodes like prompt generators.

    Returns a list of {node_id, input_name, current_value, label} for each field.
    """
    overrides: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") != "CLIPTextEncode":
            continue
        if _is_used_as_negative(workflow, node_id):
            continue

        title = node.get("_meta", {}).get("title", "")
        text_input = node.get("inputs", {}).get("text")

        if isinstance(text_input, str):
            # Direct literal text on CLIPTextEncode
            key = (node_id, "text")
            if key not in seen:
                seen.add(key)
                overrides.append({
                    "node_id": node_id,
                    "input_name": "text",
                    "current_value": text_input,
                    "label": title or f"Prompt #{node_id}",
                })
        elif isinstance(text_input, list) and len(text_input) == 2:
            # Wired — walk upstream recursively to find literal text
            upstream = _walk_upstream_text(workflow, node_id, "text", seen)
            overrides.extend(upstream)

    return overrides


_COMFYGEN_SUFFIX = "_ComfyGen"
# Title marker with an optional explicit type hint:
#   "Shift_ComfyGen"        -> base "Shift", no forced type
#   "Shift_ComfyGen_float"  -> base "Shift", forced type "float"
_COMFYGEN_RE = re.compile(r"^(?P<base>.*)_ComfyGen(?:_(?P<hint>int|float|string))?$")

# Authoritative ComfyUI input types, baked from /object_info (sgs-ui-xaqf).
# A workflow's API JSON cannot distinguish INT from FLOAT for whole numbers
# (`5` is `5`), so the static map is the source of truth: {class_type:
# {input_name: "INT"|"FLOAT"|"STRING"|"COMBO"|"BOOLEAN"}}. Regenerate with
# scripts/gen_comfyui_input_types.py. Missing file → empty map → value-guess.
_INPUT_TYPES_PATH = Path(__file__).resolve().parent / "data" / "comfyui_input_types.json"
try:
    _COMFYUI_INPUT_TYPES: dict[str, dict[str, str]] = json.loads(_INPUT_TYPES_PATH.read_text())
except (OSError, ValueError):
    _COMFYUI_INPUT_TYPES = {}

# ComfyUI INPUT_TYPES tag -> our WorkflowSetting type. COMBO (enum) and BOOLEAN
# are deliberately absent: enums aren't free-text str/int/float, and bool is out
# of scope — both map to None so the field is skipped.
_SCHEMA_TYPE_MAP = {"INT": "int", "FLOAT": "float", "STRING": "string"}


def _comfygen_value_type(value: Any) -> str | None:
    """Map a literal input value to a WorkflowSetting type, or None if it is not
    an overrideable String/Int/Float. bool is a subclass of int in Python, so it
    must be rejected before the int check."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    if isinstance(value, str):
        return "string"
    return None


def _comfygen_field_type(class_type: str, input_name: str, value: Any, hint: str | None) -> str | None:
    """Resolve the override type for one input, by priority:

    1. Explicit title hint (author intent wins) — applies to any literal scalar.
    2. Baked ComfyUI object_info schema (authoritative INT vs FLOAT).
    3. Value-based guess (legacy fallback for nodes not in the schema).

    Returns None when the input should not surface (wired, bool, enum/COMBO, or
    an unknown non-scalar).
    """
    # Wired inputs ([node_id, slot]) are never overrideable.
    if isinstance(value, list):
        return None
    # A hint forces the type, but only for a real scalar literal (not bool/None).
    if hint is not None:
        return hint if _comfygen_value_type(value) is not None else None
    schema_tag = _COMFYUI_INPUT_TYPES.get(class_type, {}).get(input_name)
    if schema_tag is not None:
        # Known input: trust the schema. COMBO/BOOLEAN -> None (skip).
        return _SCHEMA_TYPE_MAP.get(schema_tag)
    # Unknown node/input: fall back to the literal's runtime type.
    return _comfygen_value_type(value)


def _detect_comfygen_overrides(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    """Surface overrideable values from nodes tagged via their title.

    Any node whose _meta.title ends with "_ComfyGen" (optionally
    "_ComfyGen_<int|float|string>" to force a type) exposes EACH of its literal
    String/Int/Float inputs as an entry {node_id, field, label, type,
    current_value}, keyed <node_id>.<field> for runtime override. Types come
    from the title hint, then the baked object_info schema, then the literal's
    value. Wired/bool/enum inputs are skipped. The label strips the suffix; when
    a node yields more than one field, each is disambiguated by its input name.
    """
    results: list[dict[str, Any]] = []

    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        title = node.get("_meta", {}).get("title", "")
        if not isinstance(title, str):
            continue
        match = _COMFYGEN_RE.match(title)
        if not match:
            continue

        stripped = match.group("base").rstrip(" _")
        hint = match.group("hint")
        class_type = node.get("class_type", "")
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            continue

        # Collect qualifying literal inputs in declaration order.
        fields: list[tuple[str, str, Any]] = []  # (input_name, type, value)
        for input_name, value in inputs.items():
            vtype = _comfygen_field_type(class_type, input_name, value, hint)
            if vtype is not None:
                fields.append((input_name, vtype, value))

        multi = len(fields) > 1
        for input_name, vtype, value in fields:
            if multi:
                label = f"{stripped} · {input_name}" if stripped else input_name
            else:
                label = stripped or input_name
            results.append({
                "node_id": node_id,
                "field": input_name,
                "label": label,
                "type": vtype,
                "current_value": value,
            })

    return results


# ---- Progress parsing ----

# Matches: [258s] inference: (33/57) KSampler Step 1/4 (38%
# Groups: elapsed, stage, node_done, node_total, detail
_PROGRESS_RE = re.compile(
    r"\[(\d+)s\]\s+(\w+):\s+\((\d+)/(\d+)\)\s*(.*)"
)


# ---- Submit stdout classification ----


class SubmitResult:
    """Result of parsing+classifying `comfy-gen submit` stdout.

    Caller decides what to surface based on `kind`; the helper is
    exit-code-agnostic so structured errors (e.g. missing_models) are
    recognized whether the CLI exited 0 or 1.
    """
    __slots__ = ("kind", "parsed", "missing_models", "error_type", "error_message", "raw")

    def __init__(self, kind: str, *, parsed: dict[str, Any] | None = None,
                 missing_models: list[dict[str, Any]] | None = None,
                 error_type: str | None = None, error_message: str = "", raw: str = ""):
        # kind: 'success' | 'missing_models' | 'structured_error' | 'parse_failure' | 'empty'
        self.kind = kind
        self.parsed = parsed
        self.missing_models = list(missing_models) if missing_models else []
        self.error_type = error_type
        self.error_message = error_message
        self.raw = raw


def _classify_submit_stdout(stdout: str) -> SubmitResult:
    """Parse + classify `comfy-gen submit` stdout once, regardless of returncode.

    Replaces the two parallel error-handling branches that used to live
    inside `_run_comfy_job` (one inside `if returncode != 0`, one inside
    the rc==0 success path). Audit item A.1.5.
    """
    if not stdout.strip():
        return SubmitResult(kind="empty", raw=stdout)
    try:
        parsed = json.loads(stdout)
    except (json.JSONDecodeError, ValueError):
        return SubmitResult(kind="parse_failure", raw=stdout)
    if not isinstance(parsed, dict):
        return SubmitResult(kind="parse_failure", raw=stdout)

    output_data = parsed.get("output") if isinstance(parsed.get("output"), dict) else {}
    error_type = parsed.get("error_type") or output_data.get("error_type")

    if error_type == "missing_models":
        missing = parsed.get("missing_models") or output_data.get("missing_models") or []
        message = (parsed.get("error_message")
                   or output_data.get("error_message")
                   or "Missing models")
        return SubmitResult(
            kind="missing_models",
            parsed=parsed,
            missing_models=list(missing),
            error_type=error_type,
            error_message=message,
        )

    if error_type:
        message = (parsed.get("error_message")
                   or output_data.get("error_message")
                   or error_type)
        return SubmitResult(
            kind="structured_error",
            parsed=parsed,
            error_type=error_type,
            error_message=message,
        )

    if (parsed.get("ok") is False
            or output_data.get("ok") is False
            or parsed.get("status") == "error"
            or output_data.get("status") == "error"):
        message = (parsed.get("error_message")
                   or output_data.get("error_message")
                   or parsed.get("error")
                   or output_data.get("error")
                   or "comfy-gen returned an error")
        return SubmitResult(
            kind="structured_error",
            parsed=parsed,
            error_type="ok_false",
            error_message=str(message),
        )

    return SubmitResult(kind="success", parsed=parsed)


def _parse_progress_line(line: str) -> dict[str, Any] | None:
    """Parse a comfy-gen stderr progress line into structured data."""
    m = _PROGRESS_RE.match(line.strip())
    if not m:
        return None
    elapsed, stage, node_done, node_total, detail = m.groups()
    node_done_i, node_total_i = int(node_done), int(node_total)
    node_percent = round(node_done_i / node_total_i * 100) if node_total_i else 0

    result: dict[str, Any] = {
        "progress_stage": stage,
        "progress_percent": node_percent,
        "progress_node": node_done_i,
        "progress_node_total": node_total_i,
    }

    # Parse "KSampler Step 1/4 (38%" from detail
    step_match = re.search(r"Step (\d+)/(\d+)", detail)
    if step_match:
        result["progress_step"] = int(step_match.group(1))
        result["progress_total_steps"] = int(step_match.group(2))

    # Build a human-readable message from the detail, strip trailing "(38%"
    clean_detail = re.sub(r"\s*\(\d+%$", "", detail).strip() if detail.strip() else ""
    result["progress_message"] = clean_detail or f"Node {node_done}/{node_total}"

    return result


def _resolve_local_path(media_url: str) -> str:
    """Resolve a /outputs/ URL to a local filesystem path."""
    if media_url.startswith("/outputs/"):
        return str(config.LOCAL_OUTPUT_DIR / media_url.split("/outputs/", 1)[1])
    return media_url


# ---- Job runner ----

def _download_output(url: str, job_id: str) -> Path:
    """Download an output file from S3 to local /outputs."""
    ext = url.rsplit(".", 1)[-1].split("?")[0].lower()
    if ext not in ("png", "jpg", "jpeg", "webp", "mp4", "webm", "gif"):
        ext = "png"
    ts = time.strftime("%Y%m%d_%H%M%S")
    filename = f"{ts}_comfy_{job_id[:8]}.{ext}"
    path = config.LOCAL_OUTPUT_DIR / filename

    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=max(config.HTTP_TIMEOUT_SEC, 120)) as resp:
        with path.open("wb") as f:
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                f.write(chunk)
    return path


def _run_comfy_job(job_id: str, workflow_path: str, file_inputs: dict[str, str],
                   overrides: dict[str, str] | None = None,
                   endpoint_id: str = "", source: str = "", batch_id: str = "") -> None:
    """Run a ComfyUI workflow via comfy-gen CLI subprocess."""
    t0 = time.time()
    try:
        services._update_job(job_id, status="SUBMITTING")

        # Build comfy-gen command
        comfy_gen = comfy_gen_cli.resolve_comfy_gen()
        cmd = comfy_gen.command("submit", workflow_path, "--timeout", str(config.POLL_TIMEOUT_SEC))
        if endpoint_id:
            cmd.extend(["--endpoint-id", endpoint_id])
        for node_id, local_path in file_inputs.items():
            cmd.extend(["--input", f"{node_id}={local_path}"])
        for key, value in (overrides or {}).items():
            cmd.extend(["--override", f"{key}={value}"])

        print(f"[comfy-gen] Job {job_id} command:\n  {' '.join(cmd)}", flush=True)
        print(f"[comfy-gen] Job {job_id} file_inputs: {json.dumps(file_inputs, default=str)}", flush=True)
        print(f"[comfy-gen] Job {job_id} overrides: {json.dumps(overrides, default=str)}", flush=True)

        # Run as subprocess, streaming stderr for progress
        env_ctx = comfy_gen_cli.settings_subprocess_env(endpoint_id=endpoint_id)
        with env_ctx as env:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )

            # Store process reference so cancel endpoint can kill it
            with state.JOBS_LOCK:
                if job_id in state.JOBS:
                    state.JOBS[job_id]["_proc"] = proc

            services._update_job(job_id, status="RUNNING")

            # Read stderr line by line for progress updates
            assert proc.stderr is not None
            stderr_errors: list[str] = []
            for line in proc.stderr:
                line = line.strip()
                if not line:
                    continue
                progress = _parse_progress_line(line)
                if progress:
                    services._update_job(job_id, **progress)
                elif "IN_QUEUE" in line:
                    services._update_job(job_id, remote_status="IN_QUEUE",
                                         progress_stage="queue", progress_message="In queue...")
                elif "IN_PROGRESS" in line:
                    services._update_job(job_id, remote_status="IN_PROGRESS",
                                         progress_stage="running", progress_message="Running...")
                elif "Uploading" in line:
                    services._update_job(job_id, progress_stage="upload", progress_message="Uploading inputs...")
                elif "Submitting" in line:
                    services._update_job(job_id, progress_stage="submit", progress_message="Submitting...")
                elif "Job submitted" in line:
                    # Extract RunPod job ID: "Job submitted: <remote_id>"
                    match = re.search(r"Job submitted:\s*(\S+)", line)
                    if match:
                        services._update_job(job_id, remote_job_id=match.group(1))
                    services._update_job(job_id, progress_stage="queue", progress_message="Waiting for worker...")
                # Capture validation/error lines from stderr
                elif any(kw in line for kw in ("Failed to validate", "Value not in list",
                                                "not in list", "Error:", "ERROR")):
                    stderr_errors.append(line)

            proc.wait()
            assert proc.stdout is not None
            stdout = proc.stdout.read()

        # Single parse+classify pass — works for rc==0 AND rc!=0, surfacing
        # any structured error (missing_models, future error_types) before
        # falling back to exit-code-based generic failure messages.
        classification = _classify_submit_stdout(stdout)
        elapsed = round(time.time() - t0, 3)

        if classification.kind == "missing_models":
            services._update_job(job_id, status="FAILED",
                                 error=classification.error_message,
                                 missing_models=classification.missing_models,
                                 elapsed_seconds=elapsed)
            return

        if classification.kind == "structured_error":
            services._update_job(job_id, status="FAILED",
                                 error=classification.error_message,
                                 elapsed_seconds=elapsed)
            return

        if classification.kind in ("parse_failure", "empty"):
            if proc.returncode != 0:
                error_msg = (stdout.strip()
                             or f"comfy-gen exited with code {proc.returncode}")
            else:
                error_msg = (f"Invalid JSON from comfy-gen: {stdout[:500]}"
                             if classification.kind == "parse_failure"
                             else "comfy-gen returned empty output")
            services._update_job(job_id, status="FAILED", error=error_msg,
                                 elapsed_seconds=elapsed)
            return

        # kind == "success" — proceed with the result envelope.
        result = classification.parsed

        # Extract output URL from comfy-gen result
        output_data = result.get("output", {})
        media_url = output_data.get("url", "")
        if not media_url:
            # Build a readable error from available info
            error_parts: list[str] = []

            # Check for explicit error field
            if output_data.get("error"):
                error_parts.append(str(output_data["error"]))

            # Check for ComfyUI node errors (validation failures like missing models)
            node_errors = output_data.get("node_errors") or result.get("node_errors")
            if isinstance(node_errors, dict):
                for node_id, err_info in node_errors.items():
                    if isinstance(err_info, dict):
                        for msg in err_info.get("errors", []):
                            detail = msg.get("message", str(msg)) if isinstance(msg, dict) else str(msg)
                            error_parts.append(f"Node {node_id}: {detail}")
                    else:
                        error_parts.append(f"Node {node_id}: {err_info}")

            # Check for ComfyUI prompt validation errors in logs field
            logs = output_data.get("logs") or result.get("logs") or ""
            if isinstance(logs, str):
                for line in logs.splitlines():
                    if "Failed to validate" in line or "Value not in list" in line:
                        error_parts.append(line.strip())

            # Include any validation errors captured from stderr
            if stderr_errors:
                error_parts.extend(stderr_errors)

            if not error_parts:
                # Fallback: show job_id and elapsed for debugging
                job_ref = output_data.get("job_id", result.get("job_id", ""))[:12]
                error_parts.append(f"ComfyUI returned no output (job {job_ref}). "
                                   "This usually means a required model is missing or a node failed validation.")

            services._update_job(job_id, status="FAILED",
                                 error="\n".join(error_parts),
                                 elapsed_seconds=round(time.time() - t0, 3))
            return

        seed = output_data.get("seed")
        model_hashes = output_data.get("model_hashes") or {}
        resolution = output_data.get("resolution") or {}
        remote_job_id = result.get("job_id", "")
        services._update_job(job_id, video_url=str(media_url), seed=seed,
                             model_hashes=model_hashes, remote_job_id=remote_job_id)

        try:
            local_path = _download_output(str(media_url), job_id)
            local_url = f"/outputs/{local_path.name}"
            services._update_job(job_id, local_file=str(local_path),
                                 local_video_url=local_url, local_image_url=local_url)

            # Recover the prompt from overrides (any text field, not just `.text`)
            # if comfy-gen didn't return it. See _extract_override_prompt.
            override_prompt = _extract_override_prompt(output_data, overrides)
            # Persist on the job so the frontend run-card metadata panel
            # (jobAny.prompt) shows it, not just the embedded file metadata.
            if override_prompt:
                services._update_job(job_id, prompt=override_prompt)

            meta = media_meta.build_generation_meta(
                prompt=override_prompt,
                negative_prompt=output_data.get("negative_prompt", ""),
                seed=seed,
                model=output_data.get("model_cls", ""),
                task_type=output_data.get("task_type", ""),
                width=resolution.get("width") if isinstance(resolution, dict) else None,
                height=resolution.get("height") if isinstance(resolution, dict) else None,
                frames=output_data.get("frames"),
                fps=output_data.get("fps"),
                model_hashes=model_hashes or None,
                lora_hashes=output_data.get("lora_hashes") or None,
                inference_settings=output_data.get("inference_settings") or None,
                software="ComfyUI (comfy-gen)",
            )
            media_meta.embed_metadata(local_path, meta)

            services._update_job(job_id, status="COMPLETED",
                                 elapsed_seconds=round(time.time() - t0, 3))

            if source == "mcp" and batch_id:
                try:
                    _upsert_mcp_batch_run(batch_id, job_id, local_url, {
                        "seed": seed,
                        "prompt": override_prompt,
                        "software": "ComfyUI (comfy-gen)",
                        "job_ids": [job_id],
                        **({"width": resolution.get("width"), "height": resolution.get("height")}
                           if isinstance(resolution, dict) and resolution.get("width") else {}),
                        **({"overrides": overrides} if overrides else {}),
                    })
                except Exception as e:
                    print(f"[comfy-gen] MCP batch run upsert failed for {job_id}: {e}", flush=True)
        except Exception as e:
            services._update_job(job_id, status="COMPLETED_WITH_WARNING",
                                 warning=f"Failed local save: {e}",
                                 elapsed_seconds=round(time.time() - t0, 3))

    except Exception as e:
        services._update_job(job_id, status="FAILED", error=str(e),
                             elapsed_seconds=round(time.time() - t0, 3))
    finally:
        # Clean up temp workflow file
        try:
            os.unlink(workflow_path)
        except OSError:
            pass
        if source == "mcp":
            _publish_event({"type": "mcp", "job_id": job_id, "batch_id": batch_id, "phase": "end"})


# MCP batch runs: each completing job appends its output to one gallery run so the
# Artifacts MCP view fills in live. Read-modify-write of a shared run row, so the
# concurrent sliding-window completions must serialize.
_MCP_BATCH_LOCK = threading.Lock()
_VIDEO_EXT = {"mp4", "webm", "mov", "mkv", "gif"}

# SSE: the Artifacts MCP view subscribes to /events and revalidates on each tick, so
# new placeholder/finished artifacts appear without polling. Events are published from
# worker threads (the job executor), delivered to per-client asyncio queues via the
# subscriber's own loop. The payload is just a "something changed" nudge.
_EVENT_SUBSCRIBERS: set[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = set()
_EVENT_LOCK = threading.Lock()


def _publish_event(event: dict[str, Any]) -> None:
    with _EVENT_LOCK:
        subs = list(_EVENT_SUBSCRIBERS)
    for loop, q in subs:
        try:
            loop.call_soon_threadsafe(q.put_nowait, event)
        except RuntimeError:
            pass  # loop already closed


def _upsert_mcp_batch_run(batch_id: str, job_id: str, url: str, meta: dict[str, Any]) -> None:
    """Append (url, meta) to the run `run-mcp-<batch_id>`, creating it on first job.
    Images/videos are stored as arrays so the run-card renders a growing grid."""
    run_id = f"run-mcp-{batch_id}"
    is_video = url.split(".")[-1].split("?")[0].lower() in _VIDEO_EXT
    kind = "video" if is_video else "image"
    with _MCP_BATCH_LOCK:
        existing = db.get_run(run_id)
        if existing:
            br = existing["block_results"][0]
            outputs = br["outputs"]
            media = outputs.setdefault(kind, {"kind": kind, "value": []})
            if not isinstance(media["value"], list):
                media["value"] = [media["value"]]
            media["value"].append(url)
            md = outputs.setdefault("metadata", {"kind": "metadata", "value": []})
            if not isinstance(md["value"], list):
                md["value"] = [md["value"]]
            md["value"].append(meta)
            existing["status"] = "completed"
            db.save_run(existing)
            return
        run = {
            "id": run_id,
            "name": f"MCP Run — {time.strftime('%b %d %H:%M')}",
            "status": "completed",
            "flow_snapshot": {"blocks": [], "source": "mcp"},
            "block_results": [{
                "block_index": 0,
                "block_type": "comfy_gen",
                "block_label": "ComfyGen (MCP)",
                "status": "completed",
                "outputs": {
                    kind: {"kind": kind, "value": [url]},
                    "metadata": {"kind": "metadata", "value": [meta]},
                },
            }],
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        db.save_run(run)


# ---- API routes ----

def _read_png_text_chunks(data: bytes) -> dict[str, str]:
    """Read tEXt/iTXt chunks from PNG data without PIL."""
    import struct
    import zlib

    chunks: dict[str, str] = {}
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return chunks
    pos = 8
    while pos + 8 <= len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        chunk_type = data[pos + 4:pos + 8]
        chunk_data = data[pos + 8:pos + 8 + length]
        pos += 12 + length  # 4 len + 4 type + data + 4 crc
        if chunk_type == b"tEXt":
            sep = chunk_data.index(b"\x00")
            key = chunk_data[:sep].decode("latin-1")
            val = chunk_data[sep + 1:].decode("latin-1")
            chunks[key] = val
        elif chunk_type == b"iTXt":
            sep = chunk_data.index(b"\x00")
            key = chunk_data[:sep].decode("utf-8")
            rest = chunk_data[sep + 1:]
            # compression flag, compression method, language, translated keyword
            comp_flag = rest[0]
            after = rest[2:]  # skip comp flag + comp method
            lang_end = after.index(b"\x00")
            after = after[lang_end + 1:]
            kw_end = after.index(b"\x00")
            text_data = after[kw_end + 1:]
            if comp_flag:
                text_data = zlib.decompress(text_data)
            chunks[key] = text_data.decode("utf-8")
        elif chunk_type == b"IEND":
            break
    return chunks


@router.post("/extract-workflow-from-png")
async def extract_workflow_from_png(request: Request) -> JSONResponse:
    """Extract embedded ComfyUI workflow from a PNG file."""
    body = await request.body()
    if not body:
        return JSONResponse({"ok": False, "error": "No file data"}, status_code=400)

    try:
        chunks = _read_png_text_chunks(body)
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"Failed to read PNG metadata: {e}"}, status_code=400)

    raw = chunks.get("prompt", "")
    if not raw:
        return JSONResponse({"ok": False, "error": "No ComfyUI workflow found in this image"}, status_code=400)

    try:
        workflow = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return JSONResponse({"ok": False, "error": "Workflow metadata is not valid JSON"}, status_code=400)

    if not isinstance(workflow, dict):
        return JSONResponse({"ok": False, "error": "Workflow is not a JSON object"}, status_code=400)

    has_class_type = any(
        isinstance(v, dict) and "class_type" in v for v in workflow.values()
    )
    if not has_class_type:
        return JSONResponse({"ok": False, "error": "Workflow is not in ComfyUI API format"}, status_code=400)

    return JSONResponse({"ok": True, "workflow": workflow})


@router.post("/parse-workflow")
async def parse_workflow(request: Request) -> JSONResponse:
    """Parse a workflow JSON and return detected LoadImage/LoadVideo nodes."""
    body = await request.json()
    workflow = body.get("workflow", {})
    if not isinstance(workflow, dict):
        return JSONResponse({"ok": False, "error": "workflow must be a JSON object"}, status_code=400)

    # Detect graph/UI format (not API format)
    if "nodes" in workflow and "links" in workflow:
        has_subgraphs = bool(
            isinstance(workflow.get("definitions"), dict)
            and workflow["definitions"].get("subgraphs")
        )
        msg = "This workflow is in ComfyUI graph format, not API format."
        if has_subgraphs:
            msg += " It also contains subgraphs which are not supported."
        msg += " Please export as API format: in ComfyUI, enable Dev Mode in settings, then use 'Save (API Format)'."
        return JSONResponse({"ok": False, "error": msg}, status_code=400)

    try:
        nodes = _detect_load_nodes(workflow)
        ksamplers = _detect_ksamplers(workflow)
        moe_pairs = _detect_moe_pairs(workflow)
        text_overrides = _detect_text_overrides(workflow)
        resolution_nodes = _detect_resolution_nodes(workflow)
        frame_counts = _detect_frame_count(workflow)
        ref_video = _detect_reference_video(workflow)
        lora_nodes = _detect_lora_nodes(workflow)
        comfygen_overrides = _detect_comfygen_overrides(workflow)
        output_type = _detect_output_type(workflow)
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"Failed to parse workflow: {e}"}, status_code=400)

    return JSONResponse({
        "ok": True,
        "load_nodes": nodes,
        "ksamplers": ksamplers,
        "moe_pairs": moe_pairs,
        "text_overrides": text_overrides,
        "resolution_nodes": resolution_nodes,
        "frame_counts": frame_counts,
        "ref_video": ref_video,
        "lora_nodes": lora_nodes,
        "comfygen_overrides": comfygen_overrides,
        "output_type": output_type,
    })


def _resolve_added_loras(workflow: dict, added: list[dict]) -> tuple[list[dict] | None, str | None]:
    """Validate + auto-anchor runtime-added LoRAs before insertion. Returns
    (resolved, None) on success or (None, error). Fails loud instead of letting
    _insert_lora_nodes silently drop entries with a bad/missing anchor.

    Each input entry: {lora_name, strength_model?, strength_clip?, class_type?,
    chain_anchor|anchor?}. `anchor` is an existing LoRA loader node_id; when omitted
    the LoRA stacks onto the first detected LoRA chain (the backend then walks to its
    current tail). Power Lora Loader rows are not valid anchors.
    """
    # node_id -> class_type for the regular (anchorable) loaders only.
    anchors = {n["node_id"]: n.get("class_type")
               for n in _detect_lora_nodes(workflow) if "lora_key" not in n}
    resolved: list[dict] = []
    for entry in added:
        anchor = str(entry.get("chain_anchor") or entry.get("anchor") or "").strip()
        if not anchor:
            if not anchors:
                return None, ("Cannot add LoRA: this workflow has no LoRA loader to "
                              "anchor onto. Add a LoRA node in the workflow first.")
            anchor = next(iter(anchors))
        if anchor not in anchors:
            avail = ", ".join(anchors) or "none"
            return None, (f"LoRA anchor '{anchor}' is not a LoRA loader node in this "
                          f"workflow. Valid anchors: {avail}.")
        lora_name = str(entry.get("lora_name") or "").strip()
        if not lora_name:
            return None, "Each added LoRA needs a non-empty lora_name."
        out = {
            "chain_anchor": anchor,
            "class_type": entry.get("class_type") or anchors[anchor] or "LoraLoaderModelOnly",
            "lora_name": lora_name,
            "strength_model": entry.get("strength_model", 1.0),
        }
        if entry.get("strength_clip") is not None:
            out["strength_clip"] = entry["strength_clip"]
        resolved.append(out)
    return resolved, None


def _insert_lora_nodes(workflow: dict, added: list[dict]) -> dict:
    """Splice runtime-added LoRA loaders into the workflow.

    Each entry: {chain_anchor, class_type, lora_name, strength_model, strength_clip?}.
    The new loader is inserted at the *current* tail of the chain that starts
    at `chain_anchor` — i.e. walk forward through LoRA loaders that consume the
    anchor's MODEL output until none do, then splice after that node. This
    means multiple entries sharing an anchor stack in input order.
    """
    if not added:
        return workflow

    def _alloc_id() -> str:
        used = {int(k) for k in workflow.keys() if str(k).isdigit()}
        return str((max(used) + 1) if used else 1)

    def _walk_to_tail(anchor_id: str) -> str:
        current = anchor_id
        while True:
            nxt = None
            for nid, node in workflow.items():
                if not isinstance(node, dict):
                    continue
                if node.get("class_type") not in _LORA_CLASS_TYPES:
                    continue
                m = node.get("inputs", {}).get("model")
                if isinstance(m, list) and len(m) >= 2 and str(m[0]) == str(current):
                    nxt = nid
                    break
            if nxt is None:
                return current
            current = nxt

    for entry in added:
        anchor = str(entry.get("chain_anchor", ""))
        if anchor not in workflow:
            continue
        anchor_node = workflow[anchor]
        if not isinstance(anchor_node, dict) or anchor_node.get("class_type") not in _LORA_CLASS_TYPES:
            continue
        tail_id = _walk_to_tail(anchor)
        class_type = entry.get("class_type") or anchor_node.get("class_type")
        new_id = _alloc_id()
        new_inputs: dict[str, object] = {
            "lora_name": entry.get("lora_name", ""),
            "strength_model": float(entry.get("strength_model", 1.0)),
            "model": [tail_id, 0],
        }
        if class_type == "LoraLoader":
            new_inputs["strength_clip"] = float(entry.get("strength_clip", entry.get("strength_model", 1.0)))
            new_inputs["clip"] = [tail_id, 1]
        workflow[new_id] = {
            "class_type": class_type,
            "inputs": new_inputs,
            "_meta": {"title": f"Load LoRA (added: {entry.get('lora_name', '')})"},
        }
        # Rewire downstream consumers of tail's MODEL (index 0) and CLIP (index 1) to new node
        for nid, node in workflow.items():
            if nid in (new_id, tail_id):
                continue
            if not isinstance(node, dict):
                continue
            for field, value in node.get("inputs", {}).items():
                if not isinstance(value, list) or len(value) != 2:
                    continue
                if str(value[0]) != str(tail_id):
                    continue
                if value[1] == 0:
                    node["inputs"][field] = [new_id, 0]
                elif value[1] == 1 and class_type == "LoraLoader":
                    node["inputs"][field] = [new_id, 1]

    return workflow


def _bypass_lora_nodes(workflow: dict, bypass_node_ids: list[str]) -> dict:
    """Bypass LoRA loader nodes by rewiring downstream references to the LoRA's inputs.

    For each bypassed LoRA node:
    - References to [lora_id, 0] (MODEL) are replaced with the LoRA's model input
    - References to [lora_id, 1] (CLIP, LoraLoader only) are replaced with the LoRA's clip input
    - The LoRA node is deleted from the workflow
    """
    for lora_id in bypass_node_ids:
        lora_node = workflow.get(lora_id)
        if not lora_node:
            continue
        inputs = lora_node.get("inputs", {})
        model_source = inputs.get("model")  # [source_node_id, output_index]
        clip_source = inputs.get("clip")    # [source_node_id, output_index] or None

        # Scan all nodes and rewire references
        for node_id, node in workflow.items():
            if node_id == lora_id:
                continue
            node_inputs = node.get("inputs", {})
            for field, value in node_inputs.items():
                if not isinstance(value, list) or len(value) != 2:
                    continue
                if str(value[0]) == str(lora_id):
                    if value[1] == 0 and model_source:
                        node_inputs[field] = list(model_source)
                    elif value[1] == 1 and clip_source:
                        node_inputs[field] = list(clip_source)

        # Remove the bypassed LoRA node
        del workflow[lora_id]

    return workflow


@router.post("/run")
async def run(request: Request) -> JSONResponse:
    """Submit a ComfyUI workflow via comfy-gen CLI."""
    body = await request.json()
    # `... or {}` (not `.get(k, {})`): clients may send explicit JSON null for an
    # empty field (the MCP does), and a null value bypasses the get() default.
    workflow = body.get("workflow") or {}
    raw_file_inputs = body.get("file_inputs") or {}  # {node_id: {field, media_url}}
    raw_overrides = body.get("overrides") or {}  # {"node_id.param": "value"}
    bypass_loras = body.get("bypass_loras") or []  # list of node_id strings to bypass
    added_loras = body.get("added_loras") or []  # list of {chain_anchor, class_type, lora_name, strength_model, strength_clip?}
    power_lora_overrides = body.get("power_lora_overrides") or []  # list of {node_id, lora_key, on, lora, strength, add?}
    endpoint_id = str(body.get("endpoint_id") or config.RUNPOD_ENDPOINT_ID or "").strip()
    source = str(body.get("source") or "").strip()  # "mcp" tags jobs for the Artifacts MCP view
    batch_id = str(body.get("batch_id") or "").strip()  # groups MCP jobs into one growing gallery run

    # Validate + auto-anchor added LoRAs up front so a bad anchor errors loudly
    # rather than being silently dropped during insertion.
    if added_loras:
        added_loras, lora_err = _resolve_added_loras(workflow, added_loras)
        if lora_err:
            return JSONResponse({"ok": False, "error": lora_err}, status_code=400)

    # Apply LoRA bypass + insertion + power-lora overrides before processing
    if bypass_loras or added_loras or power_lora_overrides:
        workflow = copy.deepcopy(workflow)
        if bypass_loras:
            workflow = _bypass_lora_nodes(workflow, bypass_loras)
        if added_loras:
            workflow = _insert_lora_nodes(workflow, added_loras)
        if power_lora_overrides:
            workflow = _apply_power_lora_overrides(workflow, power_lora_overrides)

    if not workflow:
        return JSONResponse({"ok": False, "error": "workflow is required"}, status_code=400)

    # Write workflow to a temp file for comfy-gen CLI
    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
    json.dump(workflow, tmp)
    tmp.close()

    # Resolve media URLs to local paths for --input flags
    file_inputs: dict[str, str] = {}
    for node_id, mapping in raw_file_inputs.items():
        media_url = mapping.get("media_url", "")
        if not media_url:
            continue
        local_path = _resolve_local_path(media_url)
        if not Path(local_path).exists():
            os.unlink(tmp.name)
            return JSONResponse({"ok": False, "error": f"File not found for node {node_id}: {local_path}"}, status_code=400)
        file_inputs[node_id] = local_path

    # Overrides passed as {"node_id.param": "value"} for --override flags
    overrides: dict[str, str] = {}
    for key, value in raw_overrides.items():
        if key and str(value).strip():
            overrides[key] = str(value)

    # Auto-randomize seed on KSampler nodes unless locked
    if not body.get("lock_seed", False):
        ksamplers = _detect_ksamplers(workflow)
        for ks in ksamplers:
            # Use override_map for SamplerCustomAdvanced (targets RandomNoise.noise_seed)
            om = ks.get("override_map", {})
            seed_key = om.get("seed", f"{ks['node_id']}.seed")
            if seed_key not in overrides:  # don't override user-set seed
                overrides[seed_key] = str(random.randint(0, 2**53))

    job_id = str(uuid.uuid4())

    # Log LoRA-chain modifications so an add/bypass leaves a trace (added_loras here
    # is the RESOLVED list — actual anchor + inserted name — not the raw request).
    if added_loras:
        print(f"[comfy-gen] Job {job_id} added_loras: {json.dumps(added_loras, default=str)}", flush=True)
    if bypass_loras:
        print(f"[comfy-gen] Job {job_id} bypass_loras: {json.dumps(bypass_loras, default=str)}", flush=True)
    if power_lora_overrides:
        print(f"[comfy-gen] Job {job_id} power_lora_overrides: {json.dumps(power_lora_overrides, default=str)}", flush=True)

    record = services._new_job_record(job_id, endpoint_id, {"workflow_file": tmp.name})
    if source:
        record["source"] = source
        record["overrides"] = overrides  # live strip shows prompt/settings before completion
    if batch_id:
        record["batch_id"] = batch_id
    with state.JOBS_LOCK:
        state.JOBS[job_id] = record
        state._persist_jobs_locked()

    state.EXECUTOR.submit(_run_comfy_job, job_id, tmp.name, file_inputs, overrides,
                          endpoint_id, source, batch_id)

    if source == "mcp":
        _publish_event({"type": "mcp", "job_id": job_id, "batch_id": batch_id, "phase": "start"})

    return JSONResponse({"ok": True, "job_id": job_id})


def _job_view(job: dict[str, Any]) -> dict[str, Any]:
    """Compact job shape for the Artifacts MCP live strip."""
    ov = job.get("overrides") or {}
    prompt = job.get("prompt") or _prompt_from_overrides(ov)
    return {
        "job_id": job.get("job_id"),
        "status": job.get("status", "UNKNOWN"),
        "batch_id": job.get("batch_id", ""),
        "prompt": prompt,
        "seed": job.get("seed"),
        "url": job.get("local_image_url") or job.get("local_video_url") or job.get("video_url") or "",
        "error": job.get("error", ""),
        "overrides": ov,
        "progress": job.get("runpod_progress"),
        "created_at": job.get("created_at"),
        "updated_at": job.get("updated_at"),
    }


def _prompt_from_overrides(overrides: dict[str, str]) -> str:
    texts = [v for v in overrides.values() if isinstance(v, str) and len(v) > 40 and " " in v]
    return max(texts, key=len) if texts else ""


@router.get("/jobs")
def list_jobs(source: str = "", limit: int = 50) -> JSONResponse:
    """List recent jobs (active in-memory + finished from SQLite), newest first.
    Pass source=mcp to scope to MCP-submitted jobs (Artifacts MCP view)."""
    seen: set[str] = set()
    merged: list[dict[str, Any]] = []
    with state.JOBS_LOCK:
        active = [dict(r) for r in state.JOBS.values()]
    for job in active:
        if source and job.get("source") != source:
            continue
        jid = job.get("job_id")
        if jid:
            seen.add(jid)
        merged.append(job)
    for job in db.list_jobs(limit=200):
        if source and job.get("source") != source:
            continue
        if job.get("job_id") in seen:
            continue
        merged.append(job)
    merged.sort(key=lambda j: str(j.get("updated_at") or j.get("created_at") or ""), reverse=True)
    return JSONResponse({"ok": True, "jobs": [_job_view(j) for j in merged[:limit]]})


@router.get("/events")
async def events(request: Request) -> StreamingResponse:
    """SSE stream for the Artifacts MCP view. Emits a tick whenever an MCP job starts
    or finishes; the client revalidates its runs/jobs queries on each tick. Heartbeats
    every 15s keep the connection (and proxies) alive."""
    loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue(maxsize=200)
    sub = (loop, q)
    with _EVENT_LOCK:
        _EVENT_SUBSCRIBERS.add(sub)

    async def gen():
        try:
            yield "retry: 3000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            with _EVENT_LOCK:
                _EVENT_SUBSCRIBERS.discard(sub)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",  # disable proxy buffering so events flush immediately
    })


@router.get("/status/{job_id}")
def status(job_id: str) -> JSONResponse:
    job = services._job_snapshot(job_id)
    if not job:
        return JSONResponse({"job": {"job_id": job_id, "status": "UNKNOWN"}})
    return JSONResponse({"job": job})


@router.post("/cancel/{job_id}")
def cancel(job_id: str) -> JSONResponse:
    """Cancel a running or queued comfy-gen job.

    Kills the local subprocess and cancels the remote RunPod job if a
    remote job ID has been captured.
    """
    with state.JOBS_LOCK:
        job = state.JOBS.get(job_id)
        if not job:
            return JSONResponse({"ok": False, "error": "Job not found or already finished"}, status_code=404)
        proc: subprocess.Popen | None = job.pop("_proc", None)
        remote_job_id: str = job.get("remote_job_id") or ""
        endpoint_id: str = job.get("endpoint_id") or ""

    # Kill the local comfy-gen subprocess
    if proc is not None:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        print(f"[comfy-gen] Killed subprocess for job {job_id}", flush=True)

    # Cancel the remote RunPod job. The UI distinguishes outcomes so it
    # can offer retry only for timeout (the common RunPod-slow case)
    # without retrying genuine errors.
    cancelled_remote = False
    remote_cancel_status = "no_remote_id"
    remote_cancel_error = ""
    if remote_job_id:
        try:
            comfy_gen = comfy_gen_cli.resolve_comfy_gen()
            cmd = comfy_gen.command("cancel", remote_job_id)
            if endpoint_id:
                cmd.extend(["--endpoint-id", endpoint_id])
            print(f"[comfy-gen] Cancel command: {' '.join(cmd)}", flush=True)
            with comfy_gen_cli.settings_subprocess_env(endpoint_id=endpoint_id) as env:
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=env)
            if result.returncode == 0:
                cancelled_remote = True
                remote_cancel_status = "ok"
                print(f"[comfy-gen] Cancelled remote job {remote_job_id} for {job_id}", flush=True)
            else:
                remote_cancel_status = "error"
                remote_cancel_error = (result.stderr.strip() or result.stdout.strip()
                                       or f"exit {result.returncode}")
                print(f"[comfy-gen] Cancel exit {result.returncode}: {remote_cancel_error}", flush=True)
            if result.stdout.strip():
                print(f"[comfy-gen] Cancel stdout: {result.stdout.strip()}", flush=True)
            if result.stderr.strip():
                print(f"[comfy-gen] Cancel stderr: {result.stderr.strip()}", flush=True)
        except subprocess.TimeoutExpired:
            remote_cancel_status = "timeout"
            remote_cancel_error = "RunPod cancel API did not respond within 30s"
            print(f"[comfy-gen] Cancel timeout for remote job {remote_job_id}", flush=True)
        except Exception as e:
            remote_cancel_status = "error"
            remote_cancel_error = str(e)
            print(f"[comfy-gen] Failed to cancel remote job {remote_job_id}: {e}", flush=True)

    services._update_job(job_id, status="CANCELLED", error="Cancelled by user")

    response: dict[str, Any] = {
        "ok": True,
        "cancelled_remote": cancelled_remote,
        "remote_cancel_status": remote_cancel_status,
    }
    if remote_cancel_error:
        response["remote_cancel_error"] = remote_cancel_error
    return JSONResponse(response)

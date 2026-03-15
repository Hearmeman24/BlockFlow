from __future__ import annotations

import copy
import json
import os
import random
import re
import subprocess
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from backend import config, media_meta, state, services

router = APIRouter()


# ---------------------------------------------------------------------------
# comfy-gen cache (samplers, schedulers, loras)
# ---------------------------------------------------------------------------

_cache: dict[str, Any] = {"samplers": [], "schedulers": [], "loras": [], "fetched_at": 0}


def _read_cache_from_disk() -> None:
    """Load cached data from disk into memory (no CLI calls)."""
    cache_path = config.COMFY_GEN_INFO_CACHE_PATH
    if not cache_path.exists():
        return
    try:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
        if data.get("samplers"):
            _cache["samplers"] = data["samplers"]
        if data.get("schedulers"):
            _cache["schedulers"] = data["schedulers"]
        if data.get("loras"):
            _cache["loras"] = data["loras"]
        if data.get("fetched_at"):
            _cache["fetched_at"] = data["fetched_at"]
    except Exception:
        pass


def _save_cache_to_disk() -> None:
    config.COMFY_GEN_INFO_CACHE_PATH.write_text(
        json.dumps({
            "samplers": _cache["samplers"],
            "schedulers": _cache["schedulers"],
            "loras": _cache["loras"],
            "fetched_at": _cache["fetched_at"],
        }, indent=2) + "\n",
        encoding="utf-8",
    )


# Load from disk at import time (no CLI calls)
_read_cache_from_disk()


@router.get("/cache")
def get_cache() -> JSONResponse:
    """Return cached samplers, schedulers, and loras."""
    return JSONResponse({
        "ok": True,
        "samplers": _cache["samplers"],
        "schedulers": _cache["schedulers"],
        "loras": _cache["loras"],
        "fetched_at": _cache["fetched_at"],
    })


import threading

_refresh_state: dict[str, Any] = {"running": False, "status": "", "error": "", "done": False}
_refresh_lock = threading.Lock()


def _run_refresh(cmd: list[str]) -> None:
    """Run comfy-gen info in a thread, streaming stderr lines to _refresh_state."""
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
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
        _cache["loras"] = [l["filename"] for l in loras if isinstance(l, dict) and "filename" in l]
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
    import shutil

    with _refresh_lock:
        if _refresh_state["running"]:
            return JSONResponse({"ok": True, "already_running": True})

        if not shutil.which("comfy-gen"):
            return JSONResponse({"ok": False, "error": "comfy-gen CLI not found on PATH"})

        eid = str(payload.get("endpoint_id", "")).strip() or config.RUNPOD_ENDPOINT_ID or ""
        cmd = ["comfy-gen", "info"]
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


@router.get("/health")
def health_check() -> JSONResponse:
    """Check if comfy-gen CLI is installed and reachable."""
    import shutil

    path = shutil.which("comfy-gen")
    if not path:
        return JSONResponse({"ok": False, "error": "comfy-gen CLI not found on PATH"})
    try:
        result = subprocess.run(
            ["comfy-gen", "--help"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return JSONResponse({"ok": False, "error": f"comfy-gen --help exited with code {result.returncode}"})
    except Exception as exc:
        return JSONResponse({"ok": False, "error": str(exc)})
    return JSONResponse({"ok": True, "path": path})




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
    """Find KSampler nodes with their steps/cfg/seed/denoise/sampler/scheduler values."""
    samplers = []
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type", "")
        if class_type not in ("KSampler", "KSamplerAdvanced"):
            continue
        inputs = node.get("inputs", {})
        entry: dict[str, Any] = {
            "node_id": node_id,
            "class_type": class_type,
        }
        # Resolve literal or wired values
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
    return samplers


_KNOWN_LATENT_NODES = {
    "EmptyLatentImage", "SDXLEmptyLatentSizePicker+",
    "EmptyLTXVLatentVideo", "EmptySD3LatentImage",
}

_PRIMITIVE_TYPES = {"PrimitiveInt", "PrimitiveFloat", "Primitive int [Crystools]"}


def _walk_upstream_value(workflow: dict[str, Any], wired_ref: list, max_depth: int = 8) -> int | float | None:
    """Follow a wired input upstream to find its literal numeric value.

    Handles chains like: EmptyLTXVLatentVideo.width ← ComfyMathExpression ← PrimitiveInt.
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
        class_type = node.get("class_type", "")

        # If this is a primitive node, return its value directly
        if class_type in _PRIMITIVE_TYPES:
            val = inputs.get("value")
            if isinstance(val, (int, float)):
                return val

        # Check for a literal "value" field (generic)
        if "value" in inputs and isinstance(inputs["value"], (int, float)):
            return inputs["value"]

        # Follow wired inputs upstream — look for numeric-like input names
        for key, val in inputs.items():
            if isinstance(val, list) and len(val) >= 2:
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
            upstream_w = _walk_upstream_value(workflow, w_val) if w_wired else None
            upstream_h = _walk_upstream_value(workflow, h_val) if h_wired else None
            literal_w = int(w_val) if not w_wired and isinstance(w_val, (int, float)) else None
            literal_h = int(h_val) if not h_wired and isinstance(h_val, (int, float)) else None

            resolved_w = literal_w if literal_w is not None else (int(upstream_w) if upstream_w is not None else None)
            resolved_h = literal_h if literal_h is not None else (int(upstream_h) if upstream_h is not None else None)

            if resolved_w is not None or resolved_h is not None:
                # Find the actual source nodes for overriding
                w_source = _find_upstream_source(workflow, w_val) if w_wired else None
                h_source = _find_upstream_source(workflow, h_val) if h_wired else None

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


def _find_upstream_source(workflow: dict[str, Any], wired_ref: list, max_depth: int = 8) -> tuple[str, str] | None:
    """Find the upstream source node and field that holds a literal numeric value.

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
        class_type = node.get("class_type", "")

        # Primitive node — this is the source
        if class_type in _PRIMITIVE_TYPES and "value" in inputs and isinstance(inputs["value"], (int, float)):
            return (node_id, "value")

        # Any node with a literal "value" field
        if "value" in inputs and isinstance(inputs["value"], (int, float)):
            return (node_id, "value")

        # Follow wired inputs upstream
        for key, val in inputs.items():
            if isinstance(val, list) and len(val) >= 2:
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


def _detect_lora_nodes(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    """Detect LoRA loader nodes and their current settings.

    Returns list of {node_id, class_type, label, lora_name, strength_model, strength_clip?}
    ordered by their chain position (follows model input wiring).
    """
    lora_nodes: dict[str, dict[str, Any]] = {}
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type", "")
        if class_type not in _LORA_CLASS_TYPES:
            continue
        inputs = node.get("inputs", {})
        title = node.get("_meta", {}).get("title", "")
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
        # Track which node feeds into this one (for ordering)
        model_input = inputs.get("model")
        if isinstance(model_input, list) and len(model_input) >= 2:
            entry["_model_source"] = str(model_input[0])
        lora_nodes[node_id] = entry

    # Order by chain: start from nodes whose model source is not another LoRA
    lora_ids = set(lora_nodes.keys())
    ordered: list[dict[str, Any]] = []
    remaining = dict(lora_nodes)

    # Find roots (LoRAs whose model source is not another LoRA)
    roots = [nid for nid, n in remaining.items()
             if n.get("_model_source") not in lora_ids]
    # Follow chains from roots
    placed = set()
    for root in roots:
        current = root
        while current and current in remaining and current not in placed:
            node = remaining[current]
            placed.add(current)
            clean = {k: v for k, v in node.items() if not k.startswith("_")}
            ordered.append(clean)
            # Find next LoRA that uses this one as model source
            current = next(
                (nid for nid, n in remaining.items()
                 if n.get("_model_source") == current and nid not in placed),
                None,
            )
    # Add any remaining (disconnected) LoRAs
    for nid, node in remaining.items():
        if nid not in placed:
            clean = {k: v for k, v in node.items() if not k.startswith("_")}
            ordered.append(clean)

    return ordered


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


# ---- Progress parsing ----

# Matches: [258s] inference: (33/57) KSampler Step 1/4 (38%
# Groups: elapsed, stage, node_done, node_total, detail
_PROGRESS_RE = re.compile(
    r"\[(\d+)s\]\s+(\w+):\s+\((\d+)/(\d+)\)\s*(.*)"
)


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
                   endpoint_id: str = "") -> None:
    """Run a ComfyUI workflow via comfy-gen CLI subprocess."""
    t0 = time.time()
    try:
        services._update_job(job_id, status="SUBMITTING")

        # Build comfy-gen command
        cmd = ["comfy-gen", "submit", workflow_path]
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
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
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

        if proc.returncode != 0:
            error_msg = stdout.strip() if stdout.strip() else f"comfy-gen exited with code {proc.returncode}"
            # Try to extract error from JSON
            try:
                err_data = json.loads(stdout)
                error_msg = err_data.get("error", error_msg)
            except (json.JSONDecodeError, ValueError):
                pass
            services._update_job(job_id, status="FAILED", error=error_msg,
                                 elapsed_seconds=round(time.time() - t0, 3))
            return

        # Parse JSON output from stdout
        try:
            result = json.loads(stdout)
        except (json.JSONDecodeError, ValueError):
            services._update_job(job_id, status="FAILED",
                                 error=f"Invalid JSON from comfy-gen: {stdout[:500]}",
                                 elapsed_seconds=round(time.time() - t0, 3))
            return

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

            meta = media_meta.build_generation_meta(
                prompt=output_data.get("prompt", ""),
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
        text_overrides = _detect_text_overrides(workflow)
        resolution_nodes = _detect_resolution_nodes(workflow)
        frame_counts = _detect_frame_count(workflow)
        ref_video = _detect_reference_video(workflow)
        lora_nodes = _detect_lora_nodes(workflow)
        output_type = _detect_output_type(workflow)
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"Failed to parse workflow: {e}"}, status_code=400)

    return JSONResponse({
        "ok": True,
        "load_nodes": nodes,
        "ksamplers": ksamplers,
        "text_overrides": text_overrides,
        "resolution_nodes": resolution_nodes,
        "frame_counts": frame_counts,
        "ref_video": ref_video,
        "lora_nodes": lora_nodes,
        "output_type": output_type,
    })


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
    workflow = body.get("workflow", {})
    raw_file_inputs = body.get("file_inputs", {})  # {node_id: {field, media_url}}
    raw_overrides = body.get("overrides", {})  # {"node_id.param": "value"}
    bypass_loras = body.get("bypass_loras", [])  # list of node_id strings to bypass
    endpoint_id = str(body.get("endpoint_id") or config.RUNPOD_ENDPOINT_ID or "").strip()

    # Apply LoRA bypass before processing
    if bypass_loras:
        workflow = _bypass_lora_nodes(copy.deepcopy(workflow), bypass_loras)

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
            seed_key = f"{ks['node_id']}.seed"
            if seed_key not in overrides:  # don't override user-set seed
                overrides[seed_key] = str(random.randint(0, 2**53))

    job_id = str(uuid.uuid4())
    record = services._new_job_record(job_id, "comfy-gen", {"workflow_file": tmp.name})
    with state.JOBS_LOCK:
        state.JOBS[job_id] = record
        state._persist_jobs_locked()

    state.EXECUTOR.submit(_run_comfy_job, job_id, tmp.name, file_inputs, overrides, endpoint_id)

    return JSONResponse({"ok": True, "job_id": job_id})


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

    # Cancel the remote RunPod job
    cancelled_remote = False
    if remote_job_id:
        try:
            cmd = ["comfy-gen", "cancel", remote_job_id]
            if endpoint_id:
                cmd.extend(["--endpoint-id", endpoint_id])
            subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            cancelled_remote = True
            print(f"[comfy-gen] Cancelled remote job {remote_job_id} for {job_id}", flush=True)
        except Exception as e:
            print(f"[comfy-gen] Failed to cancel remote job {remote_job_id}: {e}", flush=True)

    services._update_job(job_id, status="CANCELLED", error="Cancelled by user")

    return JSONResponse({"ok": True, "cancelled_remote": cancelled_remote})

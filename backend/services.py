from __future__ import annotations

import json
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from backend import config, db, media_meta, state


def _now() -> float:
    return time.time()


def _request_json(method: str, url: str, payload: dict[str, Any] | None = None, timeout: int = config.HTTP_TIMEOUT_SEC) -> dict[str, Any]:
    data = None
    headers = {
        "Authorization": f"Bearer {config.RUNPOD_API_KEY}",
        "Content-Type": "application/json",
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} from RunPod: {body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"RunPod request failed: {e}") from e


def _request_json_with_headers(
    method: str,
    url: str,
    headers: dict[str, str],
    payload: dict[str, Any] | None = None,
    timeout: int = config.HTTP_TIMEOUT_SEC,
) -> dict[str, Any]:
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Request failed: {e}") from e


def _openrouter_headers() -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {config.OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
    }
    if config.OPENROUTER_SITE_URL:
        headers["HTTP-Referer"] = config.OPENROUTER_SITE_URL
    if config.OPENROUTER_APP_NAME:
        headers["X-Title"] = config.OPENROUTER_APP_NAME
    return headers


def _openrouter_request_json(method: str, path: str, payload: dict[str, Any] | None = None, timeout: int = 60) -> dict[str, Any]:
    if not config.OPENROUTER_API_KEY:
        raise RuntimeError("OPENROUTER_API_KEY is missing")
    url = f"{config.OPENROUTER_API_BASE.rstrip('/')}/{path.lstrip('/')}"
    return _request_json_with_headers(method, url, _openrouter_headers(), payload=payload, timeout=timeout)


# ---------------------------------------------------------------------------
# MiniMax direct API support
# ---------------------------------------------------------------------------

_MINIMAX_MODEL_PREFIX = "minimax/"

MINIMAX_MODELS: list[dict[str, Any]] = [
    {
        "id": f"{_MINIMAX_MODEL_PREFIX}MiniMax-M2.5",
        "name": "MiniMax M2.5",
        "context_length": 204800,
        "modality": "text->text",
        "input_modalities": ["text"],
        "output_modalities": ["text"],
    },
    {
        "id": f"{_MINIMAX_MODEL_PREFIX}MiniMax-M2.5-highspeed",
        "name": "MiniMax M2.5 High Speed",
        "context_length": 204800,
        "modality": "text->text",
        "input_modalities": ["text"],
        "output_modalities": ["text"],
    },
]


def _is_minimax_model(model_id: str) -> bool:
    return model_id.startswith(_MINIMAX_MODEL_PREFIX)


def _minimax_headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {config.MINIMAX_API_KEY}",
        "Content-Type": "application/json",
    }


def _minimax_request_json(method: str, path: str, payload: dict[str, Any] | None = None, timeout: int = 60) -> dict[str, Any]:
    if not config.MINIMAX_API_KEY:
        raise RuntimeError("MINIMAX_API_KEY is missing")
    url = f"{config.MINIMAX_API_BASE.rstrip('/')}/{path.lstrip('/')}"
    if payload is not None:
        # Strip the minimax/ prefix from the model id before sending
        payload = dict(payload)
        model = str(payload.get("model") or "")
        if model.startswith(_MINIMAX_MODEL_PREFIX):
            payload["model"] = model[len(_MINIMAX_MODEL_PREFIX):]
        # MiniMax requires temperature in (0.0, 1.0] — clamp if needed
        temp = payload.get("temperature")
        if temp is not None:
            temp = float(temp)
            if temp <= 0.0:
                payload["temperature"] = 0.01
            elif temp > 1.0:
                payload["temperature"] = 1.0
    return _request_json_with_headers(method, url, _minimax_headers(), payload=payload, timeout=timeout)


def _get_minimax_models() -> list[dict[str, Any]]:
    """Return the static MiniMax model list (no API call needed)."""
    return list(MINIMAX_MODELS)


def _get_llm_models(refresh: bool = False) -> tuple[list[dict[str, Any]], str | None, bool]:
    """Fetch models from all configured LLM providers and merge them."""
    all_models: list[dict[str, Any]] = []
    warning: str | None = None
    from_cache = False

    # OpenRouter models
    if config.OPENROUTER_API_KEY:
        or_models, or_err, or_cached = _get_openrouter_models(refresh=refresh)
        all_models.extend(or_models)
        if or_err:
            warning = or_err
        from_cache = or_cached

    # MiniMax models (static list, always available when key is set)
    if config.MINIMAX_API_KEY:
        all_models.extend(_get_minimax_models())

    return all_models, warning, from_cache


def _llm_chat_completion(payload: dict[str, Any], timeout: int = 120) -> dict[str, Any]:
    """Route a chat completion request to the appropriate provider."""
    model = str(payload.get("model") or "")
    if _is_minimax_model(model):
        return _minimax_request_json("POST", "/chat/completions", payload, timeout=timeout)
    return _openrouter_request_json("POST", "/chat/completions", payload, timeout=timeout)


def _is_text_generation_model(model_obj: dict[str, Any]) -> bool:
    arch = model_obj.get("architecture")
    if not isinstance(arch, dict):
        return False

    input_mods = arch.get("input_modalities")
    output_mods = arch.get("output_modalities")
    modality = str(arch.get("modality") or "").lower()

    input_set = {str(x).lower() for x in input_mods} if isinstance(input_mods, list) else set()
    output_set = {str(x).lower() for x in output_mods} if isinstance(output_mods, list) else set()

    input_has_text = "text" in input_set or ("text" in modality.split("->")[0] if "->" in modality else "text" in modality)
    output_has_text = "text" in output_set or ("text" in modality.split("->")[-1] if "->" in modality else "text" in modality)
    return input_has_text and output_has_text


def _normalize_openrouter_model(model_obj: dict[str, Any]) -> dict[str, Any] | None:
    model_id = str(model_obj.get("id") or "").strip()
    if not model_id:
        return None
    arch = model_obj.get("architecture") if isinstance(model_obj.get("architecture"), dict) else {}
    return {
        "id": model_id,
        "name": str(model_obj.get("name") or model_id),
        "context_length": model_obj.get("context_length"),
        "modality": arch.get("modality"),
        "input_modalities": arch.get("input_modalities") if isinstance(arch.get("input_modalities"), list) else [],
        "output_modalities": arch.get("output_modalities") if isinstance(arch.get("output_modalities"), list) else [],
    }


def _fetch_openrouter_models() -> list[dict[str, Any]]:
    resp = _openrouter_request_json("GET", "/models", None, timeout=60)
    rows = resp.get("data")
    if not isinstance(rows, list):
        raise RuntimeError(f"OpenRouter models response missing data list: {resp}")

    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        if not _is_text_generation_model(row):
            continue
        norm = _normalize_openrouter_model(row)
        if norm:
            out.append(norm)
    out.sort(key=lambda x: str(x.get("id", "")).lower())
    return out


def _get_openrouter_models(refresh: bool = False) -> tuple[list[dict[str, Any]], str | None, bool]:
    now = _now()
    with state.OPENROUTER_MODELS_CACHE_LOCK:
        cache_age = now - float(state.OPENROUTER_MODELS_CACHE.get("ts", 0.0))
        cache_valid = bool(state.OPENROUTER_MODELS_CACHE.get("ts")) and cache_age < float(config.OPENROUTER_MODEL_CACHE_TTL_SEC)
        if not refresh and cache_valid:
            cached = state.OPENROUTER_MODELS_CACHE.get("models", [])
            return list(cached) if isinstance(cached, list) else [], None, True

    try:
        models = _fetch_openrouter_models()
    except Exception as e:
        with state.OPENROUTER_MODELS_CACHE_LOCK:
            cached = state.OPENROUTER_MODELS_CACHE.get("models", [])
            if isinstance(cached, list) and cached:
                return list(cached), str(e), True
        return [], str(e), False

    with state.OPENROUTER_MODELS_CACHE_LOCK:
        state.OPENROUTER_MODELS_CACHE["ts"] = now
        state.OPENROUTER_MODELS_CACHE["models"] = list(models)
    return models, None, False


def _extract_openrouter_message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
                continue
            if isinstance(part, dict):
                text_val = part.get("text")
                if isinstance(text_val, str):
                    parts.append(text_val)
        return "\n".join([p for p in parts if p])
    if isinstance(content, dict):
        text_val = content.get("text")
        if isinstance(text_val, str):
            return text_val
    return ""


def _extract_openrouter_completion_text(resp: dict[str, Any]) -> str:
    choices = resp.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0] if isinstance(choices[0], dict) else {}
    msg = first.get("message") if isinstance(first.get("message"), dict) else {}
    text = _extract_openrouter_message_text(msg.get("content"))
    if text:
        return text
    choice_text = first.get("text")
    if isinstance(choice_text, str):
        return choice_text
    return ""


def _find_first_key(obj: Any, key: str) -> Any:
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for v in obj.values():
            found = _find_first_key(v, key)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = _find_first_key(item, key)
            if found is not None:
                return found
    return None


def _unwrap_output(status_obj: dict[str, Any]) -> dict[str, Any]:
    out = status_obj.get("output")
    if isinstance(out, dict) and isinstance(out.get("output"), dict):
        return out["output"]
    if isinstance(out, dict):
        return out
    return {}


def _run_lora_ssh_command() -> tuple[dict[str, list[str]], str | None]:
    if not config.LORA_SOURCE_SSH_TARGET:
        return {"high": [], "low": []}, "LORA_SOURCE_SSH_TARGET is empty"
    if not Path(config.LORA_SOURCE_SSH_KEY).exists():
        return {"high": [], "low": []}, f"SSH key not found: {config.LORA_SOURCE_SSH_KEY}"

    marker_start = "__LORA_JSON_START__"
    marker_end = "__LORA_JSON_END__"
    remote_py = (
        "python3 - <<'PY'\n"
        "import json, pathlib\n"
        "out={}\n"
        f"paths={{'high':{config.LORA_SOURCE_HIGH_DIR!r},'low':{config.LORA_SOURCE_LOW_DIR!r}}}\n"
        "for branch, p in paths.items():\n"
        "    d = pathlib.Path(p)\n"
        "    if not d.exists() or not d.is_dir():\n"
        "        out[branch] = []\n"
        "        continue\n"
        "    files = [x.name for x in d.iterdir() if x.is_file() and x.suffix == '.safetensors']\n"
        "    out[branch] = sorted(files)\n"
        f"print({marker_start!r})\n"
        "print(json.dumps(out))\n"
        f"print({marker_end!r})\n"
        "PY\n"
        "exit\n"
    )
    cmd = [
        "ssh",
        "-tt",
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        f"ConnectTimeout={config.LORA_SSH_CONNECT_TIMEOUT_SEC}",
        "-i",
        config.LORA_SOURCE_SSH_KEY,
        config.LORA_SOURCE_SSH_TARGET,
    ]
    try:
        proc = subprocess.run(
            cmd,
            input=remote_py.encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=max(10, config.LORA_SSH_CONNECT_TIMEOUT_SEC + 15),
            check=False,
        )
        raw = proc.stdout.decode("utf-8", errors="replace").replace("\r", "")

        start_idx = raw.rfind(marker_start)
        end_idx = raw.rfind(marker_end)
        if start_idx == -1 or end_idx == -1 or end_idx <= start_idx:
            msg = raw.strip() or f"ssh exited with code {proc.returncode}"
            return {"high": [], "low": []}, f"ssh did not return LoRA JSON markers: {msg}"

        json_blob = raw[start_idx + len(marker_start) : end_idx].strip()
        parsed = json.loads(json_blob)
        high = parsed.get("high", []) if isinstance(parsed, dict) else []
        low = parsed.get("low", []) if isinstance(parsed, dict) else []
        if not isinstance(high, list):
            high = []
        if not isinstance(low, list):
            low = []
        if proc.returncode != 0:
            # Keep parsed result if present, but surface non-zero exit as warning.
            return {"high": [str(x) for x in high], "low": [str(x) for x in low]}, f"ssh exited with code {proc.returncode}"
        return {"high": [str(x) for x in high], "low": [str(x) for x in low]}, None
    except subprocess.TimeoutExpired:
        return {"high": [], "low": []}, "ssh timed out while fetching LoRAs"
    except Exception as e:
        return {"high": [], "low": []}, f"failed to fetch LoRAs: {e}"


def _get_loras(refresh: bool = False) -> tuple[dict[str, list[str]], str | None, bool]:
    now = _now()
    with state.LORA_CACHE_LOCK:
        cache_age = now - float(state.LORA_CACHE.get("ts", 0.0))
        cache_valid = bool(state.LORA_CACHE.get("ts")) and cache_age < float(config.LORA_LIST_CACHE_TTL_SEC)
        if not refresh and cache_valid:
            return {"high": list(state.LORA_CACHE.get("high", [])), "low": list(state.LORA_CACHE.get("low", []))}, None, True

    fetched, err = _run_lora_ssh_command()
    if err is None:
        with state.LORA_CACHE_LOCK:
            state.LORA_CACHE["ts"] = now
            state.LORA_CACHE["high"] = list(fetched.get("high", []))
            state.LORA_CACHE["low"] = list(fetched.get("low", []))
        return fetched, None, False

    with state.LORA_CACHE_LOCK:
        has_cache = bool(state.LORA_CACHE.get("high") or state.LORA_CACHE.get("low"))
        if has_cache:
            return {"high": list(state.LORA_CACHE.get("high", [])), "low": list(state.LORA_CACHE.get("low", []))}, err, True
    return {"high": [], "low": []}, err, False


def _submit_job(endpoint_id: str, job_input: dict[str, Any]) -> str:
    url = f"{config.RUNPOD_API_BASE}/{endpoint_id}/run"
    resp = _request_json("POST", url, {"input": job_input}, timeout=config.HTTP_TIMEOUT_SEC)
    job_id = resp.get("id")
    if not job_id:
        raise RuntimeError(f"RunPod submit response missing job id: {resp}")
    return str(job_id)


def _extract_runpod_progress(resp: dict[str, Any]) -> dict[str, Any] | None:
    """Extract progress fields from a RunPod status response."""
    output = resp.get("output")
    if not isinstance(output, dict):
        return None
    progress: dict[str, Any] = {}
    for key in ("message", "percent", "stage", "step", "total_steps", "eta_seconds", "avg_step_seconds", "elapsed_seconds"):
        if key in output:
            progress[key] = output[key]
    return progress if progress else None


def _poll_status(endpoint_id: str, remote_job_id: str, timeout_sec: int = config.POLL_TIMEOUT_SEC, on_status: Any = None, on_poll: Any = None) -> dict[str, Any]:
    url = f"{config.RUNPOD_API_BASE}/{endpoint_id}/status/{remote_job_id}"
    deadline = _now() + timeout_sec
    last_status = None

    while True:
        resp = _request_json("GET", url, None, timeout=config.HTTP_TIMEOUT_SEC)
        status = str(resp.get("status", "UNKNOWN")).upper()
        if status != last_status:
            last_status = status
            if on_status is not None:
                on_status(status)
        if on_poll is not None:
            on_poll(resp)

        if status in {"COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"}:
            return resp
        if _now() > deadline:
            raise RuntimeError(f"Timed out waiting for remote job {remote_job_id}; last status={status}")
        time.sleep(config.POLL_INTERVAL_SEC)


def _download_video_to_output(video_url: str, local_job_id: str, max_retries: int = 3) -> Path:
    ts = time.strftime("%Y%m%d_%H%M%S")
    filename = f"{ts}_{local_job_id[:8]}.mp4"
    path = config.LOCAL_OUTPUT_DIR / filename

    last_error: Exception | None = None
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(video_url, method="GET")
            with urllib.request.urlopen(req, timeout=max(config.HTTP_TIMEOUT_SEC, 300)) as resp:
                with path.open("wb") as f:
                    while True:
                        chunk = resp.read(1024 * 256)
                        if not chunk:
                            break
                        f.write(chunk)
            return path
        except Exception as e:
            last_error = e
            if attempt < max_retries - 1:
                wait = 2 ** attempt
                print(f"[download] attempt {attempt + 1} failed for {local_job_id[:8]}, retrying in {wait}s: {e}", flush=True)
                time.sleep(wait)

    raise RuntimeError(f"Download failed after {max_retries} attempts: {last_error}")


def _embed_job_metadata(job_id: str, local_path: Path) -> None:
    """Embed generation metadata from a job record into the downloaded media file."""
    try:
        job = _job_snapshot(job_id)
        if not job:
            return
        request_data = job.get("request", {})
        meta = media_meta.build_generation_meta(
            prompt=request_data.get("prompt", ""),
            negative_prompt=request_data.get("negative_prompt", ""),
            seed=job.get("seed"),
            model=job.get("model_cls", ""),
            task_type=job.get("task_type", ""),
            width=request_data.get("width"),
            height=request_data.get("height"),
            frames=request_data.get("frames"),
            fps=request_data.get("fps"),
            loras=request_data.get("loras"),
            lora_hashes=job.get("lora_hashes"),
            model_hashes=job.get("model_hashes"),
            inference_settings=job.get("inference_settings"),
        )
        if media_meta.embed_metadata(local_path, meta):
            print(f"[meta] Embedded generation metadata into {local_path.name}", flush=True)
    except Exception as e:
        print(f"[meta] Warning: failed to embed metadata into {local_path.name}: {e}", flush=True)


def _parse_ratio(value: str) -> float | None:
    text = str(value or "").strip()
    if not text:
        return None
    if "/" in text:
        left, right = text.split("/", 1)
        try:
            num = float(left.strip())
            den = float(right.strip())
            if den == 0:
                return None
            return num / den
        except Exception:
            return None
    try:
        return float(text)
    except Exception:
        return None


def _probe_video_metadata(path: Path) -> dict[str, Any]:
    """Read real output metadata from file with ffprobe."""
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,avg_frame_rate,nb_frames",
        "-of",
        "json",
        str(path),
    ]
    try:
        raw = subprocess.check_output(cmd, stderr=subprocess.STDOUT).decode("utf-8", errors="replace")
        obj = json.loads(raw)
    except Exception as e:
        raise RuntimeError(f"ffprobe failed: {e}") from e

    streams = obj.get("streams") if isinstance(obj, dict) else None
    if not isinstance(streams, list) or not streams:
        raise RuntimeError("ffprobe returned no video stream")

    stream = streams[0] if isinstance(streams[0], dict) else {}
    width = stream.get("width")
    height = stream.get("height")
    fps = _parse_ratio(str(stream.get("avg_frame_rate", "")))
    frames_raw = stream.get("nb_frames")
    frames = None
    try:
        if frames_raw is not None and str(frames_raw).strip().isdigit():
            frames = int(str(frames_raw).strip())
    except Exception:
        frames = None

    return {
        "resolution": {"width": int(width), "height": int(height)} if width and height else None,
        "fps": round(float(fps), 3) if fps is not None else None,
        "frames": frames,
    }


def _job_snapshot(job_id: str) -> dict[str, Any]:
    with state.JOBS_LOCK:
        job = state.JOBS.get(job_id)
        if job:
            return {k: v for k, v in job.items() if not k.startswith("_")}
    # Fall back to SQLite for completed/historical jobs
    stored = db.get_job(job_id)
    return stored if stored else {}


def _update_job(job_id: str, **updates: Any) -> None:
    flush_record: dict[str, Any] | None = None
    with state.JOBS_LOCK:
        if job_id not in state.JOBS:
            return
        state.JOBS[job_id].update(updates)
        state.JOBS[job_id]["updated_at"] = _now()

        status = str(state.JOBS[job_id].get("status", "")).upper()
        if status in db.TERMINAL_JOB_STATUSES:
            # Snapshot and evict from memory
            flush_record = dict(state.JOBS[job_id])
            del state.JOBS[job_id]

        state._persist_jobs_locked()

    # Write to SQLite outside the lock
    if flush_record is not None:
        try:
            db.save_job(flush_record)
        except Exception as e:
            print(f"[job-history] failed to flush job {job_id} to SQLite: {e}", flush=True)
            # Put it back in memory so it's not lost
            with state.JOBS_LOCK:
                if job_id not in state.JOBS:
                    state.JOBS[job_id] = flush_record
                    state._persist_jobs_locked()


def _run_local_job(local_job_id: str, endpoint_id: str, job_input: dict[str, Any]) -> None:
    t0 = _now()
    try:
        _update_job(local_job_id, status="SUBMITTING")
        remote_job_id = _submit_job(endpoint_id, job_input)
        _update_job(local_job_id, status="RUNNING", remote_job_id=remote_job_id)

        def _on_poll(resp: dict[str, Any]) -> None:
            progress = _extract_runpod_progress(resp)
            if progress:
                _update_job(local_job_id, runpod_progress=progress)

        status_obj = _poll_status(
            endpoint_id,
            remote_job_id,
            timeout_sec=config.POLL_TIMEOUT_SEC,
            on_status=lambda s: _update_job(local_job_id, remote_status=s),
            on_poll=_on_poll,
        )

        remote_status = str(status_obj.get("status", "UNKNOWN")).upper()
        if remote_status != "COMPLETED":
            error_msg = _find_first_key(status_obj, "error") or f"remote job status={remote_status}"
            _update_job(
                local_job_id,
                status=remote_status,
                error=str(error_msg),
                elapsed_seconds=round(_now() - t0, 3),
            )
            return

        output = _unwrap_output(status_obj)
        video_url = output.get("url") or output.get("video_url") or _find_first_key(output, "url")
        if not video_url:
            _update_job(
                local_job_id,
                status="FAILED",
                error=f"COMPLETED but no url in output: {output}",
                elapsed_seconds=round(_now() - t0, 3),
            )
            return

        final_seed = output.get("seed") or _find_first_key(output, "seed")
        # Endpoint-reported values are useful for debugging but may be echoed from input.
        endpoint_resolution = output.get("resolution") if isinstance(output.get("resolution"), dict) else None
        endpoint_frames = output.get("frames")
        endpoint_fps = output.get("fps")
        # Capture generation metadata for CivitAI sharing
        lora_hashes = output.get("lora_hashes") or {}
        model_hashes = output.get("model_hashes") or {}
        model_cls = output.get("model_cls") or ""
        inference_settings = output.get("inference_settings") or {}

        _update_job(
            local_job_id,
            video_url=str(video_url),
            seed=final_seed,
            endpoint_reported_resolution=endpoint_resolution,
            endpoint_reported_frames=endpoint_frames,
            endpoint_reported_fps=endpoint_fps,
            lora_hashes=lora_hashes,
            model_hashes=model_hashes,
            model_cls=model_cls,
            inference_settings=inference_settings,
        )

        try:
            local_path = _download_video_to_output(str(video_url), local_job_id)
            local_url = f"/outputs/{local_path.name}"
            measured = _probe_video_metadata(local_path)
            _update_job(
                local_job_id,
                local_file=str(local_path),
                local_video_url=local_url,
                actual_resolution=measured.get("resolution"),
                actual_frames=measured.get("frames"),
                actual_fps=measured.get("fps"),
            )
            # Embed generation metadata into the video file
            _embed_job_metadata(local_job_id, local_path)
            final_status = "COMPLETED"
            warning = None
        except Exception as e:
            final_status = "COMPLETED_WITH_WARNING"
            warning = f"Failed local save: {e}"

        _update_job(
            local_job_id,
            status=final_status,
            warning=warning,
            elapsed_seconds=round(_now() - t0, 3),
            remote_status=remote_status,
        )
    except Exception as e:
        _update_job(local_job_id, status="FAILED", error=str(e), elapsed_seconds=round(_now() - t0, 3))


def _new_job_record(local_job_id: str, endpoint_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    now = _now()
    loras = payload.get("loras", [])
    if not isinstance(loras, list):
        loras = []
    lora_view = []
    for item in loras:
        if isinstance(item, dict):
            lora_view.append(
                {
                    "name": item.get("name"),
                    "branch": item.get("branch"),
                    "strength": item.get("strength"),
                }
            )
    return {
        "job_id": local_job_id,
        "endpoint_id": endpoint_id,
        "status": "QUEUED",
        "remote_status": None,
        "remote_job_id": None,
        "video_url": None,
        "local_video_url": None,
        "local_file": None,
        "seed": None,
        "error": None,
        "warning": None,
        "elapsed_seconds": None,
        "runpod_progress": None,
        "created_at": now,
        "updated_at": now,
        "request": {
            "prompt": payload.get("prompt", ""),
            "resolution": payload.get("resolution", {}),
            "width": payload.get("width"),
            "height": payload.get("height"),
            "frames": payload.get("frames"),
            "fps": payload.get("fps"),
            "sent_payload_resolution": payload.get("resolution"),
            "sent_payload_width": payload.get("width"),
            "sent_payload_height": payload.get("height"),
            "sent_payload_target_width": payload.get("target_width"),
            "sent_payload_target_height": payload.get("target_height"),
            "sent_payload_target_video_length": payload.get("target_video_length"),
            "seed_mode": "fixed" if "seed" in payload else "random",
            "requested_seed": payload.get("seed"),
            "loras": lora_view,
            "negative_prompt": payload.get("negative_prompt", ""),
        },
    }

"""BlockFlow MCP — let Claude run ComfyGen jobs and land outputs in the gallery.

Thin client over the already-running BlockFlow backend (`uv run app.py`, :8000).
Caller supplies the workflow JSON, per-node overrides, and (for I2V/V2V) local
files to upload into LoadImage/LoadVideo nodes; Claude can fan out many jobs to
mimic auto mode. Submit is fire-and-forget; the backend persists each finished
job into one growing gallery run shown live under Artifacts > MCP.

Run:  uv run --with fastmcp mcp_server.py        (stdio, for Claude config)
Env:  BLOCKFLOW_URL (default http://127.0.0.1:8000)
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any

import httpx
from fastmcp import FastMCP

BASE = os.environ.get("BLOCKFLOW_URL", "http://127.0.0.1:8000").rstrip("/")
TERMINAL = {"COMPLETED", "COMPLETED_WITH_WARNING", "FAILED", "CANCELLED", "TIMED_OUT"}

mcp = FastMCP("blockflow")


def _client() -> httpx.Client:
    return httpx.Client(base_url=BASE, timeout=60.0)


def _as_workflow(workflow: dict[str, Any] | str) -> dict[str, Any]:
    if isinstance(workflow, str):
        workflow = json.loads(workflow)
    if not workflow:
        raise ValueError("workflow is required")
    return workflow


def _resolve_file_inputs(inputs: dict[str, str] | None) -> dict[str, dict[str, str]]:
    # {node_id: {media_url}} — local abs path passes the backend's existence check as-is.
    out: dict[str, dict[str, str]] = {}
    for node_id, path in (inputs or {}).items():
        path = str(path).strip()
        if not path:
            continue
        if not path.startswith("/outputs/") and not os.path.isfile(path):
            raise FileNotFoundError(f"input for node {node_id} not found: {path}")
        out[str(node_id)] = {"media_url": path}
    return out


def _post_run(c, workflow, overrides, inputs, bypass_loras, add_loras,
              lock_seed: bool, endpoint_id: str, batch_id: str) -> str:
    """Submit one job via /run (source=mcp) and return its job_id."""
    body = {
        "workflow": workflow,
        "overrides": {k: str(v) for k, v in (overrides or {}).items() if str(v).strip()} or None,
        "file_inputs": _resolve_file_inputs(inputs) or None,
        "bypass_loras": [str(n) for n in (bypass_loras or []) if str(n).strip()] or None,
        "added_loras": list(add_loras) if add_loras else None,
        "lock_seed": lock_seed or None,
        "endpoint_id": endpoint_id or None,
        "source": "mcp",
        "batch_id": batch_id,
    }
    r = c.post("/api/blocks/comfy_gen/run", json=body)
    try:
        data = r.json()
    except ValueError:
        r.raise_for_status()
        raise
    if not data.get("ok"):
        # Surface the backend's clear message (e.g. invalid LoRA anchor).
        raise RuntimeError(data.get("error", f"submit failed ({r.status_code})"))
    return data["job_id"]


@mcp.tool()
def list_loras() -> dict[str, Any]:
    """List LoRA filenames available on the configured ComfyGen endpoint (the same
    set the UI's LoRA dropdown shows). Use these exact names in overrides like
    {"<lora_node_id>.lora_name": "<name>.safetensors"}. Also returns available
    samplers and schedulers."""
    with _client() as c:
        data = c.get("/api/blocks/comfy_gen/cache").json()
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "cache fetch failed"))
    loras = data.get("loras") or []
    return {"loras": loras, "count": len(loras),
            "samplers": data.get("samplers") or [], "schedulers": data.get("schedulers") or []}


@mcp.tool()
def inspect_workflow(workflow: dict[str, Any] | str) -> dict[str, Any]:
    """Parse a ComfyUI API-format workflow and report what's tunable BEFORE submitting.
    Returns load_nodes (LoadImage/LoadVideo that need a file uploaded — use their
    node_id in submit_jobs `inputs`), ksamplers, text_overrides, resolution_nodes,
    lora_nodes, and output_type. Call this first for any I2V/V2V workflow so you know
    which node needs a start image."""
    if isinstance(workflow, str):
        workflow = json.loads(workflow)
    with _client() as c:
        r = c.post("/api/blocks/comfy_gen/parse-workflow", json={"workflow": workflow})
        data = r.json()
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "parse failed"))
    return {k: data[k] for k in (
        "load_nodes", "ksamplers", "text_overrides", "resolution_nodes",
        "lora_nodes", "output_type",
    ) if k in data}


@mcp.tool()
def submit_jobs(
    workflow: dict[str, Any] | str,
    overrides: dict[str, str] | None = None,
    inputs: dict[str, str] | None = None,
    bypass_loras: list[str] | None = None,
    add_loras: list[dict[str, Any]] | None = None,
    count: int = 1,
    lock_seed: bool = False,
    endpoint_id: str = "",
    batch_id: str = "",
) -> dict[str, Any]:
    """Submit `count` ComfyGen jobs to BlockFlow. Fire-and-forget — returns job_ids
    immediately so you can fan out (auto mode). Seeds auto-randomize per job unless
    lock_seed=True. `overrides` maps "<node_id>.<param>" -> value, e.g.
    {"6.text": "a cat", "2.steps": "12"}.

    `inputs` uploads local files into LoadImage/LoadVideo nodes (I2V/V2V start image,
    reference video): {"<node_id>": "/abs/path/to/start.png"}. The path must exist on
    THIS machine; the backend uploads it to the worker. Use inspect_workflow first to
    find the node_id. All jobs in the batch share the same input file.

    `bypass_loras` disables specific LoRA loader nodes by node_id, e.g. ["298","300"].
    Get the node_ids from inspect_workflow's `lora_nodes`. To change a LoRA's weight or
    swap its file instead, use overrides ("<id>.strength_model", "<id>.lora_name").

    `add_loras` stacks NEW LoRA loaders onto the chain without editing the workflow —
    like the UI's "add LoRA". Each item: {lora_name, strength_model?, strength_clip?,
    anchor?}. `anchor` is an existing LoRA node_id to stack onto (from inspect_workflow
    `lora_nodes`); omit it to stack onto the first detected chain. Use list_loras for
    valid names. A bad anchor is a hard error (not silently ignored). For MoE/dual-chain
    workflows, pass one entry per chain with explicit anchors to apply to both paths.

    All jobs in one call share a batch_id and stream into ONE gallery run that grows
    live in the Artifacts > MCP view as each finishes — the backend persists them, so
    you do NOT need to call wait_for_jobs for them to appear. Pass an existing
    batch_id to add more jobs to the same gallery run. Returns {job_ids, batch_id}.
    """
    workflow = _as_workflow(workflow)
    batch_id = batch_id or uuid.uuid4().hex[:12]
    job_ids: list[str] = []
    with _client() as c:
        for _ in range(max(1, count)):
            job_ids.append(_post_run(c, workflow, overrides, inputs, bypass_loras,
                                     add_loras, lock_seed, endpoint_id, batch_id))
    return {"job_ids": job_ids, "batch_id": batch_id}


@mcp.tool()
def submit_batch(
    workflow: dict[str, Any] | str,
    jobs: list[dict[str, Any]],
    add_loras: list[dict[str, Any]] | None = None,
    lock_seed: bool = False,
    endpoint_id: str = "",
    batch_id: str = "",
) -> dict[str, Any]:
    """Submit MANY different jobs at once over a shared workflow — the right tool for
    "generate N images" with different prompts. Each item in `jobs` is
    {overrides?, inputs?, bypass_loras?, add_loras?} (same meaning as submit_jobs).
    All fire immediately (fire-and-forget) and share one batch_id, so up to the
    server's worker limit run CONCURRENTLY and they stream into one growing gallery run.

    `add_loras` here is a call-level default applied to every job; a spec may set its
    own `add_loras` to override. See submit_jobs for the entry shape.

    Do NOT call wait_for_jobs between submits — that serializes them; submit the whole
    batch in one call, then optionally wait once. Returns {job_ids, batch_id}.
    """
    workflow = _as_workflow(workflow)
    batch_id = batch_id or uuid.uuid4().hex[:12]
    job_ids: list[str] = []
    with _client() as c:
        for spec in jobs:
            job_ids.append(_post_run(
                c, workflow,
                spec.get("overrides"), spec.get("inputs"), spec.get("bypass_loras"),
                spec.get("add_loras", add_loras),
                lock_seed, endpoint_id, batch_id,
            ))
    return {"job_ids": job_ids, "batch_id": batch_id}


def _prompts_from_run(run: dict[str, Any], needle: str) -> list[dict[str, str]]:
    """Pull prompt strings (zipped with their output URL by index) out of a run's
    block_results. Filters to prompts containing `needle` (already lowercased)."""
    out: list[dict[str, str]] = []
    for br in run.get("block_results") or []:
        outs = br.get("outputs") or {}
        metas = (outs.get("metadata") or {}).get("value")
        metas = metas if isinstance(metas, list) else ([metas] if metas else [])
        media: list[str] = []
        for k in ("image", "video"):
            v = (outs.get(k) or {}).get("value")
            if isinstance(v, list):
                media.extend(v)
            elif v:
                media.append(v)
        for i, m in enumerate(metas):
            if not isinstance(m, dict):
                continue
            p = m.get("prompt")
            if not isinstance(p, str) or not p.strip():
                continue
            if needle and needle not in p.lower():
                continue
            out.append({"prompt": p, "url": media[i] if i < len(media) else ""})
    return out


@mcp.tool()
def search_prompts(query: str, limit: int = 20, source: str = "") -> dict[str, Any]:
    """Search prompts from past generations in the gallery. Case-insensitive substring
    match against the prompt text of every stored run (pipeline + MCP). Returns the
    matching prompts with their output URL, run_id, and created_at — use it to recall a
    prompt you (or the user) ran before, then feed it back into submit_jobs/submit_batch.

    `query` is the substring to find; pass "" to list the most recent prompts (no filter).
    `limit` caps how many runs are scanned (newest first). `source` narrows to "mcp"
    (agent-generated) or "pipeline" (UI-generated); omit for both. Returns
    {results: [{prompt, url, run_id, created_at}], count}."""
    params: dict[str, Any] = {"limit": max(1, limit)}
    if query.strip():
        params["q"] = query
    if source in ("mcp", "pipeline"):
        params["source"] = source
    with _client() as c:
        data = c.get("/api/runs", params=params).json()
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "runs fetch failed"))
    needle = query.strip().lower()
    results: list[dict[str, str]] = []
    for run in data.get("runs", []):
        for hit in _prompts_from_run(run, needle):
            results.append({
                **hit,
                "run_id": run.get("id", ""),
                "created_at": run.get("created_at", ""),
            })
    return {"results": results, "count": len(results)}


@mcp.tool()
def job_status(job_ids: list[str]) -> dict[str, Any]:
    """Non-blocking snapshot of one or more jobs (status + output URL if done).
    Does NOT save to the gallery — use wait_for_jobs for that."""
    out: dict[str, Any] = {}
    with _client() as c:
        for jid in job_ids:
            job = c.get(f"/api/blocks/comfy_gen/status/{jid}").json().get("job", {})
            out[jid] = {
                "status": job.get("status", "UNKNOWN"),
                "url": job.get("local_image_url") or job.get("local_video_url") or job.get("video_url") or "",
                "error": job.get("error", ""),
            }
    return out


@mcp.tool()
def cancel_jobs(job_ids: list[str]) -> dict[str, Any]:
    """Cancel running/queued jobs by id — kills the local subprocess and the remote
    RunPod job. Returns per-job {ok, remote_cancel_status}. Already-finished jobs
    report ok=false (nothing to cancel)."""
    out: dict[str, Any] = {}
    with _client() as c:
        for jid in job_ids:
            r = c.post(f"/api/blocks/comfy_gen/cancel/{jid}")
            data = r.json()
            out[jid] = {"ok": bool(data.get("ok")),
                        "remote_cancel_status": data.get("remote_cancel_status", ""),
                        "error": data.get("error", "")}
    return out


@mcp.tool()
def wait_for_jobs(
    job_ids: list[str],
    poll_seconds: int = 5,
    timeout_seconds: int = 1800,
) -> dict[str, Any]:
    """Block until all `job_ids` reach a terminal state, then return per-job results
    (status + output URL + error). Outputs are already persisted to the gallery by
    the backend as each job finishes — this is purely for waiting/reporting. Use it
    when you want the final URLs before continuing; otherwise the MCP view shows
    progress live without waiting."""
    deadline = time.time() + timeout_seconds
    jobs: dict[str, dict[str, Any]] = {}
    with _client() as c:
        pending = list(job_ids)
        while pending and time.time() < deadline:
            still: list[str] = []
            for jid in pending:
                job = c.get(f"/api/blocks/comfy_gen/status/{jid}").json().get("job", {})
                if str(job.get("status", "")).upper() in TERMINAL:
                    jobs[jid] = job
                else:
                    still.append(jid)
            pending = still
            if pending:
                time.sleep(poll_seconds)
        for jid in pending:  # timed out locally
            jobs[jid] = {"status": "TIMED_OUT"}

    results = []
    done = 0
    for jid in job_ids:
        job = jobs.get(jid, {})
        status = str(job.get("status", "UNKNOWN")).upper()
        url = job.get("local_image_url") or job.get("local_video_url") or job.get("video_url") or ""
        results.append({"job_id": jid, "status": status, "url": url, "error": job.get("error", "")})
        if url and status.startswith("COMPLETED"):
            done += 1
    return {"results": results, "completed": done}


if __name__ == "__main__":
    mcp.run()

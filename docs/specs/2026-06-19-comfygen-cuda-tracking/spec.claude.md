# Manifest-driven min-CUDA that tracks the ComfyGen image tag

- **Work type:** `feature/app` (extends `sgs-ui-cxs`)
- **Status:** `draft` → awaiting Aviv approval (do NOT dispatch until approved)
- **Bead:** `sgs-ui-80r`
- **Review surface:** [`spec.human.md`](./spec.human.md)

## 1. Problem / Context
min-CUDA is a property of the ComfyGen image tag, not a free knob: v27 is built on
`nvidia/cuda:13.0.3` + torch `+cu130` and **requires** host CUDA ≥ 13.0 (cu128 returns
`NOT_SUPPORTED` for nvfp4 and the cu130 SageAttention wheel won't import on cu128) — verified in
`remote_comfy_generator/serverless-docker/Dockerfile:7,43` and `.../docs/specs/2026-06-18-cu130-nvfp4-migration/DESIGN.md`.
v26 and earlier (cu128) need only ≥12.8. BlockFlow today hardcodes `allowedCudaVersions=["12.9","12.8"]`
(`backend/runpod_api.py:29,357`), so the moment the manifest moves to v27, provisioned/updated endpoints
would still permit 12.8 hosts → cu130 image boots on a 12.8 host → failure.

## 2. Approach & why
Carry the required CUDA floor per-tag in the runtime manifest; apply it as RunPod `minCudaVersion`
(a host-driver floor) on both provision and the Update button. Replace the exact-version whitelist
with the floor (the whitelist also wrongly excludes higher-CUDA hosts a cu128 image would run on).

Grounding:
- `ALLOWED_CUDA_VERSIONS` is used in exactly one place — the `allowedCudaVersions` field of
  `create_endpoint` (`backend/runpod_api.py:29,357`); not used for GPU filtering (grep-confirmed).
- The endpoint update body accepts `minCudaVersion` + `allowedCudaVersions` (RunPod
  `POST /endpoints/{id}/update` reference, verified 2026-06-19).
- Existing image-update flow to extend — `backend/comfygen_update_routes.py:62` (`update()`), which calls
  `runpod_api.update_endpoint_image` (`backend/runpod_api.py` image-update block).
- Provision call site — `backend/wizard_routes.py:578-584` (`create_endpoint(...)`).
- Manifest accessor to extend — `backend/runtime_manifest.py:latest_comfygen()`.

## 3. Acceptance Criteria
- [ ] Provision sets `minCudaVersion` from `latest_comfygen()["min_cuda_version"]`, defaulting to `"12.8"`
      when the manifest omits it; the `allowedCudaVersions` whitelist is removed → (ask: "patch the minimal cuda version as well" / "applied on provision and update")
- [ ] `POST /api/comfygen/update`, when the manifest has `min_cuda_version`, PATCHes the endpoint's
      `minCudaVersion` BEFORE PATCHing the template image; when absent, only swaps the image → (ask: "patch the minimal cuda version as well")
- [ ] A manifest with `min_cuda_version: "13.0"` pins the endpoint to ≥13.0; one with no field leaves
      Update image-only and provision at the `"12.8"` default → (ask: "need to change to 13 only?")
- [ ] If the CUDA PATCH errors, the image is NOT swapped (no half-apply); error surfaces as HTTP 502 → (ask: implied correctness)
- [ ] The CUDA PATCH also CLEARS any legacy `allowedCudaVersions` whitelist on the endpoint, so a v26 endpoint originally provisioned with `["12.9","12.8"]` is not stranded (whitelist ∩ floor = ∅) when raised to ≥13.0 → (ask: "user currently on 26 and upgrades to 27 … minimum cuda 13?")

## 4. Scope & Non-Goals
**In scope:** `backend/runtime_manifest.py` (`min_cuda_version` in `latest_comfygen`), `backend/runpod_api.py`
(`update_endpoint_cuda` + `create_endpoint` floor param, drop whitelist), `backend/wizard_routes.py` (pass
floor on provision), `backend/comfygen_update_routes.py` (CUDA-before-image in `update()`).

**Non-goals:** No frontend change (banner already covers the user-facing surface; CUDA is silent correctness).
No `allowedCudaVersions` list support. No GPU-type filtering by CUDA. No rollback/downgrade ordering logic
(floor-before-image is safe for the upgrade case we have; a downgrade just sets a lower floor). No editing of
blockflow-presets here (the `min_cuda_version` value is your separate edit there). No status-route change
(staleness is still image-tag only).

## 5. Key Decisions & Constraints
- **Decided:** `minCudaVersion` floor; drop `allowedCudaVersions`. Manifest carries one string (e.g. `"13.0"`).
- **Decided:** absent field → provision default `"12.8"`; Update skips the CUDA patch (image-only).
- **Decided:** Update patches CUDA before image (upgrade-safe: old image runs on ≥-CUDA hosts).
- **Decided:** `update_endpoint_cuda` PATCHes BOTH `minCudaVersion` AND `allowedCudaVersions: []` in one call, so
  the floor is authoritative and any legacy whitelist (from a pre-`sgs-ui-80r` provision) can't intersect-to-empty
  and strand the endpoint. The same applies on provision (whitelist already dropped there).
- **Constraint:** if `update_endpoint_cuda` raises, do not call `update_endpoint_image` — abort with 502.
- **Constraint:** validate the manifest value as `^\d+\.\d+$`; an invalid/blank value is treated as absent
  (don't push garbage to RunPod).
- **Mirror existing:** `update_endpoint_workers` (`backend/runpod_api.py:362-374`) is the exact PATCH-endpoint
  shape to copy for `update_endpoint_cuda`.

## 6. Code Surface Map
- `backend/runtime_manifest.py:latest_comfygen()` — add `"min_cuda_version": <str|None>` (validated `^\d+\.\d+$`).
- `backend/runpod_api.py:331-359` — `create_endpoint(..., min_cuda_version: str = "12.8")`: replace
  `"allowedCudaVersions": ALLOWED_CUDA_VERSIONS` with `"minCudaVersion": min_cuda_version`. Remove the now-unused
  `ALLOWED_CUDA_VERSIONS` constant.
- `backend/runpod_api.py` (endpoints block) — add `update_endpoint_cuda(api_key, endpoint_id, min_cuda_version) -> dict`
  → `PATCH /endpoints/{id}` `{"minCudaVersion": min_cuda_version, "allowedCudaVersions": []}` (mirror
  `update_endpoint_workers`). Clearing `allowedCudaVersions` removes any legacy whitelist that would intersect the
  floor to ∅.
- `backend/wizard_routes.py:578-584` — pass `min_cuda_version=runtime_manifest.latest_comfygen()["min_cuda_version"] or "12.8"`
  into `create_endpoint`.
- `backend/comfygen_update_routes.py:62-86` (`update()`) — before `update_endpoint_image`, if
  `latest["min_cuda_version"]` is set, call `update_endpoint_cuda` first; on error → 502 (no image swap).

## 7. Ultracode Dispatch Notes
**Build first (sequential — freezes interfaces):**
- **Slice A — manifest field + RunPod helpers.** `runtime_manifest.latest_comfygen()` gains validated
  `min_cuda_version`. `runpod_api`: add `update_endpoint_cuda`; change `create_endpoint` to the `min_cuda_version`
  floor param and drop the whitelist/constant. Tests: manifest parse (present/absent/invalid → None);
  `update_endpoint_cuda` PATCHes `/endpoints/{id}` with `minCudaVersion` AND `allowedCudaVersions: []` (whitelist
  cleared); `create_endpoint` body now carries `minCudaVersion` and no `allowedCudaVersions`.

**Parallel slices:**
- **Slice B — wire provision + update.** Writes `backend/wizard_routes.py`, `backend/comfygen_update_routes.py`.
  Provision threads the manifest floor (default `"12.8"`). `update()` applies CUDA-before-image when present,
  skips when absent, and aborts (no image swap) if the CUDA patch fails. Tests (mock runpod_api + manifest):
  manifest with `13.0` → update calls `update_endpoint_cuda("13.0")` then `update_endpoint_image`; manifest
  without it → only `update_endpoint_image`; CUDA patch raises → `update_endpoint_image` NOT called, 502;
  provision passes the floor (and the `"12.8"` default when absent).

**⛓ Collision audit:** A writes `runtime_manifest.py` + `runpod_api.py`; B writes `wizard_routes.py` +
`comfygen_update_routes.py`. No shared file. B depends only on A's frozen signatures.

```yaml
dispatch:
  frozen:
    - backend/runtime_manifest.py
    - backend/runpod_api.py
  slices:
    - {key: wire_flows, writes: [backend/wizard_routes.py, backend/comfygen_update_routes.py]}
  testRunner: "uv run pytest tests/<file>::<test> -ra"
```

## 8. Assumptions & Open Questions
- **ASSUMPTION:** RunPod's create-endpoint (`POST /endpoints`) accepts `minCudaVersion` (confirmed on the update
  endpoint; create shares the EndpointInput family). If create rejects it, fall back to provision-then-PATCH via
  `update_endpoint_cuda`. Verify with one live provision.
- **ASSUMPTION:** `minCudaVersion` is a `≥` floor, not exact-match (per the deploy doc's "Minimum CUDA → 13.0" and
  RunPod field semantics). If exact-match, a 13.1 host would be wrongly excluded → would need the whitelist instead.
- **ASSUMPTION:** RunPod intersects `allowedCudaVersions` with `minCudaVersion` (so a stale whitelist strands the
  endpoint), and accepts `allowedCudaVersions: []` to clear it. If RunPod ignores the whitelist once a floor is set,
  the clear is a harmless no-op; if `[]` is rejected, use `null`. Verify on the v26→v27 live click.
- **ASSUMPTION:** you add `min_cuda_version` to the v27 entry in blockflow-presets (absent today). Accessor + flows
  treat it as optional, so nothing breaks before you do.

# Manifest-driven min-CUDA that tracks the ComfyGen image tag

**Type:** `feature/app` · **Full spec:** [`spec.claude.md`](./spec.claude.md) · **Bead:** `sgs-ui-80r` · extends `sgs-ui-cxs`

## ✅ What you'll see when this is done
When you provision a ComfyGen endpoint, or click **Update**, the endpoint's RunPod **Minimum CUDA
version** is set to whatever the current image tag requires (from the manifest). Moving the manifest
to v27 (`min_cuda_version: "13.0"`) means new + updated endpoints are pinned to host CUDA ≥ 13.0, so
the cu130 image can't land on a 12.8 host and fail to boot. No visible UI change beyond the existing
banner — this is correctness wiring.

## ⚠️ Decisions you're approving
- **Use `minCudaVersion` (floor), drop the `allowedCudaVersions` whitelist** — manifest carries one value (`"13.0"`); we set `minCudaVersion` = host CUDA ≥ that. Chose this over *keeping the exact-version whitelist* (which currently pins `["12.9","12.8"]` and wrongly excludes higher-CUDA hosts).
- **Manifest field is optional** — when a tag's manifest entry has no `min_cuda_version`: provision uses a default floor `"12.8"` (today's cu128 reality); Update **skips** the CUDA patch (image-only). Chose this over *requiring the field* (which would break until every tag is backfilled).
- **On Update, patch CUDA *before* the image** — for an upgrade the old image still runs on the higher-CUDA hosts, so no failing window. Chose this over *image-first* (which briefly lets 12.8 hosts try a cu130 image).
- **The CUDA patch also CLEARS the legacy `allowedCudaVersions` whitelist** — every endpoint you provisioned before this feature carries `["12.9","12.8"]`. RunPod intersects that with the new ≥13.0 floor → empty host set → stranded endpoint. So `update_endpoint_cuda` sends `minCudaVersion` *and* `allowedCudaVersions: []` together. (This is the fix for your "v26 → v27" question.)

## 🎲 Riding on these assumptions
- **RunPod's create-endpoint body accepts `minCudaVersion`** (it's confirmed on the *update* endpoint; create uses the same EndpointInput family). If create rejects it, provision falls back to setting it via a follow-up PATCH. (couldn't confirm create-side against a live call.)
- **`minCudaVersion` is a floor (≥), not an exact match** — per your deploy doc's "Minimum CUDA version → 13.0" usage and RunPod's field description. If it were exact-match, a 13.1 host would be excluded.
- **You'll add `min_cuda_version` to the v27 manifest entry in blockflow-presets** — absent today; the accessor + flows treat it as optional.

## 🪤 Gotchas
- `ALLOWED_CUDA_VERSIONS=["12.9","12.8"]` (`runpod_api.py:29`) is referenced only in `create_endpoint` — removing the whitelist there is the whole blast radius (not used for GPU filtering).
- Two RunPod PATCHes on Update now (endpoint CUDA, then template image); if the CUDA patch fails, abort before swapping the image (don't half-apply).
- **Legacy whitelist conflict (the v26→v27 footgun):** existing endpoints have `allowedCudaVersions=["12.9","12.8"]`; raising the floor to 13.0 without clearing it = zero eligible hosts. The CUDA patch clears the whitelist in the same call to avoid this.
- **The `min_cuda_version` field is load-bearing:** if the v27 manifest entry omits it, Update swaps to the cu130 image but leaves CUDA alone → cu130 on a 12.8 host → boot failure. Don't ship the v27 tag without it.
- minCudaVersion gates the *host driver*, independent of `gpuTypeIds` — a GPU can be allowed but its host still filtered out by the floor.

## Done when
- [ ] Provision sets `minCudaVersion` from the manifest (default `"12.8"` when absent); `allowedCudaVersions` whitelist is gone.
- [ ] Update, when the tag's manifest entry has `min_cuda_version`, PATCHes the endpoint CUDA floor *and clears `allowedCudaVersions`* before the image; when absent, only swaps the image.
- [ ] A v26 endpoint (provisioned with the old whitelist) upgrading to v27 ends up on ≥13.0 with no leftover whitelist — not stranded.
- [ ] A v27 manifest (`min_cuda_version: "13.0"`) results in endpoints pinned to ≥13.0.
- [ ] Existing manifests (no field) keep working: provision defaults to 12.8, Update is image-only.

## The plan
1. **Build-first:** `latest_comfygen()` also returns `min_cuda_version` (optional, validated `^\d+\.\d+$`); add `runpod_api.update_endpoint_cuda()`; add a `min_cuda_version` param to `create_endpoint` replacing the whitelist.
2. **Slice B (backend):** wire provision (`wizard_routes`) to pass the manifest CUDA into `create_endpoint`; extend `POST /api/comfygen/update` to patch CUDA-before-image when present.

## ✂️ Not asked for — cut?
- (none — traces to "patch the minimal cuda version as well" + "manifest-driven, applied on provision and update".)

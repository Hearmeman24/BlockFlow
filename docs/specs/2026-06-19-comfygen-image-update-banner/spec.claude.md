# ComfyGen update banner — notify on stale image tag + one-click in-place update

- **Work type:** `feature/app`
- **Status:** `draft` → awaiting Aviv approval (do NOT dispatch until approved)
- **Bead:** `sgs-ui-cxs`
- **Review surface:** [`spec.human.md`](./spec.human.md)

## 1. Problem / Context
A new ComfyGen Docker tag is published by editing `runtime-manifest.json` in the blockflow-presets repo.
Today BlockFlow only reads that tag when **provisioning a new endpoint** (`backend/wizard_routes.py:564` →
`runtime_manifest.resolve_comfygen_image()`). Users with an **already-provisioned** endpoint are never told a
newer image exists and have no in-app way to update. We want: on app start, detect a stale endpoint, show a
banner, and let one click re-image the endpoint.

Live manifest today (verified via curl):
```json
{ "manifest_version": 1, "comfygen_serverless": { "channel": "stable",
  "image": "hearmeman/comfyui-serverless:v25", "tag": "v25", ... } }
```
BlockFlow fallback is `hearmeman/comfyui-serverless:v24` (`backend/runtime_manifest.py:16`).

## 2. Approach & why
- **Staleness = stored endpoint tag vs manifest tag**, compared numerically (`v25` → 25 > `v24` → 24).
- We persist the image tag on the endpoint row when we provision/update it (we own the value). Legacy rows
  (pre-feature) have no tag → one-time backfill from RunPod, with a safe "assume current" fallback.
- **Update re-images the running endpoint, mirroring the proven `update_endpoint` CI recipe** in the ComfyGen repo
  (`serverless-docker/.circleci/generate_continue.py:148-175`). The flow is endpoint-rooted:
  `GET /v1/endpoints/{endpoint_id}` → read `templateId` → `PATCH /v1/templates/{templateId}` with
  `{"imageName": new_image}`. RunPod then rolls the endpoint's pods onto the new tag (~1 hr); user is told.
- **Staleness + current tag are read live, not stored** — same endpoint-rooted read (`GET endpoint → templateId →
  GET template → imageName`), exactly how the ComfyGen `wait_for_rollout.py:32-68` confirms rollout. This drops the
  earlier `image_tag` column + backfill entirely.

Grounding (from working ComfyGen code, not just docs):
- `update_endpoint` CI step: `GET https://rest.runpod.io/v1/endpoints/{id}` → `templateId`, then PATCH
  `https://rest.runpod.io/v1/templates/{tid}` body `{"imageName": "hearmeman/comfyui-serverless:vN"}`
  (`serverless-docker/.circleci/generate_continue.py:152-175`).
- Rollout confirm reads `myself.endpoints[id].pods[].imageName` via GraphQL until every pod ends with `:vN`
  (`automation/wait_for_rollout.py:32-68`) — optional for BlockFlow; the banner can show a flat ~1 hr message instead.
- BlockFlow already has the REST helpers to mirror: `_rest_get` (`backend/runpod_api.py:166-181`), `_rest_patch`
  (`:90-104`); base is `REST_BASE = "https://rest.runpod.io/v1"` (`:21`). Endpoint id is stored
  (`backend/settings_store.py` endpoint row).
- Env bundle is rebuildable from settings at any time — `backend/wizard_routes.py:162-180` (`_build_env_for_template`).
- Endpoint row currently stores `template_id`/`template_name` but **no image tag** —
  `backend/settings_store.py:78-88` (schema), `:31-39` (`_ENDPOINT_COLS`), `:298-352` (`set_endpoint`, full-row-replace).
- App-start client surface is `AppShell` — `frontend/src/components/app-shell.tsx:31-79`.
- Endpoint read API already exists for the frontend — `backend/settings_routes.py:80-92`.

## 3. Acceptance Criteria
- [ ] When a ComfyGen endpoint is configured and its stored tag < manifest tag, the app shows a centered banner
      with `current → latest` and Update/Dismiss → (ask: "Add a banner or a central message on screen saying: ComfyGen has an update")
- [ ] When up-to-date OR no endpoint is configured, no banner appears → (ask: "if tag is stale")
- [ ] Update click calls the backend, which runs the `update_endpoint` recipe (GET endpoint → templateId → PATCH
      template `imageName`), and returns a ~1hr propagation message shown to the user → (ask: "Clicking update sends an API request to Runpod and updates the tag with the latest" + "an update can take around an hour to propagate")
- [ ] Dismiss hides the banner for the current latest tag; a higher tag later re-shows it → (ask: "click to dismiss")
- [ ] Banner renders release notes when present and renders cleanly when absent → (ask: "surface the release notes of the corresponding image tag")
- [ ] The current tag is read live from the endpoint's template (no stored tag); a RunPod read failure fails closed (no false banner) → (ask: "query the endpoint. if tag is stale")

## 4. Scope & Non-Goals
**In scope:** `backend/runtime_manifest.py` (expose tag + release_notes), `backend/runpod_api.py` (read current
image + update via the `update_endpoint` recipe), a new `backend/comfygen_update_routes.py` (+ router registration in
`app.py`), a new frontend update-banner component mounted in `AppShell`.

**Non-goals:** No stored `image_tag` / schema migration / backfill (current tag is read live). No automatic/background
updates (user-initiated only). No new-template-and-repoint path. No rollout-progress polling (flat ~1 hr message; the
ComfyGen `wait_for_rollout` GraphQL poll is a possible later enhancement). No changes to the AIO trainer endpoint. No
editing of blockflow-presets here (the `release_notes` text + manifest field are added there separately). No downgrade.

## 5. Key Decisions & Constraints
- **CHANGED (was: store our own `image_tag` + backfill):** read the current tag live from the endpoint each app
  start — `GET endpoint → templateId → GET template → imageName`. The ComfyGen CI proves this read is trivial, and it
  removes a schema migration + backfill + full-row-replace hazard. Cost: 2 RunPod GETs on boot (only when an endpoint
  is configured). ← this supersedes the earlier decision; calling it out for re-confirmation.
- **Decided:** Update mirrors ComfyGen's `update_endpoint` — `GET /v1/endpoints/{id}` → `templateId`, then
  `PATCH /v1/templates/{templateId}` `{"imageName": new}`. RunPod rolls the endpoint's pods (~1 hr). No new template,
  no repoint.
- **Decided:** Per-version dismiss via `localStorage` (key includes the latest tag) — not a backend pref.
- **Constraint:** the update PATCHes `imageName` ONLY on the template — env, disk, ports, docker args untouched
  (partial PATCH), so R2/CivitAI env is preserved.
- **Constraint:** tag parse must match the manifest regex `^hearmeman/comfyui-serverless:v\d+$`
  (`backend/runtime_manifest.py:20`); compare the integer after `v`; treat an unparseable image as "not stale".
- **Mirror existing:** route style → `backend/settings_routes.py:80-108`; RunPod call style → `backend/runpod_api.py`;
  the `update_endpoint` recipe → `serverless-docker/.circleci/generate_continue.py:152-175`; banner/toast →
  `frontend/src/components/ui/sonner` (wired in `layout.tsx`).
- **Scale:** personal single-operator tool — omit.

## 6. Code Surface Map
- `backend/runtime_manifest.py:73-104` — add `latest_comfygen() -> {image, tag, release_notes}` beside
  `resolve_comfygen_image()`; parse `tag` (fallback: derive from image) + optional `release_notes`.
- `backend/runpod_api.py:90-104, 166-181` — add `get_endpoint_image(api_key, endpoint_id) -> str|None`
  (`GET /endpoints/{id}` → `templateId` → `GET /templates/{id}` → `imageName`) and
  `update_endpoint_image(api_key, endpoint_id, image_name) -> dict` (same GET for `templateId`, then
  `PATCH /templates/{templateId}` `{"imageName": image_name}`). Mirrors `generate_continue.py:152-175`.
- `backend/comfygen_update_routes.py` (NEW) — `GET /api/comfygen/update-status`, `POST /api/comfygen/update`;
  register in `app.py` next to existing routers.
- `frontend/src/components/comfygen-update-banner.tsx` (NEW) — fetch status on mount, render banner, Update/Dismiss.
- `frontend/src/components/app-shell.tsx:74-79` — mount the banner inside the shell.

## 7. Ultracode Dispatch Notes
**Build first (sequential — freezes interfaces before any parallelism):**
- **Slice A — manifest accessor + RunPod helpers (the shared lib both consumers depend on).**
  `backend/runtime_manifest.py`: add `latest_comfygen()` returning `{"image","tag","release_notes"}` (tag
  int-parseable; release_notes `None` if absent). `backend/runpod_api.py`: add `get_endpoint_image(api_key,
  endpoint_id)` and `update_endpoint_image(api_key, endpoint_id, image_name)` mirroring
  `generate_continue.py:152-175`. Tests: manifest parse (tag present / derived-from-image / missing release_notes);
  RunPod helpers (mock `_rest_get`/`_rest_patch`) — get returns the template `imageName`; update GETs the
  `templateId` then PATCHes `/templates/{tid}` with `imageName`; both surface RunPod errors. Freezes the function
  signatures + the route JSON contract B and C build against.

**Parallel slices (independent — one agent each):**
- **Slice B — backend update routes.** Writes `backend/comfygen_update_routes.py`, `backend/app.py` (router
  registration only). `GET /api/comfygen/update-status` → `{configured, current_tag, latest_tag, stale,
  latest_image, release_notes}`: if no endpoint → `configured:false`; else `get_endpoint_image` → parse current tag,
  compare to `latest_comfygen()` tag; any RunPod read error → `stale:false` (fail closed, no false banner).
  `POST /api/comfygen/update` → `update_endpoint_image(endpoint_id, latest_image)`, return `{ok, message}` with the
  ~1hr propagation text. Tests (mock runpod_api + manifest): stale → `stale:true`; equal/newer → false; no endpoint →
  `configured:false`; read error → fail closed; update calls `update_endpoint_image` with the latest image; RunPod
  error → HTTP error.
- **Slice C — frontend banner.** Writes `frontend/src/components/comfygen-update-banner.tsx`,
  `frontend/src/components/app-shell.tsx` (mount only).
  On mount fetch `/api/comfygen/update-status`; if `stale`, render centered banner with `current → latest`,
  expandable "What's new" (release_notes; hidden if null), Update (POST → toast message, clear banner) and Dismiss
  (localStorage key `comfygen-update-dismissed:<latest_tag>`). Tests (RTL, mock fetch): renders when stale;
  hidden when not stale / not configured; Dismiss persists + hides; re-shows for a higher tag; Update posts + toasts.

**⛓ Collision audit:** A writes `runtime_manifest.py` + `runpod_api.py`; B writes `comfygen_update_routes.py` +
`app.py`; C writes the banner + `app-shell.tsx`. No file is written by two slices. B and C depend only on A's frozen
signatures + the route JSON contract defined here — no inter-slice writes. (No `settings_store`/`wizard_routes`/
`client.ts` changes — the live-read decision removed them.)

**Each agent must:** implement its slice + write and green its own tests + self-verify against §3.

```yaml
dispatch:
  frozen:
    - backend/runtime_manifest.py
    - backend/runpod_api.py
  slices:
    - {key: backend_routes, writes: [backend/comfygen_update_routes.py, backend/app.py]}
    - {key: frontend_banner, writes: [frontend/src/components/comfygen-update-banner.tsx, frontend/src/components/app-shell.tsx]}
  testRunner: "uv run pytest tests/<file>::<test> -ra   |   npm --prefix frontend test -- <file>"
```

## 8. Assumptions & Open Questions
- **VERIFIED by working code (was the load-bearing bet):** the update recipe is exactly ComfyGen's own `update_endpoint`
  CI step — `GET /v1/endpoints/{id}` → `templateId`, then `PATCH /v1/templates/{tid}` `{"imageName": new}`, then pods
  roll (`serverless-docker/.circleci/generate_continue.py:152-175`, `automation/wait_for_rollout.py`). This is in
  production use, so the mechanism is settled. Residual: rollout *timing* (FlashBoot warm workers age out on true cold
  start — noted in the ComfyGen deploy design) → we say ~1 hr, don't block.
- **VERIFIED:** current-image read — `GET /endpoints/{id}` → `templateId`, `GET /templates/{id}` → `imageName` (same
  endpoint-rooted read the CI uses). Status check fails closed (no banner) if either read errors.
- **ASSUMPTION:** `release_notes` will be added under `comfygen_serverless` in blockflow-presets (separate repo). It is
  absent today. Banner + accessor must treat it as optional (`None` → no "What's new").
- **ASSUMPTION:** Numeric `vN` tag ordering is sufficient (no semver/channels). Live manifest uses `v25`; matches the
  existing image regex. Impact if a non-`vN` tag ships: comparison should treat unparseable tags as "not stale" (never
  false-alarm).

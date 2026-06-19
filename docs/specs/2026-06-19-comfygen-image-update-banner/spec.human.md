# ComfyGen update banner — notify on stale image tag + one-click in-place update

**Type:** `feature/app` · **Full spec:** [`spec.claude.md`](./spec.claude.md) · **Bead:** `sgs-ui-cxs`

## ✅ What you'll see when this is done
On app start, if your configured ComfyGen endpoint is on an older image than the published one,
a centered message/banner appears: **"ComfyGen has an update (v24 → v25)."** with an expandable
**"What's new"** (release notes), an **Update** button, and a **Dismiss** button. Clicking **Update**
re-images your RunPod endpoint in place and shows: *"Update started — can take ~1 hour to propagate
to running workers."* Dismiss hides it until the next new version.

## ⚠️ Decisions you're approving
- **Mirror your `update_endpoint` recipe exactly** — Update does `GET /v1/endpoints/{id}` → `templateId`, then `PATCH /v1/templates/{templateId}` `{"imageName": new}`, then RunPod rolls the pods. This is your production CI step (`generate_continue.py:152-175`), keyed off the endpoint ID. No new template, no repoint. User told ~1 hour.
- **Read the current tag live, not stored (CHANGED from earlier)** — same endpoint-rooted read (`GET endpoint → templateId → GET template → imageName`), exactly how your `wait_for_rollout.py` checks. This drops the `image_tag` column + migration + backfill I'd specced. Cost: 2 RunPod GETs on app boot when an endpoint is configured. ← **this reverses the earlier "store + backfill" answer — confirm you're good with it.**
- **Release notes now, plain text** — a `release_notes` string in the manifest, rendered as plain text. Chose this over *banner-only + follow-up bead*.
- **Dismiss is per-version (localStorage)** — dismissing v25 still re-shows when v26 ships. Chose this over *backend app-pref* (dismissal is pure UI state).

## 🎲 Riding on these assumptions
- **Mechanism is VERIFIED by your own running code** — the recipe is your `update_endpoint` CI step, in production. Only residual: rollout *timing* (FlashBoot warm workers age out on true cold start, per your deploy design) — hence "~1 hr", not instant.
- **The manifest carries a numeric `tag` (`v25`) and we control `release_notes`.** Live manifest has `tag: "v25"` ✓ but `release_notes` doesn't exist yet — banner must render fine when it's absent, and you add the text in **blockflow-presets** separately.

## 🪤 Gotchas
- The status check makes 2 RunPod GETs on app start (only when an endpoint is configured). If either errors, fail closed — no banner — so a RunPod hiccup never shows a false "update available".
- The update PATCHes `imageName` only — RunPod leaves env/disk/ports intact on a partial template update, so R2/CivitAI config is preserved automatically.
- Release notes live in a **separate repo** (blockflow-presets) — this build only consumes the field; the text itself is your separate edit.

## Done when
- [ ] Stale endpoint → banner shows on app start with `current → latest` tags and works when release notes are present or absent.
- [ ] Up-to-date (or no endpoint configured, or a RunPod read error) → no banner.
- [ ] Update click runs the `update_endpoint` recipe, shows the ~1hr propagation message; banner clears.
- [ ] Dismiss hides v25; a later v26 re-shows.

## The plan
1. **Build-first:** manifest accessor returns `{image, tag, release_notes}`; add RunPod `get_endpoint_image` + `update_endpoint_image` helpers mirroring your CI.
2. **Slice B (backend):** `GET /api/comfygen/update-status` (live-read current tag, compare to manifest, fail closed) + `POST /api/comfygen/update` (run the `update_endpoint` recipe).
3. **Slice C (frontend):** update-banner mounted in `AppShell`, fetch status on mount, Update/Dismiss + "What's new".

## ✂️ Not asked for — cut?
- (none — everything traces to your ask: app-start check, banner with update/dismiss, RunPod update on click, optional release notes.)

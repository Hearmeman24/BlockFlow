<!-- spec.human.md — 30-second review surface. Veto at the ⚠️ and 🎲 sections. -->

# Support "Power Lora Loader (rgthree)" in the ComfyGen block

**Type:** `feature/app` · **Full spec:** [`spec.claude.md`](./spec.claude.md) · **Bead:** sgs-ui-67rq

## ✅ What you'll see when this is done
Load a workflow with `Power Lora Loader (rgthree)` nodes (e.g. `API_Wan2.2_SVI_4pass_V2.json`) and the LoRAs section now lists **each LoRA inside the node as its own row** — strength, an enable toggle, and the LoRA name, just like the regular LoRA rows. Toggling, restrengthing, or adding a LoRA there changes what's actually submitted. Today these nodes are invisible to the block.

## ⚠️ Decisions you're approving
- **One integrated LoRAs panel** — Power-loader rows render in the *existing* LoRAs section (grouped under their node), not a separate "Power LoRAs" panel. Chose this over a parallel panel because you called it "an acceptable LoRA loader" (i.e. it joins the existing handling). ← change if you want it separate
- **Enable toggle writes the native `on` field** — disabling a Power-loader row sets that LoRA's `on: false` in place (rgthree's built-in bypass), *not* node deletion/rewiring like regular LoRAs. ← this is the only sane mapping for a multi-LoRA node
- **"Add LoRA" on a Power node appends a new `lora_N` row inside that node** — chose this over inserting a separate `LoraLoaderModelOnly` after it, because the node is built to hold a stack. ← change if you'd rather it splice a standalone loader
- **Overrides apply by editing the workflow JSON server-side**, not through the `--override` CLI flag — because the CLI can't address a nested field (see gotcha). Invisible to you; flagged for honesty.

## 🎲 Riding on these assumptions
- **The rgthree node's runtime schema is `lora_N = {on: bool, lora: str, strength: number}` with a wired `model` (+ optional `clip`).** Verified against your example workflow (8 nodes), but I haven't seen a variant with separate model/clip strengths. If rgthree emits `strengthTwo`/clip fields in some export, those won't be surfaced. (couldn't confirm: only one workflow sample on disk)
- **Power-loader nodes thread the model chain through `inputs.model` like regular loaders**, so they order correctly in the chain display. Verified in the sample; assumed universal.

## 🪤 Gotchas
- **The `--override node_id.param` CLI path splits on the *first* dot** (`node_id`, rest=`param`), then writes `inputs[param]` flat. So `1021.lora_1.strength` would create a junk flat key, never touching the nested dict. That's *why* Power-loader edits must mutate the workflow in the backend `/run` (same place bypass/insert already deep-copy + edit). Regular LoRAs are unaffected — they keep the CLI path.
- One node = many rows sharing a `node_id`. Every per-row state/key must be composite (`node_id::lora_1`) or rows will clobber each other.

## Done when
- [ ] Each `lora_N` of a Power Lora Loader shows as an editable row (strength + enable + name) in the LoRAs section.
- [ ] Disabling a row submits that LoRA with `on: false`; re-enabling restores it.
- [ ] Editing strength / LoRA name on a row changes the submitted workflow.
- [ ] "Add LoRA" on a Power node appends a working new LoRA to that node at run time.
- [ ] Regular `LoraLoader`/`LoraLoaderModelOnly` behavior is unchanged (existing tests green).

## The plan
1. **Backend**: detect `Power Lora Loader (rgthree)`, emit one row per `lora_N`; add a `power_lora_overrides` apply step in `/run` that mutates the workflow dict (strength/name/on/add).
2. **Frontend**: render the rows in the existing LoRAs panel with composite keys; collect edits; send `power_lora_overrides` in the run body. Regular-LoRA path untouched.
3. Tests on both sides; verify regular-LoRA regression suite stays green.

## ✂️ Not asked for — cut?
- (none — every row of scope traces to "add support for the Power LoRA Loader as an acceptable LoRA loader")

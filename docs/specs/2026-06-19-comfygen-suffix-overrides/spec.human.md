# Tag any workflow node `*_ComfyGen` to expose its value as an editable override

**Type:** `feature/app`  ·  **Full spec:** [`spec.claude.md`](./spec.claude.md)

## ✅ What you'll see when this is done
You load a workflow where some node's title ends with `_ComfyGen` (e.g. a `PrimitiveInt` titled `Steps_ComfyGen`, or a sampler titled `Sampler_ComfyGen` with `steps`/`cfg`/`seed`). The ComfyGen block grows a new **"Workflow-Specific Overrides"** section with an editable field for **every literal String/Int/Float input on each tagged node** — number inputs for Int/Float, text for String. A single-value node shows one field labeled by its stripped name (`Steps`); a multi-input node shows one field per input (`Sampler · steps`, `Sampler · cfg`, `Sampler · seed`). Edit any of them, run the pipeline, and each is sent as a `<node_id>.<input>` override.

## ⚠️ Decisions you're approving
- **Every literal String/Int/Float input on a tagged node is overrideable** — chose this over *only the single `value` input*. A node with N primitive inputs surfaces N fields. (Wired inputs and bools are skipped.)
- **Label = stripped title, disambiguated by input name when needed** — one primitive input → `Steps`; multiple → `Sampler · steps`, `Sampler · cfg`. Over *raw title* or *always showing the input name*.
- **Dedicated "Workflow-Specific Overrides" section** — over *folding these into the existing "Workflow Settings" panel*. Same rendering + apply plumbing, its own labeled section.
- **Existing auto-detected panels win on overlap** — if a tagged node's input is already controlled by another panel (a KSampler's `steps`, the resolution `PrimitiveInt`'s `value`, etc.), that input does **not** also appear here. Over *letting `_ComfyGen` replace it* or *showing both*.

## 🎲 Riding on these assumptions
- **A node's `inputs` is a name-keyed dict and an input's literal value is editable in place** (true across every existing detector, e.g. KSampler reads `inputs["steps"]`). Per-input override `<node_id>.<input>` patches that key.
- **`type(value)` is a reliable type signal** — Python `bool` is a subclass of `int`, so the detector must exclude `bool` explicitly; only `str`/`int`/`float` (non-bool) literal inputs qualify.
- **Suffix match is exact + case-sensitive** (`title.endswith("_ComfyGen")`). A node titled `_comfygen` or `_ComfyGenX` won't match.

## 🪤 Gotchas
- Per input: a **wired** input (`[node_id, slot]`, not a literal) can't be overridden — skip that input, don't surface a dead field. Other literal inputs on the same node still surface.
- The dedupe key is `<node_id>.<input>`; existing panels already claim keys like `<ksampler>.steps` and `<source_node>.value`, so a tagged node's input that another panel controls falls out via the existing `collectAutoDetectedKeys` set — only its *un-claimed* inputs show here.
- The block re-detects on every workflow parse and clears panels when nothing matches — new state must persist via `configKeys` like the other panels, or it won't survive Restore.
- A tagged node with **zero** literal primitive inputs (everything wired, or only bool/combo) surfaces no fields — that's correct, not a bug.

## Done when
- [ ] A `*_ComfyGen`-titled node surfaces an editable field for **each** of its literal String/Int/Float inputs (type-correct input, stripped label disambiguated by input name when >1) in a "Workflow-Specific Overrides" section; editing + running sends `<node_id>.<input>` per field.
- [ ] Per-input: wired, missing, or `bool` inputs are NOT surfaced; sibling literal inputs on the same node still are.
- [ ] A tagged node input already driven by another panel (e.g. a KSampler `steps`, a resolution source `value`) is NOT duplicated here.
- [ ] Untagged workflows show no such section (no regression to existing panels).

## The plan
1. **Backend** — add `_detect_comfygen_overrides(workflow)`: for each node whose title ends `_ComfyGen`, emit one entry per literal non-bool str/int/float input → `{node_id, field:<input>, label:<stripped[+·input]>, type, current_value}`. Return it from `/parse-workflow`.
2. **Frontend** — consume the new array, dedupe against already-claimed keys, render a "Workflow-Specific Overrides" section mirroring the Workflow Settings panel, persist via `configKeys`.
3. **Apply** — emit edited values as `<node_id>.<input>` through the existing `mergeSettingsOverrides` path (which already refuses to clobber auto-detected keys).
4. Tests on both sides; regenerate the generated block.

## ✂️ Not asked for — cut?
- _(none — every criterion traces to the ask.)_

# DESIGN — MoE KSampler detection + Total Steps propagation (sgs-ui-8zu)

Status: DESIGN ONLY. No production code in this bead until the human lead approves.
Author: architect. Reviewers: breaker + builders (attack the contract on paper first).

## Problem

Wan2.2 MoE workflows split sampling across two chained samplers: a **high-noise**
expert runs the first chunk of steps, hands its latent to a **low-noise** expert
that runs the rest. Two distinct node families do this:

1. `KSamplerAdvanced` pairs — high `end_at_step` == low `start_at_step` is the split.
2. `ClownsharKSampler_Beta` pairs (RES4LYF) — high `steps_to_run` is the split count.

Today `_detect_ksamplers` renders the two samplers as **two independent panels**.
A user who wants to change total sampling steps must edit `steps` on BOTH nodes AND
re-derive the boundary by hand — easy to desync, and Wan distill LoRAs are sensitive
to the high/low split. `ClownsharKSampler_Beta` is not detected at all.

We want ONE **Total Steps** control (plus a **Split** control) per detected MoE pair
that fans out to both samplers' `steps` and the boundary fields, keeping them
consistent by construction. And we want ClownShark detected as a first-class sampler
(both as a single sampler and inside a MoE pair).

Worked example node IDs are cited from:
- `Wan2.2_T2V_Lightning.json` — KSamplerAdvanced pair 401 (high) → 402 (low).
- `Wan2.2_T2V_RES4LYF_Full.json` — ClownShark pair 407 (high) → 408 (low).

## Scope — explicitly in / out

In:
- Detect ClownsharKSampler_Beta as a single sampler (inline fields).
- Detect MoE pairs for two families: KSamplerAdvanced and ClownsharKSampler_Beta.
- One Total Steps + one Split control per pair, fanning out to override keys.
- Degrade cleanly: a lone sampler of either family still renders as a single panel.

Out (push back if requested mid-build — route via architect):
- 3+ sampler chains (refiner stacks). Detected as N independent single panels, NOT a
  MoE group. See Edge Cases.
- Cross-family pairs (a KSamplerAdvanced feeding a ClownShark). Not a MoE group.
- Per-expert independent step counts via the MoE control. The MoE control's contract
  is one shared total; per-expert cfg/sampler/scheduler/seed stay independent.
- Automation axes (the `autoNumeric`/`autoSelect` chip system) over Total Steps/Split.
  MoE Total Steps is a single scalar override, not an automation axis, in v1.

## Detection contract

### Single-sampler ClownShark (independent of MoE)

Add a fourth detection loop in `_detect_ksamplers`, mirroring the standard-KSampler
loop. For each node with `class_type == "ClownsharKSampler_Beta"`, emit a flat entry
with inline targets (no override_map needed — every field is inline on the node):

| UI field      | source input on node | notes |
|---------------|----------------------|-------|
| steps         | `steps`              | int   |
| cfg           | `cfg`                | float |
| seed          | `seed`               | int (NOT `noise_seed`) |
| denoise       | `denoise`            | float, round 3 |
| sampler_name  | `sampler_name`       | str (free-form e.g. `"linear/euler"`, `"multistep/res_3m"`) |
| scheduler     | `scheduler`          | str |

`sampler_name`/`scheduler` values are RES4LYF enums (`"linear/euler"`,
`"multistep/res_3m"`, `"res_2s"`; schedulers `"beta"`, `"bong_tangent"`), NOT the
standard ComfyUI sampler list. The curated-list contract below (O3 RESOLVED — IN v1)
gives these their own dropdown options.

These single entries are emitted **even when** the node is part of a MoE pair — the
MoE grouping is a SEPARATE structure layered on top (see output shape below), so the
per-expert cfg/sampler/scheduler/seed knobs remain editable.

### Curated ClownShark sampler/scheduler list (O3 RESOLVED — IN v1 scope)

**Problem.** Standard sampler/scheduler options flow `comfy-gen info` (live ComfyUI
`object_info`) → `_cache["samplers"]`/`["schedulers"]` (backend.block.py:136-137) →
`get_cache` → frontend `availableSamplers`/`availableSchedulers` (frontend.block.tsx:
649-650) → the KSampler panel's `options` (line 2326-2327). But that cache pulls the
GENERIC KSampler sampler enum, not the per-node RES4LYF enums on
`ClownsharKSampler_Beta`. A ClownShark panel fed `availableSamplers` would offer
`euler`/`dpmpp_2m`/… (wrong namespace) and silently drop the workflow's
`"linear/euler"` to a bare fallback.

**Source-of-truth DECISION: hardcoded constants in backend.block.py, attached per-entry.**
Two new module-level constants next to `_KNOWN_LATENT_NODES`:

```python
CLOWNSHARK_SAMPLERS = ["res_2s", "res_3m", "res_2m", "res_5s",
                       "linear/euler", "multistep/res_3m", ...]  # full RES4LYF set
CLOWNSHARK_SCHEDULERS = ["beta", "bong_tangent", "normal", "simple", ...]
```

(The builder fills the exact lists from the RES4LYF node source / a live `object_info`
dump of `ClownsharKSampler_Beta`; this design fixes the MECHANISM, not the enum
contents.)

Why hardcoded over live `object_info` (option b rejected for v1):
- The existing `_cache` fetch does NOT request per-node enums — it returns flat
  `samplers`/`schedulers`. Wiring a per-node-enum fetch into `comfy-gen info` is a
  larger, separate change with its own failure modes (RES4LYF not installed on the
  connected ComfyUI → empty list → worse than a static list).
- A hardcoded list works OFFLINE and is deterministic — matches how the block already
  degrades. If the user runs a ComfyUI without RES4LYF, the workflow wouldn't have a
  ClownShark node anyway, so the list is only ever shown when relevant.
- The current value from the workflow is ALWAYS unioned in (so a future RES4LYF sampler
  not yet in the constant still appears as a selectable option for that node).

**Attachment to the detected entry (the frontend signal).** The single-ClownShark entry
(and each ClownShark node inside a MoE pair) carries explicit option lists so the
frontend never guesses which dropdown to use:

```python
entry["sampler_options"] = _union(CLOWNSHARK_SAMPLERS, [entry.get("sampler_name")])
entry["scheduler_options"] = _union(CLOWNSHARK_SCHEDULERS, [entry.get("scheduler")])
```

Standard KSampler entries do NOT get these fields (absent ⇒ frontend uses
`availableSamplers`/`availableSchedulers` as today). This is the discriminator:
**presence of `sampler_options` on an entry ⇒ use it; absence ⇒ use the global cache
list.** No `class_type` switch in the frontend — it reads the field, keeping the
"options arrive on the entry" pattern already used for resolution/frame sources.

**Frontend wiring** (KSampler panel render, frontend.block.tsx:2326-2327):
```ts
options: ks.sampler_options ?? availableSamplers   // sampler row
options: ks.scheduler_options ?? availableSchedulers // scheduler row
```
One-line change per row. The MoE pair's per-expert dropdowns render through the SAME
per-sampler KSampler panel (MoE only owns steps/boundary), so a ClownShark MoE expert
automatically gets `sampler_options` too — no separate wiring.

**Frozen interface additions** — add to `KSamplerInfo` (comfygen-overrides.ts):
```ts
sampler_options?: string[]    // present only on ClownShark entries
scheduler_options?: string[]  // present only on ClownShark entries
```

Test: `test_clownshark_entry_has_curated_options` (single ClownShark entry carries
`sampler_options` including its own current value + the constant; a standard KSampler
entry does NOT carry the field). Frontend: `test_clownshark_panel_uses_curated_list`
(RTL — the ClownShark sampler dropdown offers the curated options, the standard one
offers `availableSamplers`).

### MoE pair detection — `_detect_moe_pairs(workflow) -> list[dict]`

New top-level function, called by the block handler alongside `_detect_ksamplers`.
Returns a NEW list rendered as a distinct "MoE Sampler" panel. This is the chosen
output shape — see Fork 4 rationale below.

**Minimal robust signal set** (ALL must hold to form a pair):

1. **Same `class_type`**, and that class is one of the two supported MoE families
   (`KSamplerAdvanced` or `ClownsharKSampler_Beta`).
2. **Chain link**: the candidate LOW sampler's `latent_image` input traces — directly
   or through pass-through latent nodes — to the candidate HIGH sampler's output
   (slot 0). `402.inputs.latent_image == ["401", 0]`; `408 == ["407", 0]`. Use a
   bounded upstream walk (max depth 4) that follows `latent_image` / `samples` /
   `latent` through pass-through node types only (see `_LATENT_PASSTHROUGH` below).
   This is the load-bearing signal — it is what distinguishes a real chain from two
   unrelated samplers that happen to share a class.
3. **Family-specific boundary signal is present and well-formed**:
   - KSamplerAdvanced: HIGH has `add_noise == "enable"` AND `end_at_step` is a finite
     int in `[1, steps-1]`; LOW has `add_noise == "disable"` AND
     `start_at_step == HIGH.end_at_step`. (401: enable, end=4; 402: disable, start=4.)
   - ClownShark: HIGH has `sampler_mode == "standard"` AND `steps_to_run` is an int in
     `[1, steps-1]`; LOW has `sampler_mode == "resample"` (typically
     `steps_to_run == -1`, the "run remainder" sentinel — but the LOW sentinel is NOT
     required, only `sampler_mode == "resample"` is). (407: standard, run=4; 408:
     resample, run=-1.)

   **KNOWN NON-DETECTION (S1, breaker-confirmed — accepted v1 gap, not a silent claim).**
   The KSA boundary check REQUIRES the canonical `add_noise = enable → disable`
   asymmetry. A non-canonical Wan KSA handoff where the split is governed purely by
   `return_with_leftover_noise` and BOTH samplers run `add_noise == "enable"` (high
   passes leftover noise, low adds its own) will FAIL this check (LOW.add_noise !=
   "disable") and degrade to two single panels. Likewise a pair encoding the split only
   via start/end-step with no add_noise asymmetry is not detected. This is a DELIBERATE
   conservative v1 stance: we refuse to infer a MoE handoff we cannot positively
   confirm, rather than mis-pair. Both example workflows use the canonical asymmetry, so
   v1 covers the user's actual files. Widening signal-3 to also accept
   "start/end-step asymmetry with both add_noise=enable" is deferred to O7 — do NOT widen
   it speculatively; wait for a real workflow that needs it.

**HIGH vs LOW identification**: the upstream feeder is HIGH, the downstream consumer is
LOW. Determined entirely by signal 2's direction (whose output feeds whose
`latent_image`). The `add_noise`/`sampler_mode` signals are a *consistency check*, not
the tiebreaker — if direction (2) and the enable/standard marker (3) disagree, the pair
is REJECTED (degrade to two single panels) rather than guessed. This avoids
mis-labeling.

**`steps` agreement**: signal-set does NOT require `HIGH.steps == LOW.steps` to FORM
the pair (a workflow may ship them desynced). But we record both. The detected
`total` surfaced to the UI is `HIGH.steps` (the upstream/authoritative expert). If
`HIGH.steps != LOW.steps` at detect time, set `"steps_mismatch": true` so the UI can
warn; the first user edit of Total Steps re-syncs both. Rationale: refusing to detect
on mismatch would strand exactly the workflows that most need the fix.

**Multiplicity / degradation**:
- Exactly 2 same-family samplers forming a valid chain → ONE MoE pair.
- A lone sampler, or a sampler whose partner fails any signal → NO pair; it still
  appears via `_detect_ksamplers` as a single panel. Nothing is lost.
- 3+ same-family samplers chained (A→B→C): do NOT form a MoE group in v1. Detect each
  as a single panel. Escalated as Open Question O1 — silently grabbing the first 2
  would mislabel a refiner stack. Pairing requires EXACTLY two same-family samplers
  whose chain-link graph has one source and one sink; if the connected same-family
  component has size != 2, emit no pair for that component.
- Two independent same-family pairs in one workflow (e.g. a T2V pass and an upscale
  pass) → two MoE pairs, keyed by their node IDs. Supported.

### MoE pair output dict (the py→TS interface)

```python
{
  "family": "KSamplerAdvanced" | "ClownsharKSampler_Beta",
  "high_node_id": "401",
  "low_node_id": "402",
  "label": str | None,            # from high node _meta.title if meaningful
  "total": 8,                     # HIGH.steps (authoritative)
  "split": 4,                     # boundary: high steps before handoff (see below)
  "steps_mismatch": False,        # True if HIGH.steps != LOW.steps at detect
  # The exact override keys each control fans out to, computed by the BACKEND
  # so the frontend never hard-codes per-family field names:
  "total_targets": ["401.steps", "402.steps"],
  "split_targets": {              # field -> how to compute from split value
    # KSamplerAdvanced:
    "401.end_at_step": "split",       # = split
    "402.start_at_step": "split",     # = split
    # ClownShark would instead be:
    # "407.steps_to_run": "split"
  },
  # Fields the MoE panel OWNS (so generic Workflow Settings + per-sampler panels
  # don't also expose them). Frontend adds these to the suppression set.
  "owned_keys": ["401.steps","402.steps","401.end_at_step","402.start_at_step"],
}
```

`split` semantics differ by family but the surfaced number is **always "how many steps
the HIGH expert runs"**:
- KSamplerAdvanced: `split = HIGH.end_at_step` (== LOW.start_at_step). 401: 4.
- ClownShark: `split = HIGH.steps_to_run`. 407: 4.

The `total_targets` / `split_targets` lists are the contract — the frontend treats them
as opaque. Adding a third family later changes only the backend mapping table, not the
frontend. This is the key design property: **the per-family field math lives in ONE
place (backend), keyed off `family`, and the frontend consumes a computed key list.**

### TypeScript interface (frontend/src/lib/comfygen-overrides.ts)

```ts
export interface MoePairInfo {
  family: 'KSamplerAdvanced' | 'ClownsharKSampler_Beta'
  high_node_id: string
  low_node_id: string
  label?: string
  total: number
  split: number
  steps_mismatch?: boolean
  total_targets: string[]              // node.field keys that receive `total`
  split_targets: Record<string, 'split'>  // node.field key -> recipe (v1: always 'split')
  owned_keys: string[]
}

export interface MoeOverride {
  total: string   // user-edited Total Steps (empty => use detected default)
  split: string   // user-edited Split (empty => use detected default)
}
```

## Propagation math — Option C (Total + explicit Split) — DECIDED

DECIDED (human spec gate, frozen): expose BOTH a **Total Steps** and a **Split** control
(Fork 2, option C), with Split defaulting to the detected absolute high-step count and
Total Steps changes **preserving the absolute split (option B behavior)** — not the
ratio. Display-clamp, non-lossy (see Rules below).

Why C over A (ratio) or B-only:
- Wan distill LoRAs are tuned for a specific number of HIGH steps (often the boundary
  is `total/2` for an even distill, but not always). Ratio-preserving (A) silently
  moves the boundary when total changes, which can degrade a tuned split. Absolute-
  preserving keeps the high expert's step budget stable.
- But a user MAY want to retune the split. So we give them an explicit Split control
  rather than hiding the boundary entirely. C = B's safe default + user escape hatch.

### Rules

Let `T` = effective Total Steps, `S` = effective Split (HIGH step count).

1. **Default Split when Total changes** (user edits Total, leaves Split untouched):
   keep `S` absolute. New `T` with old `S`. Then clamp at READ time (see rule 2).
2. **Display-clamp, not store-clamp (S2 — load-bearing).** The user's raw Split intent
   is STORED unclamped (`MoeOverride.split` holds the literal typed value, e.g. "6").
   The EFFECTIVE split used for the fan-out is computed at read time:
   `S_eff = clamp(rawS, 1, T-1)`. This means a transient Total dip does NOT destroy the
   user's split intent — set Split=6 @ T=12, drop T→4 (renders S_eff=3), raise T→12
   (renders S_eff=6 again). Total is likewise stored raw and clamped to `[2, 200]` at
   read. The pure helper `resolveMoeSteps(detected, override)` performs all clamping and
   is the single source of truth for both the rendered values and the fan-out.
3. **No family minimum on either expert (S3).** `S_eff ∈ [1, T-1]`, so the low expert
   may run as few as 1 step (e.g. T=4,S=3 → low runs 1). There is NO known distill
   minimum on either side; 1-step experts are the user's call. A builder MUST NOT invent
   a `min_high`/`min_low` floor. If the user later reports a distill that needs ≥2 on a
   side, that becomes a new bead — not a silent clamp here. (Escalated O6.)
4. **Rounding**: both controls are integer inputs; no fractional steps. Non-integer or
   empty input falls back to the detected default for that control.
5. **Independence**: editing Split never changes Total. Editing Total preserves the
   STORED Split; only `S_eff` re-clamps.

### Worked examples

KSamplerAdvanced pair (401 high / 402 low), detected `total=8, split=4`:

| User action            | T  | S | 401.steps | 402.steps | 401.end_at_step | 402.start_at_step |
|------------------------|----|---|-----------|-----------|-----------------|-------------------|
| detected (no edit)     | 8  | 4 | 8         | 8         | 4               | 4                 |
| Total → 12 (B default) | 12 | 4 | 12        | 12        | 4               | 4                 |
| Total → 16             | 16 | 4 | 16        | 16        | 4               | 4                 |
| Total → 12, Split → 6  | 12 | 6 | 12        | 12        | 6               | 6                 |
| Total → 4 (stored S=6) | 4  | 3*| 4         | 4         | 3*              | 3*                |
| ...then Total → 12     | 12 | 6 | 12        | 12        | 6               | 6                 |

`*` = S_eff is display-clamped to 3 while T=4, but the STORED split stays 6 and is
restored when Total rises again (S2). The fan-out always writes `S_eff`, never raw S.

`402.end_at_step` stays at its workflow sentinel `10000` — NEVER written by the MoE
control (it means "run to the end"). Documented in Edge Cases.

ClownShark pair (407 high / 408 low), detected `total=16, split=4`:

| User action            | T  | S | 407.steps | 408.steps | 407.steps_to_run |
|------------------------|----|---|-----------|-----------|------------------|
| detected (no edit)     | 16 | 4 | 16        | 16        | 4                |
| Total → 8 (B default)  | 8  | 4 | 8         | 8         | 4                |
| Total → 12             | 12 | 4 | 12        | 12        | 4                |
| Total → 12, Split → 6  | 12 | 6 | 12        | 12        | 6                |

`408.steps_to_run` stays at sentinel `-1` ("run remainder") — NEVER written by the MoE
control. The remainder is implicitly `T - S` (e.g. T=12,S=4 → low runs 8). We do not
write low's count; the sentinel handles it.

## Override fan-out contract

The MoE control produces a flat `Record<string,string>` merged into the submit
`overrides` map, exactly like every other panel. The fan-out, given effective `T` and
clamped `S`:

```
for key in moe.total_targets:        overrides[key] = String(T)
for key in moe.split_targets:        overrides[key] = String(S)   # recipe 'split' => S
```

Concretely:
- KSamplerAdvanced 401/402, T=12, S=6 →
  `{"401.steps":"12","402.steps":"12","401.end_at_step":"6","402.start_at_step":"6"}`
- ClownShark 407/408, T=12, S=6 →
  `{"407.steps":"12","408.steps":"12","407.steps_to_run":"6"}`

This must run in `buildOverrides` (comfygen-overrides.ts) AFTER the per-sampler KSampler
loop, so MoE-owned keys win over any stale per-sampler `steps` the single panel might
also emit. Precedence rule: **MoE-owned keys are authoritative.**

### Single-writer enforcement — THREE paths, not one (B1, breaker-confirmed)

Skipping the per-sampler `buildOverrides` loop is NECESSARY BUT NOT SUFFICIENT. There
are THREE places a MoE-owned key can leak in. Build a `moeOwnedKeys: Set<string>`
(the union of every pair's `owned_keys`) and a `moeOwnedNodeIds: Set<string>` once, then:

1. **`buildOverrides` per-sampler loop** (comfygen-overrides.ts:128-143): for a MoE-owned
   node, do NOT emit `steps`. cfg/sampler/scheduler/seed still emit. Then the MoE loop
   writes `steps`/boundary. (One writer per key.)

2. **`chipOrVal` stale length-1 chip** (comfygen-overrides.ts:117-121): `chipOrVal`
   returns `autoNumeric[key][0]` BEFORE any fallback. A saved preset can carry a stale
   `autoNumeric['401.steps'] = ['8']` (length 1) that would silently win over the MoE
   total even with the per-sampler loop skipped, IF the MoE loop ran `set()` through the
   same chip-aware path. FIX: the MoE fan-out must write `overrides[key] = String(value)`
   DIRECTLY (not via `set()`/`chipOrVal`), so no chip can shadow it. The MoE loop is the
   last and only writer of its keys.

3. **`computeAutomationAxes` orphan axis** (comfygen-overrides.ts:213-224): iterates
   `ksamplers.slice(0,3)` and pushes a `{node}.steps` automation AXIS whenever
   `autoNumeric['401.steps'].length > 1`. This path is INDEPENDENT of buildOverrides —
   a stale steps-sweep chip set before MoE existed would fan `401.steps` across the batch
   (4/8/12) while `402.steps` stays at the MoE total, breaking the shared-total invariant
   mid-sweep. FIX: `computeAutomationAxes` must SKIP `steps` (and any boundary field) for
   any node in `moeOwnedNodeIds`. cfg/denoise/sampler/scheduler axes for those nodes are
   still allowed.

Stated as one rule: **MoE-owned `{node}.field` keys are stripped from the per-sampler
override loop, written directly (chip-bypassing) by the MoE loop, and excluded from
automation-axis generation.** A stale chip in `autoNumeric`/`autoSelect` for a MoE-owned
key is INERT — it neither overrides nor sweeps. (We do not need to mutate the persisted
chip maps; we only need every READER to honor `moeOwnedNodeIds`. This is safer than
deleting chips, which could surprise a user who later un-MoE's the workflow.)

**Guardrail invariant (B3, breaker downgrade).** The path-3 exclusion is currently safe
ONLY because the axis field-list is `{steps, cfg, denoise, sampler_name, scheduler}` and
we strip `steps` for MoE nodes — the boundary keys (`end_at_step`/`start_at_step`/
`steps_to_run`) are not in that list, so they can't leak as axes today. To keep that
true if a future dev adds `end_at_step` to the axis field-list, the contract asserts the
STRONGER invariant: **no key in any MoE pair's `owned_keys` may appear in ANY generated
axis** — not just `steps`. Implement the path-3 skip against `moeOwnedKeys` (the full
owned-key set), not a hardcoded `'steps'`. Test: `test_no_moe_owned_key_in_any_axis`.

Required tests: `test_moe_total_wins_over_stale_steps_chip` (length-1 chip on 401.steps
ignored), `test_moe_owned_steps_not_emitted_as_axis` (length-3 chip on 401.steps yields
no axis), `test_moe_cfg_axis_still_allowed` (cfg sweep on a MoE node still produces an
axis), `test_no_moe_owned_key_in_any_axis` (B3 guardrail — synthesize a chip on every
owned key incl. boundary fields, assert none becomes an axis).

### The slice(0,3) cap vs. two MoE pairs (B2, breaker-confirmed)

**FIVE sites iterate `ksamplers.slice(0, 3)`** — enumerate ALL of them; a builder who
patches the two in comfygen-overrides.ts and stops leaves three live (B4,
breaker-confirmed; I found a fifth on verification — the breaker named one reporter,
there are two):

| # | Site | Effect if not patched for MoE nodes |
|---|------|--------------------------------------|
| 1 | `comfygen-overrides.ts:128` `buildOverrides` per-sampler loop | sampler #4 cfg/sampler/seed never submit |
| 2 | `comfygen-overrides.ts:213` `computeAutomationAxes` | sampler #4 cfg/sampler axes never generated |
| 3 | `frontend.block.tsx:2319` panel render map | sampler #4 has NO visible input at all |
| 4 | `frontend.block.tsx:1631` multi-job metadata reporter | sampler #4 settings absent from `jobMeta.inference_settings` |
| 5 | `frontend.block.tsx:1747` single-job metadata reporter | same, on the single-job submit path |

A two-MoE-pair workflow (T2V + upscale = 4 samplers) means the 4th sampler's per-expert
cfg/sampler/scheduler/seed is unrenderable (site 3), unsubmittable (sites 1-2), and
un-reported (sites 4-5). The MoE fan-out is a SEPARATE loop with no slice cap, so
totals/splits survive for both pairs, but everything else on sampler #4 vanishes.

Why the original cap-of-3 exists: it bounds UI clutter and override volume for
pathological workflows with many independent samplers (the panel shows a
"N KSamplers detected; only showing first 3" warning at frontend.block.tsx:2376). It is
a UX guard, not a correctness limit — safe to relax narrowly.

Decision: **define ONE predicate `isVisibleSampler(ks, index) = index < 3 ||
moeOwnedNodeIds.has(ks.node_id)` and use it at sites 1-3** (render map + both submit
loops). First 3 as today, PLUS any MoE-owned sampler regardless of position. Keeps
render and submit symmetric (a cfg you can submit is a cfg you can see). The MoE panel
itself already renders all pairs (it is not sliced). Required test:
`test_two_pairs_fourth_sampler_cfg_emitted` (submit) + an RTL assertion the 4th MoE
sampler's cfg input renders.

**Sites 4-5 (metadata reporters) — narrow MoE fix, pre-existing bug surfaced not
adopted (B4).** Both reporters write `inferenceSettings[f] = allOverrides[key]` with NO
node qualifier, so even TODAY, with 2+ samplers, each field is overwritten and only the
LAST sampler's value is reported — `inference_settings.steps` already reports one
expert, not "total". Lifting the slice here does NOT fix that; it makes more samplers
clobber one unqualified field. So for THIS feature the reporters get a NARROW change:
when a pair is MoE, emit `inference_settings.total_steps` + `split` for the pair (read
from the MoePairInfo + resolved override), instead of the raw per-node `steps`. The
general "qualify `inference_settings` by node_id for all samplers" cleanup is a SEPARATE
pre-existing-bug bead — **sgs-ui-6sn** (P3); do NOT expand this feature to fix
all-sampler provenance. Tests: `test_two_pairs_fourth_sampler_in_job_metadata` (sampler #4
reported), `test_moe_reports_total_steps_not_per_node` (a pair reports total_steps+split,
not a single expert's steps).

A single writer per key still holds: position-4 MoE node emits cfg/sampler/seed via the
per-sampler loop; its steps/boundary still come from the MoE loop.

### collectAutoDetectedKeys / suppression

Add the MoE `owned_keys` to the auto-detected suppression set in
`workflow-settings.ts::collectAutoDetectedKeys` so the generic Workflow Settings panel
never double-exposes `end_at_step` / `start_at_step` / `steps_to_run` / the paired
`steps`. Extend `AutoDetectSources` with `moePairs: { owned_keys: string[] }[]` and add:

```ts
for (const mp of src.moePairs) for (const k of mp.owned_keys) s.add(k)
```

Note today's `KSAMPLER_FIELDS` does NOT include `start_at_step`/`end_at_step`/
`steps_to_run` (confirmed line 30). Those are only ever suppressed via `owned_keys`,
so a lone (non-MoE) KSamplerAdvanced's `start_at_step` remains exposable through generic
Workflow Settings — unchanged behavior. Correct: we only claim these keys when a MoE
pair owns them.

## UI surface

A new **"MoE Sampler"** collapsible section (one per pair), rendered ABOVE the existing
KSampler section, using the same `CollapsibleSection` + `AutoNumericInput` conventions
(dark theme, shadcn/ui, `h-7 text-xs`). Per pair:

- **Total Steps** — `AutoNumericInput type=number`, placeholder = detected `total`.
- **Split (high steps)** — `AutoNumericInput type=number`, placeholder = detected
  `split`, with helper subtext `"high: {S} · low: {T-S}"` recomputed live.
- A one-line label: `"{label or 'MoE'} · {high_node_id}→{low_node_id}"`.
- If `steps_mismatch`, a `text-yellow-500` note: `"samplers shipped with different step
  counts ({hi} vs {lo}); editing Total re-syncs both"`.

The two underlying samplers STILL render in the existing KSampler section so the user
can set per-expert **cfg / sampler / scheduler / seed**. BUT in those per-sampler
panels, the `steps` numeric field is **hidden** for any node owned by a MoE pair (the
`numericFields` filter drops `steps` when `ks.node_id ∈ moeOwnedNodeIds`). cfg/denoise
remain. This is the consistency the user asked for: there is exactly one `steps` input
per expert pair, and it lives in the MoE panel.

**The render slice must match the submit slice (B2 consistency).** The KSampler panel
renders `ksamplers.slice(0, 3)` (frontend.block.tsx:2319, site 3 in the B2 table) — the
SAME cap B2 fixes in the submit loops. The single `isVisibleSampler(ks, index)`
predicate is used at sites 1-3 so render and submit stay symmetric: a 4th-position MoE
sampler that submits a cfg is also the one whose cfg input renders. Required test stays
`test_two_pairs_fourth_sampler_cfg_emitted`; add an RTL assertion the 4th sampler's cfg
input renders when MoE-owned.

Seed: the existing global Seed-lock affordance (lines 2304-2316) is unchanged and still
governs per-sampler seeds.

## Edge cases & degradation

| Case | Behavior |
|------|----------|
| Lone KSamplerAdvanced (no chained partner) | Single KSampler panel, today's behavior. No MoE pair. `start_at_step`/`end_at_step` not surfaced unless via generic settings. |
| Lone ClownShark | New single ClownShark panel (steps/cfg/seed/denoise/sampler/scheduler). No MoE pair. |
| 3+ chained same-family | Each a single panel. No MoE group (O1). |
| Cross-family chain | No MoE pair; each single. |
| `HIGH.steps != LOW.steps` at detect | Pair still formed; `steps_mismatch=true`; UI warns; `total=HIGH.steps`; first edit re-syncs. |
| LOW `end_at_step` is a real number, not 10000 | We never read or write LOW.end_at_step. Detection only needs LOW.start_at_step == HIGH.end_at_step. A non-sentinel LOW.end_at_step that is < total would mean the low expert stops early — unusual; we still pair (chain + boundary hold) and leave LOW.end_at_step untouched. Flagged as O4: should we warn? Recommend NO warn in v1 (rare, and untouched = preserved). |
| LOW ClownShark `steps_to_run` != -1 (a positive remainder count) | Detection only requires `sampler_mode=="resample"`. We never write LOW.steps_to_run, so a hand-set positive remainder is preserved. Pair still forms. |
| Pass-through node between samplers (e.g. a LatentUpscale) | If the node type is in `_LATENT_PASSTHROUGH`, the walk follows it and the pair forms. If it's a resize/transform that changes the latent meaningfully, it is NOT in the allow-list, the walk stops, no pair forms → two single panels. Conservative: we only pair through known no-op latent relays. Allow-list starts EMPTY (direct wire only) and grows only with evidence. v1: direct `["high",0]` wire required; `_LATENT_PASSTHROUGH` reserved for follow-up. |
| Same-family pair where direction (chain) and marker (add_noise/sampler_mode) disagree | Reject pair (no guessing). Two single panels. |
| `end_at_step`/`steps_to_run` out of `[1,steps-1]` at detect | Boundary signal fails → no pair. Two single panels. |
| Hidden via preset `hidden_nodes` | If EITHER node of a pair is hidden, drop the whole MoE pair (can't partially drive it). The visible node, if any, falls back to its single panel only if not hidden. |
| `total < 2` after user edit | Clamp to 2. |

## Test plan (mirror tests/test_comfy_gen_sampler_detect.py)

New file `tests/test_comfy_gen_moe_detect.py`, same `importlib` bootstrap. Backend
tests (pure, no GPU/API):

Detection — KSamplerAdvanced pair:
- `test_ksa_moe_pair_detected` — 401/402 fixture → one pair, family KSamplerAdvanced,
  high=401, low=402, total=8, split=4.
- `test_ksa_moe_total_targets` — `total_targets == ["401.steps","402.steps"]`.
- `test_ksa_moe_split_targets` — keys `401.end_at_step` + `402.start_at_step`, both
  recipe `'split'`. LOW.end_at_step NOT in targets.
- `test_ksa_moe_owned_keys` — owned_keys = those 4 keys.

Detection — ClownShark pair:
- `test_clownshark_moe_pair_detected` — 407/408 fixture → family ClownsharKSampler_Beta,
  total=16, split=4.
- `test_clownshark_split_targets` — only `407.steps_to_run` recipe `'split'`;
  408.steps_to_run NOT a target.

Single ClownShark:
- `test_clownshark_single_detected` — lone node → `_detect_ksamplers` entry with
  steps/cfg/seed(from `seed`)/denoise/sampler_name/scheduler, no override_map.
- `test_clownshark_seed_from_seed_field` — seed read from `seed`, not `noise_seed`.
- `test_clownshark_entry_has_curated_options` (O3) — entry carries `sampler_options`
  (curated constant ∪ its own current value) + `scheduler_options`; a standard
  KSampler entry does NOT carry these fields.

Degradation / negatives:
- `test_lone_ksa_no_pair` — single KSamplerAdvanced, latent_image not from a sampler →
  no MoE pair, but still one `_detect_ksamplers` entry.
- `test_three_chained_no_pair` — A→B→C same family → zero MoE pairs, three singles.
- `test_cross_family_no_pair` — KSamplerAdvanced feeding ClownShark → no pair.
- `test_direction_marker_disagree_no_pair` — chain says 401→402 but 401.add_noise =
  "disable" → reject.
- `test_boundary_out_of_range_no_pair` — end_at_step=0 or end_at_step>=steps → no pair.
- `test_steps_mismatch_flag` — high.steps=8, low.steps=10 → pair forms,
  steps_mismatch=true, total=8.
- `test_two_independent_pairs` — two KSA pairs in one workflow → two MoE pairs.

Frontend (Vitest, comfygen-overrides.test.ts pattern):
- `test_moe_fanout_total_and_split` — buildOverrides with a MoePairInfo + edited
  total=12/split=6 emits the 4 KSA keys with correct values, and the per-sampler loop
  does NOT also emit `401.steps`.
- `test_moe_fanout_clownshark` — 3 keys, no 408.steps_to_run.
- `test_moe_default_split_preserved_on_total_change` — total 8→12, split untouched →
  split stays 4 absolute (the propagation helper, tested directly).
- `test_split_clamped_to_total_minus_1` — total=4, raw split=6 → S_eff clamps to 3.
- `test_split_restored_after_total_dip` (S2) — store split=6 @ T=12, set T=4 (S_eff=3),
  set T=12 → S_eff back to 6; stored split never mutated.
- `test_collectAutoDetectedKeys_includes_moe_owned` — owned_keys suppressed from
  generic settings.
- `test_clownshark_panel_uses_curated_list` (O3, RTL) — ClownShark sampler dropdown
  offers `ks.sampler_options`; a standard KSampler dropdown offers `availableSamplers`.
- `test_moe_total_wins_over_stale_steps_chip` (B1) — `autoNumeric['401.steps']=['8']`
  present, MoE total=12 → override `401.steps == "12"`, chip ignored.
- `test_moe_owned_steps_not_emitted_as_axis` (B1) — `autoNumeric['401.steps']` length 3
  → computeAutomationAxes produces NO `401.steps` axis.
- `test_moe_cfg_axis_still_allowed` (B1) — cfg sweep on a MoE-owned node still yields a
  cfg axis (only steps/boundary are suppressed).
- `test_two_pairs_fourth_sampler_cfg_emitted` (B2) — 4 samplers (two pairs); sampler #4
  (index 3) is MoE-owned → its cfg/sampler/seed still emit despite the slice(0,3) cap.
- `test_no_moe_owned_key_in_any_axis` (B3) — chips on every owned key incl. boundary
  fields → computeAutomationAxes generates no axis for any of them.
- `test_two_pairs_fourth_sampler_in_job_metadata` (B4) — sampler #4's settings appear in
  the metadata reporter output (both multi-job and single-job paths).
- `test_moe_reports_total_steps_not_per_node` (B4) — an MoE pair's metadata reports
  `total_steps` + `split`, not a single expert's `steps`.

A small pure propagation helper (`resolveMoeSteps(detected, override) -> {total,
split, overrides}`) should live in comfygen-overrides.ts so the clamp/default math is
unit-tested without mounting the component — mirror how `buildOverrides` is extracted.

## Open questions — RESOLVED at the human spec gate

All forks closed; this section is now the decision record (frozen).

- **O1 (3+ chains):** DEFERRED-CONFIRMED. v1 treats 3+ same-family chained samplers as
  independent singles (no MoE group). Wan2.2 is 2-expert; 3-expert generalization is a
  future bead if ever needed.
- **O2 (Total Steps clamp):** ACCEPTED `[2, 200]`. Raise later if a >200-step workflow
  appears.
- **O3 (ClownShark sampler dropdown):** RESOLVED — curated list IN v1. Hardcoded
  `CLOWNSHARK_SAMPLERS`/`CLOWNSHARK_SCHEDULERS` constants in backend.block.py, unioned
  with each node's current value, attached to the entry as
  `sampler_options`/`scheduler_options`; frontend uses those when present, else the
  global cache list. See "Curated ClownShark sampler/scheduler list" in the Detection
  contract.
- **O4 (non-sentinel LOW boundary):** ACCEPTED. LOW.end_at_step (non-10000) or a
  positive LOW.steps_to_run is preserved untouched; pair still forms; no warning.
- **O5 (Total as automation axis):** ACCEPTED. MoE Total/Split are plain scalars, NOT
  automation chips in v1.
- **O6 (per-expert step minimum):** ACCEPTED — no floor. `S_eff ∈ [1, T-1]`; a 1-step
  expert is allowed; builder must not invent `min_high`/`min_low`.
- **O7 (non-canonical KSA handoff):** DEFERRED-CONFIRMED. v1 detects ONLY the canonical
  `add_noise=enable→disable` KSA pair; `return_with_leftover_noise`-governed or
  both-enable pairs degrade to two single panels. Widening signal-3 is a future bead.
- **O8 (pre-existing reporter provenance bug):** SPLIT OUT to bead **sgs-ui-6sn** (P3).
  This feature only adds the narrow MoE fix (a pair reports `total_steps` + `split`); the
  general "qualify `inference_settings` by node_id for ALL samplers" is NOT in this
  feature's scope — it lives in sgs-ui-6sn.

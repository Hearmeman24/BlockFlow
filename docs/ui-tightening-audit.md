# BlockFlow UI Tightening Audit

> Planning + documentation artifact. **No code changes.** This document maps the
> current UI, catalogs inconsistencies, and recommends a direction for tightening
> the design system. It is the basis for a future UI implementation epic.
>
> Bead: `sgs-ui-j1v` · Generated 2026-06-03 · Stack: Next.js 16 · React 19 ·
> shadcn/ui (new-york) · Tailwind · dark-theme only.
>
> Method: 5 parallel research agents — 3 codebase-mapping tracks (foundations,
> page surfaces, component/duplication) + 2 external-research tracks (reference
> patterns/shadcn, AI-slop avoidance). File:line references are from a snapshot
> of `frontend/src/`; verify before editing.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current UI Inventory](#2-current-ui-inventory)
3. [Component Usage Map](#3-component-usage-map)
4. [Typography Audit](#4-typography-audit)
5. [Button & CTA Audit](#5-button--cta-audit)
6. [Color & Theme Audit](#6-color--theme-audit)
7. [Layout & Spacing Audit](#7-layout--spacing-audit)
8. [Reusable Component Audit](#8-reusable-component-audit)
9. [Inconsistency List](#9-inconsistency-list)
10. ["AI Slop" / Generic UI Risk Areas](#10-ai-slop--generic-ui-risk-areas)
11. [Recommended shadcn/ui Components & Patterns](#11-recommended-shadcnui-components--patterns)
12. [Design-System Tightening Recommendations](#12-design-system-tightening-recommendations)
13. [Prioritized UI Cleanup Roadmap](#13-prioritized-ui-cleanup-roadmap)
14. [Suggested Engineering Tickets](#14-suggested-engineering-tickets)

---

## 1. Executive Summary

BlockFlow's foundation is **healthier than most shadcn apps** in one respect — it
has a real token sheet (oklch palette, a radius scale, Geist Sans/Mono) and one
genuinely clean shared scaffold (`block-card.tsx`, the canvas node frame). The
problem is not the foundation; it's that **roughly half the app ignores it.**

The dominant failure pattern is **primitive bypass**: ~169 raw `<button>`
elements re-implement the shadcn `Button` variants by hand, settings/LoRAs/Presets
pages use raw `<input>`/`<select>` instead of the `Input`/`Select` primitives, and
four separate bespoke modal overlays exist alongside the shadcn `Dialog`. Six
installed primitives (`progress`, `skeleton`, `sonner`, `scroll-area`,
`separator`, `navigation-menu`) are **dead imports** — most notably, every one of
the ~7 progress bars is a hand-rolled `<div>` while `ui/progress.tsx` sits unused,
and `sonner` is wired up but never called, so transient feedback falls back to
inline banners and native `confirm()`/`alert()`.

The app splits cleanly into **two consistency tiers**:

- **Tier A (aligned):** Artifacts/run-history, CivitAI submit modal, prompt
  library dialog, and the pipeline block frame use shadcn primitives correctly.
- **Tier B (divergent):** LoRAs, Presets, Settings, the ComfyGen wizard, and the
  welcome modal hand-roll buttons, inputs, modals, and panels.

On top of bypass, there's **token drift**: ~40+ arbitrary `text-[9/10/11px]`
sizes below the `text-xs` floor, ~55+ off-palette color utilities
(emerald/amber/violet/blue/red) used as ad-hoc semantic states with no tokens,
3 different modal backdrop opacities, and 5 different page max-widths across 5
content pages. State handling is the weakest surface: **no page has a loading
skeleton** (all Suspense boundaries are `fallback={null}`), Artifacts has **no
error state at all** (a failed fetch is indistinguishable from "no runs"), and
empty states are bare one-liners.

None of this reads as "broken" — it reads as **unfinished and generic**, the exact
"AI slop" signature. The good news: because the token sheet and a canonical block
frame already exist, tightening is mostly **consolidation, not redesign**. The
highest-leverage work is (1) extract ~10 shared atoms/utilities that are currently
copy-pasted 3–22× each, (2) route the divergent pages through the existing
primitives, (3) define the missing tokens (sub-xs type, semantic state colors,
link color), and (4) establish a real three-state (loading/empty/error) contract.

---

## 2. Current UI Inventory

### 2.1 Routes / Pages (`frontend/src/app/`)

| Route | Entry | Purpose | Tier | Notable |
|---|---|---|---|---|
| `/` | `page.tsx` | Home / landing | — | redirects/light |
| `/generate` | `generate/page.tsx` → **returns `null`** | Pipeline canvas | A (frame) | Content is the always-mounted `<PipelineTabs />` in `AppShell`; route file is opaque |
| `/artifacts` | `artifacts/page.tsx` → `RunHistory` | Run-history gallery | **A** | Best-in-app empty state; **no error state** |
| `/loras` | `loras/page.tsx` → `LorasPageBody` | LoRA manager (table) | **B** | Raw buttons/inputs/selects, bespoke download modal |
| `/presets` | `presets/page.tsx` → `PresetsPageBody` | Preset registry | **B** | Raw buttons, hand-rolled progress |
| `/settings` | `settings/page.tsx` → `SettingsLayout` | Settings (2-col tabs) | **B** | Custom tab nav, raw inputs, 2 bespoke modals |
| `/dev/wizard` | `dev/wizard/page.tsx` | Dev harness | B | Different heading size; raw buttons |

### 2.2 Global Chrome (`frontend/src/components/`)

- **`app-shell.tsx`** — root wrapper; `ErrorBoundary` → `TooltipProvider` →
  `PipelineTabsProvider`. Pipeline shell is **always mounted**, toggled
  `invisible pointer-events-none fixed inset-0 -z-10` off-route (`:40`).
- **`nav-bar.tsx`** — floating top pill (`fixed top-4 left-1/2`). Logo, File
  dropdown, Generate/Artifacts links, Presets/LoRAs/Settings nav-icons, Discord.
  Uses native `prompt()`/`confirm()` ×5 (`:46,57,122,135,164`).
- **`sidebar.tsx`** — left icon rail; **duplicates** Generate/Artifacts from the
  navbar (`SIDEBAR_ITEMS` mirrors `NAV_ITEMS` by hand).
- **`status-bar.tsx`** — exported but **not mounted anywhere** (orphan).
- **`error-boundary.tsx`** — single app-level boundary; fallback uses a
  hand-rolled button (`:34-41`).
- **`welcome-to-blockflow.tsx`** — onboarding modal; **bespoke** `<section
  role="dialog">` + `bg-black/65`, raw `<input>`, `z-[60]`.

### 2.3 Feature Components

Run feed (`run-history.tsx`, `run-card.tsx`), cards (`lora-card.tsx`,
`dataset-card.tsx`), media (`adaptive-media.tsx`), dialogs
(`prompt-library-dialog.tsx`, `civitai/submit-modal.tsx`), wizard
(`wizard/comfygen-wizard.tsx`, ~1,467 lines — largest component), settings tabs
(`settings/*`), civitai (`civitai/*`).

### 2.4 Pipeline / Blocks

`components/pipeline/` (23 files) + `pipeline/custom_blocks/generated/` (24
blocks). One shared frame (`block-card.tsx`); block **bodies** are unshared and
duplicate heavily (see §8).

### 2.5 States Inventory

| State | Status |
|---|---|
| **Empty** | Present but bare (one-line text, no icon/CTA) on LoRAs/Presets/dropdowns; Artifacts is best (2-line + action). |
| **Loading** | Plain `"Loading…"` text everywhere; **no skeletons**; all Suspense `fallback={null}`. |
| **Error** | Inline destructive banners on LoRAs/Presets/Settings; **none** on Artifacts; one global boundary; **no toasts**. |

---

## 3. Component Usage Map

### 3.1 shadcn Primitive Inventory (`components/ui/`, 19 files)

| Primitive | Variants defined | Actually used | Notes |
|---|---|---|---|
| `button` | 6 variants × 6 sizes | default, outline (~16), ghost (~6), destructive (~4) | `secondary`, `link`, `xs`, `icon-sm`, `icon-lg` **unused**; ~169 raw `<button>` bypass it |
| `card` | sub-components only | Card+Content (run/lora/dataset/block) | `CardFooter`/`CardDescription`/`CardAction` unused |
| `badge` | 6 variants | secondary (~6), outline (~4) | className overrides defeat variant colors |
| `select` | size: sm, default | size prop **never passed** | 22× `SelectTrigger className="h-7 text-xs"` override instead |
| `input` | — | used + bypassed | raw `<input>` in credential/storage/app/wizard |
| `dialog` | `showCloseButton` | consistent | only 2 surfaces use it vs 4 bespoke modals |
| `dropdown-menu` | item: default/destructive | default only | Sub/Portal/SubContent unused |
| `tooltip` / `label` / `textarea` / `switch` / `slider` | — | used | consistent |
| `collapsible` | — | **1 file** (`prompt_writer`) | rest use hand-rolled `CollapsibleSection` |
| `progress` | — | **0 call sites** | all ~7 progress bars hand-rolled |
| `skeleton` | — | **0** | dead import |
| `sonner` | — | **0** | wired in `ui/sonner.tsx`, never called |
| `scroll-area` | — | **0** | dead |
| `separator` | — | **0** | dead |
| `navigation-menu` | — | **0** | dead |

### 3.2 Primitive Adoption by Surface

| Surface | Button | Input | Dialog |
|---|---|---|---|
| Artifacts / run-card | ✅ shadcn | ✅ shadcn | — |
| CivitAI submit | ✅ | ✅ | ✅ |
| Prompt library | ✅ | ✅ | ✅ |
| Generated blocks | mixed | ✅ Input/Select | — |
| **LoRAs** | ❌ raw | ❌ raw | ❌ bespoke |
| **Presets** | ❌ raw | — | — |
| **Settings** | ❌ raw | ❌ raw | ❌ bespoke ×2 |
| **ComfyGen wizard** | ❌ raw | ❌ raw | ❌ bespoke |
| **Welcome modal** | ❌ raw | ❌ raw | ❌ bespoke |

---

## 4. Typography Audit

**Fonts:** Geist Sans (`--font-geist-sans`) + Geist Mono, loaded in
`layout.tsx:7-15`, applied on `<body>`. Good, intentional choice.

**Type scale in use (de-facto, not a system):**

| Size | Usage |
|---|---|
| `text-[8px]` | block overlay label |
| `text-[9px]` | micro badges (`run-card:424`, `block-picker:164`) |
| `text-[10px]` | **heavy** — meta/secondary across civitai, dataset-card, run-card (~20 sites) |
| `text-[11px]` | tight labels — block fields (`Label className="text-[11px]"` ~39×), run-card |
| `text-xs` (12) | navbar, status, buttons |
| `text-sm` (14) | nav items, inputs, button labels |
| `text-base` (16) | welcome `h3` |
| `text-lg` (18) | error-boundary heading, lora monogram |
| `text-xl` (20) | welcome `h2`, dev-wizard `h1` |
| `text-2xl` | LoRAs/Presets/Settings `h1` |

**Findings:**

- **~40+ arbitrary sub-`text-xs` sizes** (`text-[9/10/11px]`). They're used
  semi-consistently (9=micro-badge, 10=meta, 11=label) — i.e. they *want* to be
  3 named tokens but aren't. No named step exists below `text-xs`.
- **Heading rank is inconsistent:** welcome `h2`=`text-xl`, dev-wizard `h1`=
  `text-xl` (same size, different rank); page `h1`=`text-2xl`; error-boundary
  heading is a `<div>` not a heading element (`error-boundary:31`).
- **Micro-caps pattern** (`text-[10px] uppercase tracking-wider font-semibold`)
  recurs in pipeline section headers but is not tokenized; welcome modal uses
  `uppercase` + `tracking-normal` (`:118`) — wrong tracking for caps.
- Only `font-medium`/`font-semibold` in the shell — no bold/light. Good restraint.

---

## 5. Button & CTA Audit

**The headline number: ~169 raw `<button>` elements** re-implement shadcn Button
styling by hand. Concentrations:

- `settings/credential-input.tsx:104,112,116,121` — show/hide/save/validate, each
  a hand-rolled `default`/`outline` clone.
- `settings/storage-tab.tsx:174,247,276` — `bg-primary px-4 py-1.5…` (default
  clone) and `border border-border…` (outline clone).
- `settings/endpoints-tab.tsx` — **9** raw buttons.
- `loras/loras-page-body.tsx:234,244,319` — Add/Sync/filter buttons.
- `presets/presets-page-body.tsx:161,455` — Refresh/Install.
- `comfygen-wizard.tsx` — all actions raw.
- `comfy_gen.tsx:405,640`, `seedance.tsx:640`, `block-card.tsx:194`,
  `pannable-canvas.tsx:72`, `director-prompt-loras-popover.tsx:124` — block-level.

**Icon-button size drift:** three coexisting sizes — `size-6` (block-card
header), `size-7` (comfy_gen `+`), `size-9` (`size="icon"` default). The `size-6`
override fights the primitive's default.

**Inconsistent primary treatment:** pipeline Run uses `Button`; Settings "Save"
(`storage-tab:174`) and credential "Save" (`credential-input:116`) are raw clones
of `variant="default"`. Across pages, "primary action" is sometimes filled
emerald (`pipeline-tabs:154`), sometimes `bg-primary`, sometimes a raw clone.

**Native dialogs as CTAs:** `prompt()`/`confirm()`/`alert()` used for save,
save-as, rename, delete, dataset-delete (`nav-bar`, `dataset-card:78,101`,
`loras-page-body:121`, `presets-page-body:135`). Thread-blocking, unstyleable.

---

## 6. Color & Theme Audit

**Token sheet (`globals.css`):** Clean oklch palette in `:root`/`.dark`
(`:50-116`), full radius scale (`--radius-sm…4xl`, `:41-47`), Geist font tokens.
Zero raw hex in the token sheet. This is a real foundation.

**Dead tokens:**

- Entire **light-mode `:root` block** + `--sidebar-*` light values — `<html
  class="dark">` is hardcoded (`layout.tsx:28`), so light mode is unreachable.
- `--chart-1…5` — no charts in the app.
- `--radius-3xl`/`--radius-4xl` — never referenced.
- `--sidebar-primary` (vivid blue) — sidebar uses `bg-primary` instead.

**Off-palette color sprawl (~55+ utility strings, ~15 files)** — used as ad-hoc
semantic states with **no tokens**:

| Pseudo-semantic | Hue | Example sites |
|---|---|---|
| success / ready | emerald/green | `run-history:186`, `pipeline-tabs:154`, `dataset-card:116`, settings status |
| warning | amber/yellow | `approval-gate:69`, `run-history:174`, `storage-tab:220`, `prompt-library-dialog:178` |
| LoRA accent | violet | `run-card:483-508`, `lora-card:73` |
| link / external | blue | `run-card:188,308,515`, `lora-card:109`, `nav-bar:119` |
| error / danger | red | `run-card:27`, `pipeline-tabs:136`, `provider-missing-card:19` |

No `--success`/`--warning`/`--info`/`--link` tokens exist, so every consumer
picks its own `-400`/`-500`/`/10`/`/30` combination → opacity and shade drift.

**Backdrop / glass drift:** modal backdrops use **3 opacities** — `bg-black/50`
(endpoints), `bg-black/60` (loras download), `bg-black/65` (welcome); shadcn
Dialog default is `/80`. Floating chrome consistently uses `backdrop-blur-md
bg-card/80 shadow-lg` (good), but `pannable-canvas:74` and `comfygen-wizard:860`
use bare `backdrop-blur` (different level).

**Shadow tiers** are mostly coherent (chrome=`shadow-lg`, overlays=`shadow-xl`)
except welcome uses `shadow-2xl` (one step off).

---

## 7. Layout & Spacing Audit

**Page max-width — 5 different values across 5 content pages:**

| Page | max-width |
|---|---|
| Artifacts | `max-w-6xl` |
| LoRAs | `max-w-5xl` |
| Settings | `max-w-5xl` |
| Presets | `max-w-4xl` |
| Dev wizard | `max-w-3xl` |

Page gutters also drift: `px-4 pt-20 pb-6` (artifacts/loras/presets) vs `px-6
py-10` (settings).

**Page header — 5 different treatments:**

| Page | Header |
|---|---|
| Artifacts | **no `h1`** — count text replaces it (`run-history:204`) |
| LoRAs / Presets | `h1 text-2xl` inline with toolbar |
| Settings | `h1 text-2xl mb-6` above the 2-col layout |
| Dev wizard | `h1 text-xl` (smaller) |

**Spacing:** shell components draw cleanly from the standard Tailwind scale (no
arbitrary `p-[...]`/`gap-[...]` in chrome). Drift lives in **arbitrary sizing**:
`min-h-[176px]`, `max-w-[150px]`, fixed block-card widths
(`w-[280/360/440/540px]` — intentional), and the `text-[Npx]` family. Radius is
applied semantically in chrome (`rounded-full` navbar, `rounded-xl` sidebar) but
panels drift (`rounded` vs `rounded-md` vs `rounded-xl` for "card-like" things —
see §8.4).

**Structural smell:** `generate/page.tsx` returns `null`; the real render is the
always-mounted `PipelineTabs` in `AppShell` (`:40`), hidden off-route via
`invisible … -z-10`. Performance-motivated but opaque and fragile to stacking
changes.

---

## 8. Reusable Component Audit

### 8.1 What's correctly shared

- **`block-card.tsx`** — the single canonical canvas-node frame (header w/ number
  selector, editable title, status badge, iteration counter, actions, scrollable
  body). Clean, non-duplicated. The model to emulate.
- `ProviderMissingCard` (11 blocks), `PromptSourceControl`, `SourceModeControl`,
  `BlockStatusBadge`, `formatRelativeTime` (imported by lora-card).

### 8.2 Duplicated logic (promote to `lib/`)

| Pattern | Copies | Locations |
|---|---|---|
| `toText(value)` coercer | **5** | `nano_banana_2:43`, `multimodal_prompt_writer:103`, `gpt_image_piapi:66`, `elevenlabs_tts:39`, `seedance:110` |
| `uploadOne` tmpfiles hook | **4** | `nano_banana_2:86`, `multimodal_prompt_writer:183`, `seedance:232`, `gpt_image_piapi:113` |
| `toVideoUrls` | **3** | `video_fx:31`, `video_viewer:14`, `video_stitcher:34` |
| Viewer URL accumulation | **3** | `audio_viewer:35`, `video_viewer:29`, `image_viewer:49` |
| Duration formatting | **5** | `run-card:33,42`, `lora-card:25`, `lora_train:86`, `upscale:201` |
| Block health-check `useEffect` | **12+** | provider-backed blocks |

### 8.3 Duplicated UI (promote to shared components)

- **Favorite star + delete `×` SVGs** — copy-pasted verbatim ×3 (`run-card:744`,
  `lora-card:149`, `dataset-card:196`). → `FavoriteButton` / `DeleteIconButton`.
- **`CollapsibleSection`** — defined once in `comfy_gen:423`, used 15× in that one
  file, not exported; `prompt_writer` uses shadcn `Collapsible` instead. → export
  one `pipeline/collapsible-section.tsx`.
- **Block field row** (`div.space-y-1` + `Label.text-[11px]` + compact control) —
  ~39× across 20 blocks. → `<BlockField label hint>`.
- **Compact select** (`SelectTrigger className="h-7 text-xs"`) — 22×. → add a
  size variant or `BlockSelect` wrapper.
- **Hand-rolled progress bars** — ~7× (`block-card:396`, `comfy_gen:1873,1967`,
  `lora_train:532`, `dataset_caption:333`, `dataset_create:535`, `upscale:564`)
  with drifting height/radius/bg. → use the unused `Progress` primitive.

### 8.4 Card / panel treatments — 7 distinct

| Surface | Radius | Padding | Border |
|---|---|---|---|
| Block card | `rounded-xl` | `px-4 pb-3` | `border-2` per size |
| Run/Lora/Dataset card | `rounded-xl` (default) | `p-3` | `border` |
| ProviderMissingCard | `rounded-md` | `px-3 py-2.5` | `red-500/35` |
| SourceModeControl | `rounded` (4px) | `px-2 py-1.5` | `border/60` |
| Block error panel | `rounded-md` | `px-3 py-2` | `red-500/20` |
| Iteration panel | `rounded-md` | `px-3 py-1.5` | `purple-500/20` |
| R2 gate | `rounded-md` | `p-3` | `border/60` |

Informational panels (error/warning/provider/iteration/gate) are all hand-rolled
divs with slightly different padding/opacity/border. → `<AlertPanel
variant="error|warning|info">`.

### 8.5 Modal/overlay implementations — 6 distinct

shadcn `Dialog` (civitai, prompt-library) **vs** 4 bespoke overlays
(loras-download `bg-black/60`, comfygen-wizard `bg-black/50`, endpoints
`Modal`+`TrainerWizardPlaceholder` two different structures, welcome `z-[60]
bg-black/65`). → migrate all to `Dialog`, or at minimum one `ModalOverlay`.

---

## 9. Inconsistency List

Ranked, each with the canonical fix.

1. **Button primitive bypass** — ~169 raw `<button>` (settings, loras, presets,
   wizard). → `<Button variant size>`.
2. **Input/Select bypass** — raw `<input>`/`<select>` in settings, loras filter,
   wizard. → `Input`/`Select`.
3. **Modal fragmentation** — 6 implementations, 3 backdrop opacities. → `Dialog`.
4. **Progress bars hand-rolled** — ~7×, primitive unused. → `Progress`.
5. **Sub-`text-xs` arbitrary sizes** — ~40× `text-[9/10/11px]`. → 3 named tokens.
6. **Off-palette semantic colors** — ~55× emerald/amber/violet/blue/red, no
   tokens. → `--success/--warning/--info/--link` + variant helpers.
7. **Page max-width** — 5 values. → 2 standard widths (data vs settings).
8. **Page header** — 5 treatments, Artifacts has none. → one `PageHeader`.
9. **Loading state** — text-only, no skeletons, `fallback={null}`. → `Skeleton`.
10. **Error state** — Artifacts has none; no toasts. → error contract + `sonner`.
11. **Empty state** — bare one-liners. → `EmptyState` (icon + headline + CTA).
12. **Native `confirm()`/`alert()`** — 5+ sites. → `AlertDialog`.
13. **Favorite/delete SVGs** — duplicated ×3. → shared atoms.
14. **Duplicated block utils** — `toText`×5, `uploadOne`×4, etc. → `lib/`.
15. **Icon-button size drift** — `size-6/7/9`. → one token.
16. **Nav duplication** — sidebar mirrors navbar; `status-bar` orphaned. →
    dedupe `NAV_ITEMS`, remove/scope sidebar.
17. **Card radius/padding drift** — 7 panel treatments. → `AlertPanel` + Card.
18. **Dead tokens/imports** — light mode, charts, `radius-3xl/4xl`, 6 unused
    primitives. → strip or document.

---

## 10. "AI Slop" / Generic UI Risk Areas

Mapped to BlockFlow's actual symptoms (general principles from Refactoring UI,
Vercel Geist, Emil Kowalski, Satellytes, Alephic).

| Slop failure mode | Present in BlockFlow? | Evidence | Fix |
|---|---|---|---|
| **Random component variants** | **High** | 169 raw buttons, 6 modal impls, 7 card treatments | Collapse to 3 button tiers, 1 modal, ≤3 surface types |
| **Inconsistent spacing/sizing** | **Med-High** | 5 max-widths, 40+ arbitrary text sizes, 3 backdrop opacities | 4/8px discipline; named tokens |
| **Poor empty/loading/error states** | **High** | no skeletons, no Artifacts error, bare empties | 3-state contract |
| **Unclear primary action** | **Med** | filled emerald Run vs bg-primary vs raw clones; multiple filled buttons per view | one-primary-per-view; one accent |
| **Default shadcn look** | **Med** | base radius, neutral palette, Inter-adjacent defaults on bypassed controls | custom radius + accent (already have Geist) |
| **Generic equal-weight cards** | **Med** | 7 card variants, everything boxed | reserve border-card for interactive only |
| **Decorative clutter** | **Low-Med** | per-line icons, dividers where spacing suffices | icon discipline; delete redundant `Separator` |
| **Weak hierarchy** | **Med** | only `font-medium/semibold`; off-palette colors muddy the 3-step ramp | enforce `foreground`/`muted`/`muted/60` |
| **Excessive gradient/glass** | **Low** | glass is scoped to floating chrome (acceptable); no gradient text found | keep scoped; ban gradient text |

**Net:** BlockFlow's slop risk is **structural (variant sprawl + weak states)**,
not cosmetic (it largely avoids gradient-text/glassmorphism overuse). That's the
better problem to have — it's fixed by consolidation, not restraint.

---

## 11. Recommended shadcn/ui Components & Patterns

### 11.1 Add / activate

| Component | Surface | Status |
|---|---|---|
| `command` (+`kbd`) | Global `Cmd+K` — run pipeline, jump-to-block, navigate | **add** (n8n's most-praised pattern) |
| `skeleton` | Gallery/page loading grids | installed, **activate** |
| `sonner` | Run-complete, save, error toasts | installed, **activate** |
| `progress` | Block/install progress | installed, **activate** |
| `empty` | All library empty states | **add** |
| `alert-dialog` | Replace `confirm()`/`alert()` | **add** |
| `context-menu` | Right-click block → run-from-here, duplicate, delete | **add** |
| `resizable` | Canvas + inspector split pane | **add** |
| `sheet` | Inspector panel (keep canvas visible) | **add** |
| `toggle-group` | Gallery grid/list view toggle | **add** |
| `hover-card` | LoRA preview on hover | optional |

### 11.2 Reference patterns to borrow (per surface)

- **Canvas/blocks (n8n, ComfyUI Nodes 2.0):** colored category stripe per block
  type; type-colored port circles flush to edge; on-canvas status badge after run
  (green ✓ / red ✗ / spinner); right-click context menu; `Cmd+K` jump-to-block;
  minimap. Inline widgets in the block body (already BlockFlow's model — keep it).
- **Galleries (Replicate, Leonardo):** full-bleed thumbnail; bottom-left
  metadata pill; **hover-reveal action cluster** (download / copy prompt / use as
  input / delete); checkbox-on-hover bulk select with a slide-up action bar;
  aspect-ratio + model filter pills (URL-state, already BlockFlow's convention);
  **skeleton card grid** while loading.
- **Dashboards (Linear, Vercel, Raycast):** 4/8px baseline grid; muted-pill
  active nav state (not full fill); always-visible status dots; two-column
  settings; `kbd` shortcut badges; icon-only collapsible sidebar rail.

### 11.3 Build custom (no registry analog)

Block card (canvas node), typed port handle (ReactFlow `<Handle>` colored per
data type), canvas toolbar (zoom/fit/run).

---

## 12. Design-System Tightening Recommendations

### 12.1 Tokens to add (`globals.css`)

- **Sub-`text-xs` scale** — `--text-2xs/3xs/4xs` (or utilities) replacing
  `text-[11/10/9px]`. Makes intent searchable, kills 40+ arbitrary values.
- **Semantic state colors** — `--success`, `--warning`, `--info`, `--link`
  (+`-foreground`/subtle variants), dark-only. Replace the ~55 ad-hoc
  emerald/amber/blue utilities. Pair with a `<StatusBadge variant>` and
  `<AlertPanel variant>`.
- **One icon-button size token** — collapse `size-6/7/9` to one (likely `size-7`
  for dense chrome, keep `size-9` only for true touch targets).
- **Document dead tokens** — strip light-mode block + charts, or comment why kept.

### 12.2 Shared components to extract

`PageHeader`, `EmptyState`, `AlertPanel`, `StatusBadge`, `FavoriteButton`,
`DeleteIconButton`, `BlockField`, `BlockSelect`/compact-select size,
`ModalOverlay` (or full `Dialog` migration), `pipeline/collapsible-section`.

### 12.3 Shared utilities to extract (`lib/`)

`block-utils.ts` (`toText`), `tmpfiles-upload.ts` (`uploadOne`), `video-ref.ts`
(`toVideoUrls`), `format-time.ts` (duration/relative), `use-accumulated-urls.ts`,
`use-block-health.ts`.

### 12.4 Contracts to establish

- **Three-state contract:** every data surface ships loading (skeleton matching
  content shape), empty (icon + headline + one CTA), error (human message + one
  recovery action) before the happy path. No `fallback={null}`.
- **One-primary-per-view:** exactly one full-opacity accent element per screen;
  everything else outline/ghost. Define the pipeline Run as the canonical primary.
- **Primitive-first:** lint/PR rule — no raw `<button>`/`<input>`/`<select>` and
  no hand-rolled modal/progress where a primitive exists.

### 12.5 Differentiation levers (cheap, high-impact)

Custom `--radius` (deliberate, documented), a non-blue/non-violet accent,
`active:scale-[0.97]` on buttons, customized focus ring, consistent compact
density. (Geist font is already done — keep it.)

---

## 13. Prioritized UI Cleanup Roadmap

**Phase 0 — Tokens & contracts (foundation, low risk, unblocks the rest)**
- Add sub-xs type tokens, semantic state colors, link color, icon-button size.
- Strip/document dead tokens & 6 dead primitive imports.
- Write the three-state + one-primary + primitive-first contracts into `AGENTS.md`.

**Phase 1 — Extract shared atoms/utilities (mechanical, high dedup payoff)**
- `lib/` utils (`toText`, `uploadOne`, `toVideoUrls`, `format-time`, hooks).
- Atoms: `FavoriteButton`, `DeleteIconButton`, `BlockField`, compact `BlockSelect`,
  `pipeline/collapsible-section`, `AlertPanel`, `StatusBadge`, `EmptyState`,
  `PageHeader`.

**Phase 2 — Route Tier-B surfaces through primitives (consistency)**
- Settings: raw buttons/inputs → `Button`/`Input`/`Label`; 2 bespoke modals →
  `Dialog`.
- LoRAs/Presets: raw buttons/inputs/selects → primitives; download/install
  progress → `Progress`; bespoke download modal → `Dialog`.
- Welcome modal → `Dialog`; native `confirm()`/`alert()` → `AlertDialog`.
- Activate `sonner` for transient feedback.

**Phase 3 — States polish (visible quality)**
- Skeleton grids (Artifacts, LoRAs, Presets); add Artifacts error state; upgrade
  empty states; wizard step loading indicators.

**Phase 4 — Layout normalization**
- Standardize max-width (2 widths) + gutters; `PageHeader` everywhere; dedupe
  nav (`NAV_ITEMS`), remove/scope sidebar, resolve `status-bar` orphan.

**Phase 5 — Canvas/gallery UX uplift (feature-level, optional epic)**
- `Cmd+K` command palette; on-canvas status badges; right-click context menu;
  resizable inspector; gallery hover-action cluster + bulk select; block-type
  color stripes + typed port colors.

---

## 14. Suggested Engineering Tickets

Sized for a future implementation epic. IDs are placeholders.

**Foundation**
- `UI-001` Add design tokens: sub-xs type scale, `--success/--warning/--info/
  --link`, icon-button size token. Migrate 1 reference surface.
- `UI-002` Strip/document dead code: light-mode tokens, chart tokens,
  `radius-3xl/4xl`, 6 unused primitive imports (`scroll-area`, `separator`,
  `navigation-menu`; verify before removing `skeleton`/`progress`/`sonner` which
  will be activated).
- `UI-003` Codify contracts in `AGENTS.md`: three-state, one-primary-per-view,
  primitive-first; add an ESLint rule banning raw `<button>` where `Button` fits.

**Shared extraction**
- `UI-010` Extract `lib/` utilities (`toText`, `uploadOne`, `toVideoUrls`,
  `format-time`, `use-accumulated-urls`, `use-block-health`) + replace all copies.
- `UI-011` Extract atoms: `FavoriteButton`, `DeleteIconButton`.
- `UI-012` Extract `BlockField` + compact `BlockSelect` size; migrate ~39 block
  field rows + 22 compact selects.
- `UI-013` Export `pipeline/collapsible-section`; replace 15 in-file uses + the
  lone shadcn `Collapsible` usage.
- `UI-014` `AlertPanel` (error/warning/info) + `StatusBadge`; migrate 7 panel
  treatments + badge override sites.
- `UI-015` `EmptyState` + `PageHeader`; adopt across content pages.

**Primitive migration**
- `UI-020` Settings → primitives (buttons/inputs/labels) + 2 modals → `Dialog`.
- `UI-021` LoRAs → primitives; download modal → `Dialog`; progress → `Progress`.
- `UI-022` Presets → primitives; install progress → `Progress`.
- `UI-023` ComfyGen wizard → primitives (largest file — scope carefully).
- `UI-024` Welcome modal → `Dialog`; `Input`/`Label`.
- `UI-025` Replace native `confirm()`/`alert()` (5+ sites) → `AlertDialog`.
- `UI-026` Activate `sonner`; route save/sync/delete/run feedback to toasts.
- `UI-027` Replace ~7 hand-rolled progress bars with `Progress`.

**States & layout**
- `UI-030` Skeleton loading grids (Artifacts, LoRAs, Presets); remove
  `fallback={null}`.
- `UI-031` Artifacts error state + retry; distinguish error from empty.
- `UI-032` Standardize page max-width (2 widths) + gutters.
- `UI-033` Dedupe nav (`NAV_ITEMS` shared), remove/scope sidebar, resolve
  `status-bar` orphan.

**Canvas/gallery (optional follow-on epic)**
- `UI-040` `Cmd+K` command palette (`command` + `kbd`).
- `UI-041` On-canvas per-block status badges after run.
- `UI-042` Block right-click `context-menu` (run-from-here / duplicate / delete).
- `UI-043` Resizable inspector (`resizable` + `sheet`).
- `UI-044` Gallery hover-action cluster + checkbox bulk-select + slide-up bar.
- `UI-045` Block-type color stripes + typed port colors.

---

*End of audit. No code was modified. Recommendations are sequenced so Phase 0–1
(tokens + extraction) unblock the consistency migrations in Phase 2–4.*

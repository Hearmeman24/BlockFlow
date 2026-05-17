# Generate Ideas — Technical Overview

The Generate Ideas feature lets users describe a concept (e.g. "Travel photo pack in Thailand") and have an LLM produce multiple prompt variations that automatically become a batch sweep axis in downstream ComfyGen blocks.

## Data Flow

```
PromptWriter: user describes concept
    ↓
POST /api/blocks/prompt_writer/generate-ideas
    ↓
LLM returns N idea strings
    ↓
First idea → main userPrompt, rest → extraUserPrompts[]
    ↓
Execute: all prompts sent to LLM for expansion → outputs.prompt = [expanded1, expanded2, ...]
    ↓
ComfyGen receives inputs.prompt as array
    ↓
Detects array length > 1 → creates __upstream_prompt__ batch axis
    ↓
Cartesian product with other axes (samplers, LoRAs, steps, etc.)
    ↓
Each combination submitted as a separate comfy-gen job
```

## Backend: Idea Generation

**Endpoint:** `POST /api/blocks/prompt_writer/generate-ideas`
**File:** `custom_blocks/prompt_writer/backend.block.py` (lines 102–155)

### Request

```json
{
  "model": "openrouter-model-id",
  "description": "Travel photo pack in Thailand",
  "count": 8,
  "temperature": 0.9
}
```

- `count`: 1–64 (default 8)
- `temperature`: default 0.9

### Response

```json
{
  "ok": true,
  "ideas": ["idea 1", "idea 2", "..."],
  "count": 8
}
```

### System Prompt

The LLM is instructed to (lines 84–99):
- Keep the same character across all variations (consistent physical attributes)
- Vary only setting, clothing, pose, activity, lighting, mood
- Output 1–2 sentence idea seeds with specific visual details
- Return a JSON array of strings

### JSON Parsing

Three-stage fallback (lines 131–147):
1. Direct `json.loads()` on response content
2. Extract from markdown code block (`` ```json ... ``` ``)
3. Raw array extraction

Timeout: 120s for OpenRouter calls.

## Frontend: Prompt Writer

**File:** `custom_blocks/prompt_writer/frontend.block.tsx`

### State

| Variable | Type | Purpose |
|----------|------|---------|
| `ideaDescription` | `string` | User's concept description |
| `ideaCount` | `number` | How many ideas (4, 8, 16, 24, 32, 48) |
| `ideaGenerating` | `boolean` | Loading state |
| `extraUserPrompts` | `string[]` | Additional prompts beyond the main one |

### UI (lines 507–567)

Collapsible "Generate ideas" panel with:
- Textarea for description
- Count dropdown (4/8/16/24/32/48)
- Generate button (disabled without description or model)

### On Generate (lines 536–561)

1. Call `/generate-ideas` endpoint
2. First idea → `userPrompt` (main prompt field)
3. Remaining ideas → `extraUserPrompts` array
4. Close panel on success

### Execution (lines 287–341)

When the pipeline runs the PromptWriter block:
1. Collects `userPrompt` + all `extraUserPrompts`
2. Each prompt is sent to the LLM via `/generate` for full expansion
3. Output is a single string (1 prompt) or array (2+ prompts)
4. `setOutput('prompt', generatedPrompts)` passes downstream

## Frontend: ComfyGen Batch Integration

**File:** `custom_blocks/comfy_gen/frontend.block.tsx`

### Upstream Prompt Detection (lines 1089–1102)

```typescript
const upstreamPrompts = Array.isArray(inputs.prompt)
  ? inputs.prompt.filter((p) => typeof p === 'string' && p.trim())
  : []
if (upstreamPrompts.length > 1) {
  axes.push({ key: '__upstream_prompt__', values: upstreamPrompts, label: 'prompt' })
}
```

If `inputs.prompt` is an array with 2+ items, a synthetic `__upstream_prompt__` axis is added.

### Cartesian Product

The prompt axis combines with all other automation axes:

```
8 ideas × 2 samplers × 2 LoRAs = 32 jobs
```

Uses `cartesianProduct()` from `comfygen-overrides.ts` (lines 253–266).

### Batch Expansion (lines 1166–1176)

For each combination, `__upstream_prompt__` is expanded to all upstream-bound text fields:

```typescript
if (merged.__upstream_prompt__) {
  const promptVal = merged.__upstream_prompt__
  delete merged.__upstream_prompt__
  for (const to of textOverrides) {
    if (textUpstreamFlags[`${to.node_id}.${to.input_name}`]) {
      merged[`${to.node_id}.${to.input_name}`] = promptVal
    }
  }
}
```

This maps the synthetic key to real ComfyUI node overrides (e.g. `65.text`, `238:227.text`).

### Execution

Each combination is submitted to `POST /api/blocks/comfy_gen/run` with merged overrides. Jobs run in parallel with configurable concurrency (1–10, default 5).

## Limits

| Constraint | Value |
|------------|-------|
| Max ideas per generation | 64 |
| Batch confirmation threshold | > 25 combinations |
| Default parallel jobs | 5 |
| OpenRouter timeout | 120s |
| Batch status update throttle | 1000ms |

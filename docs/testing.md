# Testing in BlockFlow

BlockFlow follows strict TDD. This page is the working guide — what to write, how to write it, and what counts as "done."

If you only read one section: **"What 'passing' actually means"** below. That's the bar.

---

## TL;DR

- **Backend (Python):** `pytest`, tests in `tests/`. Run: `uv run pytest tests/`.
- **Frontend logic (TS):** `vitest`, colocated `*.test.ts`. Run: `cd frontend && npm test`.
- **Frontend components (React):** `vitest` + `@testing-library/react` (jsdom), `*.test.tsx`. Run: same as above.
- **No Playwright.** Component tests via RTL cover interaction; visual fidelity stays manual.
- **CI:** `.github/workflows/ci.yml` runs everything on every PR; red blocks merge.

---

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write code before the test? Delete it. Start over. Implementing fresh from a test is the whole point — it's the only way to know the test actually tests what you think.

---

## What "passing" actually means

A green CI is not proof of working software. The test must verify the **behavior produced**, not just that no exception was raised.

### Weak (don't ship)

```python
def test_create_endpoint():
    r = client.post("/api/endpoints", json={"name": "foo"})
    assert r.status_code == 200
```

This only proves the route doesn't crash. No assertion about what was created, where, or with what fields.

### Strong (this is the bar)

```python
def test_create_endpoint_persists_row_and_calls_runpod_once(temp_db, mock_runpod):
    r = client.post("/api/endpoints", json={"name": "foo", "tier": "recommended"})

    # Assert HTTP response shape
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "provisioning"
    assert body["id"].startswith("ep_")

    # Assert state change in the DB
    rows = temp_db.execute("SELECT name, tier FROM endpoints").fetchall()
    assert rows == [("foo", "recommended")]

    # Assert downstream call was made correctly
    mock_runpod.create_endpoint.assert_called_once_with(
        name="foo",
        template_id="blockflow-comfygen-base",
        gpu_ids=["NVIDIA RTX 5090"],
    )
```

Every meaningful side effect is asserted. If any of them is wrong, the test catches it.

---

## Edge cases are mandatory

Every test list must cover:

- Empty / missing input fields (`{}`, missing required field, `null` vs `undefined`)
- Malformed input (wrong type, out of range, oversized strings)
- Network / external-service failures (timeouts, 4xx, 5xx, dropped connection)
- Partial failures (step N succeeds, step N+1 fails — was step N rolled back?)
- Concurrent calls (race two saves, race install + uninstall)
- Boundary values (zero, negative, MAX_INT, empty list, list of 1, very large list)
- Unicode / special chars where text is user input
- Auth failures
- Cancellation mid-operation (`AbortSignal` propagation in the pipeline runtime)

"Forgot to test that" is not an acceptable reason for a v1 bug.

---

## Regression scope analysis

Before writing any test, write the regression scope. It goes in the PR description and shapes the test list.

### Example: changing the R2 client in `lora_train`

**Surface change:** swap `boto3` client construction to read R2 endpoint/creds from Settings instead of hardcoded defaults.

**What else touches this?**

| Surface | What could regress | Required test |
|---|---|---|
| `lora_train` backend route `/run` | Missing Settings → must return 400 with helpful message, not KeyError | POST with empty Settings → expect 400 + message |
| `lora_train` frontend | Must render disabled + banner when Settings missing | RTL: render with no Settings → inputs disabled + banner visible |
| `dataset_create` shares the R2 client code | Same refactor affects it identically | dataset_create's tests must still pass |
| Setup wizard step 3 R2 validation | Uses same boto3 pattern | Wizard R2-validation test continues passing |
| Pipeline runner `execute` fn | If creds are cached at module load, Settings changes don't propagate | Change Settings → invoke execute → new creds used |
| Cancellation mid-upload | `AbortSignal` must still cancel multipart uploads | Trigger cancel → S3 cleanup → no orphaned parts |
| Edge: bucket exists, wrong permissions | Cryptic boto3 exception today | Mock PermissionError → user-friendly error response |
| Edge: malformed endpoint URL | boto3 accepts silently then fails on connect | Settings validation catches it |

That's 8 tests for what looks like a "small mechanical refactor." This is the level of rigor required.

---

## Worked examples

### Backend route test (FastAPI TestClient)

```python
# tests/test_settings_route.py
from __future__ import annotations
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.main import app  # noqa: E402
from backend import settings_store  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "settings.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    return TestClient(app)


def test_save_runpod_key_persists_and_validate_is_called(client, mocker):
    mock_whoami = mocker.patch("backend.runpod_api.whoami", return_value={"id": "u_123"})

    r = client.put("/api/settings/credentials/runpod_api_key", json={"value": "rpa_test"})

    # HTTP response
    assert r.status_code == 200
    assert r.json() == {"saved": True, "validated": True}

    # State persisted
    stored = settings_store.get_credential("runpod_api_key")
    assert stored == "rpa_test"

    # Downstream call
    mock_whoami.assert_called_once_with("rpa_test")
```

### Frontend component test (Vitest + RTL)

```tsx
// frontend/src/components/settings/__tests__/credential-input.test.tsx
import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CredentialInput } from '../credential-input'

describe('CredentialInput', () => {
  test('renders masked by default; toggling Show reveals the value', async () => {
    const user = userEvent.setup()
    render(<CredentialInput label="RunPod API Key" value="rpa_secret" onChange={() => {}} />)

    const input = screen.getByLabelText('RunPod API Key')
    expect(input).toHaveAttribute('type', 'password')

    await user.click(screen.getByRole('button', { name: /show/i }))
    expect(input).toHaveAttribute('type', 'text')
    expect(input).toHaveValue('rpa_secret')
  })

  test('calls onChange with each keystroke', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<CredentialInput label="API Key" value="" onChange={onChange} />)

    await user.type(screen.getByLabelText('API Key'), 'abc')

    expect(onChange).toHaveBeenCalledTimes(3)
    expect(onChange).toHaveBeenLastCalledWith('abc')
  })

  test('Validate button is disabled while validation is in flight', async () => {
    const onValidate = vi.fn(() => new Promise(() => {}))
    const user = userEvent.setup()
    render(<CredentialInput label="API Key" value="x" onChange={() => {}} onValidate={onValidate} />)

    const btn = screen.getByRole('button', { name: /validate/i })
    await user.click(btn)
    expect(btn).toBeDisabled()
  })
})
```

### Mock at the boundary

When the code under test calls a real external service, mock the service — never the logic.

```python
# Good: mocks runpod_api at the boundary; the wizard's logic runs for real
def test_wizard_passes_correct_env_vars_to_template_creation(mocker):
    mock_create_template = mocker.patch("backend.runpod_api.create_template")

    wizard.provision_comfygen(
        runpod_key="rpa_x",
        r2_creds=R2Creds(access="ak", secret="sk", bucket="my-bucket", endpoint="https://x.r2.cloudflarestorage.com"),
        tier="recommended",
    )

    # Assert the wizard built the env-var payload correctly
    call_kwargs = mock_create_template.call_args.kwargs
    assert call_kwargs["env"]["AWS_ACCESS_KEY_ID"] == "ak"
    assert call_kwargs["env"]["AWS_SECRET_ACCESS_KEY"] == "sk"
    assert call_kwargs["env"]["S3_BUCKET"] == "my-bucket"
    assert call_kwargs["env"]["S3_ENDPOINT_URL"] == "https://x.r2.cloudflarestorage.com"
```

```python
# Bad: mocks the wizard's own logic; proves nothing
def test_wizard_mocked():
    mock_provision = mocker.patch("backend.wizard.provision_comfygen")
    wizard.provision_comfygen(...)
    mock_provision.assert_called_once()  # circular!
```

---

## External-resource carve-out

Some tests would require real money or hardware. **Stop and flag before building.**

Examples that trigger the flag:
- Spinning up a real RunPod worker (costs GPU minutes)
- A real `boto3` round-trip to R2 (needs real credentials)
- Actual ComfyUI inference on a real workflow
- Visual fidelity verification ("does this look right")

**Process:**

1. Don't silently skip the test.
2. Don't silently build it as a real-network test.
3. Stop, surface the trade-off, propose a mock at the boundary.
4. Wait for explicit human approval to either (a) build the mocked version, or (b) build the real-resource version with a budget.

The default substitute is a mocked test at the boundary — the real logic still runs end-to-end except for the external call.

---

## Running tests

```bash
# Backend
uv sync --extra dev
uv run pytest tests/                       # all
uv run pytest tests/test_settings_route.py # one file
uv run pytest tests/test_settings_route.py::test_save_runpod_key_persists_and_validate_is_called  # one test

# Frontend
cd frontend
npm test                                   # all (vitest run)
npm run test:watch                         # watch mode
npx vitest run src/components/settings/__tests__/credential-input.test.tsx  # one file

# Forbidden-token gate (the CI gate from sgs-ui-wisp-las.9)
python scripts/check_no_forbidden_tokens.py custom_blocks backend frontend/src
```

---

## When stuck

| Problem | Action |
|---|---|
| Don't know how to test | Write the wished-for API in the test first. The test shapes the design. |
| Test is huge / hard to write | Design is too coupled. Simplify. Hard-to-test = hard-to-use. |
| Need to mock everything | Code is too coupled to externals. Use dependency injection. |
| Test passes immediately | You're testing existing behavior. Fix the test. |
| External resource required | Stop. Flag. Get approval. Don't silently skip. |

---

## Anti-patterns to avoid

- **Tests-after for "the same coverage":** No. Tests-first surface design problems; tests-after only verify what you remembered.
- **Mock the unit under test:** Always mock the boundary, not the logic.
- **Single happy-path test per feature:** Edge cases are required, not optional.
- **Status-code-only assertions:** Assert state changes and downstream calls too.
- **Silent external-resource use:** Flag it. Don't build a test that needs a real API key just to run.

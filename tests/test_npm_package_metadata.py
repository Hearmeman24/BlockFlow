from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_root_package_declares_scoped_public_npx_bin():
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))

    assert package["name"] == "@hearmeman24/blockflow"
    assert package["publishConfig"]["access"] == "public"
    assert package["bin"]["blockflow"] == "bin/blockflow.mjs"
    assert "frontend/.next/standalone/" in package["files"]
    assert "frontend/.next/standalone/node_modules/" in package["files"]
    assert "pyproject.toml" in package["files"]


def test_npx_bin_boots_packaged_app_via_uv_project():
    wrapper = (ROOT / "bin" / "blockflow.mjs").read_text(encoding="utf-8")

    assert "BLOCKFLOW_PACKAGED: '1'" in wrapper
    assert "UV_PROJECT_ENVIRONMENT" in wrapper
    assert "BLOCKFLOW_COMFY_GEN_VENV" in wrapper
    assert "'--project'," in wrapper
    assert "'--no-dev'," in wrapper
    assert "'--packaged'," in wrapper
    assert "https://astral.sh/uv/install.sh" in wrapper
    assert "https://astral.sh/uv/install.ps1" in wrapper


def test_npm_publish_workflow_uses_oidc_trusted_publishing():
    workflow = (ROOT / ".github" / "workflows" / "publish-npm.yml").read_text(encoding="utf-8")

    assert "name: Publish npm package" in workflow
    assert "name: npm" in workflow
    assert "id-token: write" in workflow
    assert "run: npm publish" in workflow


def test_npm_package_smoke_script_exercises_clean_packaged_launch():
    script = (ROOT / "scripts" / "smoke_npm_package.mjs").read_text(encoding="utf-8")

    assert "npm pack --json" in script
    assert "npm exec --yes --package" in script
    assert "npm.cmd" in script
    assert "BLOCKFLOW_HOME" in script
    assert "BLOCKFLOW_NO_OPEN" in script
    assert "comfy-gen" in script
    assert "/api/runs?limit=1" in script


def test_npm_publish_workflow_runs_cross_platform_smoke_before_publish():
    workflow = (ROOT / ".github" / "workflows" / "publish-npm.yml").read_text(encoding="utf-8")

    assert "name: Cross-platform npx smoke" in workflow
    assert "matrix:" in workflow
    assert "macos-latest" in workflow
    assert "ubuntu-latest" in workflow
    assert "windows-latest" in workflow
    assert "node scripts/smoke_npm_package.mjs" in workflow
    assert "needs: npx-smoke" in workflow

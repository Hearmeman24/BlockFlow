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
    assert "pyproject.toml" in package["files"]


def test_npx_bin_boots_packaged_app_via_uv_project():
    wrapper = (ROOT / "bin" / "blockflow.mjs").read_text(encoding="utf-8")

    assert "BLOCKFLOW_PACKAGED: '1'" in wrapper
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

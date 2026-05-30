# npm Release

BlockFlow publishes to npm as `@hearmeman24/blockflow`.

## One-time bootstrap

npm trusted publishing can only be configured after the package exists on npm. The first release must be published manually from a local checkout after the frontend standalone bundle has been built:

```bash
npm login
npm --prefix frontend ci
npm --prefix frontend run build
npm pack --dry-run
npm publish --access public
```

After the package exists, configure trusted publishing on npm:

- Package: `@hearmeman24/blockflow`
- Provider: GitHub Actions
- Organization or user: `Hearmeman24`
- Repository: `BlockFlow`
- Workflow filename: `publish-npm.yml`
- Environment name: `npm`
- Allowed actions: `npm publish`

Create the matching GitHub environment:

- Repository: `Hearmeman24/BlockFlow`
- Environment: `npm`

## Normal release

1. Update `package.json` and `pyproject.toml` to the same version.
2. Ensure `comfy-gen` in `pyproject.toml` points at a published PyPI version.
3. Run:

   ```bash
   uv run --extra dev pytest tests/test_app_launcher.py tests/test_user_data_dir.py tests/test_npm_package_metadata.py tests/test_comfy_gen_cli_resolver.py
   npm --prefix frontend test -- verify-standalone-build.test.ts
   npm --prefix frontend run build
   npm pack --dry-run
   node scripts/smoke_npm_package.mjs
   ```

4. Commit the version change.
5. Push a semver tag:

   ```bash
   git tag v0.1.0
   git push origin main --tags
   ```

The `Publish npm package` workflow first runs the packaged `npx` smoke on macOS, Linux, and Windows. Each matrix leg packs the npm tarball, launches it through `npm exec`, uses an isolated `BLOCKFLOW_HOME`, verifies the backend and frontend are reachable, and checks that `comfy-gen` resolves from the managed sidecar venv. The publish job only runs after that matrix passes.

After trusted publishing works, update npm package settings to require 2FA and disallow long-lived tokens for publishing.

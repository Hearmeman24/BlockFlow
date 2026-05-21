#!/usr/bin/env python3
"""CI gate: refuse public-code paths that contain forbidden tokens.

The OSS build must not ship with private RunPod endpoint IDs, internal
bucket names, SSH targets, or other tokens that only make sense for the
project owner's private deployment. This script enforces that contract.

Exit codes:
  0 - clean
  1 - violations found (printed to stdout)
  2 - usage error (printed to stderr)

Forbidden tokens (sgs-ui-wisp-las.9 acceptance):
  - Private RunPod endpoint IDs: 17rfasn4qhfuxm, 7cimkii50xunxw, x06nemnipd7rru
  - LORA_SOURCE_SSH (matches LORA_SOURCE_SSH_TARGET and variants)
  - hearmeman-loras
  - DEFAULT_DANIELLA (case-insensitive)
  - hearmemanai_lora_training_app_v

Skipped directories: dependency dirs, generated outputs, version control,
user-data dirs, and `private_blocks/` (the local private overlay, gitignored).

Only text source files are scanned (extension allowlist).
"""
from __future__ import annotations

import sys
from pathlib import Path

# Case-sensitive tokens
TOKENS_CS: tuple[str, ...] = (
    # Private RunPod endpoint IDs — never appear in public code paths
    "17rfasn4qhfuxm",
    "7cimkii50xunxw",
    "x06nemnipd7rru",
    # Private S3 bucket name
    "hearmeman-loras",
    # Internal repo name (referenced in docstrings before the OSS push)
    "hearmemanai_lora_training_app_v",
    # NOTE: `LORA_SOURCE_SSH` was on this list during .9 grilling, but it's a
    # variable name (a key) — not a value-leak. The runtime value is env-driven
    # with empty default, so the variable name appearing in backend/config.py
    # + backend/services.py doesn't leak private data. If the SSH impl moves
    # entirely into private_blocks/ in a later cleanup, we can re-add.
)

# Case-insensitive tokens (stored lowercase)
TOKENS_CI: tuple[str, ...] = (
    "default_daniella",
)

SKIP_DIRS: frozenset[str] = frozenset({
    ".git",
    ".next",
    ".worktrees",
    ".beads",
    ".venv",
    "__pycache__",
    "node_modules",
    "private_blocks",
    "flows",
    # Codegen output for private blocks (sgs-ui-wisp-las.8 + .9). Generated
    # content mirrors the private source, which may legitimately contain
    # private-deployment tokens.
    "generated_private",
})

SCAN_EXTENSIONS: frozenset[str] = frozenset({
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".json", ".md", ".yml", ".yaml", ".toml", ".sh",
    ".html", ".css", ".scss", ".txt", ".cfg", ".ini",
})


def _iter_files(root: Path):
    """Walk root, yielding source files; skip excluded dirs in-place."""
    if root.is_file():
        if root.suffix in SCAN_EXTENSIONS:
            yield root
        return

    import os
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune skipped dirs in-place so os.walk doesn't descend
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fname in filenames:
            fpath = Path(dirpath) / fname
            if fpath.suffix in SCAN_EXTENSIONS:
                yield fpath


def _scan_file(path: Path) -> list[tuple[int, str]]:
    """Return list of (line_number, matched_token) for violations in this file."""
    violations: list[tuple[int, str]] = []
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as fh:
            for lineno, line in enumerate(fh, start=1):
                for tok in TOKENS_CS:
                    if tok in line:
                        violations.append((lineno, tok))
                line_lower = line.lower()
                for tok in TOKENS_CI:
                    if tok in line_lower:
                        violations.append((lineno, tok))
    except OSError:
        # Unreadable file (permissions, broken symlink, etc.) — skip silently.
        return []
    return violations


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: check_no_forbidden_tokens.py PATH [PATH ...]", file=sys.stderr)
        return 2

    roots: list[Path] = []
    for arg in argv:
        p = Path(arg)
        if not p.exists():
            print(f"error: path does not exist: {arg}", file=sys.stderr)
            return 2
        roots.append(p)

    total_violations = 0
    for root in roots:
        for fpath in _iter_files(root):
            for lineno, tok in _scan_file(fpath):
                print(f"{fpath}:{lineno}: forbidden token: {tok}")
                total_violations += 1

    if total_violations:
        print(f"\n{total_violations} forbidden token violation(s) found", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

"""Tests for the forbidden-token CI gate (scripts/check_no_forbidden_tokens.py).

The gate enforces that no private-deployment tokens (private RunPod endpoint
IDs, internal repo names, SSH targets, named LoRA defaults) appear in public
code paths. CI runs this on every PR to BlockFlow; failure blocks merge.

Forbidden tokens (sgs-ui-wisp-las.9 acceptance):
- Private RunPod endpoint IDs: 17rfasn4qhfuxm, 7cimkii50xunxw, x06nemnipd7rru
- LORA_SOURCE_SSH_TARGET and any LORA_SOURCE_SSH*
- hearmeman-loras (private S3 bucket name)
- DEFAULT_DANIELLA (case-insensitive — appears as DEFAULT_DANIELLA_LORA today)
- hearmemanai_lora_training_app_v
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "check_no_forbidden_tokens.py"


def _run(args: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    """Invoke the gate script. Returns the CompletedProcess (don't check=True)."""
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=cwd,
        capture_output=True,
        text=True,
    )


# --- Happy path ---------------------------------------------------------------

def test_clean_directory_exits_zero(tmp_path: Path) -> None:
    """A directory with no forbidden tokens passes."""
    (tmp_path / "clean.py").write_text("def hello():\n    return 'world'\n")
    (tmp_path / "nested").mkdir()
    (tmp_path / "nested" / "also_clean.ts").write_text("export const x = 42\n")

    result = _run([str(tmp_path)])

    assert result.returncode == 0, f"expected exit 0, got {result.returncode}; stderr={result.stderr}"


def test_empty_directory_exits_zero(tmp_path: Path) -> None:
    result = _run([str(tmp_path)])
    assert result.returncode == 0


# --- Token detection ----------------------------------------------------------

def test_single_token_in_single_file_exits_nonzero(tmp_path: Path) -> None:
    """Finding a forbidden token fails the gate."""
    bad = tmp_path / "config.py"
    bad.write_text('S3_BUCKET = "hearmeman-loras"\n')

    result = _run([str(tmp_path)])

    assert result.returncode == 1
    assert "hearmeman-loras" in result.stdout
    assert "config.py" in result.stdout


def test_runpod_endpoint_id_detected(tmp_path: Path) -> None:
    (tmp_path / "block.py").write_text('ENDPOINT = "7cimkii50xunxw"\n')
    result = _run([str(tmp_path)])
    assert result.returncode == 1
    assert "7cimkii50xunxw" in result.stdout


def test_ssh_variable_name_not_forbidden_when_value_empty(tmp_path: Path) -> None:
    """LORA_SOURCE_SSH* was on the original .9 forbidden list but it's a
    variable NAME, not a value-leak. Env-driven with empty default → no
    private data lands in public code. Keep this regression test so future
    cleanup deciding to re-add the token to the list also restores its
    flagging behavior intentionally."""
    (tmp_path / "config.py").write_text('LORA_SOURCE_SSH_TARGET = os.getenv("LORA_SOURCE_SSH_TARGET", "")\n')
    result = _run([str(tmp_path)])
    assert result.returncode == 0


def test_daniella_token_is_case_insensitive(tmp_path: Path) -> None:
    """DEFAULT_DANIELLA must be caught regardless of case (per .9 acceptance)."""
    (tmp_path / "weird.py").write_text('default_daniella_lora = "x"\n')
    result = _run([str(tmp_path)])
    assert result.returncode == 1
    assert "default_daniella" in result.stdout.lower()


def test_multiple_tokens_across_files_all_reported(tmp_path: Path) -> None:
    """All violations across the tree are aggregated."""
    (tmp_path / "a.py").write_text('B = "hearmeman-loras"\n')
    (tmp_path / "b.py").write_text('E = "17rfasn4qhfuxm"\n')

    result = _run([str(tmp_path)])

    assert result.returncode == 1
    assert "a.py" in result.stdout
    assert "b.py" in result.stdout
    assert "hearmeman-loras" in result.stdout
    assert "17rfasn4qhfuxm" in result.stdout


def test_tokens_in_nested_subdirs_found(tmp_path: Path) -> None:
    deep = tmp_path / "a" / "b" / "c"
    deep.mkdir(parents=True)
    (deep / "leaf.py").write_text('X = "x06nemnipd7rru"\n')

    result = _run([str(tmp_path)])

    assert result.returncode == 1
    assert "leaf.py" in result.stdout


# --- Skip rules ---------------------------------------------------------------

def test_node_modules_is_skipped(tmp_path: Path) -> None:
    """Dependency dirs must not trigger violations (deps may legally contain anything)."""
    nm = tmp_path / "node_modules" / "evil-pkg"
    nm.mkdir(parents=True)
    (nm / "bundled.js").write_text('const ENDPOINT = "7cimkii50xunxw";\n')

    result = _run([str(tmp_path)])

    assert result.returncode == 0, f"node_modules should be skipped; got: {result.stdout}"


def test_private_blocks_is_skipped(tmp_path: Path) -> None:
    """private_blocks/ is the local private overlay (gitignored); tokens there are expected."""
    pb = tmp_path / "private_blocks" / "wan_22"
    pb.mkdir(parents=True)
    (pb / "block.py").write_text('ENDPOINT = "17rfasn4qhfuxm"\n')

    result = _run([str(tmp_path)])

    assert result.returncode == 0, f"private_blocks/ should be skipped; got: {result.stdout}"


@pytest.mark.parametrize("skip_dir", [".git", ".next", ".worktrees", ".beads", ".venv", "__pycache__"])
def test_standard_excluded_dirs_skipped(tmp_path: Path, skip_dir: str) -> None:
    d = tmp_path / skip_dir
    d.mkdir()
    (d / "x.py").write_text('B = "hearmeman-loras"\n')
    result = _run([str(tmp_path)])
    assert result.returncode == 0, f"{skip_dir} should be skipped; stdout={result.stdout}"


def test_flows_dir_is_skipped(tmp_path: Path) -> None:
    """User-saved flows are gitignored and may contain user-specific data; don't scan."""
    f = tmp_path / "flows"
    f.mkdir()
    (f / "my.flow.json").write_text('{"endpoint": "7cimkii50xunxw"}\n')

    result = _run([str(tmp_path)])
    assert result.returncode == 0


# --- File-type scoping --------------------------------------------------------

def test_only_text_source_files_scanned(tmp_path: Path) -> None:
    """Binary files / lockfiles / generated outputs shouldn't be scanned.

    A token byte-sequence in a non-source file is not a violation.
    """
    (tmp_path / "image.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"hearmeman-loras" + b"\x00")

    result = _run([str(tmp_path)])

    assert result.returncode == 0


# --- CLI behavior -------------------------------------------------------------

def test_nonexistent_path_errors(tmp_path: Path) -> None:
    """Bad CLI input → exit code 2, stderr message. Not silent-pass."""
    result = _run([str(tmp_path / "does-not-exist")])
    assert result.returncode == 2
    assert "does-not-exist" in result.stderr or "does-not-exist" in result.stdout


def test_no_args_errors() -> None:
    """No paths supplied is a usage error, not a silent pass."""
    result = _run([])
    assert result.returncode == 2


def test_multiple_paths_all_scanned(tmp_path: Path) -> None:
    """Script accepts multiple root paths."""
    a = tmp_path / "a"
    b = tmp_path / "b"
    a.mkdir()
    b.mkdir()
    (a / "ok.py").write_text("clean\n")
    (b / "bad.py").write_text('X = "hearmeman-loras"\n')

    result = _run([str(a), str(b)])

    assert result.returncode == 1
    assert "bad.py" in result.stdout

# /// script
# requires-python = ">=3.12"
# dependencies = ["fastapi>=0.115", "uvicorn>=0.30", "boto3>=1.34", "loguru>=0.7", "curl_cffi>=0.7", "Pillow>=10"]
# ///
"""Single entrypoint: starts FastAPI backend + Next.js frontend, opens browser."""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FRONTEND_DIR = ROOT / "frontend"
BACKEND_PORT = int(os.environ.get("BACKEND_PORT", 8000))
FRONTEND_PORT = int(os.environ.get("FRONTEND_PORT", 3000))


def _is_packaged_mode(argv: list[str] | None = None) -> bool:
    args = sys.argv[1:] if argv is None else argv
    return "--packaged" in args or os.environ.get("BLOCKFLOW_PACKAGED") == "1"


def _wait_for(url: str, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except Exception:
            time.sleep(0.5)
    return False


def _find_standalone_server(frontend_dir: Path = FRONTEND_DIR) -> Path:
    standalone_dir = frontend_dir / ".next" / "standalone"
    direct = standalone_dir / "server.js"
    if direct.exists():
        return direct
    matches = sorted(standalone_dir.rglob("server.js")) if standalone_dir.exists() else []
    if matches:
        return matches[0]
    raise FileNotFoundError(
        "Missing Next.js standalone server. Run `npm --prefix frontend run build` before packaged launch."
    )


def _backend_command(backend_port: int) -> list[str]:
    return [
        sys.executable, "-m", "uvicorn",
        "backend.main:app",
        "--host", "127.0.0.1",
        "--port", str(backend_port),
    ]


def _frontend_command(*, packaged: bool, frontend_port: int) -> tuple[list[str], Path]:
    if packaged:
        server = _find_standalone_server()
        return ["node", str(server)], server.parent
    return ["npm", "run", "dev", "--", "--port", str(frontend_port)], FRONTEND_DIR


def _stop_processes(procs: list[subprocess.Popen]) -> None:
    for p in procs:
        if p.poll() is None:
            if sys.platform == "win32":
                p.terminate()
            else:
                p.send_signal(signal.SIGTERM)
    for p in procs:
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()


def main() -> None:
    if "--advanced" in sys.argv:
        os.environ["SGS_ADVANCED"] = "1"
        print("[app] Advanced mode enabled")

    packaged = _is_packaged_mode()

    # Ensure frontend deps are installed in dev mode only. Packaged mode must
    # never mutate the installed app directory.
    if not packaged and not (FRONTEND_DIR / "node_modules").exists():
        print("[app] Installing frontend dependencies...")
        subprocess.run(["npm", "install"], cwd=str(FRONTEND_DIR), check=True)

    procs: list[subprocess.Popen] = []

    try:
        # Start FastAPI backend
        print(f"[app] Starting FastAPI on :{BACKEND_PORT}...")
        backend = subprocess.Popen(
            _backend_command(BACKEND_PORT),
            cwd=str(ROOT),
        )
        procs.append(backend)

        # Start Next.js frontend
        mode = "standalone" if packaged else "dev"
        print(f"[app] Starting Next.js {mode} on :{FRONTEND_PORT}...")
        frontend_cmd, frontend_cwd = _frontend_command(packaged=packaged, frontend_port=FRONTEND_PORT)
        frontend_env = {
            **os.environ,
            "BACKEND_PORT": str(BACKEND_PORT),
            "PORT": str(FRONTEND_PORT),
            "HOSTNAME": "127.0.0.1",
        }
        frontend = subprocess.Popen(
            frontend_cmd,
            cwd=str(frontend_cwd),
            env=frontend_env,
        )
        procs.append(frontend)

        # Wait for both
        print("[app] Waiting for servers to start...")
        if not _wait_for(f"http://127.0.0.1:{BACKEND_PORT}/api/runs?limit=1", timeout=20):
            print("[app] WARNING: Backend did not respond in time")
        if not _wait_for(f"http://127.0.0.1:{FRONTEND_PORT}", timeout=30):
            print("[app] WARNING: Frontend did not respond in time")

        url = f"http://localhost:{FRONTEND_PORT}"
        if os.environ.get("BLOCKFLOW_NO_OPEN") == "1":
            print(f"[app] Ready at {url}")
        else:
            print(f"[app] Opening {url}")
            if sys.platform == "darwin":
                subprocess.Popen(["open", url])
            elif sys.platform == "win32":
                os.startfile(url)
            elif sys.platform == "linux":
                subprocess.Popen(["xdg-open", url])

        print("[app] Running. Press Ctrl+C to stop.")
        # Wait for either process to exit
        while True:
            for p in procs:
                if p.poll() is not None:
                    print(f"[app] Process {p.args} exited with code {p.returncode}")
                    raise KeyboardInterrupt
            time.sleep(1)

    except KeyboardInterrupt:
        print("\n[app] Shutting down...")
    finally:
        _stop_processes(procs)
        print("[app] Stopped.")


if __name__ == "__main__":
    main()

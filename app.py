# /// script
# requires-python = ">=3.12"
# dependencies = ["fastapi>=0.115", "uvicorn>=0.30", "boto3>=1.34", "loguru>=0.7"]
# ///
"""Single entrypoint: starts FastAPI backend + Next.js frontend, opens browser."""
from __future__ import annotations

import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FRONTEND_DIR = ROOT / "frontend"
BACKEND_PORT = int(os.environ.get("BACKEND_PORT", 8000))
FRONTEND_PORT = int(os.environ.get("FRONTEND_PORT", 3000))


def _wait_for(url: str, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except Exception:
            time.sleep(0.5)
    return False


def main() -> None:
    if "--advanced" in sys.argv:
        os.environ["SGS_ADVANCED"] = "1"
        print("[app] Advanced mode enabled")

    # Ensure frontend deps are installed
    if not (FRONTEND_DIR / "node_modules").exists():
        print("[app] Installing frontend dependencies...")
        subprocess.run(["npm", "install"], cwd=str(FRONTEND_DIR), check=True)

    procs: list[subprocess.Popen] = []

    try:
        # Start FastAPI backend
        print(f"[app] Starting FastAPI on :{BACKEND_PORT}...")
        backend = subprocess.Popen(
            [
                sys.executable, "-m", "uvicorn",
                "backend.main:app",
                "--host", "127.0.0.1",
                "--port", str(BACKEND_PORT),
            ],
            cwd=str(ROOT),
        )
        procs.append(backend)

        # Start Next.js dev server
        print(f"[app] Starting Next.js on :{FRONTEND_PORT}...")
        frontend_env = {**os.environ, "BACKEND_PORT": str(BACKEND_PORT)}
        frontend = subprocess.Popen(
            ["npm", "run", "dev", "--", "--port", str(FRONTEND_PORT)],
            cwd=str(FRONTEND_DIR),
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
        for p in procs:
            if p.poll() is None:
                p.terminate()
        for p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        print("[app] Stopped.")


if __name__ == "__main__":
    main()

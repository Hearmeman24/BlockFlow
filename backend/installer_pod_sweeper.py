"""sgs-ui-c7n: installer-pod sweeper.

Defense in depth on top of sgs-ui-8ww. Pods do not self-clean — BlockFlow
calls `delete_pod_post_install` on both the success and failure paths of
`_run_install_subprocess` (sgs-ui-515 made the failure branches symmetric).
The sweeper catches the cases where BlockFlow can't run that cleanup at
all: the BlockFlow backend gets SIGKILL'd, the user force-closes the
browser, the subprocess hangs, or the DELETE itself racey-fails. A pod we
forget about bills $0.06/hr until somebody notices.

The sweeper runs every `INSTALLER_SWEEP_INTERVAL_SEC` seconds (default 60),
lists every pod the configured RunPod API key can see, filters to those
whose name starts with `INSTALLER_POD_NAME_PREFIX` (default
`comfygen-installer`), and decides per pod:

  - Rule A — pod is tracked AND the install finished (settings_installed_presets
    has a matching row): DELETE immediately.
  - Rule B — pod is untracked (neither in-memory nor in settings) AND older
    than INSTALLER_SWEEP_ORPHAN_MIN minutes (default 5): DELETE.
  - Rule C — pod is tracked AND currently in-flight AND older than
    INSTALLER_SWEEP_STUCK_MIN minutes (default 60): DELETE + flip the
    in-memory install state to 'error'.

DELETE failures bubble up as exceptions per pod but the loop continues —
one bad pod must not poison the whole sweep.
"""
from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from backend import preset_routes, runpod_api, settings_store

INSTALLER_POD_NAME_PREFIX = os.environ.get(
    "INSTALLER_POD_NAME_PREFIX", "comfygen-installer"
)
SWEEP_INTERVAL_SEC = int(os.environ.get("INSTALLER_SWEEP_INTERVAL_SEC", "60"))
ORPHAN_MIN = int(os.environ.get("INSTALLER_SWEEP_ORPHAN_MIN", "5"))
STUCK_MIN = int(os.environ.get("INSTALLER_SWEEP_STUCK_MIN", "60"))


@dataclass
class SweepReport:
    scanned_at: datetime
    deleted: list[dict[str, Any]] = field(default_factory=list)
    skipped: list[dict[str, Any]] = field(default_factory=list)
    errors: list[dict[str, Any]] = field(default_factory=list)


def _parse_created_at(raw: str | None) -> datetime | None:
    """RunPod returns pod timestamps in Go's default `time.String()` format
    — e.g. '2026-05-24 09:18:12.662 +0000 UTC'. Older accounts / different
    endpoints sometimes return RFC3339 ('2026-05-24T07:43:16Z') so we try
    both. Returns None on missing / unparseable input so the sweeper
    treats the pod as 'unknown age' and skips (defensive: never DELETE on
    bad input)."""
    if not raw:
        return None
    s = raw.strip()
    # Format 1: RFC3339, with optional trailing Z.
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        pass
    # Format 2: Go's time.String() — '2026-05-24 09:18:12.662 +0000 UTC'.
    # Drop the trailing ' UTC' marker (the offset already carries the tz).
    if s.endswith(" UTC"):
        s = s[:-4]
    try:
        return datetime.strptime(s, "%Y-%m-%d %H:%M:%S.%f %z")
    except ValueError:
        pass
    try:
        return datetime.strptime(s, "%Y-%m-%d %H:%M:%S %z")
    except ValueError:
        return None


def _decide(
    pod: dict[str, Any],
    *,
    now: datetime,
    completed_row: dict | None,
    is_active: bool,
    active_state: str | None,
    orphan_min: int = ORPHAN_MIN,
    stuck_min: int = STUCK_MIN,
) -> tuple[str, str]:
    """Pure decision function — returns ('delete', reason) or ('skip', reason).

    Inputs:
      - pod: RunPod pod object (needs `id`, `name`, `createdAt`)
      - now: current UTC time
      - completed_row: settings_installed_presets row matching pod.id, or None
      - is_active: True iff this pod is the in-process `_install_state['pod_id']`
      - active_state: the live `_install_state['state']` if `is_active` else None

    Tested table-driven in tests/test_installer_pod_sweeper.py.
    """
    pod_id = pod.get("id") or "?"
    created = _parse_created_at(pod.get("createdAt"))
    if created is None:
        return ("skip", f"unparseable createdAt for {pod_id}")
    age = now - created

    # Rule A — install row exists → install finished; DELETE.
    if completed_row is not None:
        return ("delete", "install_completed")

    # Rule C — actively running but older than the stuck threshold.
    if is_active and active_state in ("queued", "running", "cancelling"):
        if age > timedelta(minutes=stuck_min):
            return ("delete", "install_stuck")
        return ("skip", f"active install age {age.total_seconds()/60:.1f}m")

    # Rule B — untracked + old enough.
    if not is_active and completed_row is None and age > timedelta(minutes=orphan_min):
        return ("delete", "orphan_age_exceeded")

    return ("skip", f"untracked age {age.total_seconds()/60:.1f}m below threshold")


def sweep_once(*, now: datetime | None = None) -> SweepReport:
    """Run one sweep pass. Safe to call manually (e.g. from a test or a
    `POST /api/admin/sweep` route)."""
    now = now or datetime.now(timezone.utc)
    report = SweepReport(scanned_at=now)

    api_key = settings_store.get_credential("runpod_api_key")
    if not api_key:
        report.errors.append({"scope": "config", "error": "runpod_api_key not configured"})
        return report

    try:
        all_pods = runpod_api.list_pods(api_key)
    except runpod_api.RunPodAPIError as exc:
        report.errors.append({"scope": "list_pods", "error": str(exc)})
        return report

    candidates = [
        p for p in all_pods
        if (p.get("name") or "").startswith(INSTALLER_POD_NAME_PREFIX)
    ]

    active_pod_id = preset_routes._install_state.get("pod_id")
    active_state = preset_routes._install_state.get("state")

    for pod in candidates:
        pod_id = pod.get("id")
        if not pod_id:
            continue
        completed_row = settings_store.get_installed_preset_by_pod_id(pod_id)
        is_active = (pod_id == active_pod_id)

        # Re-read the module-level thresholds at call time so tests can
        # monkey-patch them; binding to _decide's defaults would freeze the
        # values at function-definition time.
        decision, reason = _decide(
            pod, now=now,
            completed_row=completed_row,
            is_active=is_active,
            active_state=active_state if is_active else None,
            orphan_min=ORPHAN_MIN,
            stuck_min=STUCK_MIN,
        )

        if decision == "delete":
            try:
                runpod_api.delete_pod(api_key, pod_id)
                report.deleted.append({"pod_id": pod_id, "reason": reason})
                if reason == "install_stuck" and is_active:
                    # Flip in-memory state so the UI surfaces failure and
                    # the next install can start.
                    preset_routes._install_state.update({
                        "state": "error",
                        "completed_at": now.isoformat(timespec="seconds"),
                        "error": (
                            f"installer-pod sweeper killed stuck install after "
                            f"{STUCK_MIN}m"
                        ),
                    })
            except runpod_api.RunPodAPIError as exc:
                report.errors.append({"pod_id": pod_id, "error": str(exc)})
        else:
            report.skipped.append({"pod_id": pod_id, "reason": reason})

    return report


def sweeper_loop(
    *,
    interval_sec: int = SWEEP_INTERVAL_SEC,
    stop_event: threading.Event | None = None,
) -> None:
    """Run sweep_once() forever. Catch + log exceptions per iteration so
    one bad sweep doesn't kill the loop."""
    while True:
        if stop_event is not None and stop_event.is_set():
            return
        try:
            report = sweep_once()
            if report.deleted:
                names = ", ".join(
                    f"{d['pod_id']}({d['reason']})" for d in report.deleted
                )
                print(f"[installer-pod-sweeper] deleted {len(report.deleted)} pod(s): {names}")
            if report.errors:
                print(f"[installer-pod-sweeper] errors: {report.errors}")
        except Exception as exc:
            print(f"[installer-pod-sweeper] iteration crashed: {exc}")
        if stop_event is not None:
            if stop_event.wait(timeout=interval_sec):
                return
        else:
            time.sleep(interval_sec)


def start_in_background() -> threading.Thread:
    """Spawn the sweeper as a daemon thread. Returns the thread so callers
    can join in tests."""
    t = threading.Thread(target=sweeper_loop, daemon=True, name="installer-pod-sweeper")
    t.start()
    return t


def delete_pod_post_install(pod_id: str | None) -> bool:
    """sgs-ui-c7n trigger #2: called from _run_install_subprocess at every
    terminal state — success (install_done.ok=true), failure (preflight_fail,
    install_error, no-terminal-event), and outer exception. Pods do not
    self-clean; this is the primary cleanup, the sweeper is the backstop.
    Idempotent (404 = success in `delete_pod`).

    Returns True on success/404, False if no api_key or pod_id, or on error.
    """
    if not pod_id:
        return False
    api_key = settings_store.get_credential("runpod_api_key")
    if not api_key:
        return False
    try:
        return runpod_api.delete_pod(api_key, pod_id)
    except runpod_api.RunPodAPIError as exc:
        print(f"[installer-pod-sweeper] post-install delete of {pod_id} failed: {exc}")
        return False

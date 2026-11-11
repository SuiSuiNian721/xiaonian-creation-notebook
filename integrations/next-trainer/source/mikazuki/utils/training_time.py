"""Runtime estimates from training progress; no GPU work or historical guesses."""

from __future__ import annotations

import math
import re
import time

_STEPS = re.compile(r"steps:\s*\d+%\|[^|]*\|\s*(\d+)/(\d+)\s*\[([^]]+)\]", re.I)
_RATE = re.compile(r"([\d.]+)\s*(it/s|s/it)\b")
_TERMINAL = {"FINISHED", "FAILED", "TERMINATED", "CANCELLED"}


def _number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if math.isfinite(result) and result >= 0 else None


def _duration(value: str) -> float | None:
    parts = value.strip().split(":")
    if len(parts) not in (2, 3) or not all(re.fullmatch(r"\d+(?:\.\d+)?", p) for p in parts):
        return None
    values = [float(p) for p in parts]
    if values[-1] >= 60 or (len(values) == 3 and values[-2] >= 60):
        return None
    result = sum(n * 60 ** i for i, n in enumerate(reversed(values)))
    return _number(result)


def read_step_timing(line: str) -> dict | None:
    """Read only training steps, never cache/sample progress bars."""
    match = _STEPS.search(line)
    if not match:
        return None
    step, total = int(match[1]), int(match[2])
    if total <= 0 or step > total:
        return None
    clock = match[3].split(",", 1)[0].partition("<")
    elapsed, eta = _duration(clock[0]), _duration(clock[2])
    rate = _RATE.search(match[3])
    speed = _number(rate[1]) if rate else None
    seconds_per_step = (1 / speed if rate[2] == "it/s" else speed) if speed else None
    if eta is None and seconds_per_step and step > 0:
        eta = (total - step) * seconds_per_step
    if step == total:
        eta = 0
    return {
        "step": step,
        "total_steps": total,
        "training_elapsed_seconds": elapsed,
        "eta_seconds": eta,
        "seconds_per_step": seconds_per_step,
    }


def build_task_timing(metadata: dict, status: str, sample: dict | None, *, now: float | None = None) -> dict:
    """Freeze terminal durations and expire estimates when progress goes quiet."""
    now = time.time() if now is None else now
    started = _number(metadata.get("started_at"))
    finished = _number(metadata.get("finished_at"))
    terminal = status in _TERMINAL
    end = finished if terminal else now
    elapsed = max(0, end - started) if started and end is not None else None
    result = {
        "state": status.lower() if terminal else "warming_up",
        "elapsed_seconds": elapsed,
        "remaining_seconds": None,
        "estimated_finish_at": None,
        "observed_at": None,
        "stale_after_seconds": None,
        "seconds_per_step": None,
    }
    if terminal:
        return result
    if status != "RUNNING":
        result.update(state="pending", elapsed_seconds=None)
        return result
    if not sample:
        return result
    observed = _number(sample.get("observed_at"))
    eta = _number(sample.get("eta_seconds"))
    speed = _number(sample.get("seconds_per_step"))
    result.update(observed_at=observed, seconds_per_step=speed)
    if sample.get("total_steps", 0) > 0 and sample.get("step", 0) >= sample["total_steps"]:
        result["state"] = "finishing"
        return result
    if observed is None or eta is None or sample.get("step", 0) <= 0:
        return result
    stale_after = max(90, 5 * (speed or 0))
    finish_at = observed + eta
    result["stale_after_seconds"] = stale_after
    if now - observed >= stale_after or now >= finish_at:
        result["state"] = "stale"
        return result
    result.update(state="estimating", remaining_seconds=finish_at - now, estimated_finish_at=finish_at)
    return result

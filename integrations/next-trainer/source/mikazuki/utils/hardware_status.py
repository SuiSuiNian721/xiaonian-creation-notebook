"""Read-only host telemetry, independent of Torch and training engines."""

from __future__ import annotations

import copy
import math
import threading
import time

import psutil


def _optional(call):
    try:
        return call()
    except Exception:
        return None


def _read_gpu_memory(nvml, handle):
    # NVML v2 separates driver-reserved memory from application memory usage.
    memory = _optional(lambda: nvml.nvmlDeviceGetMemoryInfo(handle, version=nvml.nvmlMemory_v2))
    return memory if memory is not None else _optional(lambda: nvml.nvmlDeviceGetMemoryInfo(handle))


def read_gpus() -> list[dict]:
    try:
        import pynvml
        pynvml.nvmlInit()
    except Exception:
        return []
    try:
        gpus = []
        for index in range(pynvml.nvmlDeviceGetCount()):
            handle = pynvml.nvmlDeviceGetHandleByIndex(index)
            name = pynvml.nvmlDeviceGetName(handle)
            memory = _read_gpu_memory(pynvml, handle)
            utilization = _optional(lambda: pynvml.nvmlDeviceGetUtilizationRates(handle))
            gpus.append({
                "index": index,
                "name": name.decode("utf-8", "replace") if isinstance(name, bytes) else str(name),
                "utilization_percent": utilization.gpu if utilization is not None else None,
                "temperature_c": _optional(lambda: pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)),
                "power_w": _optional(lambda: round(pynvml.nvmlDeviceGetPowerUsage(handle) / 1000, 1)),
                "power_limit_w": _optional(lambda: round(pynvml.nvmlDeviceGetEnforcedPowerLimit(handle) / 1000, 1)),
                "memory": {"used_bytes": memory.used, "total_bytes": memory.total,
                           "percent": round(memory.used / memory.total * 100, 1)} if memory and memory.total else None,
            })
        return gpus
    except Exception:
        return []
    finally:
        _optional(pynvml.nvmlShutdown)


class HardwareSampler:
    def __init__(self):
        self._lock = threading.Lock()
        self._cached = None
        self._sampled = -math.inf

    def snapshot(self) -> dict:
        with self._lock:
            now = time.monotonic()
            if self._cached is not None and now - self._sampled < 3:
                return copy.deepcopy(self._cached)
            memory = psutil.virtual_memory()
            used = memory.total - memory.available
            snapshot = {
                "scope": "system",
                "cpu": {"percent": psutil.cpu_percent(interval=0.1)},
                "memory": {"used_bytes": used, "total_bytes": memory.total, "percent": round(used / memory.total * 100, 1)},
                "gpus": read_gpus(),
                "sampled_at": time.time(),
            }
            self._sampled, self._cached = time.monotonic(), snapshot
            return copy.deepcopy(snapshot)


sampler = HardwareSampler()

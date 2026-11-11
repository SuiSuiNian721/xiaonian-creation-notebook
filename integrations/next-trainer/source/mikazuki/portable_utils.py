# -*- coding: utf-8 -*-
"""Helpers for Windows portable (embedded) Python — flash-attn/triton compatibility."""

from __future__ import annotations

import subprocess
import sys
from typing import Callable, Dict, Optional


def is_embedded_python(executable: Optional[str] = None) -> bool:
    exe = (executable or sys.executable).replace("\\", "/").lower()
    return "python_embeded" in exe or "python_embedded" in exe


def flash_attn_stack_usable() -> bool:
    """True when flash-attn and its triton ops import cleanly in the current interpreter."""
    try:
        import triton  # noqa: F401
        import flash_attn  # noqa: F401
        from flash_attn.ops.triton.rotary import apply_rotary  # noqa: F401
        return True
    except Exception:
        return False


def sanitize_embedded_deps(log: Optional[Callable[[str], None]] = None) -> None:
    """Remove flash-attn / triton from embedded Python if the stack cannot run."""
    if not is_embedded_python():
        return

    import importlib.util

    has_flash = importlib.util.find_spec("flash_attn") is not None
    has_triton = importlib.util.find_spec("triton") is not None
    if not has_flash and not has_triton:
        return
    if has_flash and flash_attn_stack_usable():
        return

    msg = (
        "Portable package: removing incompatible flash-attn/triton "
        "(training will use xformers or PyTorch SDPA)."
    )
    if log:
        log(msg)
    else:
        print(msg)

    subprocess.run(
        [
            sys.executable,
            "-s",
            "-m",
            "pip",
            "uninstall",
            "flash-attn",
            "flash_attn",
            "triton-windows",
            "triton",
            "-y",
        ],
        capture_output=True,
        timeout=120,
    )


def train_env_overrides() -> Dict[str, str]:
    """Environment for training subprocesses on embedded Python."""
    if not is_embedded_python():
        return {}

    overrides: Dict[str, str] = {"XFORMERS_FORCE_DISABLE_TRITON": "1"}
    if not flash_attn_stack_usable():
        overrides["TRANSFORMERS_ATTN_IMPLEMENTATION"] = "sdpa"
    return overrides

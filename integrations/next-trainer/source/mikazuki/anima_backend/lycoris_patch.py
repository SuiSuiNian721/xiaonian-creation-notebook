from __future__ import annotations

import importlib
import importlib.metadata
import logging

import torch


log = logging.getLogger(__name__)


def _lycoris_lora_version() -> str | None:
    try:
        return importlib.metadata.version("lycoris-lora")
    except importlib.metadata.PackageNotFoundError:
        return None


def _patched_lokr_forward(self, x: torch.Tensor, *args, **kwargs):
    if self.module_dropout and self.training:
        if torch.rand(1, device=x.device) < self.module_dropout:
            return self.org_forward(x, *args, **kwargs)

    if self.bypass_mode:
        return self.bypass_forward(x, self.multiplier)

    base = self.org_forward(x, *args, **kwargs)
    base_weight = self._current_weight().to(x.device)
    diff_weight = self.get_weight(self.shape).to(base_weight.dtype) * self.scalar

    if self.wd:
        new_weight = self.apply_weight_decompose(
            base_weight + diff_weight, self.multiplier
        )
    elif self.multiplier == 1:
        new_weight = base_weight + diff_weight
    else:
        new_weight = base_weight + diff_weight * self.multiplier

    delta_weight = new_weight - base_weight
    if x.is_floating_point() and delta_weight.dtype != x.dtype:
        delta_weight = delta_weight.to(device=x.device, dtype=x.dtype)
    else:
        delta_weight = delta_weight.to(device=x.device)
    delta = self.op(x, delta_weight, None, **self.kw_dict)
    return base + delta


def patch_lokr_dora_bf16_forward() -> bool:
    """Patch LyCORIS 3.3 LoKr DoRA delta-weight dtype mismatch (#161)."""

    version = _lycoris_lora_version()
    if version != "3.3.0":
        return False

    try:
        lokr = importlib.import_module("lycoris.modules.lokr")
    except Exception as exc:
        log.warning("Could not import LyCORIS LoKr for dtype patch: %s", exc)
        return False

    module_cls = getattr(lokr, "LokrModule", None)
    if module_cls is None or getattr(module_cls, "_sd_trainer_lokr_dora_bf16_patch", False):
        return False

    module_cls.forward = _patched_lokr_forward
    module_cls._sd_trainer_lokr_dora_bf16_patch = True
    log.info("Applied LyCORIS 3.3 LoKr DoRA bf16 dtype patch.")
    return True

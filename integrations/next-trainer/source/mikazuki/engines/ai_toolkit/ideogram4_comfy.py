"""Comfy-Org Ideogram 4 single files -> the pinned extension's state-dict contract.

The upstream Ideogram 4 extension (`extensions_built_in/diffusion_models/ideogram4`)
only reads a diffusers-style directory (`<base>/<subfolder>/diffusion_pytorch_model*`)
and has no comfy weight candidates registered, so `use_comfy_weights` does not
apply. Two shapes of the Comfy-Org files differ from what its (otherwise
unchanged) loaders expect:

* the conditional DiT stores weight-only FP8 with a 0-dim per-tensor
  ``<name>.weight_scale`` plus one ``<name>.comfy_quant`` marker per linear,
  while ``_dequantize_fp8_state_dict`` folds ``w * scale.unsqueeze(1)`` and
  needs a per-output-channel ``[out]`` scale; the markers are runtime hints the
  dequantizer must not see;
* the Flux2 VAE is already in the original (LDM) key layout the toolkit's
  ``AutoEncoder`` uses, while ``convert_diffusers_state_dict`` only accepts the
  diffusers layout.

Everything here runs in memory inside the training process (driver.py): the
user's Comfy files stay untouched and no diffusers copy is ever written to disk.
"""

from __future__ import annotations

from pathlib import Path

FP8_SCALE_SUFFIX = ".weight_scale"
WEIGHT_SUFFIX = ".weight"
COMFY_QUANT_SUFFIX = ".comfy_quant"


def is_comfy_marker(key: str) -> bool:
    """``<name>.comfy_quant`` uint8 JSON blobs are load-time hints, not weights."""
    return key.endswith(COMFY_QUANT_SUFFIX)


def scale_target_shape(scale_shape: tuple, weight_shape: tuple | None) -> tuple:
    """Normalize a stored FP8 scale shape to the 1-D ``[out]`` form.

    The extension folds ``weight_fp8 * scale.unsqueeze(1)``, so per-tensor
    scalar scales must be widened to the output channel count and stray
    ``[out, 1]`` / ``[1, out]`` shapes squeezed."""
    flat = tuple(dim for dim in scale_shape if dim != 1)
    if not flat:
        if not weight_shape:
            raise ValueError("weight_scale 没有可推断的输出维度")
        return (int(weight_shape[0]),)
    if len(flat) != 1:
        raise ValueError(f"不支持的 weight_scale 形状: {tuple(scale_shape)}")
    return (int(flat[0]),)


def normalize_scale_tensor(tensor, weight_shape: tuple | None):
    """Widen a stored scale to ``[out]`` (a broadcast view is fine for loading)."""
    target = scale_target_shape(tuple(tensor.shape), weight_shape)
    if tensor.numel() == 1:
        return tensor.reshape(1).expand(target)
    return tensor.reshape(target)


def normalize_dit_state_dict(state_dict: dict) -> dict:
    """Drop Comfy quant markers and normalize FP8 scale shapes in place (copy)."""
    out = {}
    for key, value in state_dict.items():
        if is_comfy_marker(key):
            continue
        if key.endswith(FP8_SCALE_SUFFIX):
            weight_key = key[: -len(FP8_SCALE_SUFFIX)] + WEIGHT_SUFFIX
            weight = state_dict.get(weight_key)
            out[key] = normalize_scale_tensor(value, tuple(weight.shape) if weight is not None else None)
            continue
        out[key] = value
    return out


def is_original_vae_state_dict(state_dict: dict) -> bool:
    """True for the original Flux2/LDM key layout Comfy ships (no ``mid_block``)."""
    return any(".mid.attn_1." in key for key in state_dict)


def comfy_component_state_dict(path, subfolder: str) -> dict:
    """Read one Comfy single file as the state dict the extension expects."""
    from safetensors.torch import load_file

    state_dict = load_file(str(Path(path)))
    if subfolder == "transformer":
        return normalize_dit_state_dict(state_dict)
    return state_dict


def comfy_text_encoder_loader(original):
    """Wrap ``_load_text_encoder`` so a Comfy FP8 single file can feed the model.

    Upstream hands one path to both the tokenizer and the encoder; a Comfy FP8
    ``.safetensors`` cannot serve as a tokenizer source. Split them when the TE
    path is a single file: the tokenizer/config keep the local directory (or the
    hub id), while the weights load through the toolkit's single-file path, which
    already understands ``comfy_quant`` checkpoints.
    """

    def load_text_encoder(self, base: str):
        kwargs = self.model_config.model_kwargs or {}
        te_path = str(kwargs.get("text_encoder_path") or "")
        if not te_path.lower().endswith(".safetensors"):
            return original(self, base)
        tokenizer_source = str(kwargs.get("text_encoder_tokenizer_path") or "")
        if not tokenizer_source:
            raise ValueError(
                "Ideogram 4 使用 Comfy 单文件文本编码器时缺少 tokenizer/config 目录"
                "（model_kwargs.text_encoder_tokenizer_path）"
            )

        import os

        from transformers import AutoTokenizer
        from toolkit.basic import flush
        from toolkit.models.v2.text_encoders.qwen3_vl import Qwen3VLModelEncoder

        self.print_and_status_update(
            f"Loading Qwen3-VL text encoder from Comfy single file {te_path} "
            f"(tokenizer/config: {tokenizer_source})"
        )
        tokenizer = AutoTokenizer.from_pretrained(
            tokenizer_source, token=os.getenv("HF_TOKEN", None)
        )
        text_encoder = Qwen3VLModelEncoder.load_model(
            te_path,
            dtype=self.torch_dtype,
            subfolder="",
            config_path=tokenizer_source,
            use_comfy_weights=False,
        )
        flush()
        text_encoder.eval()
        text_encoder.requires_grad_(False)
        return tokenizer, text_encoder

    return load_text_encoder

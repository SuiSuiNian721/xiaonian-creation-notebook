#!/usr/bin/env python
"""
Generate a horizontal comparison image for Anima LoRA strength sweep.

Modes:
  - Single LoRA + multiple strengths (default): --lora PATH --strengths 0,0.5,1
  - Multiple LoRA checkpoints + fixed strength: --loras PATH1,PATH2,... --strength 0.75

PYTHONPATH must include scripts/dev when running:

  set PYTHONPATH=scripts/dev
  python scripts/dev/anima_compare_lora.py --help
"""

from __future__ import annotations

import argparse
import gc
import os
from typing import List

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

from library import anima_train_utils, anima_utils, qwen_image_autoencoder_kl, strategy_anima
from library.device_utils import clean_memory_on_device, synchronize_device
from library import strategy_base
from networks import lora_anima


def parse_float_list(text: str) -> List[float]:
    parts = [p.strip() for p in text.split(",") if p.strip() != ""]
    return [float(p) for p in parts]


def parse_path_list(text: str) -> List[str]:
    parts = [p.strip() for p in text.split(",") if p.strip() != ""]
    return parts


def encode_prompt_bundle(
    prompt: str,
    negative_prompt: str,
    text_encoder,
    dit,
    device: torch.device,
    dit_dtype: torch.dtype,
):
    ts = strategy_base.TokenizeStrategy.get_strategy()
    tes = strategy_base.TextEncodingStrategy.get_strategy()

    def encode_one(prpt: str):
        tokens = ts.tokenize(prpt)
        encoded = tes.encode_tokens(ts, [text_encoder], tokens)
        return encoded

    pos = encode_one(prompt)
    neg = encode_one(negative_prompt) if negative_prompt.strip() != "" else None

    prompt_embeds, attn_mask, t5_input_ids, t5_attn_mask = pos

    def to_tensors(pe, am, t5_ids, t5_am):
        if isinstance(pe, np.ndarray):
            pe = torch.from_numpy(pe).unsqueeze(0)
            am = torch.from_numpy(am).unsqueeze(0)
            t5_ids = torch.from_numpy(t5_ids).unsqueeze(0)
            t5_am = torch.from_numpy(t5_am).unsqueeze(0)
        pe = pe.to(device, dtype=dit_dtype)
        am = am.to(device)
        t5_ids = t5_ids.to(device, dtype=torch.long)
        t5_am = t5_am.to(device)
        return pe, am, t5_ids, t5_am

    prompt_embeds, attn_mask, t5_input_ids, t5_attn_mask = to_tensors(
        prompt_embeds, attn_mask, t5_input_ids, t5_attn_mask
    )

    if dit.use_llm_adapter:
        crossattn_emb = dit.llm_adapter(
            source_hidden_states=prompt_embeds,
            target_input_ids=t5_input_ids,
            target_attention_mask=t5_attn_mask,
            source_attention_mask=attn_mask,
        )
        crossattn_emb[~t5_attn_mask.bool()] = 0
    else:
        crossattn_emb = prompt_embeds

    neg_crossattn_emb = None
    if neg is not None:
        neg_pe, neg_am, neg_t5_ids, neg_t5_am = neg
        neg_pe, neg_am, neg_t5_ids, neg_t5_am = to_tensors(neg_pe, neg_am, neg_t5_ids, neg_t5_am)
        if dit.use_llm_adapter:
            neg_crossattn_emb = dit.llm_adapter(
                source_hidden_states=neg_pe,
                target_input_ids=neg_t5_ids,
                target_attention_mask=neg_t5_am,
                source_attention_mask=neg_am,
            )
            neg_crossattn_emb[~neg_t5_am.bool()] = 0
        else:
            neg_crossattn_emb = neg_pe

    return crossattn_emb, neg_crossattn_emb


def decode_latents_to_pil(vae, latents: torch.Tensor, device: torch.device) -> Image.Image:
    latents = latents.detach()
    org_vae_device = vae.device
    vae.to(device)
    decoded = vae.decode_to_pixels(latents)
    vae.to(org_vae_device)

    image = decoded.float()
    image = torch.clamp((image + 1.0) / 2.0, min=0.0, max=1.0)[0]
    if image.ndim == 4:
        image = image[:, 0, :, :]
    decoded_np = 255.0 * np.moveaxis(image.cpu().numpy(), 0, 2)
    decoded_np = decoded_np.astype(np.uint8)
    return Image.fromarray(decoded_np)


def _format_strength_label(mult: float) -> str:
    """Human-readable LoRA multiplier for captions."""
    if mult == int(mult):
        return str(int(mult))
    text = f"{mult:.3f}".rstrip("0").rstrip(".")
    return text


def _load_label_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "msyh.ttc"),
        os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "msyhbd.ttc"),
        os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "simhei.ttf"),
        os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "arial.ttf"),
    ]
    for path in candidates:
        if path and os.path.isfile(path):
            try:
                return ImageFont.truetype(path, size=size)
            except OSError:
                continue
    return ImageFont.load_default()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dit", required=True, help="Path to anima-preview*.safetensors")
    parser.add_argument("--vae", required=True, help="Path to qwen_image_vae.safetensors")
    parser.add_argument("--qwen3", required=True, help="Path to qwen3 base weights")
    parser.add_argument("--t5_tokenizer_path", default="", help="Optional T5 tokenizer folder; empty uses bundled")

    parser.add_argument(
        "--lora",
        default="",
        help="Single LoRA file; used with --strengths (ignored when --loras is set)",
    )
    parser.add_argument(
        "--loras",
        default="",
        help="Comma-separated LoRA paths (e.g. epoch1..epoch6 ckpts). Uses fixed --strength for each column.",
    )
    parser.add_argument("--strengths", default="0,0.25,0.5,1.0", help="Comma-separated LoRA multipliers (single --lora mode)")
    parser.add_argument(
        "--strength",
        type=float,
        default=0.75,
        help="Fixed LoRA multiplier when using --loras (default 0.75)",
    )
    parser.add_argument(
        "--column_labels",
        default="",
        help="Comma-separated bottom labels for --loras mode; must match column count. Empty: Epoch 1, Epoch 2, ...",
    )

    parser.add_argument("--prompt", required=True)
    parser.add_argument("--negative_prompt", default="worst quality, low quality, score_1, score_2, score_3, artist name, jpeg artifacts")
    parser.add_argument("--width", type=int, default=1024)
    parser.add_argument("--height", type=int, default=1024)
    parser.add_argument("--steps", type=int, default=40)
    parser.add_argument("--cfg", type=float, default=4.5)
    parser.add_argument("--flow_shift", type=float, default=3.0)
    parser.add_argument("--seed", type=int, default=42)

    parser.add_argument("--attn_mode", default="torch")
    parser.add_argument("--split_attn", action="store_true")

    parser.add_argument(
        "--blocks_to_swap",
        type=int,
        default=18,
        help="VRAM optimization: offload DiT blocks (0=off). Try 14-22 on 24GB GPUs for 1024px+CFG.",
    )

    parser.add_argument("--out", default="", help="Output PNG path")
    parser.add_argument(
        "--label_height",
        type=int,
        default=48,
        help="Height (px) of bottom strip for column captions (0 = no strip).",
    )
    parser.add_argument(
        "--no_labels",
        action="store_true",
        help="Do not draw captions under each column.",
    )

    args = parser.parse_args()

    use_loras_mode = args.loras.strip() != ""
    if use_loras_mode:
        lora_paths = parse_path_list(args.loras)
        for p in lora_paths:
            if not os.path.isfile(p):
                raise SystemExit(f"LoRA file not found: {p}")
        strengths = [float(args.strength)] * len(lora_paths)
        custom_labels = None
        if args.column_labels.strip():
            custom_labels = [s.strip() for s in args.column_labels.split(",") if s.strip()]
            if len(custom_labels) != len(lora_paths):
                raise SystemExit(
                    f"--column_labels count ({len(custom_labels)}) must match --loras count ({len(lora_paths)})"
                )
    else:
        if not args.lora.strip():
            raise SystemExit("Provide --lora (single file + strength sweep) or --loras (multi-checkpoint sweep)")
        if not os.path.isfile(args.lora):
            raise SystemExit(f"LoRA file not found: {args.lora}")
        strengths = parse_float_list(args.strengths)
        if len(strengths) == 0:
            raise SystemExit("strengths is empty")
        lora_paths = [args.lora] * len(strengths)
        custom_labels = None

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    weight_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16

    tokenize_strategy = strategy_anima.AnimaTokenizeStrategy(
        qwen3_path=args.qwen3,
        t5_tokenizer_path=args.t5_tokenizer_path if args.t5_tokenizer_path.strip() != "" else None,
        qwen3_max_length=512,
        t5_max_length=512,
    )
    text_encoding_strategy = strategy_anima.AnimaTextEncodingStrategy()
    strategy_base.TokenizeStrategy.set_strategy(tokenize_strategy)
    strategy_base.TextEncodingStrategy.set_strategy(text_encoding_strategy)

    print("Loading Qwen3 text encoder...")
    qwen3_text_encoder, _ = anima_utils.load_qwen3_text_encoder(args.qwen3, dtype=weight_dtype, device="cpu")
    qwen3_text_encoder.eval()

    print("Loading VAE...")
    vae = qwen_image_autoencoder_kl.load_vae(
        args.vae, device="cpu", disable_mmap=True, spatial_chunk_size=None, disable_cache=False
    )
    vae.to(weight_dtype)
    vae.eval()

    print("Loading DiT base...")
    dit = anima_utils.load_anima_model(
        device,
        args.dit,
        args.attn_mode,
        args.split_attn,
        device,
        weight_dtype,
        False,
    )
    dit.eval()

    if args.blocks_to_swap > 0:
        dit.enable_block_swap(args.blocks_to_swap, device)
        dit.switch_block_swap_for_inference()

    qwen3_text_encoder.to(device)

    if args.blocks_to_swap > 0:
        dit.prepare_block_swap_before_forward()

    cross_base, neg_base = encode_prompt_bundle(
        args.prompt, args.negative_prompt, qwen3_text_encoder, dit, device, dit.dtype
    )
    # Embeddings-only from here; keep TE on CPU during DiT sampling to reduce VRAM (CFG uses 2 fwd/step).
    qwen3_text_encoder.to("cpu")
    gc.collect()
    clean_memory_on_device(device)
    # One DiT for prompt encoding is enough; each strength loads its own copy — drop the first to save VRAM.
    del dit
    gc.collect()
    clean_memory_on_device(device)
    if device.type == "cuda":
        torch.cuda.empty_cache()

    images: List[Image.Image] = []

    for idx, (lora_path, mult) in enumerate(zip(lora_paths, strengths)):
        tag = os.path.basename(lora_path)
        print(f"[{idx + 1}/{len(strengths)}] Sampling LoRA={tag} strength={mult} ...")
        clean_memory_on_device(device)

        dit_copy = anima_utils.load_anima_model(
            device,
            args.dit,
            args.attn_mode,
            args.split_attn,
            device,
            weight_dtype,
            False,
        )
        dit_copy.eval()

        network, weights_sd = lora_anima.create_network_from_weights(
            float(mult),
            lora_path,
            None,
            [qwen3_text_encoder],
            dit_copy,
            weights_sd=None,
            for_inference=True,
        )

        apply_te = len(network.text_encoder_loras) > 0
        if apply_te:
            qwen3_text_encoder.to(device)
        network.apply_to([qwen3_text_encoder], dit_copy, apply_text_encoder=apply_te, apply_unet=True)
        # Merge LoRA into base Linear/Conv weights for inference (avoids extra activations from lora_down/up).
        network.merge_to([qwen3_text_encoder], dit_copy, weights_sd, dtype=dit_copy.dtype, device=device)
        network.set_enabled(False)
        del network, weights_sd
        gc.collect()
        clean_memory_on_device(device)
        if device.type == "cuda":
            torch.cuda.empty_cache()

        if args.blocks_to_swap > 0:
            dit_copy.enable_block_swap(args.blocks_to_swap, device)
            dit_copy.switch_block_swap_for_inference()
            dit_copy.prepare_block_swap_before_forward()

        # Re-encode prompts when TE LoRA is active (rare for Anima single-character runs)
        if apply_te:
            cross, neg_cross = encode_prompt_bundle(
                args.prompt, args.negative_prompt, qwen3_text_encoder, dit_copy, device, dit_copy.dtype
            )
            qwen3_text_encoder.to("cpu")
            gc.collect()
            clean_memory_on_device(device)
            if device.type == "cuda":
                torch.cuda.empty_cache()
        else:
            cross, neg_cross = cross_base, neg_base

        if args.blocks_to_swap > 0:
            dit_copy.prepare_block_swap_before_forward()

        with torch.inference_mode():
            latents = anima_train_utils.do_sample(
                args.height,
                args.width,
                args.seed,
                dit_copy,
                cross,
                args.steps,
                dit_copy.dtype,
                device,
                args.cfg,
                args.flow_shift,
                neg_cross,
            )

            synchronize_device(device)
            img = decode_latents_to_pil(vae, latents, device)
        images.append(img)
        del dit_copy, latents
        if device.type == "cuda":
            torch.cuda.empty_cache()

    total_w = sum(im.width for im in images)
    max_h = max(im.height for im in images)
    label_h = 0 if args.no_labels else max(0, args.label_height)
    canvas = Image.new("RGB", (total_w, max_h + label_h), (20, 20, 20))
    x = 0
    for im in images:
        canvas.paste(im, (x, 0))
        x += im.width

    if label_h > 0 and len(images) == len(strengths):
        # Narrower fonts when many columns so text fits
        ncols = len(images)
        font_size = max(10, min(26, label_h - 14, max(320 // max(ncols, 1), 10)))
        font = _load_label_font(font_size)
        draw = ImageDraw.Draw(canvas)
        bg_bar = (24, 24, 26)
        fg_text = (230, 230, 232)
        x = 0
        for col, im in enumerate(images):
            mult = strengths[col]
            draw.rectangle([x, max_h, x + im.width, max_h + label_h], fill=bg_bar)
            if use_loras_mode:
                if custom_labels:
                    epoch_part = custom_labels[col]
                else:
                    epoch_part = f"Epoch {col + 1}"
                label = f"{epoch_part} · LoRA×{_format_strength_label(mult)}"
            else:
                label = f"LoRA 权重 × {_format_strength_label(mult)}"
            bbox = draw.textbbox((0, 0), label, font=font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            tx = x + (im.width - tw) // 2
            ty = max_h + (label_h - th) // 2
            draw.text((tx, ty), label, fill=fg_text, font=font)
            x += im.width

    out_path = args.out
    if not out_path:
        if use_loras_mode:
            base = os.path.splitext(os.path.basename(lora_paths[0]))[0]
            tag = f"epochs_{len(lora_paths)}x{_format_strength_label(args.strength)}"
            out_path = os.path.join(os.path.dirname(lora_paths[0]) or ".", f"{base}_{tag}_compare.png")
        else:
            base = os.path.splitext(os.path.basename(args.lora))[0]
            out_path = os.path.join(os.path.dirname(args.lora) or ".", f"{base}_compare_{'_'.join(str(s) for s in strengths)}.png")

    canvas.save(out_path)
    print(f"Saved: {out_path}")


if __name__ == "__main__":
    main()

"""Explicit local model modes. No path-to-Hub guessing and no implicit copies."""
from pathlib import Path, PureWindowsPath
import json

from .capabilities import MODELS, family
from mikazuki.model_asset_validation import local_weights, safetensors_header
from mikazuki.model_assets import SD15_CONFIG_DIR


def absolute(value, root: Path) -> Path:
    text = str(value or "").strip()
    if not text:
        raise ValueError("模型路径不能为空")
    if PureWindowsPath(text).drive and not Path(text).is_absolute():
        raise ValueError(f"Windows 路径不在当前服务端，请选择服务端路径: {text}")
    path = Path(text.replace("\\", "/")).expanduser()
    return (path if path.is_absolute() else root / path).resolve()


def model_inputs(source, root, variant):
    spec = MODELS[variant]
    kind = family(variant)
    mode = source.get("model_input_mode")
    legacy = not mode
    raw = source.get("model_path") or source.get("dit_path") or source.get("dit") or source.get("pretrained_model_name_or_path")
    if not mode:
        path = absolute(raw, root)
        if path.is_dir():
            mode = "model_directory"
        elif path.is_file():
            mode = "single_file"
        else:
            raise ValueError("旧配置的模型路径无法识别；请选择模型输入模式并填写本地路径，不会自动下载或转换")
    if mode not in spec["modes"]:
        raise ValueError(f"{spec['label']} 不支持模型输入模式 {mode}；支持: {', '.join(spec['modes'])}")
    # Only the selected mode participates in the launch. Other fields stay in drafts.
    key = "model_path" if mode == "model_directory" else "dit_path"
    path = absolute(source.get(key) or (raw if legacy else None), root)
    if not (path.is_dir() if mode == "model_directory" else path.is_file()):
        raise ValueError(f"{key} 路径不存在或类型错误: {path}（必须是服务端本地路径）")
    model = {"arch": spec["arch"], "name_or_path": str(path), "model_kwargs": {"use_comfy_weights": False}}
    assets = {"mode": mode, "family": kind, "source": str(path), "variant": variant}
    te = ""
    if kind in {"klein", "krea2"}:
        selected = source.get("model_variant", spec["variants"][0])
        if selected not in spec["variants"]:
            raise ValueError(f"{variant} 不支持 model_variant={selected}")
        if path.is_dir():
            filename = spec["dit_filename"]
            if kind == "klein" and selected == "distilled":
                filename = filename.replace("-base-", "-")
            path = path / filename
            if not path.is_file():
                raise ValueError(f"DiT 文件不存在: {path}")
        model["name_or_path"] = str(path)
        te = str(absolute(source.get("text_encoder_path") or source.get("text_encoder"), root))
        vae_raw = source.get("vae_path") or (path.parent / "ae.safetensors" if kind == "klein" else None)
        vae = str(absolute(vae_raw, root))
        assets.update(dit=str(path), text_encoder=te, vae=vae, model_variant=selected)
        if kind == "klein":
            model["vae_path"] = vae
            model["model_kwargs"]["match_target_res"] = False
        else:
            model["model_kwargs"].update(text_encoder_path=te, vae_path=vae)
    elif kind == "ideogram4":  # upstream reads DiT/VAE from the model dir; TE is explicit
        te = str(absolute(source.get("text_encoder_path") or source.get("text_encoder"), root))
        model["model_kwargs"]["text_encoder_path"] = te
        assets["text_encoder"] = te
        tokenizer_source = str(source.get("text_encoder_tokenizer_path") or "").strip()
        if tokenizer_source and te.lower().endswith(".safetensors"):
            # Comfy FP8 TE file: the tokenizer/config still come from a directory
            # (or a hub id, which is kept verbatim).
            candidate = Path(tokenizer_source)
            resolved = str(candidate if candidate.is_absolute() else root / candidate)
            if Path(resolved).is_dir():
                model["model_kwargs"]["text_encoder_tokenizer_path"] = resolved
                assets["text_encoder_tokenizer"] = resolved
            else:
                model["model_kwargs"]["text_encoder_tokenizer_path"] = tokenizer_source
                assets["text_encoder_tokenizer"] = tokenizer_source
        if mode == "comfyui_files":  # Comfy-Org components, loaded in place by driver.py
            components = {"transformer": str(path), "vae": str(absolute(source.get("vae_path"), root))}
            model["model_kwargs"]["next_trainer_comfy_components"] = components
            assets["components"] = components
        # Optional: the unconditional-pass LoRA for asymmetric-CFG sampling. Without
        # it, sampling falls back to single-DiT CFG (upstream ignores a null path).
        unconditional = str(source.get("unconditional_lora_path") or "").strip()
        if unconditional:
            resolved_lora = str(absolute(unconditional, root))
            model["unconditional_lora_path"] = resolved_lora
            assets["unconditional_lora"] = resolved_lora
    elif mode == "single_file":  # SDXL / SD 1.5 checkpoint plus local Diffusers configs/tokenizers
        config_dir = source.get("model_config_dir") or (SD15_CONFIG_DIR if kind == "sd15" else None)
        extras = str(absolute(config_dir, root))
        model["extras_name_or_path"] = extras
        model["model_kwargs"]["next_trainer_sd15_config" if kind == "sd15" else "next_trainer_sdxl_config"] = extras
        assets["config_dir"] = extras
    elif mode == "comfyui_files":  # Qwen 2.1 native component loaders
        extras = str(absolute(source.get("model_config_dir"), root))
        components = {"transformer": str(path), "text_encoder": str(absolute(source.get("text_encoder_path"), root)),
                      "vae": str(absolute(source.get("vae_path"), root))}
        model["extras_name_or_path"] = extras
        model["model_kwargs"]["next_trainer_components"] = components
        assets.update(config_dir=extras, components=components)
    return model, te, assets


def _config(path):
    if not path.is_file():
        raise ValueError(f"模型目录缺少配置: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"模型配置格式错误: {path}")
    return value


def _component_weights(directory: Path) -> None:
    """Require at least one diffusion_pytorch_model*.safetensors under a component."""
    if not (directory.is_dir() and any(directory.glob("diffusion_pytorch_model*.safetensors"))):
        raise ValueError(f"模型目录缺少组件权重 {directory / 'diffusion_pytorch_model*.safetensors'}")
    local_weights(directory)


def _qwen3_vl_dir(directory: Path) -> None:
    cfg = _config(directory / "config.json")
    _config(directory / "tokenizer_config.json")
    _config(directory / "tokenizer.json")
    local_weights(directory)
    if cfg.get("model_type") not in (None, "qwen3_vl"):
        raise ValueError(f"文本编码器不是 Qwen3-VL: {directory}（model_type={cfg.get('model_type')}）")
    text_cfg = cfg.get("text_config") if isinstance(cfg.get("text_config"), dict) else {}
    hidden = text_cfg.get("hidden_size", cfg.get("hidden_size"))
    if hidden is not None and hidden != 4096:
        raise ValueError(f"文本编码器与 Ideogram 4 不匹配: {directory}，要求 hidden_size=4096")


def validate_assets(assets):
    spec = MODELS[assets["variant"]]
    kind = assets["family"]
    if kind == "ideogram4":
        te_path = Path(assets["text_encoder"])
        if te_path.suffix.lower() == ".safetensors":
            # Comfy FP8 single file for the weights; tokenizer/config live in a
            # local directory (hub ids are accepted as-is by transformers).
            safetensors_header(te_path)
            tokenizer_source = str(assets.get("text_encoder_tokenizer") or "")
            tokenizer_dir = Path(tokenizer_source)
            if tokenizer_source and tokenizer_dir.is_dir():
                _config(tokenizer_dir / "config.json")
                _config(tokenizer_dir / "tokenizer_config.json")
                _config(tokenizer_dir / "tokenizer.json")
        else:
            _qwen3_vl_dir(te_path)
        if assets["mode"] == "comfyui_files":
            dit = Path(assets["components"]["transformer"])
            header = safetensors_header(dit)
            if not any(key.startswith("layers.") and key.endswith(".attention.qkv.weight") for key in header):
                raise ValueError(f"不是 Ideogram 4 条件 DiT（Comfy 单文件）: {dit}")
            safetensors_header(Path(assets["components"]["vae"]))
        else:
            base = Path(assets["source"])
            _component_weights(base / "transformer")
            _component_weights(base / "vae")
        return
    if kind in {"klein", "krea2"}:
        safetensors_header(Path(assets["dit"]))
        te = Path(assets["text_encoder"])
        cfg = _config(te / "config.json")
        _config(te / "tokenizer_config.json")
        _config(te / "tokenizer.json")
        local_weights(te)
        if kind == "klein":
            expected = spec["te_hidden_size"]
            if cfg.get("hidden_size") != expected:
                raise ValueError(f"文本编码器与变体不匹配: {te}，要求 hidden_size={expected}")
            safetensors_header(Path(assets["vae"]))
        else:
            vae = Path(assets["vae"])
            if (vae / "vae").is_dir():
                vae = vae / "vae"
            _config(vae / "config.json")
            local_weights(vae)
        return
    base = Path(assets.get("config_dir") or assets["source"])
    _config(base / "model_index.json")
    for component in spec["components"]:
        _config(base / component / "config.json")
        if assets["mode"] == "model_directory":
            local_weights(base / component)
    for folder in spec["tokenizers"]:
        directory = base / folder
        _config(directory / "tokenizer_config.json")
        if not (directory / "tokenizer.json").is_file() and not (directory / "vocab.json").is_file() and not (directory / "spiece.model").is_file():
            raise ValueError(f"模型目录缺少 tokenizer 词表: {directory}")
    if assets["mode"] == "single_file":
        # SD 1.5 pipeline configs declare a CLIPImageProcessor the loader reads
        # from the same local directory (feature_extractor/preprocessor_config.json).
        if kind == "sd15":
            _config(base / "feature_extractor" / "preprocessor_config.json")
        safetensors_header(Path(assets["source"]))
    for path in assets.get("components", {}).values():
        safetensors_header(Path(path))

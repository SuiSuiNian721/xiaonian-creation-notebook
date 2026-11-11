"""Default model assets per train type (presence check + download).

Generic across training backends: each train type registers its required base
models with default local paths and optional HuggingFace / ModelScope sources.

Repo ids can be overridden per asset in config/model_assets.toml:

    [krea2-lora.dit]
    hf_repo = "..."
    hf_file = "..."
    ms_repo = "..."
    ms_file = "..."
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
import json
import os
import re

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 runtime
    import toml as tomllib


CONFIG_PATH = Path("config/model_assets.toml")


@dataclass(frozen=True)
class AssetDef:
    key: str
    label: str
    default_path: str  # relative to project root; a directory for kind="dir"
    optional: bool = False
    kind: str = "file"  # "file" | "dir" (directory of loose files, e.g. tokenizer)
    hf_repo: str = ""
    hf_file: str = ""
    ms_repo: str = ""
    ms_file: str = ""
    # kind="dir" only: download allow_patterns and completeness check.
    dir_patterns: tuple[str, ...] = ()
    dir_required: tuple[str, ...] = ()
    dir_needs_weights: bool = False  # require at least one *.safetensors


KREA2_REPO = "Comfy-Org/Krea-2"
QWEN3_VL_REPO = "Qwen/Qwen3-VL-4B-Instruct"
IDEOGRAM4_REPO = "Comfy-Org/Ideogram-4"
IDEOGRAM4_TOKENIZER_REPO = "Qwen/Qwen3-VL-8B-Instruct"
TOKENIZER_FILES = ["tokenizer.json", "tokenizer_config.json", "vocab.json", "merges.txt"]
TOKENIZER_REQUIRED = ("tokenizer.json", "tokenizer_config.json")

KLEIN_4B_REPO = "black-forest-labs/FLUX.2-klein-base-4B"
KLEIN_9B_REPO = "black-forest-labs/FLUX.2-klein-base-9B"

# SD 1.5 single-file training (AI Toolkit arch `sd1`) loads the Comfy/LDM
# checkpoint through diffusers `from_single_file`; only the pipeline configs and
# the CLIP tokenizer are needed locally (the offline launch never calls the Hub).
# ModelScope's AI-ModelScope/stable-diffusion-v1-5 carries the same layout and
# the same v1-5-pruned-emaonly.safetensors single file.
SD15_REPO = "stable-diffusion-v1-5/stable-diffusion-v1-5"
SD15_MS_REPO = "AI-ModelScope/stable-diffusion-v1-5"
SD15_CKPT_FILE = "v1-5-pruned-emaonly.safetensors"
SD15_CONFIG_DIR = "sd-models/sd15/config"
SD15_CONFIG_PATTERNS = ("model_index.json", "unet/*.json", "vae/*.json", "text_encoder/*.json",
                        "feature_extractor/*.json", "scheduler/*.json", "tokenizer/*")
SD15_CONFIG_REQUIRED = (
    "model_index.json", "unet/config.json", "vae/config.json", "text_encoder/config.json",
    "feature_extractor/preprocessor_config.json", "scheduler/scheduler_config.json",
    "tokenizer/vocab.json", "tokenizer/tokenizer_config.json",
)

# AI Toolkit's Ideogram 4 extension loads its text encoder with transformers
# (upstream default: the bf16 Qwen/Qwen3-VL-8B-Instruct repo); the Comfy-Org
# FP8 text encoder file used by Musubi is not consumed by this engine.
IDEOGRAM4_TE_DIR = "sd-models/ideogram4/qwen3-vl-8b-instruct"

# ai-toolkit auto-loads `<name_or_path>/ae.safetensors` when present (flux2_model.py),
# so the VAE asset lands next to the DiT file under sd-models/klein/.
# ModelScope mirror (KanKanKan/flux2-vae, flux2-vae.safetensors) verified 2026-08-28
# to use the single-file ae key layout (decoder.up.0.block.0.conv1.bias present).
KLEIN_VAE_REPO = "ai-toolkit/flux2_vae"
KLEIN_VAE_FILE = "ae.safetensors"
KLEIN_VAE_MS_REPO = "KanKanKan/flux2-vae"
KLEIN_VAE_MS_FILE = "flux2-vae.safetensors"

# TE for Klein variants: upstream defaults to the HF ids Qwen/Qwen3-4B (4B) /
# Qwen/Qwen3-8B (9B); both have same-id ModelScope mirrors with full file sets.
TE_DIR_PATTERNS = ("*.json", "*.safetensors", "*.txt")
TE_DIR_REQUIRED = ("config.json", "tokenizer.json", "tokenizer_config.json")


def _klein_te_asset(variant_tag: str, te_repo: str, te_dir: str) -> AssetDef:
    return AssetDef(
        "text_encoder", f"文本编码器（Qwen3-{variant_tag}，目录）", f"sd-models/klein/{te_dir}",
        kind="dir",
        hf_repo=te_repo, ms_repo=te_repo,
        dir_patterns=TE_DIR_PATTERNS, dir_required=TE_DIR_REQUIRED, dir_needs_weights=True,
    )


def _klein_assets(variant: str, repo: str, dit_file: str, te_repo: str, te_dir: str, te_tag: str) -> tuple[AssetDef, ...]:
    return (
        AssetDef("dit", f"Klein {variant} DiT（底模）", f"sd-models/klein/{dit_file}",
                 hf_repo=repo, hf_file=dit_file,
                 ms_repo=repo, ms_file=dit_file),
        AssetDef("vae", "VAE（FLUX.2，ae.safetensors，须与 DiT 同目录）", f"sd-models/klein/{KLEIN_VAE_FILE}",
                 hf_repo=KLEIN_VAE_REPO, hf_file=KLEIN_VAE_FILE,
                 ms_repo=KLEIN_VAE_MS_REPO, ms_file=KLEIN_VAE_MS_FILE),
        _klein_te_asset(te_tag, te_repo, te_dir),
    )


ASSET_REGISTRY: dict[str, tuple[AssetDef, ...]] = {
    "qwen-image-21-lora": (
        AssetDef("diffsynth_model_dir", "Qwen-Image-2.1 官方模型目录", "sd-models/qwen-image-21", kind="dir",
                 hf_repo="Qwen/Qwen-Image-2.1", ms_repo="Qwen/Qwen-Image-2.1",
                 dir_patterns=("transformer/*", "text_encoder/*", "vae/*", "processor/*"),
                 dir_required=("processor/tokenizer.json", "processor/tokenizer_config.json", "processor/preprocessor_config.json", "processor/chat_template.jinja", "processor/video_preprocessor_config.json")),
    ),
    "klein-4b-lora": _klein_assets("base-4B", KLEIN_4B_REPO, "flux-2-klein-base-4b.safetensors", "Qwen/Qwen3-4B", "qwen3-4b", "4B"),
    "klein-9b-lora": _klein_assets("base-9B", KLEIN_9B_REPO, "flux-2-klein-base-9b.safetensors", "Qwen/Qwen3-8B", "qwen3-8b", "8B"),
    "krea2-lora": (
        AssetDef("dit", "Krea 2 DiT（RAW 底模）", "sd-models/krea2/krea2.safetensors",
                 hf_repo=KREA2_REPO, hf_file="diffusion_models/krea2_raw_bf16.safetensors",
                 ms_repo=KREA2_REPO, ms_file="diffusion_models/krea2_raw_bf16.safetensors"),
        AssetDef("vae", "VAE（Qwen-Image）", "sd-models/krea2/qwen_image_vae.safetensors",
                 hf_repo=KREA2_REPO, hf_file="vae/qwen_image_vae.safetensors",
                 ms_repo=KREA2_REPO, ms_file="vae/qwen_image_vae.safetensors"),
        AssetDef("text_encoder", "文本编码器（Qwen3-VL-4B）", "sd-models/krea2/qwen3_vl_4b.safetensors",
                 hf_repo=KREA2_REPO, hf_file="text_encoders/qwen3vl_4b_bf16.safetensors",
                 ms_repo=KREA2_REPO, ms_file="text_encoders/qwen3vl_4b_bf16.safetensors"),
        AssetDef("turbo_dit", "Turbo 蒸馏 DiT（可选）", "sd-models/krea2/krea2-turbo.safetensors", optional=True,
                 hf_repo=KREA2_REPO, hf_file="diffusion_models/krea2_turbo_bf16.safetensors",
                 ms_repo=KREA2_REPO, ms_file="diffusion_models/krea2_turbo_bf16.safetensors"),
        AssetDef("tokenizer", "Qwen3-VL tokenizer（目录）", "sd-models/krea2/qwen3-vl-tokenizer", kind="dir",
                 hf_repo=QWEN3_VL_REPO, ms_repo=QWEN3_VL_REPO),
    ),
    # Ideogram 4 ships quantized-only weights (FP8) under the Ideogram
    # Non-Commercial license; the pack must not bundle them, users fetch them.
    # ModelScope carries the same Comfy-Org mirror layout (verified 2026-10-10),
    # so both download sources work out of the box.
    "ideogram4-lora": (
        AssetDef("dit", "Ideogram 4 conditional DiT（FP8 底模，非商用许可）", "sd-models/ideogram4/ideogram4_fp8_scaled.safetensors",
                 hf_repo=IDEOGRAM4_REPO, hf_file="diffusion_models/ideogram4_fp8_scaled.safetensors",
                 ms_repo=IDEOGRAM4_REPO, ms_file="diffusion_models/ideogram4_fp8_scaled.safetensors"),
        AssetDef("unconditional_dit", "Ideogram 4 unconditional DiT（非对称 CFG，可选）",
                 "sd-models/ideogram4/ideogram4_unconditional_fp8_scaled.safetensors", optional=True,
                 hf_repo=IDEOGRAM4_REPO, hf_file="diffusion_models/ideogram4_unconditional_fp8_scaled.safetensors",
                 ms_repo=IDEOGRAM4_REPO, ms_file="diffusion_models/ideogram4_unconditional_fp8_scaled.safetensors"),
        AssetDef("text_encoder", "文本编码器（Qwen3-VL-8B，FP8）", "sd-models/ideogram4/qwen3vl_8b_fp8_scaled.safetensors",
                 hf_repo=IDEOGRAM4_REPO, hf_file="text_encoders/qwen3vl_8b_fp8_scaled.safetensors",
                 ms_repo=IDEOGRAM4_REPO, ms_file="text_encoders/qwen3vl_8b_fp8_scaled.safetensors"),
        AssetDef("vae", "VAE（Flux2）", "sd-models/ideogram4/flux2-vae.safetensors",
                 hf_repo=IDEOGRAM4_REPO, hf_file="vae/flux2-vae.safetensors",
                 ms_repo=IDEOGRAM4_REPO, ms_file="vae/flux2-vae.safetensors"),
        AssetDef("tokenizer", "Qwen3-VL-8B tokenizer（目录）", "sd-models/ideogram4/qwen3-vl-8b-tokenizer", kind="dir",
                 hf_repo=IDEOGRAM4_TOKENIZER_REPO, ms_repo=IDEOGRAM4_TOKENIZER_REPO),
    ),
    # AI Toolkit SD 1.5: the checkpoint stays a Comfy/LDM single file; only the
    # diffusers configs + tokenizer are downloaded here, so no weight conversion
    # and no weight duplication. Both files are public on HF and ModelScope.
    "ai-toolkit-sd15-lora": (
        AssetDef("dit", "SD 1.5 底模（Comfy/LDM 单文件，SD 1.5 官方权重）", f"sd-models/sd15/{SD15_CKPT_FILE}",
                 hf_repo=SD15_REPO, hf_file=SD15_CKPT_FILE,
                 ms_repo=SD15_MS_REPO, ms_file=SD15_CKPT_FILE),
        AssetDef("model_config_dir", "SD 1.5 配置与 tokenizer（单文件训练所需，不含权重）", SD15_CONFIG_DIR, kind="dir",
                 hf_repo=SD15_REPO, ms_repo=SD15_MS_REPO,
                 dir_patterns=SD15_CONFIG_PATTERNS, dir_required=SD15_CONFIG_REQUIRED),
    ),
    # AI Toolkit Ideogram 4: same Comfy-Org single files as the Musubi entry
    # (conditional DiT + Flux2 VAE, non-commercial license, nothing bundled),
    # loaded in place by the engine driver; the bf16 Qwen3-VL-8B directory is
    # what the upstream extension's transformers loader expects.
    "ai-toolkit-ideogram4-lora": (
        AssetDef("dit", "Ideogram 4 conditional DiT（FP8 底模，非商用许可，Comfy 单文件）",
                 "sd-models/ideogram4/ideogram4_fp8_scaled.safetensors",
                 hf_repo=IDEOGRAM4_REPO, hf_file="diffusion_models/ideogram4_fp8_scaled.safetensors",
                 ms_repo=IDEOGRAM4_REPO, ms_file="diffusion_models/ideogram4_fp8_scaled.safetensors"),
        AssetDef("vae", "VAE（Flux2，Comfy 单文件）", "sd-models/ideogram4/flux2-vae.safetensors",
                 hf_repo=IDEOGRAM4_REPO, hf_file="vae/flux2-vae.safetensors",
                 ms_repo=IDEOGRAM4_REPO, ms_file="vae/flux2-vae.safetensors"),
        AssetDef("text_encoder", "文本编码器（Qwen3-VL-8B FP8，Comfy 单文件）",
                 "sd-models/ideogram4/qwen3vl_8b_fp8_scaled.safetensors",
                 hf_repo=IDEOGRAM4_REPO, hf_file="text_encoders/qwen3vl_8b_fp8_scaled.safetensors",
                 ms_repo=IDEOGRAM4_REPO, ms_file="text_encoders/qwen3vl_8b_fp8_scaled.safetensors"),
        AssetDef("unconditional_lora", "无条件采样 LoRA（可选，非对称 CFG 预览用；第三方产物 ostris/ideogram_4_unconditional_lora）",
                 "sd-models/ideogram4/ideogram_4_unconditional_lora_r16.safetensors", optional=True,
                 hf_repo="ostris/ideogram_4_unconditional_lora",
                 hf_file="ideogram_4_unconditional_lora_r16.safetensors"),
        AssetDef("text_encoder_tokenizer", "Qwen3-VL-8B config/tokenizer（目录，供 Comfy 单文件加载）", IDEOGRAM4_TE_DIR,
                 kind="dir", hf_repo=IDEOGRAM4_TOKENIZER_REPO, ms_repo=IDEOGRAM4_TOKENIZER_REPO,
                 dir_patterns=("*.json", "*.txt", "*.jinja"),
                 dir_required=("config.json", "tokenizer.json", "tokenizer_config.json")),
    ),
}


def _config() -> dict:
    path = CONFIG_PATH
    if not path.is_file():
        return {}
    return tomllib.loads(path.read_text(encoding="utf-8"))


def manifest_for(train_type: str) -> list[AssetDef]:
    base = ASSET_REGISTRY.get(train_type)
    if not base:
        return []
    overrides = _config().get(train_type, {})
    resolved = []
    for asset in base:
        extra = overrides.get(asset.key, {}) if isinstance(overrides, dict) else {}
        resolved.append(AssetDef(
            key=asset.key,
            label=asset.label,
            default_path=str(extra.get("default_path") or asset.default_path),
            optional=bool(extra.get("optional", asset.optional)),
            kind=str(extra.get("kind") or asset.kind),
            hf_repo=str(extra.get("hf_repo") or asset.hf_repo),
            hf_file=str(extra.get("hf_file") or asset.hf_file),
            ms_repo=str(extra.get("ms_repo") or asset.ms_repo),
            ms_file=str(extra.get("ms_file") or asset.ms_file),
            dir_patterns=tuple(extra.get("dir_patterns") or asset.dir_patterns),
            dir_required=tuple(extra.get("dir_required") or asset.dir_required),
            dir_needs_weights=bool(extra.get("dir_needs_weights", asset.dir_needs_weights)),
        ))
    return resolved


def resolve_train_type(payload_train_type: str, values: dict[str, Any]) -> str:
    """Prefer the config's model_train_type (e.g. lora-master → sd-lora/sdxl-lora)."""
    from_values = str(values.get("model_train_type") or "").strip()
    return from_values or payload_train_type.strip()


def _target_path(raw: str, project_root: Path) -> Path:
    path = Path(raw.strip() or ".")
    if not path.is_absolute():
        path = project_root / path
    return path.resolve()


def dir_complete(path: Path) -> bool:
    return all((path / name).is_file() for name in TOKENIZER_REQUIRED)


_TOKENIZER_CONFIG_NAME = "tokenizer_config.json"


def normalize_tokenizer_config(tokenizer_dir: Path, log: Callable[[str], None] = print) -> bool:
    """Rewrite a tokenizer_config whose ``extra_special_tokens`` is a legacy list.

    transformers >= 4.5x expects a mapping (``{"additional_special_tokens": [...]}``);
    a bare list raises while loading the tokenizer, which used to surface as an
    opaque TypeError during preflight/training (#416). Idempotent, and never
    touches a config that is already in the mapping form.
    """
    config_path = Path(tokenizer_dir) / _TOKENIZER_CONFIG_NAME
    if not config_path.is_file():
        return False
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log(f"[tokenizer] cannot read {config_path} ({exc}); left unchanged")
        return False
    if not isinstance(payload, dict):
        return False
    value = payload.get("extra_special_tokens")
    if not isinstance(value, list):
        return False
    payload["extra_special_tokens"] = {
        "additional_special_tokens": [str(item) for item in value]
    }
    tmp = config_path.with_name(config_path.name + ".mikazuki-tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, config_path)
    log(f"[tokenizer] extra_special_tokens list -> mapping in {config_path}")
    return True


def asset_dir_complete(asset: AssetDef, path: Path) -> bool:
    if asset.key == "diffsynth_model_dir":
        from mikazuki.engines.diffsynth.adapter import weight_files
        try:
            for folder, pattern in (("transformer", "diffusion_pytorch_model*.safetensors"), ("text_encoder", "model*.safetensors"), ("vae", "diffusion_pytorch_model*.safetensors")):
                weight_files(path / folder, pattern)
        except ValueError:
            return False
    required = asset.dir_required or TOKENIZER_REQUIRED
    if not all((path / name).is_file() for name in required):
        return False
    if asset.dir_needs_weights and not any(path.glob("*.safetensors")):
        return False
    return True


def tokenizer_dir_for(train_type: str, project_root: Path) -> Path:
    for asset in manifest_for(train_type):
        if asset.key == "tokenizer":
            return _target_path(asset.default_path, project_root)
    return _target_path("sd-models/krea2/qwen3-vl-tokenizer", project_root)


def krea2_tokenizer_dir(project_root: Path) -> Path:
    return tokenizer_dir_for("krea2-lora", project_root)


KREA2_ENCODER_REL = Path("src/musubi_tuner/krea2/krea2_encoder.py")
_TOKENIZER_PATCH_MARK = "# mikazuki: patched tokenizer path"
_TOKENIZER_LINES = (
    "    tokenizer = AutoTokenizer.from_pretrained(tokenizer_repo, max_length=max_length)",
    "    processor = Qwen2TokenizerFast.from_pretrained(tokenizer_repo, max_length=max_length)",
)


def patch_krea2_tokenizer_path(source_root: Path, tokenizer_dir: Path, log: Callable[[str], None] = print) -> bool:
    """Rewrite krea2_encoder.py in place: point the two tokenizer from_pretrained
    calls at the local tokenizer directory instead of the Hub id. Idempotent;
    no-op when the directory is incomplete. Refuses to write a broken result."""
    encoder = Path(source_root) / KREA2_ENCODER_REL
    if not encoder.is_file():
        return False
    tokenizer_dir = Path(tokenizer_dir)
    normalize_tokenizer_config(tokenizer_dir, log)
    if not dir_complete(tokenizer_dir):
        return False
    text = encoder.read_text(encoding="utf-8")
    if _TOKENIZER_PATCH_MARK in text:
        return True
    patched = text
    for line in _TOKENIZER_LINES:
        if line not in patched:
            log(f"[patch] tokenizer load line not found in {encoder}; skipped")
            return False
        patched_line = line.replace("tokenizer_repo", f'r"{tokenizer_dir.as_posix()}"')
        patched = patched.replace(line, f"{patched_line}  {_TOKENIZER_PATCH_MARK}", 1)
    try:
        compile(patched, str(encoder), "exec")
    except SyntaxError as exc:
        log(f"[patch] result would not compile ({exc}); {encoder} left unchanged")
        return False
    encoder.write_text(patched, encoding="utf-8")
    log(f"[patch] krea2 tokenizer_repo -> {tokenizer_dir}")
    return True


def patch_krea2_tokenizer_everywhere(project_root: Path, log: Callable[[str], None] = print) -> bool:
    """Patch every known musubi source root (installed extension, vendor, upstream cache)."""
    from mikazuki.engines.musubi.extension_state import default_layout as musubi_default_layout

    tokenizer_dir = krea2_tokenizer_dir(project_root)
    patched = False
    for root in (
        musubi_default_layout(project_root).source,
        Path(project_root) / "vendor" / "musubi-tuner",
        Path(project_root) / ".cache" / "musubi" / "upstream",
    ):
        patched = patch_krea2_tokenizer_path(root, tokenizer_dir, log) or patched
    return patched


IDEOGRAM4_UTILS_REL = Path("src/musubi_tuner/ideogram4/ideogram4_utils.py")
_ROTARY_PATCH_MARK = "# mikazuki: rebuild rotary embedding after to_empty"
_ROTARY_ANCHOR = "    _materialize_meta_tensors(model)"
_ROTARY_PATCH = """    _materialize_meta_tensors(model)
    # mikazuki: rebuild rotary embedding after to_empty (upstream #1139) — the
    # non-persistent inv_freq buffer is not in the checkpoint, so to_empty()
    # leaves it uninitialized and the cached text encoder outputs turn to junk.
    _rotary = model.language_model.rotary_emb
    try:
        model.language_model.rotary_emb = type(_rotary)(config.text_config, device=_rotary.inv_freq.device)
    except TypeError:  # older/newer transformers builds may not accept the device kwarg
        model.language_model.rotary_emb = type(_rotary)(config.text_config)"""
_IDEOGRAM4_TOKENIZER_LINE = "    return AutoTokenizer.from_pretrained(QWEN3_VL_8B_INSTRUCT_REPO_ID)"
# Original Hub call or a previous local-directory patch: either shape can be
# rewritten, so the patch can follow a moved/re-downloaded tokenizer directory
# (and fall back to the Hub id when the local directory disappears).
_IDEOGRAM4_TOKENIZER_CALL_RE = re.compile(
    r'(?m)^\s*return AutoTokenizer\.from_pretrained\((?:r"[^"]*"|QWEN3_VL_8B_INSTRUCT_REPO_ID)\)(?:[^\n]*)$'
)


def _ideogram4_tokenizer_call(tokenizer_dir: Path) -> str:
    if dir_complete(tokenizer_dir):
        return f'    return AutoTokenizer.from_pretrained(r"{tokenizer_dir.as_posix()}")  {_TOKENIZER_PATCH_MARK}'
    return _IDEOGRAM4_TOKENIZER_LINE


def patch_ideogram4_source(source_root: Path, tokenizer_dir: Path, log: Callable[[str], None] = print) -> bool:
    """Fix the Ideogram 4 text encoder in the musubi source tree.

    Two idempotent source patches:
    1. rebuild the Qwen3-VL rotary embedding after ``to_empty()`` (upstream #1139);
    2. point the tokenizer at the local directory when it is complete, and
       re-point (or revert to the Hub id) when that directory changes.
    Refuses to write a result that does not compile.
    """
    module = Path(source_root) / IDEOGRAM4_UTILS_REL
    if not module.is_file():
        return False
    normalize_tokenizer_config(Path(tokenizer_dir), log)
    text = module.read_text(encoding="utf-8")
    patched = text
    if _ROTARY_PATCH_MARK not in patched:
        if _ROTARY_ANCHOR in patched:
            patched = patched.replace(_ROTARY_ANCHOR, _ROTARY_PATCH, 1)
        else:
            log(f"[patch] rotary anchor not found in {module}; skipped")
    desired_call = _ideogram4_tokenizer_call(Path(tokenizer_dir))
    if _IDEOGRAM4_TOKENIZER_CALL_RE.search(patched):
        patched = _IDEOGRAM4_TOKENIZER_CALL_RE.sub(desired_call, patched, count=1)
    else:
        log(f"[patch] tokenizer load line not found in {module}; skipped")
    if patched == text:
        return False
    try:
        compile(patched, str(module), "exec")
    except SyntaxError as exc:
        log(f"[patch] result would not compile ({exc}); {module} left unchanged")
        return False
    # Write atomically: a partial file would break the installed snapshot.
    tmp = module.with_name(module.name + ".mikazuki-tmp")
    tmp.write_text(patched, encoding="utf-8")
    os.replace(tmp, module)
    log(f"[patch] ideogram4 rotary rebuild + tokenizer -> {tokenizer_dir}")
    return True


def patch_ideogram4_everywhere(project_root: Path, log: Callable[[str], None] = print) -> bool:
    """Patch every known musubi source root (installed extension, vendor, upstream cache)."""
    from mikazuki.engines.musubi.extension_state import default_layout as musubi_default_layout

    tokenizer_dir = tokenizer_dir_for("ideogram4-lora", project_root)
    patched = False
    for root in (
        musubi_default_layout(project_root).source,
        Path(project_root) / "vendor" / "musubi-tuner",
        Path(project_root) / ".cache" / "musubi" / "upstream",
    ):
        patched = patch_ideogram4_source(root, tokenizer_dir, log) or patched
    return patched


def check_assets(train_type: str, values: dict[str, Any], project_root: Path) -> list[dict]:
    items = []
    for asset in manifest_for(train_type):
        target = _target_path(str(values.get(asset.key) or asset.default_path), project_root)
        exists = asset_dir_complete(asset, target) if asset.kind == "dir" else target.is_file()
        items.append({
            "key": asset.key,
            "label": asset.label,
            "path": str(target),
            "exists": exists,
            "optional": asset.optional,
            "sources": {
                "huggingface": bool(asset.hf_repo and (asset.hf_file or asset.kind == "dir")),
                "modelscope": bool(asset.ms_repo and (asset.ms_file or asset.kind == "dir")),
            },
        })
    return items


def _download_dir_asset(asset: AssetDef, source: str, target_dir: Path, log: Callable[[str], None]) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    patterns = list(asset.dir_patterns or TOKENIZER_FILES)
    if source == "huggingface":
        log(f"[download] huggingface {asset.hf_repo} {patterns} -> {target_dir}")
        from huggingface_hub import snapshot_download

        snapshot_download(repo_id=asset.hf_repo, allow_patterns=patterns, local_dir=str(target_dir))
    else:
        log(f"[download] modelscope {asset.ms_repo} {patterns} -> {target_dir}")
        try:
            from modelscope import snapshot_download
        except ImportError as exc:
            raise RuntimeError("ModelScope 下载需要 modelscope 依赖，请先安装 requirements.txt") from exc

        snapshot_download(asset.ms_repo, allow_patterns=patterns, local_dir=str(target_dir))
    if not asset_dir_complete(asset, target_dir):
        raise FileNotFoundError(f"下载完成但目录缺少必要文件: {target_dir}")


def download_assets(
    train_type: str,
    items: list[dict],
    source: str,
    project_root: Path,
    log: Callable[[str], None],
) -> None:
    """Download selected asset keys to their target paths. Runs inside a task thread."""
    assets = {asset.key: asset for asset in manifest_for(train_type)}
    for item in items:
        asset = assets.get(str(item.get("key")))
        if asset is None:
            raise ValueError(f"未知资产: {item.get('key')}")
        if asset.kind == "dir":
            target_dir = _target_path(str(item.get("path") or asset.default_path), project_root)
            _download_dir_asset(asset, source, target_dir, log)
            log(f"[done] {asset.label}")
            if asset.key == "tokenizer":
                normalize_tokenizer_config(target_dir, log)
            if train_type == "krea2-lora" and asset.key == "tokenizer":
                patch_krea2_tokenizer_everywhere(project_root, log)
            elif train_type == "ideogram4-lora" and asset.key == "tokenizer":
                patch_ideogram4_everywhere(project_root, log)
            continue
        target = _target_path(str(item.get("path") or asset.default_path), project_root)
        target.parent.mkdir(parents=True, exist_ok=True)
        if source == "huggingface":
            if not (asset.hf_repo and asset.hf_file):
                raise ValueError(f"{asset.label} 未配置 HuggingFace 下载源")
            log(f"[download] huggingface {asset.hf_repo}/{asset.hf_file} -> {target}")
            from huggingface_hub import hf_hub_download

            downloaded = Path(hf_hub_download(repo_id=asset.hf_repo, filename=asset.hf_file, local_dir=str(target.parent)))
        elif source == "modelscope":
            if not (asset.ms_repo and asset.ms_file):
                raise ValueError(f"{asset.label} 未配置 ModelScope 下载源")
            log(f"[download] modelscope {asset.ms_repo}/{asset.ms_file} -> {target}")
            try:
                from modelscope import snapshot_download
            except ImportError as exc:
                raise RuntimeError("ModelScope 下载需要 modelscope 依赖，请先安装 requirements.txt") from exc

            snapshot_download(asset.ms_repo, allow_patterns=[asset.ms_file], local_dir=str(target.parent))
            downloaded = target.parent / asset.ms_file
        else:
            raise ValueError(f"未知下载源: {source}")
        if downloaded.resolve() != target:
            if not downloaded.is_file():
                raise FileNotFoundError(f"下载完成但未找到文件: {downloaded}")
            downloaded.replace(target)
        log(f"[done] {asset.label} -> {target}")


def start_download_task(train_type: str, items: list[dict], source: str, project_root: Path) -> tuple[str, dict]:
    import threading
    import uuid

    from mikazuki.tasks import LANE_MAINTENANCE, tm
    from mikazuki.train_log_hub import hub as train_log_hub

    task_id = f"assets-download-{uuid.uuid4()}"
    task = tm.create_task(
        ["assets-download"],
        os.environ.copy(),
        metadata={"kind": "assets_download", "train_type": train_type, "source": source, "items": items},
        cwd=str(project_root),
        task_id=task_id,
        lane=LANE_MAINTENANCE,
    )
    task.start_log_only()

    def runner() -> None:
        def log(line: str) -> None:
            train_log_hub.append_line(task_id, line)

        try:
            log(f"[start] asset download via {source} ({train_type})")
            from mikazuki.networking.process import download_models
            download_models(train_type, items, source, project_root, log)
            task.finish_log_only(0, None)
        except (Exception, KeyboardInterrupt) as exc:
            log(f"[error] {exc}")
            task.finish_log_only(1, exc)

    threading.Thread(target=runner, daemon=True).start()
    return task_id, {
        "task_id": task_id,
        "log_stream": f"/api/train/log/stream/{task_id}",
    }

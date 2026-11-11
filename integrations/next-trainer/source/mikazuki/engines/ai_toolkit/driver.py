"""ai-toolkit run.py driver: apply pack-side overrides, then hand off to upstream.

Runs inside the extension venv with cwd = toolkit source root (launcher
contract). Binds Klein's class-level TE path, SDXL/SD 1.5 local single-file
configs, Qwen's native component loaders and Ideogram 4's Comfy single files
before handing off. No weights are copied or rewritten. The upstream run.py
receives the training seed through SEED.
"""

from __future__ import annotations

import os
import runpy
import sys
from pathlib import Path

_MODULE_DIR = str(Path(__file__).resolve().parent)
if _MODULE_DIR not in sys.path:
    sys.path.insert(0, _MODULE_DIR)


def local_component_loader(model_class, path, config_dir):
    """Bind a native v2 loader to explicit files for this training subprocess."""
    original = model_class.load_model.__func__

    def load(cls, name_or_path, *args, **kwargs):
        kwargs['config_path'] = config_dir
        kwargs['use_comfy_weights'] = False
        kwargs['local_files_only'] = True
        return original(cls, path, *args, **kwargs)

    model_class.load_model = classmethod(load)


def preserve_qwen_reference_size(encoder_class):
    original = encoder_class.load_processor.__func__

    def load(cls, *args, **kwargs):
        processor = original(cls, *args, **kwargs)
        # Qwen already grid-resizes references for both TE and VAE. The
        # processor's minimum-area resize would change only the TE slot count.
        processor.image_processor.do_resize = False
        return processor

    encoder_class.load_processor = classmethod(load)


def apply_ideogram4_comfy_inputs(sources: dict) -> None:
    """Hand the extension the Comfy-Org single-file components in place.

    The pinned extension reads its DiT/VAE from a diffusers directory and its
    text encoder from identity kwargs; it registers no comfy weight candidates,
    so `use_comfy_weights` never applies here. Two module-level hooks are enough
    to feed it the unmodified Comfy files (see ideogram4_comfy.py):

    * `_load_component_state_dict` reads the job's Comfy files, normalizing the
      FP8 `weight_scale` layout and dropping `comfy_quant` markers;
    * `convert_diffusers_state_dict` tolerates the original (LDM) Flux2 VAE key
      layout the Comfy file already uses.

    Nothing is written to disk and `base`/`basename` stay untouched for the
    diffusers-directory path.
    """
    from ideogram4_comfy import (
        comfy_component_state_dict,
        comfy_text_encoder_loader,
        is_original_vae_state_dict,
    )

    from extensions_built_in.diffusion_models.ideogram4 import ideogram4 as ideogram4_ext

    original_loader = ideogram4_ext._load_component_state_dict
    original_convert = ideogram4_ext.convert_diffusers_state_dict

    def load_component_state_dict(base, subfolder, basename):
        source = sources.get(subfolder)
        if not source:
            return original_loader(base, subfolder, basename)
        return comfy_component_state_dict(source, subfolder)

    def convert_diffusers_state_dict(state_dict):
        if is_original_vae_state_dict(state_dict):
            return state_dict
        return original_convert(state_dict)

    ideogram4_ext._load_component_state_dict = load_component_state_dict
    ideogram4_ext.convert_diffusers_state_dict = convert_diffusers_state_dict
    # Comfy FP8 text encoder: tokenizer/config from a directory, weights from the
    # single file (upstream's one-path-for-both does not accept a file here).
    ideogram4_ext._load_text_encoder = comfy_text_encoder_loader(ideogram4_ext._load_text_encoder)


def apply_local_inputs(model):
    options = model.get('model_kwargs', {})
    if model.get('arch') == 'sdxl' and options.get('next_trainer_sdxl_config'):
        from diffusers import StableDiffusionXLPipeline
        original = StableDiffusionXLPipeline.from_single_file.__func__

        def load(cls, path, **kwargs):
            return original(cls, path, config=options['next_trainer_sdxl_config'], local_files_only=True, **kwargs)

        StableDiffusionXLPipeline.from_single_file = classmethod(load)
    if model.get('arch') == 'sd1' and options.get('next_trainer_sd15_config'):
        # Comfy/LDM single-file SD 1.5: bind the local diffusers config dir so
        # the offline launch never fetches pipeline configs from the Hub.
        from diffusers import StableDiffusionPipeline
        original = StableDiffusionPipeline.from_single_file.__func__

        def load(cls, path, **kwargs):
            # Upstream passes load_safety_checker=False, which diffusers still
            # treats as "fetch CompVis/stable-diffusion-safety-checker"; drop it
            # so a single-file run stays fully local. The pack config dir and
            # local-only mode always win over job-supplied duplicates.
            kwargs.pop('load_safety_checker', None)
            kwargs.pop('config', None)
            kwargs.pop('local_files_only', None)
            return original(cls, path, config=options['next_trainer_sd15_config'], local_files_only=True, **kwargs)

        StableDiffusionPipeline.from_single_file = classmethod(load)
    components = options.get('next_trainer_components')
    if model.get('arch') == 'qwen_image_2':
        from extensions_built_in.diffusion_models.qwen_image_2.qwen_image_2 import (
            QwenImage21Transformer2DModel, QwenImage21TextEncoder, AutoencoderKLQwenImage21,
        )
        preserve_qwen_reference_size(QwenImage21TextEncoder)
        if components:
            for key, cls in [('transformer', QwenImage21Transformer2DModel), ('text_encoder', QwenImage21TextEncoder), ('vae', AutoencoderKLQwenImage21)]:
                local_component_loader(cls, components[key], model['extras_name_or_path'])
    if model.get('arch') == 'ideogram4' and options.get('next_trainer_comfy_components'):
        apply_ideogram4_comfy_inputs(options['next_trainer_comfy_components'])


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: driver.py <config.yaml> [run.py args...]")
    root = Path.cwd().resolve()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    import yaml
    job = yaml.safe_load(Path(sys.argv[1]).read_text(encoding='utf-8'))
    model = job['config']['process'][0]['model']
    # Upstream run.py consumes SEED from the environment, not TrainConfig.seed.
    os.environ['SEED'] = str(job['config']['process'][0]['train']['seed'])
    te_path = os.environ.get("AI_TOOLKIT_TE_PATH", "").strip()
    if te_path and model.get('arch', '').startswith('flux2_klein_'):
        from extensions_built_in.diffusion_models.flux2 import Flux2Klein4BModel, Flux2Klein9BModel

        Flux2Klein4BModel.flux2_klein_te_path = te_path
        Flux2Klein9BModel.flux2_klein_te_path = te_path

    apply_local_inputs(model)

    sys.argv = ["run.py", *sys.argv[1:]]
    runpy.run_path(str(root / "run.py"), run_name="__main__")


if __name__ == "__main__":
    main()

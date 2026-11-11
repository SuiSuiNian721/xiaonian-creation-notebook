"""Local, model-backed captions with explicit training-format policies."""
import importlib.util
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import uuid
from workbench_preprocess import atomic_json, dataset_manifest, file_hash, item_path, no_links

FLORENCE_REPOSITORY = "florence-community/Florence-2-base"
FLORENCE_REVISION = "00921df66db728a9ceb750f5eca43e5c203a2051"
STYLE_TAGS = {"watercolor", "watercolor (medium)", "oil painting", "sketch", "lineart", "traditional media", "digital media", "monochrome", "greyscale", "flat color", "graphite (medium)", "pencil (medium)", "ink (medium)", "photorealistic", "realistic"}
TAGGER_DEFAULTS = {"download_endpoint": "", "threshold": 0.35, "character_threshold": 0.6, "add_rating_tag": False, "add_model_tag": False, "additional_tags": "", "replace_underscore": True, "escape_tag": True, "batch_input_recursive": True, "batch_output_action_on_conflict": "ignore"}
UNDERSCORE_EXCLUDES = "0_0, (o)_(o), +_+, +_-, ._., <o>_<o>, <|>_<|>, =_=, >_<, 3_3, 6_9, >_o, @_@, ^_^, o_o, u_u, x_x, |_|, ||_||"


def normalize_tagger_options(config):
    raw = config.get("taggerOptions", {})
    if not isinstance(raw, dict) or set(raw) - set(TAGGER_DEFAULTS):
        raise ValueError("打标参数包含未知字段或格式无效。")
    options = {**TAGGER_DEFAULTS, **raw}
    if "batch_output_action_on_conflict" not in raw and config.get("policy") == "regenerate":
        options["batch_output_action_on_conflict"] = "copy"
    if options["download_endpoint"] == "默认":
        options["download_endpoint"] = ""
    for key in ("threshold", "character_threshold"):
        value = options[key]
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not 0 <= value <= 1:
            raise ValueError(f"打标参数 {key} 须为 0 到 1 的数值。")
    for key in ("add_rating_tag", "add_model_tag", "replace_underscore", "escape_tag", "batch_input_recursive"):
        if type(options[key]) is not bool:
            raise ValueError(f"打标参数 {key} 须为布尔值。")
    if not isinstance(options["download_endpoint"], str) or options["download_endpoint"] not in {"", "https://hf-mirror.com", "https://modelscope.cn"} or not isinstance(options["batch_output_action_on_conflict"], str) or options["batch_output_action_on_conflict"] not in {"ignore", "copy", "prepend", "append"}:
        raise ValueError("打标下载源或已有标签处理方式无效。")
    tags = options["additional_tags"]
    if not isinstance(tags, str) or len(tags) > 4000 or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", tags):
        raise ValueError("附加标签无效或过长。")
    return options


def reuse_caption(config, item, existing):
    if item.get("requiresCaption") or not caption_is_compatible(existing, config.get("captionFormat", "tags")):
        return False
    if config.get("captionFormat", "tags") == "tags" and "taggerOptions" in config:
        return normalize_tagger_options(config)["batch_output_action_on_conflict"] == "ignore" or config.get("policy") == "existing"
    return config.get("policy") != "regenerate"


def caption_receipt(config, directory, item, current_hash):
    """A durable intent before replace makes interrupted prepend/append retryable.

    Receipts bind the caption operation, options, image and before/after caption
    bytes. They do not mark the dataset complete or alter its original manifest.
    """
    operation_id = config.get("captionOperationId") or config.get("requestId")
    if not operation_id:
        return None, False
    inputs = {key: config.get(key) for key in ("model", "policy", "purpose", "trigger", "captionFormat", "captionModelPath", "taggerOptions")}
    inputs["operationId"] = operation_id
    fingerprint = hashlib.sha256(json.dumps(inputs, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    name = hashlib.sha256(item["name"].encode("utf-8")).hexdigest() + ".json"
    path = directory.parent / "caption-checkpoints" / fingerprint / name
    if not path.exists():
        return path, False
    no_links(path)
    if path.stat().st_size > 16384:
        raise ValueError("标注恢复记录过大。")
    record = json.loads(path.read_text(encoding="utf-8"))
    if record.get("operationId") != operation_id or record.get("name") != item["name"] or record.get("imageSha256") != item["sha256"] or not isinstance(record.get("afterSha256"), str):
        raise ValueError("标注恢复记录校验失败。")
    if current_hash == record["afterSha256"]:
        return path, True
    if current_hash != record.get("beforeSha256"):
        raise ValueError("工作标注已改变，与恢复记录不匹配。")
    return path, False


def read_caption(path):
    if not path.exists():
        return "", None
    no_links(path)
    if not path.is_file() or path.stat().st_size > 128 * 1024:
        raise ValueError("工作标注不是普通文件或超过 128 KiB。")
    content = path.read_bytes()
    return content.decode("utf-8-sig").strip(), hashlib.sha256(content).hexdigest()


def caption_is_compatible(text, format):
    text = text.strip()
    if not text:
        return False
    fragments = [part.strip() for part in text.split(",") if part.strip()]
    taglike = len(fragments) >= 3 and sum(len(part.split()) <= 4 for part in fragments) >= len(fragments) * 0.75 and not re.search(r"\b(?:is|are|wearing|depicts|shows)\b", text, re.I)
    sentence = len(text.split()) >= 5 and bool(re.search(r"\b(?:a|an|the|is|are|with|in|on|at|of|beside)\b", text, re.I) or re.search(r"[.!?]$", text))
    if re.search(r"[\u4e00-\u9fff]{6,}", text):
        sentence = True
    return (sentence and not taglike) if format == "natural" else not sentence or taglike


def normalize_tags(tags, purpose, character_names=()):
    excluded = STYLE_TAGS if purpose == "style" else set()
    characters = {value.replace("_", " ").lower() for value in character_names} if purpose != "style" else set()
    output = []
    for value in tags:
        value = " ".join(str(value).strip().split())
        key = value.replace("_", " ").lower()
        if value and key not in excluded and key not in characters and value not in output:
            output.append(value)
    return output


def format_caption(text, trigger, format, purpose):
    if format == "tags":
        values = normalize_tags(text.split(","), purpose)
        if trigger:
            values = [value for value in values if value != trigger]
            values.insert(0, trigger)
        return ", ".join(values)
    text = " ".join(text.strip().split())
    if purpose == "style":
        content = re.sub(r"^(?:a|an|the)\s+(?:(?:watercolor|oil|digital|traditional|black and white)\s+)*(?:painting|illustration|drawing|sketch|photograph)\s+of\s+", "", text, flags=re.I)
        if content != text:
            text = "The image shows " + content
    return (trigger + ". " + text) if trigger and not text.startswith(trigger + ".") else text


def caption_needs_model(config):
    normalize_tagger_options(config)
    directory = Path(config["path"])
    manifest = json.loads((directory.parent / "dataset-manifest.json").read_text(encoding="utf-8"))
    for item in manifest["items"]:
        path = item_path(directory, item["name"]).with_suffix(".txt")
        existing, current_hash = read_caption(path)
        _, resumed = caption_receipt(config, directory, item, current_hash)
        if item.get("captionSha256") and current_hash != item["captionSha256"] and not resumed:
            raise ValueError("工作标注已改变，校验失败。")
        if not resumed and not reuse_caption(config, item, existing):
            return True
    return False


def caption_capabilities(config, data_root):
    required = {"torch": "torch", "transformers": "transformers", "Pillow": "PIL", "safetensors": "safetensors"}
    missing = [name for name, module in required.items() if importlib.util.find_spec(module) is None]
    if missing:
        return {"ok": False, "reason": "本地自然语言描述 Python 缺少：" + "、".join(missing), "missing": missing}
    spec = importlib.util.find_spec("transformers")
    if not (Path(next(iter(spec.submodule_search_locations))) / "models" / "florence2" / "modeling_florence2.py").is_file():
        return {"ok": False, "reason": "当前 Transformers 没有内置 Florence2；请选择已有兼容环境，不执行远程自定义代码。"}
    directory = Path(config.get("captionModelPath") or (Path(data_root) / "preprocess-models" / "florence2-base"))
    files = ["config.json", "model.safetensors", "preprocessor_config.json", "tokenizer_config.json", "tokenizer.json"]
    absent = [name for name in files if not (directory / name).is_file()]
    if absent and not (config.get("allowDownload") and not config.get("captionModelPath")):
        recovery = "请补齐指定目录，或清空“描述模型目录”并开启“下载标注与裁切模型”，再重新建立流程以下载到工作台缓存。" if config.get("captionModelPath") else "请补齐此目录，或开启“下载标注与裁切模型”后重新建立流程。"
        return {"ok": False, "modelReady": False, "reason": f"本地 Florence-2 描述模型缺少 {', '.join(absent)}。目录：{directory}。{recovery}", "missingFiles": absent}
    if not absent:
        model_config = json.loads((directory / "config.json").read_text(encoding="utf-8"))
        if model_config.get("model_type") != "florence2" or model_config.get("image_token_id") is None:
            return {"ok": False, "reason": "描述模型目录不是原生 Florence2 格式；请使用 florence-community/Florence-2-base，不能用训练底模或旧远程代码版替代。"}
    return {"ok": True, "modelReady": not absent, "modelPath": str(directory)}


class FlorenceCaptioner:
    def __init__(self, config):
        check = caption_capabilities(config, config["dataRoot"])
        if not check["ok"]:
            raise ValueError(check["reason"])
        directory = check["modelPath"]
        if not check["modelReady"]:
            from huggingface_hub import snapshot_download
            snapshot_download(FLORENCE_REPOSITORY, revision=FLORENCE_REVISION, local_dir=directory, allow_patterns=["*.json", "*.txt", "LICENSE", "model.safetensors"])
        # From here on, model and tokenizer reads must stay local. Use built-in
        # classes and safetensors, never a repository's custom Python files.
        os.environ["HF_HUB_OFFLINE"] = "1"
        import torch
        from transformers import Florence2ForConditionalGeneration, Florence2Processor
        torch.set_num_threads(4)
        self.torch = torch
        self.processor = Florence2Processor.from_pretrained(directory, local_files_only=True)
        self.model = Florence2ForConditionalGeneration.from_pretrained(directory, local_files_only=True, use_safetensors=True, dtype=torch.float32, attn_implementation="eager").to("cpu").eval()

    def __call__(self, image):
        task = "<DETAILED_CAPTION>"
        inputs = self.processor(text=task, images=image, return_tensors="pt")
        with self.torch.inference_mode():
            output = self.model.generate(**inputs, max_new_tokens=192, num_beams=3, do_sample=False)
        text = self.processor.batch_decode(output, skip_special_tokens=False)[0]
        result = self.processor.post_process_generation(text, task=task, image_size=image.size)
        caption = result.get(task)
        if not isinstance(caption, str) or not caption.strip():
            raise ValueError("本地描述模型没有返回有效自然语言。")
        return caption


class WD14Captioner:
    def __init__(self, config):
        os.environ["MIKAZUKI_TAGGER_ORT_PROVIDERS"] = "cpu"
        from mikazuki.tagger.interrogator import available_interrogators
        from mikazuki.tagger.model_fetch import ensure_interrogator_assets, interrogator_assets_ready, use_download_endpoint
        from mikazuki.tagger.interrogators.base import Interrogator
        self.options = normalize_tagger_options(config)
        self.interrogator = copy.copy(available_interrogators[config["model"]])
        if not config.get("allowDownload"):
            os.environ["HF_HUB_OFFLINE"] = "1"
            self.interrogator.kwargs = {**getattr(self.interrogator, "kwargs", {}), "local_files_only": True}
        with use_download_endpoint(self.options["download_endpoint"] if config.get("allowDownload") else ""):
            if not interrogator_assets_ready(self.interrogator, config["model"]):
                if not config.get("allowDownload"):
                    raise ValueError("本地标签模型未就绪，不能联网下载。")
                ensure_interrogator_assets(config["model"], self.interrogator)
            self.interrogator.load()
        self.postprocess = Interrogator.postprocess_tags
        self.character_names = []
        table = getattr(self.interrogator, "tags", None)
        if hasattr(table, "columns") and "category" in table.columns:
            self.character_names = table.loc[table["category"] == 4, "name"].tolist()
        elif isinstance(table, tuple) and len(table) == 3 and isinstance(table[2], dict):
            self.character_names = [name for name, category in table[2].items() if category == "Character"]

    def __call__(self, image):
        tags = self.interrogator.interrogate(image)
        options = self.options
        return list(self.postprocess(tags, threshold=options["threshold"], character_threshold=options["character_threshold"], add_rating_tag=options["add_rating_tag"], add_model_tag=options["add_model_tag"], additional_tags=[tag.strip() for tag in options["additional_tags"].split(",") if tag.strip()], replace_underscore=options["replace_underscore"], replace_underscore_excludes=[tag.strip() for tag in UNDERSCORE_EXCLUDES.split(",")], escape_tag=options["escape_tag"]))


def caption_dataset(config, owner, generator=None, progress=None):
    options = normalize_tagger_options(config)
    directory, manifest_path, manifest = dataset_manifest(config["path"], owner)
    format = config.get("captionFormat", "tags")
    purpose, trigger = config.get("purpose", "character"), config.get("trigger", "")
    if format not in {"tags", "natural"} or purpose not in {"character", "style", "pose"}:
        raise ValueError("标注策略无效。")
    generated, reused, warnings = 0, 0, []
    for index, item in enumerate(manifest["items"]):
        image_path = item_path(directory, item["name"])
        if file_hash(image_path) != item["sha256"]:
            raise ValueError("图像已改变，不能使用旧标注继续训练。")
        caption_path = image_path.with_suffix(".txt")
        existing, before_hash = read_caption(caption_path)
        receipt_path, resumed = caption_receipt(config, directory, item, before_hash)
        if item.get("captionSha256") and before_hash != item["captionSha256"] and not resumed:
            raise ValueError("工作标注已改变，校验失败。")
        can_reuse = resumed or reuse_caption(config, item, existing)
        native_options = format == "tags" and "taggerOptions" in config
        if can_reuse:
            text = existing
            reused += 1
        else:
            if config.get("policy") == "existing":
                raise ValueError(f"{item['name']} 需要重新标注，但当前仅允许已有标注。")
            if generator is None:
                generator = FlorenceCaptioner(config) if format == "natural" else WD14Captioner(config)
            from PIL import Image, ImageOps
            from workbench_vision import inference_image
            with Image.open(image_path) as raw:
                prediction = generator(inference_image(ImageOps.exif_transpose(raw)))
            if format == "tags":
                if not isinstance(prediction, (list, tuple)):
                    raise ValueError("标签模型没有返回标签列表。")
                text = ", ".join(normalize_tags(prediction, "character" if native_options else purpose, () if native_options else getattr(generator, "character_names", ())))
                if "taggerOptions" in config and existing and not item.get("requiresCaption"):
                    if options["batch_output_action_on_conflict"] == "prepend":
                        text = text + ", " + existing
                    elif options["batch_output_action_on_conflict"] == "append":
                        text = existing + ", " + text
            else:
                if not isinstance(prediction, str) or not caption_is_compatible(prediction, "natural"):
                    raise ValueError(f"{item['name']} 没有得到有效自然语言，已阻止以标签串替代。")
                text = prediction
            generated += 1
        text = existing if resumed else format_caption(text, trigger, format, "character" if native_options else purpose)
        if not text.strip():
            raise ValueError("策略处理后标注为空。")
        if file_hash(image_path) != item["sha256"]:
            raise ValueError("生成标注期间图像发生改变，不能提交旧画面的标注。")
        if read_caption(caption_path)[1] != before_hash:
            raise ValueError("生成标注期间工作标注发生改变，已停止写入。")
        if not resumed:
            content = (text + "\n").encode("utf-8")
            if len(content) > 128 * 1024:
                raise ValueError("生成的标注超过 128 KiB。")
            if receipt_path is not None:
                # Walk only newly created, fixed-named receipt directories.
                # Reject links before mkdir can follow an existing component.
                for folder in (receipt_path.parent.parent, receipt_path.parent):
                    if folder.exists():
                        no_links(folder)
                    else:
                        no_links(folder.parent)
                        folder.mkdir()
                atomic_json(receipt_path, {"operationId": config.get("captionOperationId") or config.get("requestId"), "requestId": config.get("requestId"), "name": item["name"], "imageSha256": item["sha256"], "beforeSha256": before_hash, "afterSha256": hashlib.sha256(content).hexdigest()})
            temporary = caption_path.with_name(caption_path.name + ".tmp-" + uuid.uuid4().hex)
            try:
                with temporary.open("xb") as output:
                    output.write(content)
                no_links(caption_path.parent)
                if caption_path.exists():
                    no_links(caption_path)
                os.replace(temporary, caption_path)
            finally:
                temporary.unlink(missing_ok=True)
        item.update(requiresCaption=False, captionFormat=format, captionPurpose=purpose, captionImageSha256=item["sha256"], captionSha256=file_hash(caption_path))
        if progress:
            progress(index + 1, len(manifest["items"]), item["name"])
    result = {"complete": True, "requestId": config.get("requestId"), "format": format, "generatedCount": generated, "reusedCount": reused, "model": "florence2-base" if format == "natural" else config.get("model"), "warnings": warnings}
    manifest["captions"] = result
    atomic_json(manifest_path, manifest)
    return result


if __name__ == "__main__":
    import sys
    if sys.argv[1:] == ["--check"]:
        payload = json.load(sys.stdin)
        print(json.dumps(caption_capabilities(payload["config"], payload["dataRoot"]), ensure_ascii=True))

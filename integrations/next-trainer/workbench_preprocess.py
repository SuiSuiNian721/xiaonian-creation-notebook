"""Owned dataset operations shared by local crop and caption workers."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import uuid

DWPOSE_REVISION = "1a7144101628d69ee7a3768d1ee3a094070dc388"


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def no_links(path):
    for component in (Path(path), *Path(path).parents):
        if component.is_symlink() or getattr(component.lstat(), "st_file_attributes", 0) & 0x400:
            raise ValueError("工作副本路径不能经过链接或目录联接。")


def dataset_manifest(path, owner):
    directory = Path(path)
    if not directory.is_absolute() or str(directory).startswith("\\\\") or directory.name != "images":
        raise ValueError("仅接受当前流程的本地 images 工作目录。")
    no_links(directory)
    manifest_path = directory.parent / "dataset-manifest.json"
    no_links(manifest_path)
    if manifest_path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("图集清单过大。")
    value = json.loads(manifest_path.read_text(encoding="utf-8"))
    if value.get("owner") != owner or Path(value.get("imageDir", "")).resolve() != directory.resolve() or not isinstance(value.get("items"), list):
        raise ValueError("数据集清单不属于当前流程实例。")
    return directory, manifest_path, value


def item_path(directory, name):
    if not isinstance(name, str) or "\\" in name or ":" in name or any(part in {".", ".."} for part in name.split("/")) or PurePosixPath(name).is_absolute():
        raise ValueError("素材相对路径无效。")
    path = directory / name
    no_links(path)
    try:
        path.resolve().relative_to(directory.resolve())
    except ValueError:
        raise ValueError("素材路径越出当前工作副本。") from None
    if not path.is_file() or path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
        raise ValueError("素材不是支持的普通图像。")
    return path


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def crop_capabilities(config, environment_root, data_root):
    if config.get("cropMode") == "preserve":
        return {"ok": True, "modelReady": True, "mode": "preserve"}
    missing = [name for name in ("numpy", "cv2", "onnxruntime", "PIL") if importlib.util.find_spec(name) is None]
    if missing:
        return {"ok": False, "reason": "本地裁切 Python 缺少：" + "、".join(missing), "missing": missing}
    default = Path(data_root) / "preprocess-models" / "dwpose"
    candidates = [Path(config["detectorPath"])] if config.get("detectorPath") else [default, Path(environment_root) / "tagger-models" / "dwpose"]
    for directory in candidates:
        if all((directory / name).is_file() for name in ("yolox_l.onnx", "dw-ll_ucoco_384.onnx")):
            return {"ok": True, "modelReady": True, "modelPath": str(directory)}
    if config.get("allowDownload") and not config.get("detectorPath"):
        return {"ok": True, "modelReady": False, "modelPath": str(default)}
    recovery = "请补齐指定目录，或清空“裁切模型目录”并开启“下载标注与裁切模型”，再重新建立流程以下载到工作台缓存。" if config.get("detectorPath") else "请补齐此目录，或开启“下载标注与裁切模型”后重新建立流程。"
    return {"ok": False, "modelReady": False, "reason": f"裁切模型缺少 yolox_l.onnx 与 dw-ll_ucoco_384.onnx。目录：{candidates[0]}。{recovery}"}


def ensure_crop_models(config, environment_root, data_root):
    result = crop_capabilities(config, environment_root, data_root)
    if not result["ok"]:
        raise ValueError(result["reason"])
    if not result.get("modelReady"):
        from huggingface_hub import hf_hub_download
        directory = Path(result["modelPath"])
        directory.mkdir(parents=True, exist_ok=True)
        for filename in ("yolox_l.onnx", "dw-ll_ucoco_384.onnx"):
            hf_hub_download("yzd-v/DWPose", filename, revision=DWPOSE_REVISION, local_dir=directory)
    return result.get("modelPath")


def crop_dataset(config, owner, detector=None, progress=None):
    from PIL import Image, ImageOps
    from workbench_vision import crop_regions, DWPoseDetector, inference_image
    directory, manifest_path, manifest = dataset_manifest(config["path"], owner)
    mode = config.get("cropMode", "preserve")
    if mode not in {"character", "pose", "preserve"}:
        raise ValueError("裁切策略无效。")
    previous = manifest.get("processing", {})
    if previous.get("requestId") == config.get("requestId") and previous.get("complete"):
        for item in manifest["items"]:
            if file_hash(item_path(directory, item["name"])) != item["sha256"]:
                raise ValueError("已处理副本的像素文件发生变化。")
        return previous
    if mode != "preserve" and detector is None:
        models = ensure_crop_models(config, config["environmentRoot"], config["dataRoot"])
        detector = DWPoseDetector(models)
    originals = [item for item in manifest["items"] if item.get("kind", "original") == "original"]
    staging = directory.parent / ("crop-staging-" + uuid.uuid4().hex)
    staging.mkdir()
    folder_name = "crops-" + uuid.uuid4().hex[:12]
    generated, warnings = [], []
    for index, item in enumerate(originals):
        path = item_path(directory, item["name"])
        if file_hash(path) != item["sha256"]:
            raise ValueError("原始工作副本发生变化，请重新建立流程。")
        with Image.open(path) as raw:
            # Orientation is applied only to the new crop. Originals stay byte-exact.
            image = ImageOps.exif_transpose(raw)
            people = detector.detect(inference_image(image)) if mode != "preserve" else []
            regions, review = crop_regions(image.size, people, mode)
            warnings.extend({"image": item["name"], "reason": reason} for reason in review)
            for ordinal, region in enumerate(regions):
                name = f"{index + 1:06d}-{region['kind']}-{ordinal}.png"
                target = staging / name
                image.convert("RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB").crop(tuple(region["box"])).save(target, format="PNG")
                generated.append({"name": folder_name + "/" + name, "sha256": file_hash(target), "kind": region["kind"], "source": item.get("source", item["name"]), "generatedFrom": item["name"], "cropBox": region["box"], "requiresCaption": True})
        if progress:
            progress(index + 1, len(originals), item["name"])
    if generated:
        destination = directory / folder_name
        os.replace(staging, destination)
    else:
        staging.rmdir()
    # Only after every image succeeds does the manifest expose derived files.
    manifest["items"] = originals + generated
    reviews = {}
    for warning in warnings:
        reviews.setdefault(warning["image"], []).append(warning["reason"])
    result = {"complete": True, "requestId": config.get("requestId"), "originalCount": len(originals), "derivedCount": len(generated), "imageCount": len(originals) + len(generated), "reviewCount": len(reviews), "reviews": [{"image": image, "reasons": reasons} for image, reasons in list(reviews.items())[:100]], "cropMode": mode}
    manifest["processing"] = result
    atomic_json(manifest_path, manifest)
    return result

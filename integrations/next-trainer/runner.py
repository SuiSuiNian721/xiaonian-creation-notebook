"""Workbench API-only adapter for the verified Next Trainer controller snapshot.

No GUI, plugin startup, dependency preparation, installer, or Torch import runs
at startup. Maintenance is explicit; training is dispatched from this app root.
"""
import argparse
import asyncio
from contextlib import asynccontextmanager
import contextvars
from datetime import datetime
import hmac
import importlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import types
import uuid

TAGGER_MODELS = {
    "wd14-convnextv2-v2": ("SmilingWolf/wd-v1-4-convnextv2-tagger-v2", "v2.0"),
    "wd-convnext-v3": ("SmilingWolf/wd-convnext-tagger-v3", "main"),
    "wd-swinv2-v3": ("SmilingWolf/wd-swinv2-tagger-v3", "main"),
    "wd-vit-v3": ("SmilingWolf/wd-vit-tagger-v3", "main"),
    "wd14-swinv2-v2": ("SmilingWolf/wd-v1-4-swinv2-tagger-v2", "v2.0"),
    "wd14-vit-v2": ("SmilingWolf/wd-v1-4-vit-tagger-v2", "v2.0"),
    "wd14-moat-v2": ("SmilingWolf/wd-v1-4-moat-tagger-v2", "v2.0"),
    "wd-eva02-large-tagger-v3": ("SmilingWolf/wd-eva02-large-tagger-v3", "main"),
    "wd-vit-large-tagger-v3": ("SmilingWolf/wd-vit-large-tagger-v3", "main"),
    "cl_tagger_1_01": ("cella110n/cl_tagger", "main"),
}

ENGINE_PACKAGES = {"kohya": "kohya", "anima-fast": "anima_fast", "musubi": "musubi", "ai-toolkit": "ai_toolkit", "diffsynth": "diffsynth", "moss": "moss"}


async def engine_route(engine_id, action, payload=None):
    """Only fixed app-snapshot controller modules are importable here."""
    package = ENGINE_PACKAGES.get(engine_id)
    if not package or action not in {"status", "preflight", "install", "repair"}:
        raise ValueError("未知训练引擎或操作。")
    module = importlib.import_module(f"mikazuki.engines.{package}.routes")
    handler = getattr(module, action)
    return await handler() if action == "status" else await handler(payload)


def tagger_workspace(config, owner):
    if not isinstance(config, dict):
        raise ValueError("打标配置须为对象。")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from workbench_caption import normalize_tagger_options
    normalize_tagger_options(config)
    if config.get("captionOperationId") is not None and (not isinstance(config["captionOperationId"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,159}", config["captionOperationId"])):
        raise ValueError("标注操作编号无效。")
    directory = Path(str(config.get("path") or ""))
    if not directory.is_absolute() or not directory.is_dir() or directory.name != "images":
        raise ValueError("打标只接受一键流程生成的 images 工作目录。")
    for item in (directory, *directory.parents):
        if item.is_symlink() or getattr(item, "is_junction", lambda: False)():
            raise ValueError("打标工作目录不能经过链接。")
    manifest_path = directory.parent / "dataset-manifest.json"
    if not manifest_path.is_file() or manifest_path.is_symlink() or manifest_path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("缺少受管数据集清单。")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("owner") != owner or Path(manifest.get("imageDir", "")).resolve() != directory.resolve():
        raise ValueError("打标图集不属于当前训练实例。")
    if config.get("model") not in TAGGER_MODELS or type(config.get("allowDownload")) is not bool or config.get("policy") not in {"fill-missing", "regenerate", "existing"} or config.get("captionFormat", "tags") not in {"tags", "natural"}:
        raise ValueError("打标方案无效。")
    for item in directory.rglob("*"):
        if item.is_symlink() or getattr(item.lstat(), "st_file_attributes", 0) & 0x400 or not (item.is_file() or item.is_dir()):
            raise ValueError("打标目录只能包含普通图像、标注及其目录。")
    return directory


def caption_resource_root(config, data_root):
    root = Path(config.get("captionResourceRoot") or data_root)
    if not root.is_absolute():
        raise ValueError("打标资源目录须为本地绝对路径。")
    return root


def tagger_capabilities(config, environment_root, data_root):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from workbench_caption import normalize_tagger_options
    normalize_tagger_options(config)
    manifest = json.loads((Path(config["path"]).parent / "dataset-manifest.json").read_text(encoding="utf-8")) if config.get("path") else {}
    if manifest.get("format", 1) >= 2:
        from workbench_caption import caption_needs_model
        if not caption_needs_model(config):
            return {"ok": True, "modelReady": True, "requiresModel": False, "pythonPath": sys.executable}
    if config.get("captionFormat") == "natural":
        python = Path(environment_root) / "extensions" / "kohya" / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        if not python.is_file():
            return {"ok": False, "reason": f"自然语言描述需要已有 Kohya Python：{python}"}
        result = subprocess.run([str(python), "-s", "-B", str(Path(__file__).resolve().parent / "workbench_caption.py"), "--check"], input=json.dumps({"config": config, "dataRoot": str(caption_resource_root(config, data_root))}), stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8", timeout=30, env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}, **({"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}))
        if result.returncode:
            return {"ok": False, "reason": "本地自然语言环境检查失败：" + result.stderr[-1200:]}
        value = json.loads(result.stdout.strip().splitlines()[-1])
        return {**value, "pythonPath": str(python), "requiresModel": True}
    required = {"numpy": "numpy", "pandas": "pandas", "Pillow": "PIL", "ONNX Runtime": "onnxruntime", "OpenCV": "cv2", "huggingface-hub": "huggingface_hub"}
    missing = [name for name, module in required.items() if importlib.util.find_spec(module) is None]
    if missing:
        return {"ok": False, "missing": missing, "reason": "打标 Python 环境缺少：" + "、".join(missing)}
    model = config["model"]
    if model not in TAGGER_MODELS:
        return {"ok": False, "reason": "未知本地打标模型。"}
    filenames = ("cl_tagger_1_01/model.onnx", "cl_tagger_1_01/tag_mapping.json") if model == "cl_tagger_1_01" else ("model.onnx", "selected_tags.csv")
    aliases = {"wd-vit-v3": ("wd14-vit-v3",), "wd14-moat-v2": ("wd-v1-4-moat-tagger-v2",)}
    roots = [Path(environment_root) / "tagger-models", Path(data_root) / "tagger-models"]
    if config.get("captionResourceRoot"):
        roots.insert(0, caption_resource_root(config, data_root) / "tagger-models")
    for root in roots:
        folders = [folder for name in (model, *aliases.get(model, ())) for folder in (root / "wd14" / name, root / name)]
        if any(all((folder / name).is_file() for name in filenames) for folder in folders):
            return {"ok": True, "modelReady": True, "modelsRoot": str(root)}
    from huggingface_hub import try_to_load_from_cache
    repo, revision = TAGGER_MODELS[model]
    cached = all(isinstance(try_to_load_from_cache(repo, name, revision=revision), str) for name in filenames)
    destination = caption_resource_root(config, data_root) / "tagger-models"
    if not cached and not config["allowDownload"]:
        return {"ok": False, "modelReady": False, "missingFiles": list(filenames), "reason": f"本地未找到 {model} 的 {' 与 '.join(filenames)}。请按相对路径放入 {destination / 'wd14' / model}，或启用下载缺失的打标模型。"}
    return {"ok": True, "modelReady": cached, "modelsRoot": str(destination)}


def run_processor_job(request_path, cropping=False):
    payload = json.loads(Path(request_path).read_text(encoding="utf-8"))
    if not payload["config"].get("allowDownload"):
        os.environ["HF_HUB_OFFLINE"] = "1"
    root = Path(__file__).resolve().parent
    os.chdir(root)
    sys.path.insert(0, str(root))
    from workbench_preprocess import atomic_json, dataset_manifest, crop_dataset
    from workbench_caption import caption_dataset
    config = {**payload["config"], "environmentRoot": payload["environmentRoot"], "dataRoot": str(caption_resource_root(payload["config"], payload["dataRoot"])), "requestId": payload["requestId"]}
    directory, _, manifest = dataset_manifest(config["path"], payload["owner"])
    progress_path = directory.parent / ("cropping-progress.json" if cropping else "tagging-progress.json")
    def progress(current, total, filename):
        values = {"current": current, "total": total, "filename": filename, "percent": round(current * 100 / max(total, 1))}
        atomic_json(progress_path, {"phase": "cropping" if cropping else "tagging", "message": "正在本地处理", "tagging": values})
        print(f"PROCESSING {current}/{total} {filename}", flush=True)
    try:
        if not cropping and config.get("captionFormat", "tags") == "tags":
            check = tagger_capabilities(config, payload["environmentRoot"], payload["dataRoot"])
            if not check["ok"]:
                raise ValueError(check["reason"])
            if check.get("modelsRoot"):
                os.environ["MIKAZUKI_TAGGER_MODELS_DIR"] = check["modelsRoot"]
        result = crop_dataset(config, payload["owner"], progress=progress) if cropping else caption_dataset(config, payload["owner"], progress=progress)
        atomic_json(progress_path, {"phase": "done", "message": "本地处理完成", "result": result, "tagging": {"current": len(manifest["items"]), "total": len(manifest["items"]), "percent": 100}})
    except Exception as error:
        atomic_json(progress_path, {"phase": "error", "error": str(error), "message": str(error)})
        raise


def run_tagging_job(request_path):
    payload = json.loads(Path(request_path).read_text(encoding="utf-8"))
    if not payload["config"].get("allowDownload"):
        os.environ["HF_HUB_OFFLINE"] = "1"
    root = Path(__file__).resolve().parent
    os.chdir(root)
    sys.path.insert(0, str(root))
    config = payload["config"]
    directory = tagger_workspace(config, payload["owner"])
    check = tagger_capabilities(config, payload["environmentRoot"], payload["dataRoot"])
    if not check["ok"]:
        raise RuntimeError(check["reason"])
    os.environ["MIKAZUKI_TAGGER_MODELS_DIR"] = check["modelsRoot"]
    from mikazuki.agent_tagger import TaggerJobRequest
    from mikazuki.tagger.jobs import run_interrogate_job
    from mikazuki.tagger.progress import tagger_progress
    from workbench_caption import normalize_tagger_options
    import threading
    progress_path = directory.parent / "tagging-progress.json"

    def save_progress():
        temporary = progress_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(tagger_progress.get(), ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, progress_path)

    finished = threading.Event()

    def report_progress():
        while not finished.wait(1):
            try:
                save_progress()
            except OSError:
                pass

    reporter = threading.Thread(target=report_progress, daemon=True)
    reporter.start()
    try:
        # The upstream batch glob and relative-output calculation must only see
        # this literal directory, never wildcard characters or duplicate images
        # segments from a profile's absolute path.
        os.chdir(directory.parent)
        options = normalize_tagger_options(config)
        # The old entry has no per-image manifest. Its original nonrecursive
        # default remains compatible unless native options were supplied.
        if "taggerOptions" not in config:
            options["batch_input_recursive"] = False
        if config["policy"] == "existing":
            options["batch_output_action_on_conflict"] = "ignore"
        request = TaggerJobRequest(path="images", interrogator_model=config["model"], **options)
        run_interrogate_job(request)
    finally:
        finished.set()
        reporter.join(timeout=2)
        save_progress()
    snapshot = tagger_progress.get()
    if snapshot.get("phase") != "done" or snapshot.get("error"):
        raise RuntimeError(snapshot.get("error") or snapshot.get("message") or "打标未完成。")
    prefix_tagging_captions(directory, config.get("trigger", ""), recursive=options["batch_input_recursive"])
    print("WORKBENCH_TAGGING_DONE " + json.dumps(snapshot, ensure_ascii=False), flush=True)


def prefix_tagging_captions(directory, trigger, recursive=False):
    """Keep user trigger text separate from WD14 tag normalization."""
    if not trigger:
        return
    for caption in (Path(directory).rglob("*.txt") if recursive else Path(directory).glob("*.txt")):
        if caption.is_symlink():
            raise ValueError("工作标注不能是链接。")
        text = caption.read_text(encoding="utf-8").strip()
        if text and text != trigger and not text.startswith(trigger + ","):
            caption.write_text(trigger + ", " + text + "\n", encoding="utf-8")


def protect_dataset(config, engine_id="kohya"):
    """Read-only counterpart of training-dataset-guard.mjs, before both API paths."""
    if engine_id not in ENGINE_PACKAGES:
        raise ValueError("未知训练引擎的数据集检查规则。")

    def local(value, label, directory=False, base=None):
        if not isinstance(value, str) or not value.strip() or re.search(r"[\x00-\x1f]", value) or value.startswith(("\\\\", "//")) or re.match(r"^[A-Za-z]:[^\\/]", value):
            raise ValueError(f"{label} 必须是本地绝对路径。")
        path = Path(value)
        if base is not None and not path.is_absolute():
            path = base / path
        if not path.is_absolute() or os.name == "nt" and ":" in str(path)[2:]:
            raise ValueError(f"{label} 不支持相对、设备或数据流路径。")
        for part in (*reversed(path.parents), path):
            if part.is_symlink() or getattr(part.lstat(), "st_file_attributes", 0) & 0x400:
                raise ValueError(f"{label} 不能经过链接或目录联接。")
        if not (path.is_dir() if directory else path.is_file()):
            raise ValueError(f"{label} 不存在或不是普通{'目录' if directory else '文件'}。")
        return path

    inspected = set()

    def tree(value, label):
        path = local(value, label, directory=True)
        if path in inspected:
            return path
        for entry in path.iterdir():
            if entry.is_symlink() or getattr(entry.lstat(), "st_file_attributes", 0) & 0x400:
                raise ValueError(f"{label} 中存在链接或目录联接。")
            if entry.is_dir():
                tree(str(entry), label)
        inspected.add(path)
        return path

    def directories(values, label, allow_lines=False):
        if values in (None, ""):
            return
        if allow_lines and isinstance(values, str):
            values = [line.strip() for line in values.splitlines() if line.strip()]
        if not isinstance(values, list):
            raise ValueError(f"{label} 必须是目录数组。")
        for value in values:
            tree(value, label)

    def text_file(value, label):
        path = local(value, label)
        if path.stat().st_size > 32 * 1024 * 1024:
            raise ValueError(f"{label} 超过 32 MiB。")
        return path.read_text(encoding="utf-8-sig")

    def kohya_metadata(value, image_dir=None):
        records = json.loads(text_file(value, "Kohya 元数据"))
        if not isinstance(records, dict):
            raise ValueError("Kohya 元数据必须是图像键到标注的对象。")
        for key in records:
            # Keep sd-scripts' literal-path/stem/NPZ fallback contract. Missing
            # candidates are normal, while any link/device path is not.
            for base in {Path.cwd(), Path(image_dir).absolute() if image_dir else Path.cwd()}:
                path = Path(key) if Path(key).is_absolute() else base / key
                stem = os.path.splitext(str(path))[0]
                candidates = {str(path), stem + ".npz", stem + "_flip.npz"}
                for suffix in (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".avif", ".jxl", ".npz", "_flip.npz"):
                    candidates.update((str(path) + suffix, str(path) + suffix.upper()))
                # Validate the raw key too, before Path normalizes its prefix.
                try:
                    local(key, "Kohya 元数据图像键", base=base)
                except FileNotFoundError:
                    pass
                for candidate in candidates:
                    try:
                        local(candidate, "Kohya 元数据图像键")
                    except FileNotFoundError:
                        pass

    if engine_id == "moss":
        preprocess = config.get("run_preprocess", True) not in (False, "false")
        if preprocess or config.get("src"):
            tree(config.get("src"), "src 数据集目录")
        if not preprocess:
            tree(config.get("cache_dir"), "cache_dir 缓存目录")
        return
    if engine_id == "diffsynth":
        if config.get("dataset_format", "image_text") == "metadata":
            import csv
            import io
            base = local(config.get("dataset_base_path"), "dataset_base_path", directory=True)
            text = text_file(config.get("dataset_metadata_path"), "dataset_metadata_path")
            suffix = Path(config["dataset_metadata_path"]).suffix.lower()
            if suffix == ".json":
                rows = json.loads(text)
            elif suffix == ".jsonl":
                rows = [json.loads(line) for line in text.splitlines() if line.strip()]
            elif suffix == ".csv":
                rows = list(csv.DictReader(io.StringIO(text, newline="")))
            else:
                raise ValueError("元数据仅支持 CSV / JSON / JSONL。")
            if not isinstance(rows, list) or not rows:
                raise ValueError("数据集元数据必须是非空记录列表。")
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get("image"), str) or not isinstance(row.get("prompt"), str):
                    raise ValueError("元数据记录需要 image 和 prompt 字符串。")
                local(row["image"], "元数据 image", base=base)
                if config.get("training_task") == "image-edit":
                    references = row.get("edit_image")
                    if isinstance(references, str):
                        references = json.loads(references) if references.lstrip().startswith("[") else [references]
                    if not isinstance(references, list) or not references:
                        raise ValueError("元数据 edit_image 需要参考图路径或非空数组。")
                    for reference in references:
                        local(reference, "元数据 edit_image", base=base)
            return
        editing = config.get("training_task") == "image-edit"
        tree(config.get("train_data_dir") or (config.get("output_data_dir") if editing else None), "训练数据目录")
        if editing:
            controls = config.get("control_data_dirs")
            directories(config.get("input_data_dirs") if controls is None else controls, "Edit 参考图目录")
        return
    if engine_id == "anima-fast":
        tree(config.get("source_image_dir") or config.get("train_data_dir"), "source_image_dir / train_data_dir")
        if config.get("resized_image_dir"):
            tree(config["resized_image_dir"], "resized_image_dir")
        return
    if engine_id == "ai-toolkit":
        tree(config.get("train_data_dir"), "训练数据目录")
        directories(config.get("control_data_dirs"), "control_data_dirs", allow_lines=True)
        return

    directory = tree(config.get("train_data_dir"), "训练数据目录")
    if engine_id == "kohya":
        if config.get("dataset_config"):
            text = text_file(config["dataset_config"], "dataset_config")
            try:
                import tomllib
                parsed = tomllib.loads(text)
            except ImportError:  # The supported service Python may be 3.10.
                import toml
                parsed = toml.loads(text)
            datasets = parsed.get("datasets", [])
            for dataset in datasets if isinstance(datasets, list) else []:
                subsets = dataset.get("subsets", []) if isinstance(dataset, dict) else []
                for subset in subsets if isinstance(subsets, list) else []:
                    if not isinstance(subset, dict):
                        continue
                    for key in ("image_dir", "conditioning_data_dir", "metadata_file"):
                        if subset.get(key):
                            path = local(subset[key], key, directory=key != "metadata_file", base=Path.cwd())
                            if key != "metadata_file":
                                tree(str(path), key)
                            else:
                                kohya_metadata(str(path), subset.get("image_dir"))
            return
        if config.get("reg_data_dir"):
            tree(config["reg_data_dir"], "reg_data_dir 正则化数据目录")
        if config.get("in_json"):
            kohya_metadata(config["in_json"], directory)
        if config.get("model_train_type") == "sdxl-finetune":
            return
    # Musubi also calls the organizer and ignores dataset_config. Its valid
    # TOML is not an opt-out; only Kohya's launcher supports that contract.
    if not any(item.is_dir() and re.match(r"^\d+_.+", item.name) for item in directory.iterdir()):
        raise ValueError("为保护散图和标注，工作台禁止自动整理数据目录；请准备重复次数子目录（Kohya 也可提供 dataset_config）。")


def disk_log_tail(task, log_root, limit):
    """Read a bounded tail from this task's own persistent stdout file."""
    path = Path(str(task.metadata.get("log_file") or ""))
    expected = log_root / f"{task.task_id}.log"
    try:
        if path.resolve() != expected.resolve() or path.is_symlink() or not path.is_file():
            return []
        with path.open("rb") as source:
            size = source.seek(0, os.SEEK_END)
            offset = max(0, size - 2 * 1024 * 1024)
            source.seek(offset)
            lines = source.read().decode("utf-8", errors="replace").splitlines()
            if offset and lines:
                lines = lines[1:]
            return lines[-limit:]
    except OSError:
        return []


def isolate_prompt_files(config, autosave, timestamp):
    """Upstream may normalize these files; only pass it an owned copy."""
    for field in ("prompt_file", "sample_prompts"):
        value = config.get(field)
        if not isinstance(value, str) or not value or len(value) >= 4096:
            continue
        source = Path(value)
        try:
            is_file = source.is_file()
        except OSError:
            is_file = False  # A literal prompt can be an invalid filesystem path.
        if not is_file:
            continue
        destination = autosave / f"{timestamp}-{field}.txt"
        try:
            shutil.copyfile(source, destination)
        except OSError as error:
            raise OSError(f"采样提示文件无法复制到独立目录，已拒绝提交以保护原文件：{error}") from error
        config[field] = str(destination)


def main():
    if len(sys.argv) == 3 and sys.argv[1] in {"--processor-job", "--crop-job"}:
        run_processor_job(sys.argv[2], cropping=sys.argv[1] == "--crop-job")
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--tagging-job":
        run_tagging_job(sys.argv[2])
        return
    parser = argparse.ArgumentParser()
    parser.add_argument("--bootstrap", required=True)
    args = parser.parse_args()
    bootstrap = json.loads(Path(args.bootstrap).read_text(encoding="utf-8"))
    data_root = Path(args.bootstrap).resolve().parent
    log_root = data_root / "logs" / "tasks"
    root = Path(bootstrap["root"]).resolve()
    if Path(__file__).resolve().parent != root:
        raise RuntimeError("Runner must execute from the isolated bundled source directory")
    os.chdir(root)
    sys.path.insert(0, str(root))
    # Importing mikazuki.app normally imports the entire GUI and mounts its
    # frontend. A namespace package loads only the selected core submodules.
    app_package = types.ModuleType("mikazuki.app")
    app_package.__path__ = [str(root / "mikazuki" / "app")]
    app_package.__package__ = "mikazuki.app"
    sys.modules["mikazuki.app"] = app_package

    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import FileResponse, JSONResponse, Response
    import uvicorn
    import toml
    from mikazuki.app.config import app_config
    from mikazuki.tasks import tm, TaskStatus
    from mikazuki.train_log_hub import hub
    from mikazuki.utils import task_insights
    from mikazuki.utils.config_import import validate_config_import
    from mikazuki.utils.hardware_status import sampler
    from mikazuki.utils.training_time import build_task_timing

    token = bootstrap["token"]
    catalog = json.loads((root / "workbench_catalog.json").read_text(encoding="utf-8"))["training_types"]
    supported = {item["train_type"] for item in catalog if item.get("control_supported")}
    training_engines = {item["train_type"]: item["engine"] for item in catalog if item.get("control_supported")}
    engines = {item["engine"] for item in catalog}
    active = {TaskStatus.CREATED, TaskStatus.RUNNING, TaskStatus.QUEUED}
    lifecycle = {"closing": False}
    submission_context = contextvars.ContextVar("workbench_submission", default=None)
    create_task = tm.create_task

    def owned_create_task(command, environ, metadata=None, cwd=None, task_id=None, lane="compute", group=None):
        context = submission_context.get()
        if lane == "compute" and not context:
            raise ValueError("Training must originate from an authenticated workbench submission")
        task_id = task_id or str(uuid.uuid4())
        metadata = {**(metadata or {}), **(context or {}), "log_file": str(log_root / f"{task_id}.log")}
        return create_task(command, environ, metadata=metadata, cwd=cwd, task_id=task_id, lane=lane, group=group)

    tm.create_task = owned_create_task
    app_config.path = str(root / "assets" / "config.json")
    app_config.load_config()
    tm.enable_persistence()
    tm.restore_queue()
    tm._auto_retry_max = 0

    def success(data=None):
        return {"status": "success", "data": data if data is not None else {}}

    def failure(message, data=None):
        return {"status": "fail", "message": str(message), "data": data or {}}

    def task_for(task_id, owner=None):
        task = tm.tasks.get(task_id)
        if not task or owner and task.metadata.get("workbench_owner") != owner:
            raise HTTPException(status_code=404, detail="没有找到属于当前实例的任务。")
        return task

    def config_for(task):
        config = task.metadata.get("source_config")
        if not isinstance(config, dict):
            config = task_insights.resolve_task_config(task.metadata)
        config = dict(config)
        config.setdefault("model_train_type", task.metadata.get("train_type"))
        return config

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    os.environ.update(MIKAZUKI_HOST="127.0.0.1", MIKAZUKI_PORT=str(port), MIKAZUKI_OPEN_BROWSER="0", MIKAZUKI_TRAIN_LOG_AUTO_OPEN="0")
    identity = {key: bootstrap[key] for key in ("launchId", "kernelRevision", "sourceRevision", "adapterRevision", "version", "environmentRoot", "pythonPath", "root")}
    identity.update(pid=os.getpid(), url=f"http://127.0.0.1:{port}", sourceModule=str(Path(sys.modules["mikazuki.tasks"].__file__).resolve()))

    @asynccontextmanager
    async def lifespan(app):
        # Fail startup rather than silently allowing a heavy import regression.
        if "torch" in sys.modules:
            raise RuntimeError("Torch must not be imported during sidecar startup")
        Path(bootstrap["readyPath"]).write_text(json.dumps(identity), encoding="utf-8")
        print("WORKBENCH_TRAINING_READY " + json.dumps(identity), flush=True)
        yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def authenticate(request: Request, call_next):
        authorization = request.headers.get("authorization", "")
        if request.client.host not in {"127.0.0.1", "::1"} or request.headers.get("origin") or not hmac.compare_digest(authorization, "Bearer " + token):
            return JSONResponse(status_code=401, content={"detail": "内核身份凭据无效。"})
        if lifecycle["closing"] and (request.method != "GET" or request.url.path.startswith("/api/tasks/terminate/")):
            return JSONResponse(status_code=409, content={"detail": "内核正在退出，不能接收新提交。"})
        return await call_next(request)

    @app.get("/__workbench/identity")
    async def get_identity():
        return success(identity)

    @app.post("/__workbench/shutdown")
    async def shutdown():
        if any(task.status in active for task in tm.tasks.values()):
            raise HTTPException(status_code=409, detail="仍有活动训练任务，不能关闭内核。")
        lifecycle["closing"] = True
        asyncio.get_running_loop().call_later(0.2, setattr, server, "should_exit", True)
        return success({"stopped": True})

    @app.get("/api/version")
    async def version():
        return success({"version": bootstrap["version"], "kernelRevision": bootstrap["kernelRevision"]})

    @app.get("/api/engines/{engine_id}/status")
    async def engine_status(engine_id: str):
        if engine_id not in engines:
            raise HTTPException(status_code=404, detail="未知训练引擎。")
        result = await engine_route(engine_id, "status")
        result.data.update(control_supported=True, source_bundled=engine_id == "kohya", target=bootstrap.get("engineTargets", {}).get(engine_id, "original" if engine_id == "kohya" else "isolated"))
        return result

    @app.post("/api/engines/{engine_id}/maintenance/{action}")
    async def engine_maintenance(engine_id: str, action: str, request: Request):
        if engine_id not in engines or action not in {"install", "repair"}:
            raise HTTPException(status_code=404, detail="未知训练引擎或操作。")
        owner = request.headers.get("x-workbench-owner", "")
        if not re.fullmatch(r"[a-f0-9]{64}", owner):
            raise HTTPException(status_code=403, detail="环境维护需要所属工作台实例。")
        if any(task.status in active for task in tm.tasks.values()):
            raise HTTPException(status_code=409, detail="仍有训练或维护任务，请等待完成后操作。")
        payload = await request.json()
        if not isinstance(payload, dict) or set(payload) != {"dry_run"} or type(payload["dry_run"]) is not bool:
            return failure("环境维护参数无效。")
        context = submission_context.set({"workbench_owner": owner, "workbench_request": "maintenance-" + uuid.uuid4().hex})
        try:
            return await engine_route(engine_id, action, payload)
        except (ValueError, OSError) as error:
            return failure(error)
        finally:
            submission_context.reset(context)

    @app.post("/api/config/validate-import")
    async def validate(request: Request):
        payload = await request.json()
        if not isinstance(payload, dict) or not isinstance(payload.get("config"), dict) or payload.get("page_train_type") not in supported:
            return failure("请提供已内置的训练类型和 JSON 配置。")
        return success(validate_config_import(payload["page_train_type"], payload["config"]))

    @app.post("/api/engines/{engine_id}/preflight")
    async def preflight(engine_id: str, request: Request):
        if engine_id not in engines:
            return failure("未知训练引擎。")
        config = await request.json()
        try:
            if not isinstance(config, dict) or training_engines.get(config.get("model_train_type")) != engine_id:
                raise ValueError("训练类型与预检引擎不匹配。")
            protect_dataset(config, engine_id)
            if engine_id == "kohya" and config.get("dataset_config"):
                from mikazuki.utils.train_utils import validate_dataset_config
                ok, message = validate_dataset_config(config["dataset_config"])
                if not ok:
                    raise ValueError(message)
            return await engine_route(engine_id, "preflight", config)
        except (ValueError, OSError) as error:
            return failure(error, {"ok": False, "errors": [str(error)]})

    @app.post("/api/run")
    async def run(request: Request):
        owner, request_id = request.headers.get("x-workbench-owner", ""), request.headers.get("x-workbench-request", "")
        if not re.fullmatch(r"[a-f0-9]{64}", owner) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,159}", request_id):
            return failure("提交必须包含工作台实例与请求编号。")
        config = await request.json()
        # Reading a request body yields to the event loop; shutdown may have
        # been accepted after this request passed the authentication middleware.
        if lifecycle["closing"]:
            raise HTTPException(status_code=409, detail="内核正在退出，不能接收新提交。")
        if not isinstance(config, dict) or config.get("model_train_type") not in supported:
            return failure("此训练类型的源码尚未内置。")
        # A persisted owner/request tag also prevents duplicates if an HTTP
        # client loses its response after the queue has accepted the job.
        existing = [task for task in tm.tasks.values() if task.metadata.get("workbench_owner") == owner and task.metadata.get("workbench_request") == request_id]
        if existing:
            return success({"task_id": existing[0].metadata.get("train_task_id") or existing[0].task_id, "reused": True, "queued": existing[0].status == TaskStatus.QUEUED})
        try:
            protect_dataset(config, training_engines[config["model_train_type"]])
            from mikazuki.app.train_submit import sanitize_config
            from mikazuki.engines.runner import RunContext, dispatch_run
            from mikazuki.utils import train_utils
            from mikazuki.utils.config_args import normalize_custom_args
            from mikazuki.utils.output_naming import ensure_unique_output_name
            train_utils.fix_config_types(config)
            normalize_custom_args(config)
            train_utils.ensure_enable_preview_flag(config)
            timestamp = f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
            autosave = root / "config" / "autosave"
            autosave.mkdir(parents=True, exist_ok=True)
            isolate_prompt_files(config, autosave, timestamp)
            source_config = dict(config)
            train_type = config.pop("model_train_type")
            gpu_ids = config.pop("gpu_ids", None)
            renamed_from = ensure_unique_output_name(config, tm)
            source_config["output_name"] = config.get("output_name")
            context = submission_context.set({"workbench_owner": owner, "workbench_request": request_id, "source_config": source_config})
            try:
                result = dispatch_run(train_type, config, RunContext(timestamp=timestamp, autosave_dir=str(autosave), gpu_ids=gpu_ids, model_train_type=train_type))
            finally:
                submission_context.reset(context)
            if result is None:
                return failure("训练类型未被内核识别。")
            if renamed_from and result.status == "success":
                result.data = {**(result.data or {}), "output_name_renamed": {"from": renamed_from, "to": config["output_name"]}}
            return result
        except (ValueError, OSError) as error:
            # If a task exists despite an exception, do not report a definitive
            # rejection: HTTP 500 leaves the caller's durable ledger uncertain.
            if any(task.metadata.get("workbench_owner") == owner and task.metadata.get("workbench_request") == request_id for task in tm.tasks.values()):
                raise HTTPException(status_code=500, detail="提交过程中发生异常，请先核对任务列表。") from error
            return failure(error)

    @app.post("/api/tagger/check")
    async def check_tagger(request: Request):
        try:
            config = await request.json()
            tagger_workspace(config, request.headers.get("x-workbench-owner"))
            check_config = {**config, "requestId": request.headers.get("x-workbench-request")}
            return success(await asyncio.to_thread(tagger_capabilities, check_config, bootstrap["environmentRoot"], data_root))
        except (ValueError, OSError) as error:
            return failure(error)

    @app.post("/api/tagger/run")
    async def run_tagger(request: Request):
        owner, request_id = request.headers.get("x-workbench-owner", ""), request.headers.get("x-workbench-request", "")
        if not re.fullmatch(r"[a-f0-9]{64}", owner) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,159}", request_id):
            return failure("打标必须包含所属实例和固定提交编号。")
        config = await request.json()
        if lifecycle["closing"]:
            raise HTTPException(status_code=409, detail="内核正在退出。")
        existing = [task for task in tm.tasks.values() if task.metadata.get("workbench_owner") == owner and task.metadata.get("workbench_request") == request_id]
        if existing:
            return success({"task_id": existing[0].task_id, "reused": True})
        try:
            tagger_workspace(config, owner)
            readiness = await asyncio.to_thread(tagger_capabilities, {**config, "requestId": request_id}, bootstrap["environmentRoot"], data_root)
            if not readiness["ok"]:
                return failure(readiness["reason"])
            if lifecycle["closing"]:
                raise HTTPException(status_code=409, detail="内核正在退出。")
            # The capability check yields: recheck idempotency before creation.
            existing = [task for task in tm.tasks.values() if task.metadata.get("workbench_owner") == owner and task.metadata.get("workbench_request") == request_id]
            if existing:
                return success({"task_id": existing[0].task_id, "reused": True})
            autosave = root / "config" / "autosave"
            autosave.mkdir(parents=True, exist_ok=True)
            config_path = autosave / f"tagging-{uuid.uuid4().hex}.json"
            config_path.write_text(json.dumps({"owner": owner, "requestId": request_id, "config": config, "environmentRoot": bootstrap["environmentRoot"], "dataRoot": str(data_root)}, ensure_ascii=False), encoding="utf-8")
            context = submission_context.set({"workbench_owner": owner, "workbench_request": request_id, "source_config": config})
            try:
                version = json.loads((Path(config["path"]).parent / "dataset-manifest.json").read_text(encoding="utf-8")).get("format", 1)
                task = tm.create_task([readiness.get("pythonPath") or sys.executable, "-u", str(Path(__file__).resolve()), "--processor-job" if version >= 2 else "--tagging-job", str(config_path)], {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}, metadata={"stage": "tagging", "job_label": "本地自然语言标注" if config.get("captionFormat") == "natural" else "本地图集自动打标", "backend": "tagger", "workbench_image_dir": config["path"]}, cwd=str(root))
                tm.submit(task)
            finally:
                submission_context.reset(context)
            return success({"task_id": task.task_id, "queued": task.status == TaskStatus.QUEUED})
        except (ValueError, OSError) as error:
            if any(task.metadata.get("workbench_owner") == owner and task.metadata.get("workbench_request") == request_id for task in tm.tasks.values()):
                raise HTTPException(status_code=500, detail="打标提交异常，请核对任务列表。") from error
            return failure(error)

    @app.post("/api/preprocess/check")
    async def check_crop(request: Request):
        from workbench_preprocess import dataset_manifest, crop_capabilities
        try:
            config = await request.json()
            dataset_manifest(config["path"], request.headers.get("x-workbench-owner", ""))
            if config.get("purpose") not in {"character", "style", "pose"} or config.get("cropMode") not in {"character", "pose", "preserve"} or type(config.get("allowDownload")) is not bool:
                return failure("裁切策略无效。")
            return success(crop_capabilities(config, bootstrap["environmentRoot"], data_root))
        except (ValueError, OSError, KeyError) as error:
            return failure(error)

    @app.post("/api/preprocess/run")
    async def run_crop(request: Request):
        from workbench_preprocess import dataset_manifest, crop_capabilities
        owner, request_id = request.headers.get("x-workbench-owner", ""), request.headers.get("x-workbench-request", "")
        if not re.fullmatch(r"[a-f0-9]{64}", owner) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,159}", request_id):
            return failure("裁切必须包含所属实例和固定编号。")
        config = await request.json()
        if lifecycle["closing"]:
            raise HTTPException(status_code=409, detail="内核正在退出。")
        existing = [task for task in tm.tasks.values() if task.metadata.get("workbench_owner") == owner and task.metadata.get("workbench_request") == request_id]
        if existing:
            return success({"task_id": existing[0].task_id, "reused": True})
        try:
            dataset_manifest(config["path"], owner)
            ready = crop_capabilities(config, bootstrap["environmentRoot"], data_root)
            if not ready["ok"]:
                return failure(ready["reason"])
            autosave = root / "config" / "autosave"
            autosave.mkdir(parents=True, exist_ok=True)
            config_path = autosave / f"crop-{uuid.uuid4().hex}.json"
            config_path.write_text(json.dumps({"owner": owner, "requestId": request_id, "config": config, "environmentRoot": bootstrap["environmentRoot"], "dataRoot": str(data_root)}, ensure_ascii=False), encoding="utf-8")
            context = submission_context.set({"workbench_owner": owner, "workbench_request": request_id, "source_config": config})
            try:
                task = tm.create_task([sys.executable, "-u", str(Path(__file__).resolve()), "--crop-job", str(config_path)], {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}, metadata={"stage": "cropping", "job_label": "本地检测与裁切", "backend": "preprocess", "workbench_image_dir": config["path"]}, cwd=str(root))
                tm.submit(task)
            finally:
                submission_context.reset(context)
            return success({"task_id": task.task_id, "queued": task.status == TaskStatus.QUEUED})
        except (ValueError, OSError) as error:
            if any(task.metadata.get("workbench_owner") == owner and task.metadata.get("workbench_request") == request_id for task in tm.tasks.values()):
                raise HTTPException(status_code=500, detail="裁切提交异常，请核对任务列表。") from error
            return failure(error)

    @app.get("/api/tasks")
    async def tasks():
        return success({"tasks": tm.dump()})

    @app.get("/api/tasks/terminate/{task_id}")
    async def terminate(task_id: str, request: Request):
        owner = request.headers.get("x-workbench-owner")
        if not owner:
            raise HTTPException(status_code=403, detail="停止任务需要所属工作台实例。")
        task_for(task_id, owner)
        await asyncio.to_thread(tm.terminate_task, task_id)
        return success()

    @app.get("/api/tasks/{task_id}/config")
    async def task_config(task_id: str):
        task = task_for(task_id)
        return success({"config": config_for(task), "train_type": task.metadata.get("train_type")})

    @app.post("/api/tasks/{task_id}/resume")
    async def resume(task_id: str, request: Request):
        owner = request.headers.get("x-workbench-owner", "")
        if not owner:
            raise HTTPException(status_code=403, detail="继续任务需要所属实例。")
        task_for(task_id, owner)
        return success({"resumed": tm.resume_task(task_id)})

    @app.get("/api/tasks/{task_id}/metrics")
    async def metrics(task_id: str):
        task = task_for(task_id)
        if task.metadata.get("stage") in {"tagging", "cropping"}:
            try:
                progress = json.loads((Path(task.metadata["workbench_image_dir"]).parent / ("cropping-progress.json" if task.metadata.get("stage") == "cropping" else "tagging-progress.json")).read_text(encoding="utf-8"))
                values = progress.get("tagging", {})
                return success({"progress": {"step": values.get("current"), "total_steps": values.get("total"), "percent": values.get("percent")}, "tagging": progress, "timing": {}})
            except (OSError, ValueError, KeyError):
                return success({"progress": {}, "timing": {}})
        lines = hub.tail(task_id, 300) or disk_log_tail(task, log_root, 300)
        return success({"progress": task_insights.read_progress(lines), "timing": build_task_timing(task.metadata, task.status.name, hub.timing_snapshot(task_id)), "tags": task_insights.read_loss_scalars(task.metadata)})

    @app.get("/api/train/log/tail/{task_id}")
    async def logs(task_id: str, limit: int = 240):
        task = task_for(task_id)
        lines, total, done = hub.snapshot_from(task_id, 0)
        limit = max(1, min(limit, 2000))
        if not lines:
            lines = disk_log_tail(task, log_root, limit)
            total = len(lines)
        return success({"lines": lines[-limit:], "total": total, "done": task.status not in active})

    @app.get("/api/tasks/{task_id}/previews")
    async def previews(task_id: str):
        return success({"images": task_insights.list_preview_images(task_for(task_id).metadata)})

    @app.get("/api/tasks/{task_id}/previews/{filename}")
    async def preview(task_id: str, filename: str, thumb: bool = False):
        path = task_insights.resolve_preview_image(task_for(task_id).metadata, filename)
        if path is None:
            raise HTTPException(status_code=404, detail="预览图不存在。")
        if thumb:
            thumbnail = task_insights.preview_thumbnail(path)
            if thumbnail is not None:
                return Response(content=thumbnail, media_type="image/jpeg")
        return FileResponse(path)

    @app.get("/api/hardware/status")
    async def hardware():
        return success(await asyncio.to_thread(sampler.snapshot))

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False))
    server.run(sockets=[sock])


if __name__ == "__main__":
    main()

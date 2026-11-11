"""Read original saved forms and actual task archives without importing its app."""
import json
from pathlib import Path
import re
import sys

SECRET = re.compile(r"password|secret|authorization|credential|api.?key|(?:^|_)(?:access_?|hf_?)?token$", re.I)


def clean(value):
    if isinstance(value, dict):
        return {key: clean(item) for key, item in value.items() if not SECRET.search(key)}
    if isinstance(value, list):
        return [clean(item) for item in value]
    return value


def read(path):
    if not path.is_file() or path.stat().st_size > 1024 * 1024:
        return None
    return json.loads(path.read_text(encoding="utf-8-sig"))


def main(root):
    root = Path(root).resolve()
    configs, errors, seen = [], [], set()
    try:
        saved = (read(root / "assets" / "config.json") or {}).get("saved_params", {})
        for name, item in saved.items():
            config = item.get("form") if isinstance(item, dict) else None
            if not isinstance(config, dict):
                continue
            config = dict(config)
            config.setdefault("model_train_type", {"sd3-lora": "anima-lora", "lora-master": "sd-lora"}.get(name, name))
            configs.append({"id": f"saved:{name}", "name": name, "source": "saved_params", "config": clean(config)})
    except (OSError, ValueError) as error:
        errors.append(f"保存参数读取失败：{error}")
    archives = root / "user_data" / "tasks"
    for path in sorted(archives.glob("*/*/*/task.json"), reverse=True):
        if len(configs) >= 200:
            break
        try:
            if root not in path.resolve().parents:
                continue
            item = read(path)
            if not isinstance(item, dict) or not isinstance(item.get("config"), dict):
                continue
            config = dict(item["config"])
            train_type = (item.get("metadata") or {}).get("train_type")
            if train_type:
                config.setdefault("model_train_type", train_type)
            task_id = str(item.get("task_id") or path.parent.name)
            seen.add(task_id)
            configs.append({"id": f"archive:{task_id}", "name": str(config.get("output_name") or task_id), "source": "task_archive", "createdAt": item.get("created_at"), "config": clean(config)})
        except (OSError, ValueError) as error:
            errors.append(f"历史配置读取失败：{path.name}: {error}")
    # Older queues predate user_data archives. Read the exact saved TOML if it
    # still lives inside the original installation; never execute its code.
    try:
        queue = read(root / "logs" / "task_queue.json") or []
        for item in reversed(queue if isinstance(queue, list) else []):
            if len(configs) >= 200:
                break
            task_id = str(item.get("task_id") or "")
            if not task_id or task_id in seen:
                continue
            metadata = item.get("metadata") or {}
            config = metadata.get("source_config")
            if not isinstance(config, dict):
                path = Path(str(metadata.get("config_path") or ""))
                if not path.is_absolute():
                    path = root / path
                if root not in path.resolve().parents or not path.is_file() or path.stat().st_size > 1024 * 1024 or path.suffix.lower() != ".toml":
                    continue
                import toml
                config = toml.loads(path.read_text(encoding="utf-8-sig"))
            config = dict(config)
            if metadata.get("train_type"):
                config.setdefault("model_train_type", metadata["train_type"])
            configs.append({"id": f"history:{task_id}", "name": str(config.get("output_name") or task_id), "source": "task_history", "config": clean(config)})
    except (OSError, ValueError) as error:
        errors.append(f"旧任务配置读取失败：{error}")
    print(json.dumps({"configs": configs, "errors": errors}, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main(sys.argv[1])

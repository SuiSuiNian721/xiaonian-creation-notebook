"""Build a reviewable, byte-exact source snapshot; never copy user/runtime data."""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import subprocess

PREFIXES = ("mikazuki/", "scripts/dev/", "scripts/stable/", "vendor/sd-scripts/", "config/presets/")
ROOT_FILES = {"VERSION", "requirements.txt", "LICENSE", "NOTICE.md"}
EXCLUDED_PARTS = {".git", ".github", "__pycache__", "tests", "test", "screenshots", "docs", ".venv", "node_modules"}
SCHEMAS = {"anima-lora": "sd3-lora", "sd-lora": "lora-master", "sdxl-lora": "lora-master", "sd-dreambooth": "dreambooth", "sdxl-finetune": "dreambooth", "lumina-lora": "lumina2-lora", "klein-4b-lora": "klein-lora", "klein-9b-lora": "klein-lora", "flux-finetune": None}


def constants(path):
    result = {}
    for node in ast.parse(path.read_text(encoding="utf-8-sig")).body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    try:
                        result[target.id] = ast.literal_eval(node.value)
                    except (ValueError, TypeError):
                        pass
    return result


def catalog(root):
    result = []
    for path in sorted((root / "mikazuki/engines").glob("*/manifest.py")):
        if path.parent.name.startswith("_"):
            continue
        values = constants(path)
        engine, types = values.get("ENGINE_ID"), values.get("TRAIN_TYPES")
        if engine == "ai-toolkit" and types is None:
            models = constants(path.parent / "capabilities.py")["MODELS"]
            types = {(f"{key}-lora" if key.startswith("klein-") else f"ai-toolkit-{key}-lora"): key for key in models}
        if not isinstance(engine, str) or not isinstance(types, dict):
            raise ValueError(f"Cannot statically read manifest: {path}")
        for train_type, variant in types.items():
            result.append({"train_type": train_type, "engine": engine, "variant": variant, "schema_name": SCHEMAS.get(train_type, train_type), "bundled": engine == "kohya", "supported": engine == "kohya"})
    if len({item["train_type"] for item in result}) != len(result):
        raise ValueError("Duplicate training types")
    return {"training_types": result}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--destination", default=str(Path(__file__).parent))
    args = parser.parse_args()
    root, destination = Path(args.source).resolve(), Path(args.destination).resolve()
    if root == destination or root in destination.parents:
        raise ValueError("Snapshot must be outside the source installation")
    git = lambda *args: subprocess.check_output(["git", "-C", str(root), *args])
    tracked = set(git("ls-files", "-z").decode("utf-8").split("\0"))
    untracked = set(git("ls-files", "--others", "--exclude-standard", "-z", "mikazuki").decode("utf-8").split("\0"))
    candidates = sorted(name for name in tracked | untracked if name and (name in ROOT_FILES or name.startswith(PREFIXES)) and not EXCLUDED_PARTS.intersection(Path(name).parts) and not name.endswith((".pyc", ".pyo")))
    changed = set(git("diff", "--name-only", "HEAD", "-z").decode("utf-8").split("\0")) | untracked
    files = []
    for name in candidates:
        source = root / name
        if not source.is_file():
            continue
        if source.is_symlink() or root not in source.resolve().parents:
            raise ValueError(f"Unexpected source link: {name}")
        data = source.read_bytes()
        target = destination / "source" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files.append({"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    revision = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    manifest = {"format": 1, "version": (root / "VERSION").read_text(encoding="utf-8").strip(), "kernelRevision": revision, "source": {"repository": git("remote", "get-url", "origin").decode().strip(), "commit": git("rev-parse", "HEAD").decode().strip(), "snapshot": "local modified working tree", "localPath": str(root)}, "modifiedFiles": sorted(name for name in changed if any(file["path"] == name for file in files)), "files": files}
    (destination / "source-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (destination / "catalog.json").write_text(json.dumps(catalog(destination / "source"), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"files": len(files), "bytes": sum(file["size"] for file in files), "kernelRevision": revision, "modifiedFiles": manifest["modifiedFiles"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()

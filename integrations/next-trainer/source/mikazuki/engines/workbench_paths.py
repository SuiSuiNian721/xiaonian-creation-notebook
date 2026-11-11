"""Resolve explicitly bound Workbench environments without changing native defaults."""
import json
from pathlib import Path
import re


def managed_environment_paths(project_root: Path, engine_id: str, extension_root: Path):
    project_root = project_root.resolve()
    binding = project_root / "workbench_engine_roots.json"
    if binding.is_symlink():
        raise ValueError("Workbench engine binding must be an ordinary file")
    if not binding.exists():
        return None
    if not binding.is_file() or binding.stat().st_size > 64 * 1024:
        raise ValueError("Workbench engine binding is invalid")
    data = json.loads(binding.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("format") != 1:
        raise ValueError("Workbench engine binding format is invalid")
    entries = data.get("engines")
    if not isinstance(entries, dict):
        raise ValueError("Workbench engine bindings are invalid")
    entry = entries.get(engine_id)
    if not isinstance(entry, dict) or not re.fullmatch(r"[A-Za-z0-9_]+", str(entry.get("directory", ""))):
        raise ValueError("Workbench engine binding directory is invalid")
    if not isinstance(entry.get("root"), str):
        raise ValueError("Workbench selected environment root is invalid")
    selected = Path(entry.get("root", ""))
    native = project_root / "extensions" / entry["directory"]
    if not selected.is_absolute() or not selected.is_dir():
        raise ValueError("Workbench selected environment root is invalid")
    selected = selected.resolve()
    if native.resolve() != selected or extension_root.resolve() != selected:
        raise ValueError("Workbench engine binding does not match the native extension directory")
    python_dir = (selected / ".python").resolve()
    python_dir.relative_to(selected)
    return selected, python_dir

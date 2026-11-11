"""Explicit app-owned API environment preparation. Never installs a training engine."""
import json
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone

# Controller API, status and engine-management requirements only. Torch/CUDA and
# model downloads belong to the separately confirmed engine maintenance action.
PACKAGES = ["fastapi==0.95.1", "uvicorn==0.22.0", "toml==0.10.2", "tomli>=2,<3", "psutil>=5.9,<8", "PyYAML>=6,<7", "Pillow>=10,<13", "requests>=2.31,<3", "huggingface-hub==0.36.2", "uv>=0.5,<1"]


def prepare(request_path):
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    root = Path(request["root"])
    state_path = Path(request["statePath"])
    expected = state_path.parent / "service-env"
    if root.resolve() != expected.resolve() or root.is_symlink() or getattr(root, "is_junction", lambda: False)():
        raise ValueError("服务环境必须位于工作台资料目录。")
    request.update(status="running", pid=os.getpid())

    def save():
        temporary = state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(request, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(state_path)

    save()
    try:
        if not (3, 10) <= sys.version_info[:2] < (3, 13):
            raise ValueError("请选择 Python 3.10—3.12 作为基础 Python。")
        root.mkdir(parents=True, exist_ok=True)
        venv = root / ".venv"
        python = venv / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        environment = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONNOUSERSITE": "1"}
        for key in ("PYTHONPATH", "PYTHONHOME"):
            environment.pop(key, None)
        if not python.is_file():
            if importlib.util.find_spec("venv") is not None:
                command = [sys.executable, "-I", "-m", "venv", str(venv)]
            elif importlib.util.find_spec("uv") is not None:
                command = [sys.executable, "-I", "-m", "uv", "venv", "--seed", "--python", sys.executable, str(venv)]
            else:
                raise ValueError("基础 Python 缺少 venv 和 uv，请选择完整 Python 安装或已带 uv 的便携 Python。")
            subprocess.run(command, check=True, env=environment)
        subprocess.run([str(python), "-I", "-m", "pip", "install", "--disable-pip-version-check", *PACKAGES], check=True, env=environment)
        subprocess.run([str(python), "-I", "-c", "import fastapi,uvicorn,toml,psutil,yaml,PIL,requests,huggingface_hub"], check=True, env=environment)
        request.update(status="completed", pythonPath=str(python), finishedAt=datetime.now(timezone.utc).isoformat())
    except Exception as error:
        request.update(status="failed", reason=str(error), finishedAt=datetime.now(timezone.utc).isoformat())
        raise
    finally:
        save()
        lock = Path(request["lockPath"])
        if lock.exists() and json.loads(lock.read_text(encoding="utf-8")).get("launchId") == request["launchId"]:
            lock.unlink(missing_ok=True)


if __name__ == "__main__":
    prepare(sys.argv[1])

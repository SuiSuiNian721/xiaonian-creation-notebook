"""Read runtime versions and resource availability without importing ComfyUI or loading models."""
import ast
import hashlib
import importlib.metadata
import importlib.util
import json
import pathlib
import platform
import shutil
import sys


def cli_capabilities(directory):
    """Read declarations only. Never import, eval or execute the target CLI."""
    path = pathlib.Path(directory) / "comfy" / "cli_args.py"
    result = {"path": str(path), "sha256": None, "flags": [], "fastFeatures": []}
    try:
        if path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError("CLI 文件超过 2 MiB。")
        source = path.read_bytes()
        result["sha256"] = hashlib.sha256(source).hexdigest()
        tree = ast.parse(source.decode("utf-8-sig"), filename=str(path))
        flags = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "add_argument":
                for argument in node.args:
                    if isinstance(argument, ast.Constant) and isinstance(argument.value, str) and argument.value.startswith("--"):
                        flags.add(argument.value)
        result["flags"] = sorted(flags)
        features = []
        for statement in tree.body:
            if not isinstance(statement, ast.ClassDef) or statement.name != "PerformanceFeature":
                continue
            for member in statement.body:
                if isinstance(member, (ast.Assign, ast.AnnAssign)) and isinstance(member.value, ast.Constant) and isinstance(member.value.value, str):
                    features.append(member.value.value)
        result["fastFeatures"] = list(dict.fromkeys(features))
    except Exception as error:
        result["error"] = str(error)
    return result


def optional_modules():
    result = {}
    for name in ("xformers", "sageattention", "flash_attn", "comfy_kitchen"):
        try:
            result[name] = {"present": importlib.util.find_spec(name) is not None}
        except Exception as error:
            result[name] = {"present": None, "error": str(error)}
    return result


def comfy_version(directory):
    for name in ("comfyui_version.py", "comfy_version.py"):
        path = pathlib.Path(directory) / name
        if not path.is_file():
            continue
        try:
            for statement in ast.parse(path.read_text(encoding="utf-8-sig")).body:
                if isinstance(statement, ast.Assign) and any(
                    isinstance(target, ast.Name) and target.id in ("__version__", "VERSION", "version")
                    for target in statement.targets
                ):
                    value = ast.literal_eval(statement.value)
                    if isinstance(value, str):
                        return {"version": value, "source": name}
        except Exception as error:
            return {"version": None, "error": str(error)}
    return {"version": None, "error": "未找到静态版本信息。"}


def frontend_version():
    package = "comfyui-frontend-package"
    try:
        return {"version": importlib.metadata.version(package), "source": package}
    except importlib.metadata.PackageNotFoundError:
        return {"version": None, "source": package, "error": "当前 Python 未发现前端包元数据；自定义网页前端未核实。"}
    except Exception as error:
        return {"version": None, "source": package, "error": str(error)}


def accelerator_info(adapter, name):
    result = {"available": False, "status": "unavailable", "devices": []}
    if adapter is None or not hasattr(adapter, "is_available"):
        return result
    try:
        result["available"] = bool(adapter.is_available())
    except Exception as error:
        return {**result, "available": None, "status": "unverified", "error": str(error)}
    if not result["available"]:
        return result
    try:
        if name == "mps":
            result["devices"] = [{"index": 0, "name": "Apple Metal (MPS)"}]
        else:
            count = adapter.device_count()
            if not isinstance(count, int) or count < 1 or count > 256:
                raise ValueError("设备可用，但未返回有效的设备数量。")
            for index in range(count):
                device = {"index": index, "name": str(adapter.get_device_name(index))}
                # Memory APIs differ across PyTorch builds. Missing memory data is
                # not proof that an otherwise enumerated accelerator is absent.
                try:
                    if hasattr(adapter, "mem_get_info"):
                        free, total = adapter.mem_get_info(index)
                        device.update(vramFree=free, vramTotal=total)
                    elif hasattr(adapter, "get_device_properties"):
                        device["vramTotal"] = adapter.get_device_properties(index).total_memory
                except Exception as error:
                    device["memoryError"] = str(error)
                result["devices"].append(device)
        result["status"] = "available"
    except Exception as error:
        result.update(status="unverified", error=str(error))
    return result


def torch_info():
    result = {"version": None, "cudaVersion": None, "cudaAvailable": None,
              "devices": [], "backend": None, "backendStatus": "unverified",
              "cpuAvailable": None, "backends": {}}
    try:
        import torch

        result["version"] = str(torch.__version__)
        result["cudaVersion"] = getattr(torch.version, "cuda", None)
        result["xpuVersion"] = getattr(torch.version, "xpu", None)
        backends = {
            "cuda": accelerator_info(getattr(torch, "cuda", None), "cuda"),
            "xpu": accelerator_info(getattr(torch, "xpu", None), "xpu"),
            "mps": accelerator_info(getattr(getattr(torch, "backends", None), "mps", None), "mps"),
            "cpu": {"available": True, "status": "available", "devices": [{"index": 0, "name": platform.processor() or platform.machine() or "CPU"}]},
        }
        result["backends"] = backends
        result["cudaAvailable"] = backends["cuda"]["available"]
        # Preserve the historical CUDA-only devices field for launch settings.
        result["devices"] = backends["cuda"]["devices"]
        result["cpuAvailable"] = True
        backend = next((name for name in ("cuda", "xpu", "mps") if backends[name]["available"]), "cpu")
        result["backend"] = backend
        verified = backends[backend]["status"] == "available"
        if backend == "cpu" and any(item["status"] == "unverified" for item in backends.values()):
            verified = False
        result["backendStatus"] = "verified" if verified else "unverified"
    except Exception as error:
        result["error"] = str(error)
    return result


def disk_info(value):
    try:
        path = pathlib.Path(value).resolve()
        while not path.exists() and path.parent != path:
            path = path.parent
        usage = shutil.disk_usage(path)
        return {"path": str(path), "total": usage.total, "free": usage.free}
    except Exception as error:
        return {"path": value, "error": str(error)}


if len(sys.argv) == 3 and sys.argv[1] == "--cli-only":
    sys.stdout.buffer.write(json.dumps({"cli": cli_capabilities(sys.argv[2])}, ensure_ascii=False).encode("utf-8"))
    sys.exit(0)


result = {
    "python": {"version": platform.python_version(), "executable": sys.executable},
    "comfy": comfy_version(sys.argv[1]),
    "frontend": frontend_version(),
    "cli": cli_capabilities(sys.argv[1]),
    "optionalModules": optional_modules(),
    "disks": [disk_info(value) for value in dict.fromkeys(sys.argv[1:3])],
}
result["torch"] = torch_info()

sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))

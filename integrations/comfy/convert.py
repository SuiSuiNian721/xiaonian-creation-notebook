"""Separate stdlib-only command for the vendored Comfy CLI converter."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from workflow_to_api import convert_ui_to_api

try:
    data = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    result = convert_ui_to_api(data["workflow"], data["object_info"])
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
except Exception as error:
    sys.stderr.buffer.write(str(error).encode("utf-8"))
    sys.exit(1)

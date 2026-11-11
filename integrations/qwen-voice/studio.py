"""One-shot Qwen3-TTS adapter. Imports models only for an explicit voice job.

Official API: https://github.com/QwenLM/Qwen3-TTS
Use a dedicated qwen-tts / transformers==4.57.3 interpreter, never the MOSS v5 env.
"""
import argparse
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import sys
from types import SimpleNamespace


def generate(model, request, reference=None):
    mode, kind = request.get("mode"), request.get("modelKind")
    expected = {"design": "voice-design", "clone": "base", "synthesis": "custom-voice"}
    if expected.get(mode) != kind:
        raise ValueError("Qwen模型类型与任务模式不匹配")
    shared = {"text": request["text"], "language": request.get("language", "Chinese")}
    if mode == "clone":
        if not reference or not request.get("transcript", "").strip():
            raise ValueError("Qwen Base克隆需要参考音频和对应转录")
        return model.generate_voice_clone(**shared, ref_audio=str(reference),
                                         ref_text=request["transcript"], x_vector_only_mode=False)
    if mode == "design":
        if not request.get("instruction", "").strip():
            raise ValueError("声音设计需要声音描述")
        return model.generate_voice_design(**shared, instruct=request["instruction"])
    return model.generate_custom_voice(**shared, speaker=request.get("speaker", "Vivian"))


def load_model(path, loader, dtype, device):
    if not Path(path).is_absolute() or not Path(path).is_dir():
        raise ValueError("模型需要已存在的本地绝对路径")
    return loader.from_pretrained(str(path), device_map=device, dtype=dtype,
                                  attn_implementation="sdpa", local_files_only=True)


def audio_helpers():
    directory = Path(__file__).resolve().parent.parent / "moss-voice"
    sys.path.insert(0, str(directory))
    spec = importlib.util.spec_from_file_location("workbench_moss_audio", directory / "studio.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def process_request(path):
    helpers = audio_helpers()
    path = helpers.local_path(path, "任务", "file")
    raw = path.read_bytes()
    if len(raw) > 65536:
        raise ValueError("声音任务过大")
    request = json.loads(raw.decode("utf-8"))
    if not isinstance(request, dict) or request.get("provider") != "qwen3-tts":
        raise ValueError("声音提供者无效")
    for key, limit in (("text", 500), ("instruction", 1200), ("transcript", 2000), ("language", 60), ("speaker", 100)):
        value = request.get(key, "")
        if not isinstance(value, str) or len(value) > limit or "\0" in value:
            raise ValueError("声音任务字段无效：" + key)
    if not request.get("text", "").strip():
        raise ValueError("试听台词不能为空")
    seed = request.get("seed", 90321)
    if type(seed) is not int or not 0 <= seed <= 4294967295:
        raise ValueError("随机种子无效")
    model_path = helpers.local_path(request.get("model"), "模型", "directory")
    output = helpers.local_path(request.get("output"), "输出", "output")
    reference = reference_output = None
    source = request.get("sourcePath")
    if source:
        sys.path.insert(0, str(helpers.local_path(source, "Qwen源码", "directory")))
    created = []
    def unchanged():
        if path.read_bytes() != raw:
            raise ValueError("声音任务已改变，请重新生成")
        if reference and hashlib.sha256(reference.read_bytes()).hexdigest() != reference_sha:
            raise ValueError("参考音频已改变，请重新生成")
    try:
        if request.get("mode") == "clone":
            reference = helpers.local_path(request.get("reference"), "参考音频", "file")
            reference_output = helpers.local_path(request.get("referenceOutput"), "标准化参考", "output")
            if reference_output == output:
                raise ValueError("试听输出与参考输出需要不同路径")
            if reference.stat().st_size > 32 * 1024 * 1024:
                raise ValueError("参考音频超过32 MiB")
            reference_sha = hashlib.sha256(reference.read_bytes()).hexdigest()
            normalized = helpers.normalize_audio(SimpleNamespace(reference=reference, reference_sha256=reference_sha, assert_unchanged=unchanged))
            helpers.write_new_wav(reference_output, normalized)
            created.append(reference_output)
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        import torch
        import numpy as np
        import soundfile as sf
        from scipy.signal import resample_poly
        from transformers import set_seed
        from qwen_tts import Qwen3TTSModel
        set_seed(seed)
        unchanged()
        model = load_model(model_path, Qwen3TTSModel, torch.bfloat16 if torch.cuda.is_available() else torch.float32,
                           "cuda:0" if torch.cuda.is_available() else "cpu")
        with torch.inference_mode():
            wavs, rate = generate(model, request, reference_output)
        unchanged()
        audio = np.asarray(wavs[0], dtype=np.float64)
        if audio.ndim != 1 or not 8000 <= rate <= 192000 or not 1 <= audio.size <= rate * 600 or not np.isfinite(audio).all():
            raise ValueError("Qwen返回了无效或过长的音频")
        if rate != 24000:
            divisor = math.gcd(int(rate), 24000)
            audio = resample_poly(audio, 24000 // divisor, int(rate) // divisor)
        stream = io.BytesIO()
        sf.write(stream, np.clip(audio, -0.98, 0.98), 24000, format="WAV", subtype="PCM_16")
        data = stream.getvalue()
        if len(data) > 32 * 1024 * 1024:
            raise ValueError("声音输出超过32 MiB")
        unchanged()
        helpers.write_new_wav(output, data)
        created.append(output)
        unchanged()
        return {"output": str(output), **helpers.audio_metadata(data)}
    except BaseException:
        for created_path in reversed(created):
            created_path.unlink(missing_ok=True)
        raise


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="本地Qwen3-TTS声音工作进程")
    parser.add_argument("--request", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(process_request(args.request), ensure_ascii=False), flush=True)
        return 0
    except Exception as error:
        print("声音任务失败：" + " ".join(str(error).split())[:500], file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

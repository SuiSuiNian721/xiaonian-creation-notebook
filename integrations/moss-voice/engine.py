"""Fixed-reference MOSS inference. Heavy dependencies are imported lazily."""

from dataclasses import dataclass
import gc
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import sys
import wave


class ProfileChangedError(ValueError):
    """The on-disk recipe no longer matches this service's identity."""


class IncompleteAudioError(RuntimeError):
    """Generation did not reach its own audio end token."""


def sha256_file(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_json(path):
    raw = Path(path).read_bytes()
    if len(raw) > 65536:
        raise ValueError("配置文件过大")
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("配置必须是 JSON 对象")
    return value, hashlib.sha256(raw).hexdigest()


def token_budget(text, configured):
    """12.5 Hz codec: allow longer utterances without unbounded GPU jobs."""
    return min(4096, max(configured, 128 + len(text) * 10))


def require_complete_generation(codes, audio_end_token):
    if len(codes) != 1:
        raise IncompleteAudioError("语音生成结果不完整")
    prefix_length, rows = codes[0]
    # MOSS returns audio_start + optional continuation prefix + new tokens.
    generated_rows = rows[int(prefix_length) + 1:]
    if not any(int(row[0]) == audio_end_token for row in generated_rows):
        raise IncompleteAudioError("语音达到生成上限，未返回截断音频；请缩短台词")


def validate_wav(data):
    """Require a complete, bounded, mono 24 kHz PCM16 RIFF file."""
    if not isinstance(data, bytes) or not 44 <= len(data) <= 32 * 1024 * 1024:
        raise ValueError("无效的 WAV 数据")
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE" or int.from_bytes(data[4:8], "little") + 8 != len(data):
        raise ValueError("WAV 文件未完整生成")
    with wave.open(io.BytesIO(data), "rb") as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, 24000, "NONE"):
            raise ValueError("需要单声道 24 kHz PCM16 WAV")
        frames = wav.getnframes()
        if frames < 1 or len(wav.readframes(frames)) != frames * 2:
            raise ValueError("WAV 帧不完整")
    return data


@dataclass(frozen=True)
class VoiceProfile:
    path: Path
    profile_sha256: str
    reference: Path
    reference_sha256: str
    model: Path
    codec: Path
    parameters: dict

    @classmethod
    def load(cls, path):
        path = Path(path)
        if not path.is_absolute():
            raise ValueError("音色配方需要绝对路径")
        profile, profile_sha = read_json(path)
        required = ("reference_file", "reference_sha256", "model", "codec", "parameters")
        if any(key not in profile for key in required):
            raise ValueError("音色配方缺少必需字段")
        if not isinstance(profile["reference_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", profile["reference_sha256"]):
            raise ValueError("参考音频校验值无效")
        paths = []
        for key in ("reference_file", "model", "codec"):
            if not isinstance(profile[key], str) or not Path(profile[key]).is_absolute():
                raise ValueError("音色文件需要绝对路径")
            paths.append(Path(profile[key]))
        reference, model, codec = paths
        if not reference.is_file() or not model.is_dir() or not codec.is_dir():
            raise ValueError("音色文件或本地模型不存在")
        if reference.stat().st_size > 32 * 1024 * 1024 or sha256_file(reference) != profile["reference_sha256"]:
            raise ValueError("固定参考音频校验失败")
        validate_wav(reference.read_bytes())
        parameters = profile["parameters"]
        allowed = {"max_new_tokens", "audio_temperature", "audio_top_p", "audio_top_k",
                   "audio_repetition_penalty", "n_vq_for_inference"}
        if not isinstance(parameters, dict) or set(parameters) != allowed:
            raise ValueError("固定音色推理参数不完整或含未知字段")
        for key, value in parameters.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError("音色推理参数必须是有限数值")
        for key in ("max_new_tokens", "audio_top_k", "n_vq_for_inference"):
            if type(parameters[key]) is not int:
                raise ValueError("音色推理整数参数无效")
        if not (1 <= parameters["max_new_tokens"] <= 4096 and 0 < parameters["audio_temperature"] <= 3
                and 0 < parameters["audio_top_p"] <= 1 and 1 <= parameters["audio_top_k"] <= 1000
                and 0 < parameters["audio_repetition_penalty"] <= 3 and parameters["n_vq_for_inference"] == 32):
            raise ValueError("音色推理参数超出支持范围")
        return cls(path, profile_sha, reference, profile["reference_sha256"], model, codec, dict(parameters))

    def assert_unchanged(self):
        try:
            same = sha256_file(self.path) == self.profile_sha256 and sha256_file(self.reference) == self.reference_sha256
        except OSError:
            same = False
        if not same:
            raise ProfileChangedError("音色配方或参考已变更，请重新启动语音服务")


class MossEngine:
    """Keep only the CPU processor/codec and reference codes between requests."""

    def __init__(self, profile):
        self.profile = profile
        self.processor = None
        self.reference_codes = None

    @property
    def loaded(self):
        return self.processor is not None

    def _load_reference(self):
        if self.loaded:
            return
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
        os.environ.setdefault("HF_MODULES_CACHE", str(Path(sys.prefix) / "hf-modules"))
        import numpy as np
        import soundfile as sf
        import torch
        import transformers
        from transformers import AutoProcessor

        if not torch.cuda.is_available():
            raise RuntimeError("此音色配置需要 CUDA")
        torch.set_num_threads(8)
        torch.backends.cuda.enable_cudnn_sdp(False)
        transformers.utils.logging.disable_progress_bar()
        transformers.utils.logging.set_verbosity_error()
        self.profile.assert_unchanged()
        # This custom processor forwards loader kwargs to ProcessorMixin;
        # enforce offline loading via HF_HUB_OFFLINE, not local_files_only.
        processor = AutoProcessor.from_pretrained(str(self.profile.model), codec_path=str(self.profile.codec),
            trust_remote_code=True)
        processor.audio_tokenizer.to("cpu").eval()
        reference, sr = sf.read(self.profile.reference, dtype="float32", always_2d=True)
        if sr != 24000 or reference.shape[1] != 1 or not np.isfinite(reference).all():
            raise ValueError("固定参考音频格式无效")
        with torch.inference_mode():
            reference_codes = processor.encode_audios_from_wav(
                [torch.from_numpy(reference.T.copy())], sr, n_vq=32)[0].cpu()
        # No future encoding is needed; retain only the decoder on CPU.
        processor.audio_tokenizer.encoder = torch.nn.ModuleList()
        self.profile.assert_unchanged()
        self.processor, self.reference_codes = processor, reference_codes
        gc.collect()

    def _generate(self, text):
        import torch
        from transformers import AutoModel, set_seed

        model = input_ids = attention_mask = batch = codes = None
        try:
            model = AutoModel.from_pretrained(str(self.profile.model), trust_remote_code=True,
                local_files_only=True, dtype=torch.bfloat16, attn_implementation="sdpa").to("cuda").eval()
            set_seed(90321)
            message = self.processor.build_user_message(text=text, reference=[self.reference_codes])
            batch = self.processor([[message]], mode="generation")
            input_ids = batch["input_ids"].to("cuda")
            attention_mask = batch["attention_mask"].to("cuda")
            parameters = {**self.profile.parameters, "max_new_tokens": token_budget(text, self.profile.parameters["max_new_tokens"])}
            with torch.inference_mode():
                codes = model.generate(input_ids=input_ids, attention_mask=attention_mask, **parameters)
            cpu_codes = [(int(length), tensor.cpu()) for length, tensor in codes]
            require_complete_generation(cpu_codes, model.config.audio_end_token_id)
            return cpu_codes
        finally:
            # This helper returns before decoder allocation, including on failure.
            model = input_ids = attention_mask = batch = codes = None
            gc.collect()
            torch.cuda.empty_cache()

    def _decode(self, codes):
        import numpy as np
        import soundfile as sf
        import torch

        messages = None
        try:
            self.processor.audio_tokenizer.to("cuda")
            with torch.inference_mode():
                messages = self.processor.decode(codes)
            if len(messages) != 1 or messages[0] is None or len(messages[0].audio_codes_list) != 1:
                raise ValueError("解码音频段无效")
            audio = messages[0].audio_codes_list[0].cpu().float().numpy().reshape(-1)
            if len(audio) < 2400 or not np.isfinite(audio).all():
                raise ValueError("生成音频无效")
            peak = float(np.max(np.abs(audio)))
            rms = float(np.sqrt(np.mean(audio ** 2)))
            if rms < 0.001:
                raise ValueError("生成音频过于安静")
            output = io.BytesIO()
            sf.write(output, audio * min(1.0, 0.98 / peak), 24000, format="WAV", subtype="PCM_16")
            return validate_wav(output.getvalue())
        finally:
            messages = None
            try:
                self.processor.audio_tokenizer.to("cpu")
            except Exception:
                # A failed device move must not leave a persistent GPU codec.
                self.processor = self.reference_codes = None
                raise
            finally:
                gc.collect()
                torch.cuda.empty_cache()

    def synthesize(self, text):
        try:
            self.profile.assert_unchanged()
            self._load_reference()
            codes = self._generate(text)
            audio = self._decode(codes)
            self.profile.assert_unchanged()
            return audio
        except Exception as exc:
            # Failed Torch calls can retain entire CUDA modules in traceback
            # frames even after local model variables have been cleared.
            exc.__traceback__ = None
            exc.__context__ = None
            exc.__cause__ = None
            raise exc from None
        finally:
            gc.collect()
            if "torch" in sys.modules:
                sys.modules["torch"].cuda.empty_cache()

    def close(self):
        self.processor = self.reference_codes = None
        gc.collect()
        if "torch" in sys.modules:
            sys.modules["torch"].cuda.empty_cache()

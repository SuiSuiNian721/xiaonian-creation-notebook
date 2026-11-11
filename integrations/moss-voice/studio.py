"""One-shot local MOSS voice design, cloning, and CPU reference normalization."""

import argparse
from array import array
from dataclasses import dataclass
import gc
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sys
import wave

from engine import (MossEngine, ProfileChangedError, read_json, require_complete_generation,
                    sha256_file, token_budget, validate_wav)


SAMPLE_RATE = 24000
MAX_REFERENCE_BYTES = 32 * 1024 * 1024
AUDIO_EXTENSIONS = {".wav", ".flac", ".mp3", ".ogg"}


def local_path(value, label, kind):
    if not isinstance(value, (str, Path)) or not str(value) or "\0" in str(value):
        raise ValueError(label + "路径无效")
    path = Path(value)
    if not path.is_absolute() or str(path).startswith(("\\\\", "//")):
        raise ValueError(label + "需要本地绝对路径")
    # Reject Windows alternate data streams as well as device/network paths.
    if ":" in str(path)[len(path.drive):]:
        raise ValueError(label + "路径无效")
    path = path.resolve()
    if str(path).startswith(("\\\\", "//")):
        raise ValueError(label + "不能指向网络路径")
    if kind == "file" and not path.is_file():
        raise ValueError(label + "文件不存在")
    if kind == "directory" and not path.is_dir():
        raise ValueError(label + "目录不存在")
    if kind == "output":
        if path.suffix.lower() != ".wav" or path.exists() or not path.parent.is_dir():
            raise ValueError(label + "需要尚不存在的 WAV 文件及已存在的父目录")
    return path


@dataclass(frozen=True)
class StudioRequest:
    path: Path
    request_sha256: str
    mode: str
    text: str
    instruction: str
    seed: int
    model: Path | None
    codec: Path | None
    reference: Path | None
    reference_sha256: str | None
    output: Path
    reference_output: Path | None

    @classmethod
    def load(cls, path):
        path = local_path(path, "任务", "file")
        try:
            data, request_sha = read_json(path)
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise ValueError("任务需要有效的 UTF-8 JSON 对象") from exc
        mode = data.get("mode")
        if mode not in ("design", "clone", "normalize"):
            raise ValueError("声音任务模式无效")
        text = data.get("text", "")
        if not isinstance(text, str) or len(text) > 500 or (mode != "normalize" and not text.strip()):
            raise ValueError("试读台词需要 1–500 个字符")
        instruction = data.get("instruction", "")
        if not isinstance(instruction, str) or len(instruction) > 2000:
            raise ValueError("声音描述不能超过 2000 个字符")
        if mode == "design" and not instruction.strip():
            raise ValueError("声音生成需要声音描述")
        seed = data.get("seed", 0 if mode == "normalize" else None)
        if type(seed) is not int or not 0 <= seed <= 4294967295:
            raise ValueError("随机种子需要是 0–4294967295 的整数")
        model = codec = None
        if mode != "normalize":
            model = local_path(data.get("model"), "模型", "directory")
            codec = local_path(data.get("codec"), "编解码器", "directory")
        output = local_path(data.get("output"), "输出", "output")
        reference = reference_output = reference_sha = None
        if mode in ("clone", "normalize"):
            reference = local_path(data.get("reference"), "参考音频", "file")
            if reference.suffix.lower() not in AUDIO_EXTENSIONS:
                raise ValueError("参考音频仅支持 WAV、FLAC、MP3 或 OGG")
            if not 1 <= reference.stat().st_size <= MAX_REFERENCE_BYTES:
                raise ValueError("参考音频必须大于 0 字节且不超过 32 MiB")
            reference_sha = sha256_file(reference)
            if mode == "clone":
                reference_output = local_path(data.get("referenceOutput"), "标准化参考", "output")
                if reference_output == output:
                    raise ValueError("标准化参考和试听输出需要不同路径")
        return cls(path, request_sha, mode, text, instruction, seed, model, codec,
                   reference, reference_sha, output, reference_output)

    def assert_unchanged(self):
        try:
            unchanged = sha256_file(self.path) == self.request_sha256
            if self.reference is not None:
                unchanged = unchanged and sha256_file(self.reference) == self.reference_sha256
        except OSError:
            unchanged = False
        if not unchanged:
            raise ProfileChangedError("声音任务或参考音频已变更，请重新生成")


def audio_metadata(data):
    """Validate complete PCM bytes and reject silent results without Torch/numpy."""
    validate_wav(data)
    with wave.open(io.BytesIO(data), "rb") as wav:
        frame_count = wav.getnframes()
        pcm = array("h", wav.readframes(frame_count))
    if sys.byteorder != "little":
        pcm.byteswap()
    rms = math.sqrt(sum(int(sample) ** 2 for sample in pcm) / len(pcm)) / 32768
    if frame_count < 2400 or rms < 0.001:
        raise ValueError("音频为空、过短或过于安静")
    return {"durationSeconds": frame_count / SAMPLE_RATE,
            "sha256": hashlib.sha256(data).hexdigest(), "sampleRate": SAMPLE_RATE}


def validate_ogg(data):
    """Require intact logical streams, rather than libsndfile's recoverable prefix.

    Ogg framing/CRC: https://xiph.org/ogg/doc/framing.html
    """
    crc_table = []
    for index in range(256):
        checksum = index << 24
        for _ in range(8):
            checksum = ((checksum << 1) ^ (0x04C11DB7 if checksum & 0x80000000 else 0)) & 0xFFFFFFFF
        crc_table.append(checksum)
    offset, streams = 0, {}
    while offset < len(data):
        if (len(data) - offset < 27 or data[offset:offset + 4] != b"OggS"
                or data[offset + 4] != 0 or data[offset + 5] & ~7):
            raise ValueError("参考 OGG 页头不完整或无效")
        flags, segment_count = data[offset + 5], data[offset + 26]
        header_end = offset + 27 + segment_count
        if header_end > len(data):
            raise ValueError("参考 OGG 分段表不完整")
        lacing = data[offset + 27:header_end]
        page_end = header_end + sum(lacing)
        if page_end > len(data):
            raise ValueError("参考 OGG 页数据不完整")
        page = bytearray(data[offset:page_end])
        expected_crc = int.from_bytes(page[22:26], "little")
        page[22:26] = b"\0\0\0\0"
        checksum = 0
        for byte in page:
            checksum = ((checksum << 8) & 0xFFFFFFFF) ^ crc_table[((checksum >> 24) ^ byte) & 255]
        if checksum != expected_crc:
            raise ValueError("参考 OGG 页校验失败，文件可能已损坏")
        serial = int.from_bytes(page[14:18], "little")
        sequence = int.from_bytes(page[18:22], "little")
        previous = streams.get(serial)
        if previous is None:
            if not flags & 2 or flags & 1 or sequence != 0:
                raise ValueError("参考 OGG 缺少完整起始页")
            continued = False
        else:
            previous_sequence, continued, ended = previous
            if flags & 2 or ended or sequence != ((previous_sequence + 1) & 0xFFFFFFFF):
                raise ValueError("参考 OGG 页序列不连续")
            if bool(flags & 1) != continued:
                raise ValueError("参考 OGG 跨页音频包不完整")
        if lacing:
            continued = lacing[-1] == 255
        if flags & 4 and continued:
            raise ValueError("参考 OGG 终止页含未完成音频包")
        streams[serial] = (sequence, continued, bool(flags & 4))
        offset = page_end
    if not streams or any(not state[2] for state in streams.values()):
        raise ValueError("参考 OGG 缺少完整终止页")


def normalize_audio(request):
    """Decode bounded local media and produce mono 24 kHz PCM16 entirely on CPU."""
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly

    request.assert_unchanged()
    data = request.reference.read_bytes()
    if not 1 <= len(data) <= MAX_REFERENCE_BYTES:
        raise ValueError("参考音频不能超过 32 MiB")
    if hashlib.sha256(data).hexdigest() != request.reference_sha256:
        raise ProfileChangedError("参考音频已变更，请重新选择")
    if request.reference.suffix.lower() == ".wav":
        if (len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE"
                or int.from_bytes(data[4:8], "little") + 8 != len(data)):
            raise ValueError("参考 WAV 文件不完整")
    elif request.reference.suffix.lower() == ".ogg":
        validate_ogg(data)
    try:
        with sf.SoundFile(io.BytesIO(data)) as source:
            sample_rate, frames, channels = source.samplerate, source.frames, source.channels
            if not 8000 <= sample_rate <= 192000 or not 1 <= channels <= 8:
                raise ValueError("参考音频需要 8–192 kHz、1–8 声道")
            if not sample_rate <= frames <= 30 * sample_rate:
                raise ValueError("参考音频时长需要 1–30 秒")
            audio = source.read(dtype="float32", always_2d=True)
        if len(audio) != frames or not np.isfinite(audio).all():
            raise ValueError("参考音频解码不完整或含无效采样")
    except (sf.LibsndfileError, RuntimeError) as exc:
        raise ValueError("参考音频无法解码，请检查文件是否完整") from exc
    mono = np.mean(audio, axis=1, dtype=np.float64)
    if sample_rate != SAMPLE_RATE:
        divisor = math.gcd(SAMPLE_RATE, sample_rate)
        mono = resample_poly(mono, SAMPLE_RATE // divisor, sample_rate // divisor)
    if not np.isfinite(mono).all() or float(np.sqrt(np.mean(mono ** 2))) < 0.001:
        raise ValueError("参考音频为空或过于安静")
    peak = float(np.max(np.abs(mono)))
    output = io.BytesIO()
    sf.write(output, mono * min(1.0, 0.98 / peak), SAMPLE_RATE, format="WAV", subtype="PCM_16")
    normalized = output.getvalue()
    audio_metadata(normalized)
    return normalized


@dataclass(frozen=True)
class StudioProfile:
    request: StudioRequest
    reference: Path | None
    reference_sha256: str | None

    @property
    def model(self):
        return self.request.model

    @property
    def codec(self):
        return self.request.codec

    @property
    def parameters(self):
        parameters = {"max_new_tokens": 700,
                      "audio_temperature": 1.5 if self.request.mode == "design" else 1.0,
                      "audio_top_p": 0.6 if self.request.mode == "design" else 0.95,
                      "audio_top_k": 50, "audio_repetition_penalty": 1.1}
        # VoiceGenerator's strict generate() has no n_vq_for_inference;
        # Local-Transformer exposes it explicitly for reference cloning.
        if self.request.mode == "clone":
            parameters["n_vq_for_inference"] = 32
        return parameters

    def assert_unchanged(self):
        self.request.assert_unchanged()
        if self.reference is not None:
            try:
                same = sha256_file(self.reference) == self.reference_sha256
            except OSError:
                same = False
            if not same:
                raise ProfileChangedError("标准化参考音频已变更，请重新生成")


class StudioEngine(MossEngine):
    """Use the existing decoder with seeded design/reference-conditioned generation."""

    def __init__(self, request, reference=None):
        self.request = request
        profile = StudioProfile(request, reference, sha256_file(reference) if reference else None)
        super().__init__(profile)

    def _load_reference(self):
        if self.request.mode == "clone":
            return super()._load_reference()
        if self.loaded:
            return
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
        os.environ.setdefault("HF_MODULES_CACHE", str(Path(sys.prefix) / "hf-modules"))
        import torch
        import transformers
        from transformers import AutoProcessor

        if not torch.cuda.is_available():
            raise RuntimeError("本地声音生成需要可用的 CUDA 显卡")
        torch.set_num_threads(8)
        torch.backends.cuda.enable_cudnn_sdp(False)
        transformers.utils.logging.disable_progress_bar()
        transformers.utils.logging.set_verbosity_error()
        self.profile.assert_unchanged()
        # The official processor forwards unknown kwargs to its constructor;
        # offline processor loading is enforced through HF_HUB_OFFLINE.
        processor = AutoProcessor.from_pretrained(str(self.profile.model), codec_path=str(self.profile.codec),
            trust_remote_code=True, normalize_inputs=True)
        processor.audio_tokenizer.to("cpu").eval()
        # Voice design never encodes or invents a reference recording.
        processor.audio_tokenizer.encoder = torch.nn.ModuleList()
        self.profile.assert_unchanged()
        self.processor = processor
        gc.collect()

    def _generate(self, text):
        import torch
        from transformers import AutoModel, set_seed

        model = input_ids = attention_mask = batch = codes = None
        try:
            model = AutoModel.from_pretrained(str(self.profile.model), trust_remote_code=True,
                local_files_only=True, dtype=torch.bfloat16, attn_implementation="sdpa").to("cuda").eval()
            set_seed(self.request.seed)
            if self.request.mode == "design":
                message = self.processor.build_user_message(text=text, instruction=self.request.instruction)
            else:
                message = self.processor.build_user_message(text=text, reference=[self.reference_codes])
            batch = self.processor([[message]], mode="generation")
            input_ids = batch["input_ids"].to("cuda")
            attention_mask = batch["attention_mask"].to("cuda")
            parameters = {**self.profile.parameters,
                          "max_new_tokens": token_budget(text, self.profile.parameters["max_new_tokens"])}
            with torch.inference_mode():
                codes = model.generate(input_ids=input_ids, attention_mask=attention_mask, **parameters)
            cpu_codes = [(int(length), tensor.cpu()) for length, tensor in codes]
            require_complete_generation(cpu_codes, model.config.audio_end_token_id)
            return cpu_codes
        finally:
            # The language model must be gone before inherited _decode moves
            # the float32 codec to CUDA; together they exceed an 8 GiB GPU.
            model = input_ids = attention_mask = batch = codes = None
            gc.collect()
            torch.cuda.empty_cache()


def write_new_wav(path, data):
    """Publish only validated audio, never overwrite a caller's existing file."""
    audio_metadata(data)
    created = False
    try:
        with path.open("xb") as stream:
            created = True
            stream.write(data)
    except Exception:
        if created:
            path.unlink(missing_ok=True)
        raise


def process_request(request, *, engine_factory=StudioEngine):
    request.assert_unchanged()
    engine = None
    created = []
    try:
        try:
            reference = None
            if request.mode in ("clone", "normalize"):
                normalized = normalize_audio(request)
                request.assert_unchanged()
                reference = request.output if request.mode == "normalize" else request.reference_output
                write_new_wav(reference, normalized)
                created.append(reference)
            if request.mode == "normalize":
                audio = normalized
            else:
                engine = engine_factory(request, reference)
                audio = engine.synthesize(request.text)
                audio_metadata(audio)
                request.assert_unchanged()
                write_new_wav(request.output, audio)
                created.append(request.output)
            request.assert_unchanged()
            reference = reference or request.output
            return {"output": str(request.output), "reference": str(reference), **audio_metadata(audio),
                    "referenceSha256": sha256_file(reference)}
        finally:
            if engine is not None:
                engine.close()
    except BaseException:
        for path in reversed(created):
            path.unlink(missing_ok=True)
        raise


def main(argv=None):
    # Windows console defaults must not corrupt Chinese errors or JSON paths.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="本地 MOSS 声音工作进程")
    parser.add_argument("--request", required=True, help="受控 JSON 任务的本地绝对路径")
    args = parser.parse_args(argv)
    try:
        result = process_request(StudioRequest.load(args.request))
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0
    except Exception as exc:
        # No tracebacks/model dumps in the worker protocol; cap lower-level
        # library messages while retaining a readable reason for the UI.
        message = " ".join(str(exc).split())[:500] or type(exc).__name__
        print("声音任务失败：" + message, file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

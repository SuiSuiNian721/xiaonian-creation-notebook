"""Voice studio contracts; no real model loading or GPU inference."""

import ast
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave
import weakref


ROOT = Path(__file__).resolve().parent
HAS_AUDIO = all(importlib.util.find_spec(name) for name in ("numpy", "soundfile", "scipy"))
MODEL_SOURCES = {
    "design": Path(r"E:\voice\models\moss-voice-generator\MOSS-VoiceGenerator\modeling_moss_tts.py"),
    "clone": Path(r"E:\voice\models\moss-clone\MOSS-TTS-Local-Transformer\modeling_moss_tts.py"),
}


def strict_generation_boundary(mode, record):
    """Keep the installed model signature but replace all Torch work with a recorder."""
    source = MODEL_SOURCES[mode]
    if source.is_file():
        tree = ast.parse(source.read_text(encoding="utf-8"))
        model = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                     and node.name == "MossTTSDelayModel")
        method = next(node for node in model.body if isinstance(node, ast.FunctionDef)
                      and node.name == "generate")
    else:
        # CI and clean installs have no model weights. Mirror the official
        # signatures there so a generic **kwargs mock cannot hide drift.
        shared = ("self, input_ids, attention_mask=None, max_new_tokens=None, "
                  "text_temperature=None, text_top_p=None, text_top_k=None, "
                  "audio_temperature=None, audio_top_p=None, audio_top_k=None, "
                  "audio_repetition_penalty=None")
        extra = ", n_vq_for_inference=None, **kwargs" if mode == "clone" else ""
        method = ast.parse("def generate(" + shared + extra + "):\n    pass\n").body[0]
    method.decorator_list = []
    method.returns = None
    for argument in (*method.args.posonlyargs, *method.args.args, *method.args.kwonlyargs):
        argument.annotation = None
    for argument in (method.args.vararg, method.args.kwarg):
        if argument is not None:
            argument.annotation = None
    method.body = ast.parse("return record(locals())").body
    namespace = {"record": record}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), str(source), "exec"),
         namespace)
    return namespace["generate"]


def wav_bytes(duration=1.25, rate=24000, channels=1, amplitude=0.15):
    samples = (int(amplitude * 32767 * math.sin(2 * math.pi * 440 * i / rate))
               for i in range(round(duration * rate)))
    pcm = b"".join(struct.pack("<h", sample) * channels for sample in samples)
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm)
    return output.getvalue()


def ogg_page(sequence, flags, payload=b"packet", lacing=None):
    """Minimal checksummed framing fixture, independent of the audio decoder."""
    lacing = [len(payload)] if lacing is None else lacing
    header = struct.pack("<4sBBQIIIB", b"OggS", 0, flags, 0, 42, sequence, 0, len(lacing))
    page = bytearray(header + bytes(lacing) + payload)
    checksum = 0
    for byte in page:
        checksum ^= byte << 24
        for _ in range(8):
            checksum = ((checksum << 1) ^ (0x04C11DB7 if checksum & 0x80000000 else 0)) & 0xFFFFFFFF
    page[22:26] = checksum.to_bytes(4, "little")
    return bytes(page)


class StudioTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((ROOT / "studio.py").is_file(), "独立声音工作进程尚未实现")
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        import studio
        self.studio = studio
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        (self.directory / "model").mkdir()
        (self.directory / "codec").mkdir()
        self.reference = self.directory / "reference.wav"
        self.reference.write_bytes(wav_bytes())
        self.request_path = self.directory / "request.json"
        self.data = {"mode": "design", "text": "念念，今天的花开了。", "instruction": "温暖清亮、自然的年轻女性声音",
                     "seed": 4294967295, "model": str(self.directory / "model"),
                     "codec": str(self.directory / "codec"), "output": str(self.directory / "output.wav")}

    def request(self, **updates):
        self.request_path.write_text(json.dumps({**self.data, **updates}, ensure_ascii=False), encoding="utf-8")
        return self.studio.StudioRequest.load(self.request_path)

    def clone_request(self, **updates):
        return self.request(**{"mode": "clone", "reference": str(self.reference),
                            "referenceOutput": str(self.directory / "normalized.wav"), **updates})

    def test_import_does_not_load_torch_or_audio_libraries(self):
        completed = subprocess.run([sys.executable, "-B", "-c",
            "import sys; import studio; assert not any(n in sys.modules for n in ('torch','numpy','soundfile','scipy','transformers'))"],
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_design_requires_description_text_seed_and_local_model_directories(self):
        request = self.request()
        self.assertEqual(request.seed, 4294967295)
        self.assertEqual(request.instruction, self.data["instruction"])
        for updates in ({"instruction": " "}, {"text": ""}, {"text": "啊" * 501}, {"text": 123},
                        {"seed": True}, {"seed": -1}, {"seed": 4294967296}, {"seed": 1.5},
                        {"model": str(self.reference)}, {"codec": str(self.directory / "absent")},
                        {"mode": "other"}):
            with self.subTest(updates=updates), self.assertRaises(ValueError):
                self.request(**updates)

    def test_paths_must_be_local_absolute_and_outputs_cannot_overwrite_inputs(self):
        for updates in ({"output": "relative.wav"}, {"model": "relative-model"},
                        {"output": "https://example.com/output.wav"},
                        {"output": r"\\server\share\output.wav"},
                        {"output": str(self.directory)}, {"output": str(self.reference)},
                        {"output": str(self.directory / "out.mp3")},
                        {"output": str(self.directory / "missing" / "output.wav")}):
            with self.subTest(updates=updates), self.assertRaises(ValueError):
                self.request(**updates)
        with self.assertRaises(ValueError):
            self.studio.StudioRequest.load(Path("relative.json"))

    def test_clone_requires_distinct_reference_output_and_bounded_supported_audio(self):
        for updates in ({"reference": "relative.wav"}, {"reference": str(self.directory)},
                        {"referenceOutput": str(self.reference)},
                        {"referenceOutput": self.data["output"]}, {"referenceOutput": "relative.wav"}):
            value = {"mode": "clone", "reference": str(self.reference),
                     "referenceOutput": str(self.directory / "normalized.wav"), **updates}
            with self.subTest(updates=updates), self.assertRaises(ValueError):
                self.request(**value)
        unknown = self.directory / "reference.txt"
        unknown.write_bytes(wav_bytes())
        with self.assertRaises(ValueError):
            self.clone_request(reference=str(unknown))
        with self.reference.open("r+b") as stream:
            stream.truncate(32 * 1024 * 1024 + 1)
        with self.assertRaises(ValueError):
            self.clone_request()

    def test_normalize_does_not_require_model_seed_or_text(self):
        self.request_path.write_text(json.dumps({"mode": "normalize", "reference": str(self.reference),
            "output": self.data["output"]}), encoding="utf-8")
        request = self.studio.StudioRequest.load(self.request_path)
        self.assertEqual(request.mode, "normalize")
        self.assertEqual(request.reference, self.reference)

    def test_request_json_must_be_small_object(self):
        for raw in (b"[]", b"null", b"{", b" " * 65537):
            self.request_path.write_bytes(raw)
            with self.subTest(raw=raw[:8]), self.assertRaises(ValueError):
                self.studio.StudioRequest.load(self.request_path)

    @unittest.skipUnless(HAS_AUDIO, "需要本地 numpy/soundfile/scipy 音频环境")
    def test_normalization_downmixes_resamples_and_reports_matching_hashes_without_torch(self):
        self.reference.write_bytes(wav_bytes(rate=48000, channels=2))
        request = self.request(mode="normalize", reference=str(self.reference))
        result = self.studio.process_request(request)
        output = Path(result["output"]).read_bytes()
        with wave.open(io.BytesIO(output)) as wav:
            self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (1, 2, 24000))
            self.assertEqual(wav.getnframes(), 30000)
        self.assertEqual(result["sampleRate"], 24000)
        self.assertEqual(result["durationSeconds"], 1.25)
        self.assertEqual(result["reference"], result["output"])
        self.assertEqual(result["sha256"], hashlib.sha256(output).hexdigest())
        self.assertEqual(result["referenceSha256"], result["sha256"])
        self.assertNotIn("torch", sys.modules)

    @unittest.skipUnless(HAS_AUDIO, "需要本地 numpy/soundfile/scipy 音频环境")
    def test_invalid_silent_short_long_or_truncated_audio_is_not_published(self):
        for content in (b"not audio", wav_bytes(amplitude=0), wav_bytes(duration=0.99),
                        wav_bytes(duration=30.01), wav_bytes()[:-2]):
            self.reference.write_bytes(content)
            request = self.request(mode="normalize", reference=str(self.reference))
            with self.subTest(size=len(content)), self.assertRaises(ValueError):
                self.studio.process_request(request)
            self.assertFalse(request.output.exists())

    @unittest.skipUnless(HAS_AUDIO, "需要本地 numpy/soundfile/scipy 音频环境")
    def test_normalization_accepts_flac_ogg_and_mp3(self):
        import numpy as np
        import soundfile as sf
        for extension, audio_format in (("flac", "FLAC"), ("ogg", "OGG"), ("mp3", "MP3")):
            if audio_format not in sf.available_formats():
                continue
            reference = self.directory / ("source." + extension)
            signal = np.sin(np.arange(44100, dtype=np.float64) * (2 * math.pi * 440 / 44100)) * 0.2
            sf.write(reference, signal, 44100, format=audio_format)
            request = self.request(mode="normalize", reference=str(reference),
                                   output=str(self.directory / (extension + ".wav")))
            result = self.studio.process_request(request)
            self.assertGreaterEqual(result["durationSeconds"], 1)
            self.assertEqual(result["sampleRate"], 24000)

    @unittest.skipUnless(HAS_AUDIO, "需要本地 numpy/soundfile/scipy 音频环境")
    def test_truncated_ogg_cannot_succeed_with_only_earlier_decodable_pages(self):
        import numpy as np
        import soundfile as sf
        reference = self.directory / "source.ogg"
        signal = np.sin(np.arange(6 * 24000, dtype=np.float64) * (2 * math.pi * 440 / 24000)) * 0.2
        sf.write(reference, signal, 24000, format="OGG")
        original = reference.read_bytes()
        for index, content in enumerate((original[:-1], original[:-100], original[:original.rfind(b"OggS")])):
            reference.write_bytes(content)
            request = self.request(mode="normalize", reference=str(reference),
                                   output=str(self.directory / ("output-" + str(index) + ".wav")))
            with self.subTest(size=len(content)), self.assertRaisesRegex(ValueError, "OGG"):
                self.studio.process_request(request)
            self.assertFalse(request.output.exists())

    def test_ogg_requires_complete_checksums_sequences_packets_and_end_marker(self):
        self.assertTrue(callable(getattr(self.studio, "validate_ogg", None)), "缺少完整 OGG 容器校验")
        first, last = ogg_page(0, 2), ogg_page(1, 4)
        self.studio.validate_ogg(first + last)
        continued = ogg_page(0, 2, b"x" * 255, [255])
        self.studio.validate_ogg(continued + ogg_page(1, 5))
        corrupted = bytearray(first + last)
        corrupted[-1] ^= 1
        for data in (b"", first, first + last[:-1], first + ogg_page(2, 4),
                     ogg_page(0, 0) + last, first + ogg_page(1, 5),
                     continued + last, first + ogg_page(1, 4, b"x" * 255, [255]),
                     bytes(corrupted), first + last + b"trailing"):
            with self.subTest(size=len(data)), self.assertRaisesRegex(ValueError, "OGG"):
                self.studio.validate_ogg(data)

    def test_design_uses_description_without_reference_and_passes_seed_to_model(self):
        request = self.request()
        self.assert_generation_contract(request, {"text": request.text, "instruction": request.instruction})

    def test_design_processor_stays_on_cpu_and_discards_unused_encoder(self):
        request = self.request()
        events = []

        class Tokenizer:
            encoder = "unused-encoder"

            def to(self, device):
                events.append(device)
                return self

            def eval(self):
                return self

        processor = SimpleNamespace(audio_tokenizer=Tokenizer())

        def load_processor(*args, **kwargs):
            self.assertEqual(os.environ.get("HF_HUB_OFFLINE"), "1")
            self.assertNotIn("local_files_only", kwargs)
            self.assertTrue(kwargs.get("normalize_inputs"))
            return processor

        no_op = lambda *args, **kwargs: None
        fake_torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True),
            nn=SimpleNamespace(ModuleList=lambda: "empty-encoder"), set_num_threads=no_op,
            backends=SimpleNamespace(cuda=SimpleNamespace(enable_cudnn_sdp=no_op)))
        fake_transformers = SimpleNamespace(AutoProcessor=SimpleNamespace(from_pretrained=load_processor),
            utils=SimpleNamespace(logging=SimpleNamespace(disable_progress_bar=no_op, set_verbosity_error=no_op)))
        engine = self.studio.StudioEngine(request)
        with patch.dict(sys.modules, {"torch": fake_torch, "transformers": fake_transformers}), patch.dict(os.environ):
            engine._load_reference()
        self.assertEqual(events, ["cpu"])
        self.assertIs(engine.processor, processor)
        self.assertEqual(processor.audio_tokenizer.encoder, "empty-encoder")
        self.assertIsNone(engine.reference_codes)

    def test_clone_uses_reference_codes_and_passes_seed_to_model(self):
        request = self.clone_request()
        self.assert_generation_contract(request, {"text": request.text, "reference": ["encoded-reference"]})

    def assert_generation_contract(self, request, expected_message):
        calls, references, seed_calls, events = [], [], [], []

        class Tensor:
            def to(self, device):
                return self

        class Model:
            config = SimpleNamespace(audio_end_token_id=99)

            def to(self, device):
                events.append("model-to-" + device)
                return self

            def eval(self):
                return self

        def record_generation(arguments):
            calls.append({key: value for key, value in arguments.items() if key != "self"})
            return [(0, SimpleNamespace(cpu=lambda: [[1], [3], [99]]))]

        Model.generate = strict_generation_boundary(request.mode, record_generation)

        def make_model(*args, **kwargs):
            value = Model()
            references.append(weakref.ref(value))
            return value

        class Processor:
            def build_user_message(self, **kwargs):
                calls.append(kwargs)
                return kwargs

            def __call__(self, messages, mode):
                return {"input_ids": Tensor(), "attention_mask": Tensor()}

        fake_torch = SimpleNamespace(bfloat16="bf16", inference_mode=lambda: patch.dict({}, {}),
            cuda=SimpleNamespace(empty_cache=lambda: events.append("empty-cache")))
        fake_transformers = SimpleNamespace(AutoModel=SimpleNamespace(from_pretrained=make_model),
                                             set_seed=seed_calls.append)
        engine = self.studio.StudioEngine(request, request.reference)
        engine.processor = Processor()
        engine.reference_codes = "encoded-reference"
        with patch.dict(sys.modules, {"torch": fake_torch, "transformers": fake_transformers}):
            codes = engine._generate(request.text)
        self.assertEqual(seed_calls, [4294967295])
        self.assertEqual(calls[0], expected_message)
        self.assertGreaterEqual(calls[1]["max_new_tokens"], 650)
        if request.mode == "clone":
            self.assertEqual(calls[1]["n_vq_for_inference"], 32)
        else:
            self.assertNotIn("n_vq_for_inference", calls[1])
        self.assertEqual(len(codes), 1)
        self.assertIsNone(references[0](), "语言模型必须在编解码器进 GPU 前释放")
        self.assertIn("empty-cache", events)

    def test_capped_generation_is_rejected_even_when_reference_has_end_token(self):
        request = self.request()
        import engine
        with self.assertRaises(engine.IncompleteAudioError):
            self.studio.require_complete_generation([(1, [[1], [99], [4]])], 99)

    @unittest.skipUnless(HAS_AUDIO, "需要本地 numpy/soundfile/scipy 音频环境")
    def test_clone_normalizes_before_generation_and_cleans_failed_outputs(self):
        request = self.clone_request()
        observed = []

        class FailingEngine:
            def __init__(self, received, reference):
                observed.append(reference)
                with wave.open(str(reference)) as wav:
                    self_outer.assertEqual(wav.getframerate(), 24000)

            def synthesize(self, text):
                raise RuntimeError("模拟推理失败")

            def close(self):
                observed.append("closed")

        self_outer = self
        with self.assertRaises(RuntimeError):
            self.studio.process_request(request, engine_factory=FailingEngine)
        self.assertEqual(observed, [request.reference_output, "closed"])
        self.assertFalse(request.output.exists())
        self.assertFalse(request.reference_output.exists())
        self.assertTrue(self.reference.exists())

    def test_design_result_is_its_own_reference_and_engine_always_closes(self):
        request = self.request()
        calls = []

        class SuccessfulEngine:
            def __init__(self, received, reference):
                calls.append(reference)

            def synthesize(self, text):
                calls.append(text)
                return wav_bytes()

            def close(self):
                calls.append("closed")

        result = self.studio.process_request(request, engine_factory=SuccessfulEngine)
        self.assertEqual(calls, [None, request.text, "closed"])
        self.assertEqual(result["reference"], str(request.output))
        self.assertEqual(result["referenceSha256"], result["sha256"])

    def test_generated_silence_and_truncation_are_not_successful_results(self):
        for content in (wav_bytes(amplitude=0), wav_bytes()[:-2]):
            request = self.request()
            closed = []

            class InvalidEngine:
                def __init__(self, received, reference):
                    pass

                def synthesize(self, text):
                    return content

                def close(self):
                    closed.append(True)

            with self.subTest(size=len(content)), self.assertRaises(ValueError):
                self.studio.process_request(request, engine_factory=InvalidEngine)
            self.assertFalse(request.output.exists())
            self.assertEqual(closed, [True])

    def test_close_failure_does_not_leave_a_successful_audio_file(self):
        request = self.request()

        class UnclosedEngine:
            def __init__(self, received, reference):
                pass

            def synthesize(self, text):
                return wav_bytes()

            def close(self):
                raise RuntimeError("模拟资源释放失败")

        with self.assertRaises(RuntimeError):
            self.studio.process_request(request, engine_factory=UnclosedEngine)
        self.assertFalse(request.output.exists())

    def test_changed_request_or_reference_is_rejected_before_processing(self):
        for change_reference in (False, True):
            request = self.clone_request()
            if change_reference:
                self.reference.write_bytes(wav_bytes(amplitude=0.3))
            else:
                self.request_path.write_bytes(self.request_path.read_bytes() + b" ")
            with self.assertRaises(ValueError):
                self.studio.process_request(request)
            self.assertFalse(request.output.exists())
            self.assertFalse(request.reference_output.exists())

    @unittest.skipUnless(HAS_AUDIO, "需要本地 numpy/soundfile/scipy 音频环境")
    def test_cli_last_line_is_json_and_errors_are_bounded_readable_stderr(self):
        self.request(mode="normalize", reference=str(self.reference))
        completed = subprocess.run([sys.executable, "-B", "-u", str(ROOT / "studio.py"),
            "--request", str(self.request_path)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertEqual(result["output"], self.data["output"])
        self.request_path.write_text(json.dumps({**self.data, "seed": -1}), encoding="utf-8")
        failed = subprocess.run([sys.executable, "-B", "-u", str(ROOT / "studio.py"),
            "--request", str(self.request_path)], capture_output=True, text=True, encoding="utf-8")
        self.assertNotEqual(failed.returncode, 0)
        self.assertLess(len(failed.stderr), 1000)
        self.assertNotIn("Traceback", failed.stderr)
        self.assertIn("声音任务失败", failed.stderr)


if __name__ == "__main__":
    unittest.main()

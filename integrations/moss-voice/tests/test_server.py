"""HTTP contract tests: no Torch import and no real GPU inference."""

import ast
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import struct
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave
import weakref


ROOT = Path(__file__).resolve().parents[1]
TOKEN = "test-private-token-0123456789abcdef"
VOICE_ID = "xiaoli-warm-bright"


def wav_bytes():
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(struct.pack("<h", 1200) * 2400)
    return output.getvalue()


class FakeEngine:
    def __init__(self, profile):
        self.profile = profile
        self.loaded = False
        self.entered = threading.Event()
        self.release = threading.Event()
        self.block = False
        self.failure = None
        self.output = wav_bytes()
        self.calls = []

    def synthesize(self, text):
        self.calls.append(text)
        self.loaded = True
        self.entered.set()
        if self.block and not self.release.wait(5):
            raise RuntimeError("test timed out")
        if self.failure:
            raise self.failure
        return self.output

    def close(self):
        self.loaded = False


class EnginePolicyTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((ROOT / "engine.py").is_file(), "MOSS engine is not implemented")
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        import engine
        self.engine = engine

    def test_import_does_not_load_torch_and_token_cap_scales_for_long_text(self):
        self.assertNotIn("torch", sys.modules)
        self.assertEqual(self.engine.token_budget("短句", 650), 650)
        self.assertGreater(self.engine.token_budget("啊" * 500, 650), 3000)
        self.assertLessEqual(self.engine.token_budget("啊" * 500, 650), 4096)

    def test_reference_eos_cannot_disguise_a_truncated_generation(self):
        with self.assertRaises(self.engine.IncompleteAudioError):
            self.engine.require_complete_generation([(1, [[1], [99], [3], [4]])], 99)
        with self.assertRaises(self.engine.IncompleteAudioError):
            self.engine.require_complete_generation([], 99)
        self.engine.require_complete_generation([(0, [[1], [3], [99]])], 99)

    def test_inference_traceback_does_not_keep_model_resources_alive(self):
        class Profile:
            def assert_unchanged(self):
                pass

        class ModelResource:
            pass

        references = []

        def failing_generation(text):
            model_resource = ModelResource()
            references.append(weakref.ref(model_resource))
            try:
                raise ValueError("lower-level GPU failure")
            except ValueError as error:
                raise RuntimeError("GPU failure") from error

        instance = self.engine.MossEngine(Profile())
        instance._load_reference = lambda: None
        instance._generate = failing_generation
        try:
            instance.synthesize("你好")
        except RuntimeError:
            self.assertIsNone(references[0](), "inference traceback retained model resources")
        else:
            self.fail("inference failure was swallowed")

    def test_installed_processor_factory_does_not_forward_unsupported_constructor_kwargs(self):
        source = Path(r"E:\voice\models\moss-clone\MOSS-TTS-Local-Transformer\processing_moss_tts.py")
        if not source.is_file():
            self.skipTest("本机 MOSS 处理器源码不可用")
        # Compile only the installed factory, without importing its Torch model.
        tree = ast.parse(source.read_text(encoding="utf-8"))
        processor_class = next(node for node in tree.body if isinstance(node, ast.ClassDef)
            and node.name == "MossTTSDelayProcessor")
        factory = next(node for node in processor_class.body if isinstance(node, ast.FunctionDef)
            and node.name == "from_pretrained")
        factory.decorator_list = []

        class ProcessorBoundaryReached(Exception):
            pass

        class StrictProcessor:
            # ProcessorMixin accepts its declared components, not loader kwargs.
            def __init__(self, *, tokenizer, audio_tokenizer, model_config):
                raise ProcessorBoundaryReached()

        loader = SimpleNamespace(from_pretrained=lambda *args, **kwargs: object())
        namespace = {"Path": Path, "cast": lambda annotation, value: value,
            "MossTTSDelayConfig": object, "AutoConfig": loader, "AutoTokenizer": loader, "AutoModel": loader}
        exec(compile(ast.Module(body=[factory], type_ignores=[]), str(source), "exec"), namespace)
        StrictProcessor.from_pretrained = classmethod(namespace["from_pretrained"])
        no_op = lambda *args, **kwargs: None
        fake_torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True),
            set_num_threads=no_op, backends=SimpleNamespace(cuda=SimpleNamespace(enable_cudnn_sdp=no_op)))
        fake_transformers = SimpleNamespace(AutoProcessor=StrictProcessor,
            utils=SimpleNamespace(logging=SimpleNamespace(disable_progress_bar=no_op, set_verbosity_error=no_op)))
        instance = self.engine.MossEngine(SimpleNamespace(model=Path("fixed-model"), codec=Path("fixed-codec"),
            assert_unchanged=no_op))
        failure = None
        with patch.dict(sys.modules, {"numpy": SimpleNamespace(), "soundfile": SimpleNamespace(),
                "torch": fake_torch, "transformers": fake_transformers}), patch.dict(os.environ, {}, clear=False):
            try:
                instance._load_reference()
            except Exception as error:
                failure = error
            self.assertEqual(os.environ.get("HF_HUB_OFFLINE"), "1")
        self.assertIsInstance(failure, ProcessorBoundaryReached,
            "实际处理器把不受支持的加载参数透传给了构造函数：" + repr(failure))


class VoiceServerTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((ROOT / "server.py").is_file(), "MOSS HTTP service is not implemented")
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        spec = importlib.util.spec_from_file_location("moss_voice_test_server", ROOT / "server.py")
        self.module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self.module
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        reference = self.directory / "reference.wav"
        reference.write_bytes(wav_bytes())
        self.reference_sha = hashlib.sha256(reference.read_bytes()).hexdigest()
        self.profile_path = self.directory / "profile.json"
        self.profile = {
            "reference_file": str(reference), "reference_sha256": self.reference_sha,
            "model": str(self.directory / "model"), "codec": str(self.directory / "codec"),
            "parameters": {"max_new_tokens": 650, "audio_temperature": 1.0,
                "audio_top_p": 0.95, "audio_top_k": 50, "audio_repetition_penalty": 1.1,
                "n_vq_for_inference": 32},
        }
        (self.directory / "model").mkdir()
        (self.directory / "codec").mkdir()
        self.profile_path.write_text(json.dumps(self.profile), encoding="utf-8")
        self.profile_sha = hashlib.sha256(self.profile_path.read_bytes()).hexdigest()
        self.config_path = self.directory / "private.json"
        self.config = {"version": 1, "service": "moss-character-voice", "token": TOKEN,
            "profilePath": str(self.profile_path), "voiceId": VOICE_ID,
            "voiceName": "小璃 · 温暖清亮"}
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")
        self.server = self.module.create_server(self.config_path, port=0, engine_factory=FakeEngine)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.engine.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def request(self, method, path, data=None, *, auth=True, headers=None, raw=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        request_headers = {"Content-Type": "application/json"}
        if auth:
            request_headers["Authorization"] = "Bearer " + TOKEN
        request_headers.update(headers or {})
        body = raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
        conn.request(method, path, body=body, headers=request_headers)
        response = conn.getresponse()
        status, response_headers, content = response.status, dict(response.getheaders()), response.read()
        conn.close()
        return status, response_headers, content

    def speech(self, **updates):
        return {"input": "念念，早上好呀。", "voice": VOICE_ID, "model": "moss-tts-local",
                "response_format": "wav", **updates}

    def assert_json_error(self, response, status):
        actual_status, headers, body = response
        self.assertEqual(actual_status, status)
        self.assertIn("application/json", headers["Content-Type"])
        error = json.loads(body)["error"]
        self.assertIsInstance(error["code"], str)
        self.assertIsInstance(error["message"], str)
        self.assertNotIn(TOKEN, body.decode())
        self.assertNotIn(str(self.directory), body.decode())

    def test_health_identity_is_public_and_engine_is_lazy(self):
        status, _, body = self.request("GET", "/health", auth=False)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"service": "moss-character-voice", "version": 1,
                                         "busy": False, "loaded": False})
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        self.assertEqual(self.server.engine.calls, [])

    def test_bearer_is_required_for_all_private_routes(self):
        for method, path, data in [("GET", "/v1/voices", None), ("GET", "/v1/models", None),
                                   ("POST", "/v1/audio/speech", self.speech()), ("POST", "/shutdown", {})]:
            with self.subTest(path=path):
                self.assert_json_error(self.request(method, path, data, auth=False), 401)
                self.assert_json_error(self.request(method, path, data,
                    headers={"Authorization": "Bearer wrong"}), 401)

    def test_voice_metadata_is_exact_profile_and_reference_identity(self):
        status, _, body = self.request("GET", "/v1/voices")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"voices": [{"id": VOICE_ID, "name": "测试音色 · 温暖清亮",
            "profileSha256": self.profile_sha, "referenceSha256": self.reference_sha}]})
        status, _, body = self.request("GET", "/v1/models")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["object"], "list")
        self.assertEqual(json.loads(body)["data"][0]["id"], "moss-tts-local")

    def test_complete_pcm16_wav_has_matching_identity_headers(self):
        status, headers, body = self.request("POST", "/v1/audio/speech", self.speech())
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "audio/wav")
        self.assertEqual(int(headers["Content-Length"]), len(body))
        self.assertEqual(headers["X-Voice-Id"], VOICE_ID)
        self.assertEqual(headers["X-Voice-Profile-SHA256"], self.profile_sha)
        self.assertEqual(headers["X-Reference-SHA256"], self.reference_sha)
        self.assertEqual(body, wav_bytes())
        with wave.open(io.BytesIO(body)) as wav:
            self.assertEqual((wav.getsampwidth(), wav.getframerate(), wav.getnframes()), (2, 24000, 2400))

    def test_invalid_voice_model_format_and_text_are_rejected_before_inference(self):
        cases = [self.speech(voice="other"), self.speech(model="other"), self.speech(response_format="mp3"),
                 self.speech(input=""), self.speech(input="  "), self.speech(input="啊" * 501),
                 self.speech(input=1), [], None]
        for data in cases:
            with self.subTest(data=data):
                self.assert_json_error(self.request("POST", "/v1/audio/speech", data, raw=b"null" if data is None else None), 400)
        self.assertEqual(self.server.engine.calls, [])
        self.assertEqual(self.request("POST", "/v1/audio/speech", self.speech(input="啊" * 500))[0], 200)

    def test_busy_request_is_429_and_health_remains_responsive(self):
        self.server.engine.block = True
        responses = []
        worker = threading.Thread(target=lambda: responses.append(self.request("POST", "/v1/audio/speech", self.speech())))
        worker.start()
        self.assertTrue(self.server.engine.entered.wait(2))
        try:
            _, _, body = self.request("GET", "/health", auth=False)
            self.assertTrue(json.loads(body)["busy"])
            self.assert_json_error(self.request("POST", "/v1/audio/speech", self.speech()), 429)
        finally:
            self.server.engine.release.set()
            worker.join(3)
        self.assertEqual(responses[0][0], 200)
        self.assertEqual(len(self.server.engine.calls), 1)
        self.assertFalse(json.loads(self.request("GET", "/health", auth=False)[2])["busy"])

    def test_inference_failure_is_private_json_and_lock_is_released(self):
        self.server.engine.failure = RuntimeError(TOKEN + str(self.directory))
        self.assert_json_error(self.request("POST", "/v1/audio/speech", self.speech()), 500)
        self.server.engine.failure = None
        self.assertEqual(self.request("POST", "/v1/audio/speech", self.speech())[0], 200)

    def test_invalid_or_truncated_audio_is_not_delivered(self):
        for output in [b"not audio", wav_bytes()[:-2], wav_bytes() + b"unexpected"]:
            self.server.engine.output = output
            self.assert_json_error(self.request("POST", "/v1/audio/speech", self.speech()), 500)

    def test_profile_or_reference_changed_after_start_never_uses_stale_identity(self):
        self.profile_path.write_bytes(self.profile_path.read_bytes() + b" ")
        self.assert_json_error(self.request("POST", "/v1/audio/speech", self.speech()), 409)
        self.assertEqual(self.server.engine.calls, [])

    def test_changed_reference_is_rejected_by_metadata_and_speech(self):
        Path(self.profile["reference_file"]).write_bytes(wav_bytes() + b"changed")
        self.assert_json_error(self.request("GET", "/v1/voices"), 409)
        self.assert_json_error(self.request("POST", "/v1/audio/speech", self.speech()), 409)
        self.assertEqual(self.server.engine.calls, [])

    def test_capped_generation_is_an_explicit_json_error_and_cannot_return_audio(self):
        self.server.engine.failure = self.module.IncompleteAudioError("reached token cap")
        status, headers, body = self.request("POST", "/v1/audio/speech", self.speech())
        self.assertEqual(status, 422)
        self.assertIn("application/json", headers["Content-Type"])
        self.assertEqual(json.loads(body)["error"]["code"], "generation_incomplete")

    def test_shutdown_waits_for_running_generation_and_rejects_new_work(self):
        self.server.engine.block = True
        responses = []
        worker = threading.Thread(target=lambda: responses.append(self.request("POST", "/v1/audio/speech", self.speech())))
        worker.start()
        self.assertTrue(self.server.engine.entered.wait(2))
        self.assertEqual(self.request("POST", "/shutdown", {})[0], 200)
        self.server.engine.release.set()
        worker.join(3)
        self.assertEqual(responses[0][0], 200)
        self.thread.join(2)
        self.assertFalse(self.thread.is_alive())

    def test_reference_hash_mismatch_prevents_service_creation(self):
        Path(self.profile["reference_file"]).write_bytes(b"changed")
        with self.assertRaises(ValueError):
            self.module.create_server(self.config_path, port=0, engine_factory=FakeEngine)

    def test_service_identity_and_fixed_voice_cannot_be_reconfigured_as_fallback(self):
        for update in [{"service": "unrelated"}, {"version": True}, {"voiceId": "fallback"},
                       {"voiceName": "other"}, {"token": "short"}]:
            with self.subTest(update=update):
                self.config_path.write_text(json.dumps({**self.config, **update}), encoding="utf-8")
                with self.assertRaises(ValueError):
                    self.module.create_server(self.config_path, port=0, engine_factory=FakeEngine)

    def test_foreign_host_and_origin_are_rejected_even_with_token(self):
        for headers in [{"Host": "evil.example"}, {"Host": "127.0.0.1.evil.example"},
                        {"Origin": "https://evil.example"}, {"Origin": "null"},
                        {"Origin": "http://localhost.evil.example"}]:
            with self.subTest(headers=headers):
                self.assert_json_error(self.request("GET", "/v1/voices", headers=headers), 403)
        self.assertEqual(self.request("GET", "/v1/voices", headers={"Origin": "http://localhost:3210"})[0], 200)

    def test_bad_json_and_oversized_or_wrong_content_type_body_are_json_errors(self):
        self.assert_json_error(self.request("POST", "/v1/audio/speech", raw=b"{"), 400)
        self.assert_json_error(self.request("POST", "/v1/audio/speech", raw=b"x" * 20000), 413)
        self.assert_json_error(self.request("POST", "/v1/audio/speech", self.speech(),
            headers={"Content-Type": "text/plain"}), 415)

    def test_transfer_encoding_and_duplicate_length_are_rejected(self):
        port = self.server.server_port
        requests = [
            f"POST /v1/audio/speech HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
            f"POST /v1/audio/speech HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: 0\r\nContent-Length: 20\r\n\r\n",
        ]
        for payload in requests:
            with socket.create_connection(("127.0.0.1", port), timeout=3) as connection:
                connection.sendall(payload.encode())
                response = http.client.HTTPResponse(connection)
                response.begin()
                self.assertEqual(response.status, 400)
                self.assertIsInstance(json.loads(response.read())["error"], dict)

    def test_unknown_route_is_json_and_shutdown_only_stops_own_server(self):
        self.assert_json_error(self.request("GET", "/unknown"), 404)
        self.assertEqual(self.request("POST", "/shutdown", {})[0], 200)
        self.thread.join(2)
        self.assertFalse(self.thread.is_alive())


if __name__ == "__main__":
    unittest.main()

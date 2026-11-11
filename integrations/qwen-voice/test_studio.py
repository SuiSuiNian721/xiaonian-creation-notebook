"""Adapter contract tests use fake model APIs; no torch imports or weights."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

ADAPTER = Path(__file__).with_name("studio.py")


class QwenAdapterTests(unittest.TestCase):
    def load(self):
        self.assertTrue(ADAPTER.is_file(), "Qwen需要独立Python适配器")
        spec = importlib.util.spec_from_file_location("workbench_qwen_studio", ADAPTER)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module

    def test_dispatch_clone_requires_base_audio_and_transcript(self):
        module = self.load()
        class Model:
            def generate_voice_clone(self, **kwargs):
                self.kwargs = kwargs
                return [[0.1, -0.1]], 24000
        model = Model()
        module.generate(model, {"mode": "clone", "modelKind": "base", "text": "你好", "language": "Chinese", "transcript": "参考台词"}, "reference.wav")
        self.assertEqual(model.kwargs["ref_audio"], "reference.wav")
        self.assertEqual(model.kwargs["ref_text"], "参考台词")
        self.assertFalse(model.kwargs["x_vector_only_mode"])

    def test_design_and_custom_voice_call_distinct_official_methods(self):
        module = self.load()
        class Model:
            def generate_voice_design(self, **kwargs):
                self.design = kwargs
                return [[0.1]], 24000
            def generate_custom_voice(self, **kwargs):
                self.custom = kwargs
                return [[0.1]], 24000
        model = Model()
        module.generate(model, {"mode": "design", "modelKind": "voice-design", "text": "你好", "instruction": "温暖", "language": "Chinese"})
        self.assertEqual(model.design["instruct"], "温暖")
        module.generate(model, {"mode": "synthesis", "modelKind": "custom-voice", "text": "你好", "speaker": "Vivian", "language": "Chinese"})
        self.assertEqual(model.custom["speaker"], "Vivian")
        with self.assertRaisesRegex(ValueError, "模型|模式"):
            module.generate(model, {"mode": "clone", "modelKind": "voice-design", "text": "你好"})

    def test_loader_is_local_only_and_uses_supplied_model_path(self):
        module = self.load()
        class Loader:
            @classmethod
            def from_pretrained(cls, path, **kwargs):
                cls.path, cls.kwargs = path, kwargs
                return cls()
        with tempfile.TemporaryDirectory() as directory:
            module.load_model(Path(directory), Loader, "float32", "cpu")
            self.assertEqual(Loader.path, directory)
            self.assertTrue(Loader.kwargs["local_files_only"])
            self.assertEqual(Loader.kwargs["attn_implementation"], "sdpa")


if __name__ == "__main__":
    unittest.main()

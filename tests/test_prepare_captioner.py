import contextlib
import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest

INTEGRATION = Path(__file__).resolve().parents[1] / 'integrations' / 'next-trainer'
sys.path.insert(0, str(INTEGRATION))
from prepare_captioner import prepare


class PrepareCaptioner(unittest.TestCase):
    def test_native_registry_filenames_endpoint_and_no_model_load(self):
        with tempfile.TemporaryDirectory(prefix='.captioner-download-') as tmp:
            directory = Path(tmp) / 'assets'; directory.mkdir()
            events = []
            @contextlib.contextmanager
            def endpoint(value): events.append(('endpoint', value)); yield
            def download(**kwargs):
                events.append(kwargs)
                path = directory / kwargs['filename']; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b'fixture')
                return str(path)
            hub = types.SimpleNamespace(hf_hub_download=download)
            prepare({'captionerId': 'cl_tagger_1_01', 'directory': str(directory), 'downloadEndpoint': 'https://modelscope.cn'}, hub=hub, endpoint_context=endpoint)
            self.assertEqual(events[0], ('endpoint', 'https://modelscope.cn'))
            self.assertEqual([item['filename'] for item in events[1:]], ['cl_tagger_1_01/model.onnx', 'cl_tagger_1_01/tag_mapping.json'])
            self.assertTrue(all(item['repo_id'] == 'cella110n/cl_tagger' for item in events[1:]))
            self.assertNotIn('torch', sys.modules)
            self.assertNotIn('transformers', sys.modules)
            self.assertNotIn('onnxruntime', sys.modules)

    def test_florence_download_allows_data_files_but_no_remote_python(self):
        with tempfile.TemporaryDirectory(prefix='.captioner-download-') as tmp:
            directory = Path(tmp) / 'assets'; directory.mkdir(); calls = []
            def snapshot(repo, **kwargs): calls.append((repo, kwargs)); return str(directory)
            prepare({'captionerId': 'florence2-base', 'directory': str(directory)}, hub=types.SimpleNamespace(snapshot_download=snapshot), endpoint_context=lambda value: contextlib.nullcontext())
            repo, options = calls[0]
            self.assertEqual(repo, 'florence-community/Florence-2-base')
            self.assertEqual(options['revision'], '00921df66db728a9ceb750f5eca43e5c203a2051')
            self.assertEqual(options['allow_patterns'], ['*.json', '*.txt', 'LICENSE', 'model.safetensors'])
            self.assertNotIn('torch', sys.modules)

    def test_unknown_model_or_external_destination_never_calls_downloader(self):
        hub = types.SimpleNamespace(hf_hub_download=lambda **kwargs: self.fail('must not download'))
        for request in [{'captionerId': 'other', 'directory': 'E:/outside'}, {'captionerId': 'wd-vit-v3', 'directory': 'E:/outside'}, {'captionerId': 'wd-vit-v3', 'directory': 'E:/outside', 'downloadEndpoint': 'https://custom.invalid'}]:
            with self.subTest(request=request), self.assertRaises(ValueError):
                prepare(request, hub=hub, endpoint_context=lambda value: contextlib.nullcontext())


if __name__ == '__main__':
    unittest.main()

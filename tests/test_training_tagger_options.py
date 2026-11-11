import contextlib
import hashlib
import importlib.util
import json
from pathlib import Path
import runpy
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
INTEGRATION = PROJECT / 'integrations' / 'next-trainer'
sys.path.insert(0, str(INTEGRATION / 'source'))
sys.path.insert(0, str(INTEGRATION))
import workbench_caption as captions


class NativeTaggerOptions(unittest.TestCase):
    def fixture(self, root, existing='old_tag', requires=False):
        from PIL import Image
        images = root / 'images'; images.mkdir()
        image = images / '000001.png'; Image.new('RGB', (16, 16), 'white').save(image)
        caption = image.with_suffix('.txt'); caption.write_text(existing, encoding='utf-8')
        item = {'name': image.name, 'kind': 'original', 'sha256': hashlib.sha256(image.read_bytes()).hexdigest(), 'requiresCaption': requires, 'captionSha256': hashlib.sha256(caption.read_bytes()).hexdigest()}
        (root / 'dataset-manifest.json').write_text(json.dumps({'format': 2, 'owner': 'owner', 'imageDir': str(images), 'items': [item]}), encoding='utf-8')
        return {'path': str(images), 'captionFormat': 'tags', 'purpose': 'character', 'trigger': '', 'model': 'cl_tagger_1_01', 'policy': 'fill-missing', 'requestId': 'request-1', 'allowDownload': False}, image, caption

    def test_native_thresholds_rating_model_additional_and_escaping_are_applied(self):
        fake = types.SimpleNamespace(tags=None, load=lambda: None, interrogate=lambda image: {'general': [('low_tag', .25), ('custom_(tag)', .91)], 'character': [('alice', .7)], 'rating': [('safe', .99)], 'model': [('model_name', .98)]})
        fetched = types.ModuleType('mikazuki.tagger.model_fetch')
        fetched.interrogator_assets_ready = lambda *args: True
        fetched.ensure_interrogator_assets = lambda *args: self.fail('must not download')
        fetched.use_download_endpoint = lambda endpoint: contextlib.nullcontext()
        registry = types.ModuleType('mikazuki.tagger.interrogator'); registry.available_interrogators = {'cl_tagger_1_01': fake}
        with patch.dict(sys.modules, {'mikazuki.tagger.interrogator': registry, 'mikazuki.tagger.model_fetch': fetched}):
            captioner = captions.WD14Captioner({'model': 'cl_tagger_1_01', 'allowDownload': False, 'taggerOptions': {'threshold': .2, 'character_threshold': .8, 'add_rating_tag': True, 'add_model_tag': True, 'additional_tags': 'extra_tag', 'replace_underscore': False, 'escape_tag': True}})
            result = captioner(None)
        self.assertIn('low_tag', result)
        self.assertIn('model_name', result)
        self.assertIn('safe', result)
        self.assertIn('extra_tag', result)
        self.assertIn(r'custom_\(tag\)', result)
        self.assertNotIn('alice', result)

    def test_conflict_actions_have_native_order_and_preserve_verified_hashes(self):
        for action, expected, calls in [('ignore', 'old_tag', 0), ('copy', 'new_tag', 1), ('prepend', 'new_tag, old_tag', 1), ('append', 'old_tag, new_tag', 1)]:
            with self.subTest(action=action), tempfile.TemporaryDirectory() as tmp:
                config, image, caption = self.fixture(Path(tmp))
                config['taggerOptions'] = {'batch_output_action_on_conflict': action}
                generated = []
                def generator(image): generated.append(True); return ['new_tag']
                result = captions.caption_dataset(config, 'owner', generator=generator)
                self.assertEqual(caption.read_text(encoding='utf-8').strip(), expected)
                self.assertEqual(len(generated), calls)
                manifest = json.loads((image.parent.parent / 'dataset-manifest.json').read_text(encoding='utf-8'))
                self.assertEqual(manifest['items'][0]['captionSha256'], hashlib.sha256(caption.read_bytes()).hexdigest())
                self.assertTrue(result['complete'])

    def test_changed_image_during_model_call_cannot_commit_caption_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            config, image, caption = self.fixture(Path(tmp), requires=True)
            before = caption.read_bytes()
            def generator(_): image.write_bytes(b'changed'); return ['new_tag']
            with self.assertRaisesRegex(ValueError, '改变|校验'):
                captions.caption_dataset(config, 'owner', generator=generator)
            self.assertEqual(caption.read_bytes(), before)
            manifest = json.loads((image.parent.parent / 'dataset-manifest.json').read_text(encoding='utf-8'))
            self.assertNotIn('captions', manifest)

    def test_append_retry_after_caption_write_reuses_verified_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            config, image, caption = self.fixture(Path(tmp))
            config['taggerOptions'] = {'batch_output_action_on_conflict': 'append'}
            def interrupted(*args): raise RuntimeError('controlled cancellation')
            with self.assertRaisesRegex(RuntimeError, 'controlled cancellation'):
                captions.caption_dataset(config, 'owner', generator=lambda image: ['new_tag'], progress=interrupted)
            self.assertFalse(json.loads((image.parent.parent / 'dataset-manifest.json').read_text(encoding='utf-8')).get('captions', {}).get('complete', False))
            result = captions.caption_dataset(config, 'owner', generator=lambda image: self.fail('retry must reuse completed caption'))
            self.assertEqual(caption.read_text(encoding='utf-8').strip(), 'old_tag, new_tag')
            self.assertEqual(result['generatedCount'], 0)
            self.assertEqual(result['reusedCount'], 1)

    def test_new_task_attempt_resumes_same_caption_operation_but_changed_options_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            config, image, caption = self.fixture(Path(tmp))
            config.update(captionOperationId='flow.tag', requestId='flow.tag.0', taggerOptions={'batch_output_action_on_conflict': 'append'})
            def interrupted(*args): raise RuntimeError('controlled cancellation')
            with self.assertRaises(RuntimeError):
                captions.caption_dataset(config, 'owner', generator=lambda image: ['new_tag'], progress=interrupted)
            changed = {**config, 'requestId': 'flow.tag.1', 'taggerOptions': {'batch_output_action_on_conflict': 'copy'}}
            with self.assertRaisesRegex(ValueError, '标注.*改变|校验'):
                captions.caption_dataset(changed, 'owner', generator=lambda image: ['different_tag'])
            continued = {**config, 'requestId': 'flow.tag.1'}
            self.assertFalse(captions.caption_needs_model(continued))
            result = captions.caption_dataset(continued, 'owner', generator=lambda image: self.fail('same operation must reuse completed caption'))
            self.assertEqual(caption.read_text(encoding='utf-8').strip(), 'old_tag, new_tag')
            self.assertEqual(result['generatedCount'], 0)
            self.assertEqual(result['requestId'], 'flow.tag.1')

    def test_explicit_native_additional_style_tag_survives_automatic_style_filter(self):
        with tempfile.TemporaryDirectory() as tmp:
            config, image, caption = self.fixture(Path(tmp), requires=True)
            config.update(purpose='style', taggerOptions={'additional_tags': 'watercolor', 'batch_output_action_on_conflict': 'copy'})
            captions.caption_dataset(config, 'owner', generator=lambda image: ['watercolor', 'new_tag'])
            self.assertIn('watercolor', caption.read_text(encoding='utf-8'))

    def test_changed_caption_hash_is_rejected_without_a_matching_write_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            config, image, caption = self.fixture(Path(tmp))
            caption.write_text('tampered', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, '标注.*改变|校验'):
                captions.caption_dataset(config, 'owner', generator=lambda image: ['new_tag'])

    def test_cl_assets_use_native_nested_mapping_paths_without_network(self):
        runner = runpy.run_path(str(INTEGRATION / 'runner.py'))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); models = root / 'tagger-models' / 'wd14' / 'cl_tagger_1_01' / 'cl_tagger_1_01'; models.mkdir(parents=True)
            (models / 'model.onnx').write_bytes(b'fixture')
            (models / 'tag_mapping.json').write_text('{}', encoding='utf-8')
            with patch.object(importlib.util, 'find_spec', return_value=object()):
                result = runner['tagger_capabilities']({'model': 'cl_tagger_1_01', 'allowDownload': False}, root, root / 'data')
            self.assertTrue(result['ok'], result)
            self.assertTrue(result['modelReady'])

    def test_instance_assets_take_precedence_over_shared_kernel_assets(self):
        runner = runpy.run_path(str(INTEGRATION / 'runner.py'))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for storage in ('instance', 'shared', 'external'):
                models = root / storage / 'tagger-models' / 'wd14' / 'cl_tagger_1_01' / 'cl_tagger_1_01'
                models.mkdir(parents=True)
                (models / 'model.onnx').write_bytes(b'fixture')
                (models / 'tag_mapping.json').write_text('{}', encoding='utf-8')
            with patch.object(importlib.util, 'find_spec', return_value=object()):
                result = runner['tagger_capabilities']({'model': 'cl_tagger_1_01', 'allowDownload': False, 'captionResourceRoot': str(root / 'instance')}, root / 'external', root / 'shared')
            self.assertTrue(result['ok'], result)
            self.assertEqual(Path(result['modelsRoot']), root / 'instance' / 'tagger-models')

    def test_missing_cl_assets_checks_only_native_hub_cache_filenames(self):
        runner = runpy.run_path(str(INTEGRATION / 'runner.py'))
        self.assertEqual(len(runner['TAGGER_MODELS']), 10)
        requests = []
        hub = types.ModuleType('huggingface_hub')
        def cache(repo, name, revision): requests.append((repo, name, revision)); return None
        hub.try_to_load_from_cache = cache
        hub.hf_hub_download = lambda *args, **kwargs: self.fail('readiness must not download')
        with tempfile.TemporaryDirectory() as tmp, patch.object(importlib.util, 'find_spec', return_value=object()), patch.dict(sys.modules, {'huggingface_hub': hub}):
            result = runner['tagger_capabilities']({'model': 'cl_tagger_1_01', 'allowDownload': False}, Path(tmp), Path(tmp) / 'data')
        self.assertFalse(result['ok'])
        self.assertEqual(result['missingFiles'], ['cl_tagger_1_01/model.onnx', 'cl_tagger_1_01/tag_mapping.json'])
        self.assertEqual(requests[0], ('cella110n/cl_tagger', 'cl_tagger_1_01/model.onnx', 'main'))

    def test_missing_model_never_downloads_without_explicit_opt_in(self):
        events = []
        fake = types.SimpleNamespace(tags=None, kwargs={}, load=lambda: events.append('load'))
        fetched = types.ModuleType('mikazuki.tagger.model_fetch')
        fetched.interrogator_assets_ready = lambda *args: False
        fetched.ensure_interrogator_assets = lambda *args: events.append('download')
        @contextlib.contextmanager
        def endpoint(value): events.append(('endpoint', value)); yield
        fetched.use_download_endpoint = endpoint
        registry = types.ModuleType('mikazuki.tagger.interrogator'); registry.available_interrogators = {'cl_tagger_1_01': fake}
        config = {'model': 'cl_tagger_1_01', 'allowDownload': False, 'taggerOptions': {'download_endpoint': 'https://modelscope.cn'}}
        with patch.dict(sys.modules, {'mikazuki.tagger.interrogator': registry, 'mikazuki.tagger.model_fetch': fetched}):
            with self.assertRaisesRegex(ValueError, '不能联网'):
                captions.WD14Captioner(config)
            self.assertEqual(events, [('endpoint', '')])
            events.clear()
            captions.WD14Captioner({**config, 'allowDownload': True})
            self.assertEqual(events, [('endpoint', 'https://modelscope.cn'), 'download', 'load'])

    def test_derived_requires_caption_cannot_keep_stale_original_caption_on_ignore(self):
        with tempfile.TemporaryDirectory() as tmp:
            config, image, caption = self.fixture(Path(tmp), requires=True)
            config['taggerOptions'] = {'batch_output_action_on_conflict': 'ignore'}
            result = captions.caption_dataset(config, 'owner', generator=lambda image: ['new_crop_tag'])
            self.assertEqual(result['generatedCount'], 1)
            self.assertEqual(caption.read_text(encoding='utf-8').strip(), 'new_crop_tag')


if __name__ == '__main__':
    unittest.main()

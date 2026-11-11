"""Exercise the actual API adapter with local fixtures; no engine/ML imports."""
import json
import os
from pathlib import Path
import runpy
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
guard = runpy.run_path(str(ROOT / 'integrations' / 'next-trainer' / 'runner.py'))['protect_dataset']


class DatasetGuardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='training-python-guard-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.images('source')

    def images(self, name):
        path = self.root / name
        path.mkdir()
        (path / 'portrait.png').write_bytes(b'controlled image fixture')
        (path / 'portrait.txt').write_text('A portrait of a character.\n', encoding='utf-8')
        return path

    def test_moss_source_and_cache_only(self):
        guard({'src': str(self.source)}, 'moss')
        cache = self.root / 'cache'
        cache.mkdir()
        guard({'run_preprocess': False, 'cache_dir': str(cache)}, 'moss')
        guard({'run_preprocess': 'false', 'cache_dir': str(cache)}, 'moss')
        with self.assertRaises(ValueError):
            guard({'run_preprocess': False}, 'moss')
        self.assertEqual(sorted(p.name for p in self.source.iterdir()), ['portrait.png', 'portrait.txt'])

    def test_flat_and_edit_directories(self):
        references = self.images('references')
        for engine in ('diffsynth', 'ai-toolkit', 'anima-fast'):
            guard({'train_data_dir': str(self.source)}, engine)
        guard({'source_image_dir': str(self.source)}, 'anima-fast')
        guard({'training_task': 'image-edit', 'output_data_dir': str(self.source),
               'input_data_dirs': [str(references)]}, 'diffsynth')
        guard({'training_task': 'image-edit', 'train_data_dir': str(self.source),
               'control_data_dirs': [str(references)]}, 'ai-toolkit')

    def test_metadata_formats_and_external_reference_path_rejection(self):
        row = {'image': 'portrait.png', 'prompt': 'A portrait, with a smile.', 'edit_image': ['portrait.png']}
        for extension, content in (
            ('json', json.dumps([row])),
            ('jsonl', json.dumps(row) + '\n'),
            ('csv', 'image,prompt,edit_image\r\nportrait.png,"A portrait,\nwith a ""smile"".","[""portrait.png""]"\r\n'),
        ):
            metadata = self.root / ('dataset.' + extension)
            metadata.write_text(content, encoding='utf-8', newline='')
            config = {'dataset_format': 'metadata', 'training_task': 'image-edit',
                      'dataset_base_path': str(self.source), 'dataset_metadata_path': str(metadata)}
            guard(config, 'diffsynth')
            with metadata.open(encoding='utf-8', newline='') as stream:
                self.assertEqual(stream.read(), content)
        metadata = self.root / 'unsafe.json'
        metadata.write_text(json.dumps([{**row, 'image': r'\\server\dataset\portrait.png'}]), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '本地'):
            guard({**config, 'dataset_metadata_path': str(metadata)}, 'diffsynth')

    def test_kohya_and_musubi_keep_no_organization_rule(self):
        dataset = self.root / 'dataset.toml'
        dataset.write_text('[[datasets]]\n[[datasets.subsets]]\nimage_dir = ' + json.dumps(str(self.source)) + '\n', encoding='utf-8')
        for engine in ('kohya', 'musubi'):
            with self.assertRaisesRegex(ValueError, '散图|自动整理'):
                guard({'train_data_dir': str(self.source)}, engine)
        guard({'train_data_dir': str(self.source), 'dataset_config': str(dataset)}, 'kohya')
        with self.assertRaisesRegex(ValueError, '散图|自动整理'):
            guard({'train_data_dir': str(self.source), 'dataset_config': str(dataset)}, 'musubi')
        self.assertEqual((self.source / 'portrait.png').read_bytes(), b'controlled image fixture')

    def test_kohya_metadata_keeps_relative_subset_and_ignored_legacy_fields(self):
        previous = Path.cwd()
        self.addCleanup(os.chdir, previous)
        os.chdir(self.root)
        metadata = self.root / 'metadata.json'
        metadata.write_text(json.dumps({'portrait': {'caption': 'unchanged'}}), encoding='utf-8')
        dataset = self.root / 'dataset.toml'
        dataset.write_text('[[datasets]]\n[[datasets.subsets]]\nimage_dir = "source"\nmetadata_file = "metadata.json"\n', encoding='utf-8')
        guard({'train_data_dir': str(self.source), 'dataset_config': str(dataset),
               'in_json': str(self.root / 'ignored.json'), 'reg_data_dir': str(self.root / 'ignored-reg')}, 'kohya')

    def test_link_rejection_in_root_metadata_and_regularization(self):
        link = self.root / 'linked'
        # Windows directory junctions do not require Developer Mode/admin.
        if os.name == 'nt':
            import subprocess
            result = subprocess.run(['pwsh', '-NoProfile', '-Command',
                                     'New-Item -ItemType Junction -Path $env:DATASET_TEST_LINK -Target $env:DATASET_TEST_SOURCE | Out-Null'],
                                    capture_output=True, text=True,
                                    env={**os.environ, 'DATASET_TEST_LINK': str(link), 'DATASET_TEST_SOURCE': str(self.source)})
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            link.symlink_to(self.source, target_is_directory=True)
        for engine, config in (
            ('moss', {'src': str(link)}),
            ('diffsynth', {'train_data_dir': str(link)}),
            ('kohya', {'train_data_dir': str(self.source), 'reg_data_dir': str(link)}),
        ):
            with self.assertRaisesRegex(ValueError, '链接|联接'):
                guard(config, engine)
        metadata = self.root / 'linked.json'
        metadata.write_text(json.dumps([{'image': str(link / 'portrait.png'), 'prompt': ''}]), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '链接|联接'):
            guard({'dataset_format': 'metadata', 'dataset_base_path': str(self.source),
                   'dataset_metadata_path': str(metadata)}, 'diffsynth')
        metadata.write_text(json.dumps({str(link / 'portrait'): {'caption': 'unchanged'}}), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '链接|联接'):
            guard({'model_train_type': 'sdxl-finetune', 'train_data_dir': str(self.source), 'in_json': str(metadata)}, 'kohya')


if __name__ == '__main__':
    unittest.main()

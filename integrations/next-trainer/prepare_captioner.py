"""Explicit fixed-catalog model download. No model loading or inference."""
import json
from pathlib import Path
import runpy
import shutil
import sys


def prepare(request, hub=None, endpoint_context=None):
    root = Path(__file__).resolve().parent
    registry = runpy.run_path(str(root / 'runner.py'))['TAGGER_MODELS']
    from workbench_caption import FLORENCE_REPOSITORY, FLORENCE_REVISION
    captioner = request.get('captionerId')
    if captioner not in registry and captioner != 'florence2-base':
        raise ValueError('未知打标器。')
    endpoint = request.get('downloadEndpoint', '默认')
    if endpoint not in ('默认', '', 'https://hf-mirror.com', 'https://modelscope.cn'):
        raise ValueError('模型下载源无效。')
    directory = Path(request['directory'])
    if not directory.is_absolute() or directory.name != 'assets' or not directory.parent.name.startswith('.captioner-download-'):
        raise ValueError('仅允许工作台模型下载暂存目录。')
    from workbench_preprocess import no_links
    no_links(directory)
    if hub is None:
        import huggingface_hub as hub
    if endpoint_context is None:
        sys.path.insert(0, str(root / 'source'))
        from mikazuki.tagger.model_fetch import use_download_endpoint
        endpoint_context = use_download_endpoint
    print('CAPTIONER_PROGRESS ' + json.dumps({'stage': '正在准备 ' + captioner}), flush=True)
    with endpoint_context('' if endpoint == '默认' else endpoint):
        if captioner == 'florence2-base':
            source = Path(hub.snapshot_download(FLORENCE_REPOSITORY, revision=FLORENCE_REVISION, local_dir=str(directory), allow_patterns=['*.json', '*.txt', 'LICENSE', 'model.safetensors']))
            if source.resolve() != directory.resolve():
                for path in source.rglob('*'):
                    relative = path.relative_to(source)
                    if path.is_file() and not any(part.startswith('.') for part in relative.parts) and (path.suffix in {'.json', '.txt'} or path.name in {'LICENSE', 'model.safetensors'}):
                        target = directory / relative; target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(path, target)
        else:
            repo, revision = registry[captioner]
            names = ['cl_tagger_1_01/model.onnx', 'cl_tagger_1_01/tag_mapping.json'] if captioner == 'cl_tagger_1_01' else ['model.onnx', 'selected_tags.csv']
            for name in names:
                print('CAPTIONER_PROGRESS ' + json.dumps({'stage': '下载 ' + name}), flush=True)
                source = Path(hub.hf_hub_download(repo_id=repo, revision=revision, filename=name, local_dir=str(directory)))
                target = directory / name
                if source.resolve() != target.resolve():
                    target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(source, target)
    print('CAPTIONER_PROGRESS ' + json.dumps({'stage': '模型下载结束，准备检查文件'}), flush=True)


if __name__ == '__main__':
    prepare(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))

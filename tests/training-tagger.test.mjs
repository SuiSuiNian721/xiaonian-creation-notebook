import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('真实 Python 打标适配：原样触发词、含括号的资料路径和 images 同名祖先', { skip: !process.env.NEXT_TRAINER_SMOKE_ROOT, timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tagger-adapter-'));
  const integration = fileURLToPath(new URL('../integrations/next-trainer/', import.meta.url));
  const python = join(dirname(process.env.NEXT_TRAINER_SMOKE_ROOT), 'python_embeded', 'python.exe');
  const child = spawn(python, ['-s', '-B', '-c', `
import json,os,pathlib,runpy,sys
integration=pathlib.Path(sys.argv[1]); temporary=pathlib.Path(sys.argv[2])
adapter=runpy.run_path(str(integration/'runner.py'))
worker=adapter['run_tagging_job']; worker.__globals__['__file__']=str(integration/'source'/'workbench_runner.py')
sys.path.insert(0,str(integration/'source'))
sys.path.insert(0,str(integration))
from PIL import Image
import mikazuki.tagger.jobs as jobs
import mikazuki.tagger.interrogator as interrogation
class FakeInterrogator:
    def load(self): pass
    def unload(self): pass
    def interrogate(self,image): return {'general':[('cat_ears',0.9),('long_hair',0.8)]}
jobs.available_interrogators['wd14-convnextv2-v2']=FakeInterrogator()
jobs.interrogator_assets_ready=lambda *args: True
jobs.describe_interrogator_asset_status=lambda *args: (True,'fixture assets')
worker.__globals__['tagger_capabilities']=lambda *args: {'ok':True,'modelReady':True,'modelsRoot':str(temporary/'models')}
images=temporary/'images[owned]'/'workflows'/'images'/'dataset-example'/'images'
images.mkdir(parents=True)
Image.new('RGB',(32,32),'white').save(images/'000001.png')
original=(images/'000001.png').read_bytes()
owner='a'*64
(images.parent/'dataset-manifest.json').write_text(json.dumps({'owner':owner,'imageDir':str(images)}),encoding='utf-8')
trigger='xiaoxi_character(test)'
request=temporary/'request.json'
request.write_text(json.dumps({'owner':owner,'environmentRoot':str(temporary),'dataRoot':str(temporary),'config':{'path':str(images),'model':'wd14-convnextv2-v2','allowDownload':False,'trigger':trigger,'policy':'fill-missing'}}),encoding='utf-8')
worker(request)
caption=images/'000001.txt'
assert caption.is_file(),list(images.rglob('*'))
assert caption.read_text(encoding='utf-8').startswith(trigger+', ')
assert 'cat ears' in caption.read_text(encoding='utf-8')
assert (images/'000001.png').read_bytes()==original
assert len(list(images.rglob('*.txt')))==1
print('TAGGER_ADAPTER_RESULT '+json.dumps({'scope':'real adapter and batch writer, fake model, no GPU or download','trigger':trigger}))
`, integration, directory], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await new Promise(done => child.once('close', done)); }
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true });
  });
  let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
  const code = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done); });
  assert.equal(code, 0, output); assert.match(output, /TAGGER_ADAPTER_RESULT/);
});

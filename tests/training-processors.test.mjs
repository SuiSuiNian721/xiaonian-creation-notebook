import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const integration = fileURLToPath(new URL('../integrations/next-trainer/', import.meta.url));
const python = process.env.NEXT_TRAINER_SMOKE_ROOT ? join(dirname(process.env.NEXT_TRAINER_SMOKE_ROOT), 'python_embeded', 'python.exe') : process.env.AI_FUTURE_TEST_PYTHON;
test('本地处理器：三种裁切策略、完整关节、原图哈希、裁后重标和格式策略', { skip: !python, timeout: 45000 }, async t => {
  assert.ok(existsSync(join(integration, 'workbench_preprocess.py')), '应提供真实本地裁切处理器');
  const directory = await mkdtemp(join(tmpdir(), 'training-processors-'));
  const child = spawn(python, ['-s', '-B', '-c', `
import hashlib,json,pathlib,sys
sys.path.insert(0,sys.argv[1])
from PIL import Image
from workbench_vision import crop_regions
from workbench_preprocess import crop_dataset,item_path
from workbench_caption import caption_is_compatible,normalize_tags,format_caption,caption_dataset
root=pathlib.Path(sys.argv[2]); images=root/'images'; (images/'originals').mkdir(parents=True)
image=images/'originals'/'000001.png'; Image.new('RGBA',(800,1000),(255,0,0,0)).save(image)
points=[[400,220,0.9] for _ in range(133)]
for index,x,y in [(0,400,210),(1,370,200),(2,430,200),(3,340,215),(4,460,215),(5,300,330),(6,500,330),(7,180,450),(8,620,450),(9,90,420),(10,710,420),(11,330,600),(12,470,600),(13,320,760),(14,480,760),(15,260,940),(16,540,940)]: points[index]=[x,y,0.9]
person={'box':[200,100,600,930],'score':0.95,'keypoints':points}
regions,warnings=crop_regions((800,1000),[person],'pose')
assert len(regions)==1
x1,y1,x2,y2=regions[0]['box']
assert all(x1<=x<=x2 and y1<=y<=y2 for x,y,c in points if c>=0.4)
assert crop_regions((800,1000),[person],'preserve')[0]==[]
assert crop_regions((800,1000),[person,person],'character')[0]==[]
incomplete={**person,'keypoints':[[x,y,0.01] if i in [15,16] else [x,y,c] for i,(x,y,c) in enumerate(points)]}
assert crop_regions((800,1000),[incomplete],'pose')[0]==[]
original=image.read_bytes(); digest=hashlib.sha256(original).hexdigest()
(images/'originals'/'000001.txt').write_text('source caption',encoding='utf-8')
manifest={'format':2,'owner':'a'*64,'imageDir':str(images),'workspace':str(root),'sourcePath':str(root/'source'),'items':[{'name':'originals/000001.png','sha256':digest,'kind':'original'}]}
(root/'dataset-manifest.json').write_text(json.dumps(manifest),encoding='utf-8')
class Detector:
    def detect(self,image):
        assert image.mode=='RGB' and image.getpixel((0,0))==(255,255,255)
        return [person]
result=crop_dataset({'path':str(images),'purpose':'pose','cropMode':'pose','requestId':'fixture','allowDownload':False},'a'*64,detector=Detector())
assert result['derivedCount']==1
saved=json.loads((root/'dataset-manifest.json').read_text(encoding='utf-8'))
derived=[item for item in saved['items'] if item['kind']!='original']
assert len(derived)==1 and derived[0]['requiresCaption'] is True
assert not (images/derived[0]['name']).with_suffix('.txt').exists()
assert Image.open(images/derived[0]['name']).mode=='RGBA'
assert image.read_bytes()==original and (images/'originals'/'000001.txt').read_text(encoding='utf-8')=='source caption'
assert caption_is_compatible('long hair, blue eyes, standing','tags')
assert not caption_is_compatible('long hair, blue eyes, standing','natural')
assert caption_is_compatible('A woman with long hair is standing beside a telescope.','natural')
assert caption_is_compatible('A close-up portrait of a young woman.','natural')
for caption in ['A girl in a red dress.','A woman holding a blue umbrella.','Two children playing chess in the garden.']:
    assert caption_is_compatible(caption,'natural'),caption
for escaped in ['C:/outside.png','../outside.png','originals/../../outside.png']:
    try: item_path(images,escaped)
    except ValueError: pass
    else: raise AssertionError('escaped image path accepted')
assert normalize_tags(['watercolor','long hair','standing'],'style')==['long hair','standing']
assert format_caption('A researcher is standing beside a telescope.','xiaoxi_character','natural','character').startswith('xiaoxi_character. ')
def describe(image):
    assert image.mode=='RGB' and image.getpixel((0,0))==(255,255,255)
    return 'A person is standing with arms extended beside a telescope.'
result=caption_dataset({'path':str(images),'purpose':'pose','captionFormat':'natural','requestId':'caption-fixture','trigger':'pose_token'},'a'*64,generator=describe)
assert result['generatedCount']==2
saved=json.loads((root/'dataset-manifest.json').read_text(encoding='utf-8'))
assert all(item.get('requiresCaption') is False and item['captionImageSha256']==item['sha256'] and item['captionSha256']==hashlib.sha256((images/item['name']).with_suffix('.txt').read_bytes()).hexdigest() for item in saved['items'])
# Reusing valid captions needs no Pillow or inference dependency at all.
import builtins
real_import=builtins.__import__
def guarded_import(name,*args,**kwargs):
    if name=='PIL' or name.startswith('PIL.'): raise AssertionError('unneeded Pillow import')
    return real_import(name,*args,**kwargs)
builtins.__import__=guarded_import
try:
    reused=caption_dataset({'path':str(images),'purpose':'pose','captionFormat':'natural','requestId':'reuse-fixture','trigger':'pose_token'},'a'*64)
    assert reused['reusedCount']==2
finally: builtins.__import__=real_import
print('TRAINING_PROCESSORS_RESULT '+json.dumps({'derived':len(derived),'originalUnchanged':True,'scope':'real file processing, injected detector, no GPU'}))
`, integration, directory], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await new Promise(done => child.once('close', done)); } assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const code = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done); });
  assert.equal(code, 0, output); assert.match(output, /TRAINING_PROCESSORS_RESULT/);
});

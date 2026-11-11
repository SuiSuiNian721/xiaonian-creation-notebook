import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPipelinePlan, pipelineInput } from '../framework/training-plan.mjs';

const integration = fileURLToPath(new URL('../integrations/next-trainer/', import.meta.url));
const python = process.env.NEXT_TRAINER_SMOKE_ROOT ? join(dirname(process.env.NEXT_TRAINER_SMOKE_ROOT), 'python_embeded', 'python.exe') : process.env.AI_FUTURE_TEST_PYTHON;
test('实际内置分桶几何：整图默认不放大小图，现代模型裁边小于16像素而非绝对零裁切', { skip: !python, timeout: 15000 }, async () => {
  const plan = await buildPipelinePlan(pipelineInput({ sourcePath: 'E:\\dataset' }), null, { model_train_type: 'moss-image-lora' });
  const child = spawn(python, ['-s', '-B', '-c', `
import ast,json,math,pathlib,sys
import numpy as np
root=pathlib.Path(sys.argv[1]); policy=json.loads(sys.argv[2])
module=ast.parse((root/'source/vendor/sd-scripts/library/train_util.py').read_text(encoding='utf-8'))
node=next(node for node in module.body if isinstance(node,ast.ClassDef) and node.name=='BucketManager')
future=ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0)
tree=ast.fix_missing_locations(ast.Module(body=[future,node],type_ignores=[]))
scope={'math':math,'np':np};exec(compile(tree,'<bundled BucketManager>','exec'),scope)
assert policy['enable_bucket'] and policy['bucket_no_upscale']
manager=scope['BucketManager'](True,(1024,1024),256,2048,policy['bucket_reso_steps'])
reports=[]
for width,height in [(320,520),(800,1200),(4096,1200),(1500,2600)]:
    bucket,resized,error=manager.select_bucket(width,height)
    assert resized[0]<=width and resized[1]<=height
    assert all(0<=resized[i]-bucket[i]<16 for i in (0,1))
    reports.append({'source':[width,height],'resized':resized,'bucket':bucket})
assert reports[0]['resized']==(320,520)
assert any(row['resized']!=row['bucket'] for row in reports)
assert 'torch' not in sys.modules
print('BUCKET_GEOMETRY_OK '+json.dumps(reports))
`, integration, JSON.stringify(plan.strategy.dataset)], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const code = await new Promise((done, fail) => { child.once('close', done); child.once('error', fail); });
  assert.equal(code, 0, output); assert.match(output, /BUCKET_GEOMETRY_OK/);
});

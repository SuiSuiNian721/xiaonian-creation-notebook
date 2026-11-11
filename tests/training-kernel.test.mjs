import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';

const integration = fileURLToPath(new URL('../integrations/next-trainer/', import.meta.url));
async function fixture(t, beforeRemove = async () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'training-kernel-'));
  t.after(async () => { await beforeRemove(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  return directory;
}

test('bundled source has a complete integrity manifest and preserves the local MOSS/ETA/hardware fixes', async () => {
  const { verifyKernel } = await import('../framework/training-runtime.mjs');
  const manifest = await verifyKernel(integration);
  assert.equal(manifest.version, '3.3.1-dev');
  assert.match(manifest.source.commit, /^12963ec/);
  assert.ok(manifest.files.length > 700);
  for (const path of ['mikazuki/utils/config_import.py', 'vendor/sd-scripts/library/strategy_moss_image.py', 'mikazuki/train_log_hub.py', 'mikazuki/utils/training_time.py', 'mikazuki/utils/hardware_status.py']) {
    assert.ok(manifest.files.some(file => file.path === path), path);
    assert.ok(manifest.modifiedFiles.includes(path), path);
  }
  assert.ok(manifest.files.some(file => file.path === 'LICENSE'));
  assert.ok(manifest.files.some(file => file.path === 'vendor/sd-scripts/LICENSE.md'));
  assert.ok(manifest.files.every(file => !/(^|\/)(\.git|\.venv|extensions|user_data|output|logs|__pycache__)(\/|$)|^assets\/config\.json|^config\/autosave\//.test(file.path)));
  const catalog = JSON.parse(await readFile(join(integration, 'catalog.json'), 'utf8'));
  assert.equal(catalog.training_types.find(type => type.train_type === 'moss-image-lora').engine, 'kohya');
  assert.equal(catalog.training_types.find(type => type.train_type === 'moss-image-lora').bundled, true);
});

test('source verification rejects a changed source file before runtime materialization', async t => {
  const { verifyKernel } = await import('../framework/training-runtime.mjs');
  const directory = await fixture(t);
  await mkdir(join(directory, 'source'));
  await writeFile(join(directory, 'source', 'VERSION'), 'tampered');
  await writeFile(join(directory, 'source-manifest.json'), JSON.stringify({ format: 1, version: 'test', kernelRevision: 'test', source: { commit: 'test' }, files: [{ path: 'VERSION', size: 8, sha256: '0'.repeat(64) }] }));
  await assert.rejects(verifyKernel(directory), /校验|哈希|hash|integrity/i);
});

test('dataset protection rejects loose images without moving them and accepts explicit dataset configuration', async t => {
  const { protectDataset } = await import('../framework/training.mjs');
  const directory = await fixture(t);
  const image = join(directory, '原图.png'); await writeFile(image, 'fixture-image');
  const config = { model_train_type: 'moss-image-lora', train_data_dir: directory };
  await assert.rejects(protectDataset(config), /散图|自动整理|dataset_config/);
  assert.equal(await readFile(image, 'utf8'), 'fixture-image');
  const dataset = join(directory, 'dataset.toml'); await writeFile(dataset, `[[datasets]]\n[[datasets.subsets]]\nimage_dir = ${JSON.stringify(directory)}\n`);
  await protectDataset({ ...config, dataset_config: dataset });
  await mkdir(join(directory, '10_character'));
  await protectDataset(config);
});

test('kernel materialization uses verified app source and only reuses an environment directory', async t => {
  const { materializeKernel } = await import('../framework/training-runtime.mjs');
  const directory = await fixture(t); const original = join(directory, 'original');
  await mkdir(join(original, 'extensions', 'kohya'), { recursive: true });
  const result = await materializeKernel({ integrationDir: integration, directory: join(directory, 'runtime'), environmentRoot: original });
  assert.ok(result.root.startsWith(join(directory, 'runtime')));
  assert.notEqual(result.root, original);
  assert.equal(await readFile(join(result.root, 'VERSION'), 'utf8'), await readFile(join(integration, 'source', 'VERSION'), 'utf8'));
  const { realpath } = await import('node:fs/promises');
  assert.equal(await realpath(join(result.root, 'extensions', 'kohya')), await realpath(join(original, 'extensions', 'kohya')));
});

test('identity probe timeout does not become the ordinary engine-query timeout', async t => {
  const { TrainingRuntime } = await import('../framework/training-runtime.mjs');
  const directory = await fixture(t);
  const record = { token: 'fixture', launchId: 'fixture', kernelRevision: 'fixture', adapterRevision: 'fixture', environmentRoot: directory, root: directory };
  const server = createServer(async (request, response) => {
    if (request.url !== '/__workbench/identity') await delay(2700);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'success', data: request.url === '/__workbench/identity' ? { ...record, token: undefined, pid: 12345 } : { state: 'ready' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  record.url = `http://127.0.0.1:${server.address().port}`;
  const runtime = new TrainingRuntime({ dataDir: directory });
  assert.ok(await runtime.identity(record));
  assert.equal((await runtime.request('GET', '/api/engines/kohya/status')).state, 'ready');
});

test('a standalone workbench uses its own runtime root with an explicitly selected service Python',async t=>{
  const {TrainingRuntime}=await import('../framework/training-runtime.mjs'),directory=await fixture(t);
  const runtime=new TrainingRuntime({dataDir:directory,store:{module:()=>({config:{pythonPath:process.execPath}})}});
  const selected=await runtime.configuration();assert.equal(selected.environmentRoot,join(directory,'training','environment'));assert.equal(selected.pythonPath,process.execPath);
  assert.equal(typeof runtime.prepareService,'function');
  await assert.rejects(runtime.prepareService({pythonPath:process.execPath}),/确认/);
});

test('service preparation has one owned process and a durable result without touching the selected base interpreter',async t=>{
  const {TrainingRuntime}=await import('../framework/training-runtime.mjs'),directory=await fixture(t),children=[];
  const code=`const fs=require('node:fs'),path=require('node:path');const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));setTimeout(()=>{const pythonPath=path.join(p.root,'.venv','Scripts','python.exe');fs.mkdirSync(path.dirname(pythonPath),{recursive:true});fs.writeFileSync(pythonPath,'fixture only');fs.writeFileSync(p.statePath,JSON.stringify({...p,pid:process.pid,status:'completed',pythonPath}));fs.unlinkSync(p.lockPath);},150);`;
  const options={dataDir:directory,store:{module:()=>({config:{}})},spawnImpl:(_exe,args,settings)=>{const child=spawn(process.execPath,['-e',code,args.at(-1)],settings);children.push(child);return child;}};
  t.after(()=>{for(const child of children)if(child.exitCode===null)child.kill();});
  const runtime=new TrainingRuntime(options),result=await runtime.prepareService({pythonPath:process.execPath,confirmed:true});
  assert.equal(result.training_started,false);assert.equal(children.length,1);
  await assert.rejects(new TrainingRuntime(options).prepareService({pythonPath:process.execPath,confirmed:true}),/正在准备/);
  for(let n=0;n<30&&(await runtime.servicePreparationState()).status!=='completed';n++)await delay(30);
  const reopened=new TrainingRuntime(options),saved=await reopened.servicePreparationState();assert.equal(saved.status,'completed');assert.ok(saved.pythonPath.startsWith(join(directory,'training','service-env')));
  assert.equal((await reopened.configuration()).pythonPath,saved.pythonPath);assert.equal(children.length,1);
});

test('service preparation Python worker limits installs to API dependencies in its own venv', {skip:!process.env.NEXT_TRAINER_SMOKE_ROOT},async t=>{
  const {TrainingRuntime}=await import('../framework/training-runtime.mjs'),directory=await fixture(t);
  const runtime=new TrainingRuntime({dataDir:directory,store:{module:()=>({config:{trainerPath:process.env.NEXT_TRAINER_SMOKE_ROOT}})}}),python=(await runtime.configuration()).pythonPath;
  const request={launchId:'fixture-api-only',root:join(directory,'service-env'),statePath:join(directory,'service-preparation.json'),lockPath:join(directory,'service-preparation.lock')};
  const requestPath=join(directory,'request.json');await writeFile(requestPath,JSON.stringify(request));await writeFile(request.lockPath,JSON.stringify({launchId:request.launchId}));
  const code=`import json,pathlib,runpy,subprocess,sys,types
module=runpy.run_path(sys.argv[1]); request=json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8')); commands=[]
def fixture_run(command,**kwargs):
    commands.append(command)
    if 'venv' in command:
        venv=pathlib.Path(command[-1]); target=venv/('Scripts/python.exe' if sys.platform=='win32' else 'bin/python');target.parent.mkdir(parents=True);target.write_text('fixture interpreter',encoding='utf-8')
    return types.SimpleNamespace(returncode=0)
subprocess.run=fixture_run
module['prepare'](sys.argv[2])
saved=json.loads(pathlib.Path(request['statePath']).read_text(encoding='utf-8'))
assert saved['status']=='completed' and pathlib.Path(saved['pythonPath']).is_relative_to(pathlib.Path(request['root']))
assert not pathlib.Path(request['lockPath']).exists()
assert len(commands)==3 and 'pip' in commands[1]
import importlib.util
if importlib.util.find_spec('venv') is None:
    assert 'uv' in commands[0], 'embedded Python without venv must use its installed uv module'
assert all(not any(part.startswith(('torch','diffusers','nvidia','accelerate')) for part in command) for command in commands)
print('SERVICE_PREPARATION_FIXTURE_OK')`;
  const child=spawn(python,['-I','-B','-c',code,join(integration,'prepare_service.py'),requestPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);assert.equal((await once(child,'close'))[0],0,output);assert.match(output,/SERVICE_PREPARATION_FIXTURE_OK/);
});

test('owned sidecar lifecycle shares one process, preserves active work, and confirms idle shutdown', async t => {
  const { TrainingRuntime } = await import('../framework/training-runtime.mjs');
  const directory = await fixture(t); const original = join(directory, 'original');
  await mkdir(join(original, 'extensions', 'kohya'), { recursive: true });
  const config = { trainerPath: original, pythonPath: process.execPath };
  const store = { module: () => ({ config }) }; let spawns = 0;
  const children = [];
  const code = `
    const fs=require('node:fs'),http=require('node:http');
    const b=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
    const identity={...b,token:undefined,pid:process.pid};
    const server=http.createServer((req,res)=>{
      if(req.headers.authorization!=='Bearer '+b.token){res.writeHead(401);res.end();return;}
      let data={};
      if(req.url==='/__workbench/identity')data=identity;
      else if(req.url==='/api/tasks'){try{data={tasks:JSON.parse(fs.readFileSync(b.root+'/fixture-tasks.json','utf8'))}}catch{data={tasks:[]}}}
      else if(req.url==='/__workbench/shutdown')setTimeout(()=>server.close(()=>process.exit(0)),100);
      res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'success',data}));
    });
    server.listen(0,'127.0.0.1',()=>{identity.url='http://127.0.0.1:'+server.address().port;fs.writeFileSync(b.readyPath,JSON.stringify(identity));});`;
  const spawnImpl = (executable, args, options) => { spawns++; const child = spawn(process.execPath, ['-e', code, args.at(-1)], options); children.push(child); return child; };
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  let loseIdentity = false;
  const fetchImpl = (...args) => loseIdentity ? Promise.reject(new Error('temporary identity timeout')) : fetch(...args);
  const first = new TrainingRuntime({ store, dataDir: directory, spawnImpl, fetchImpl });
  assert.equal((await first.state()).status, 'stopped'); assert.equal(spawns, 0);
  const starting = first.start();
  const incompatible = first.start({ trainerPath: join(directory, 'different'), pythonPath: process.execPath }).then(() => null, error => error);
  const [one, two] = await Promise.all([starting, first.start()]);
  assert.equal(spawns, 1); assert.equal(one.pid, two.pid);
  assert.equal((await incompatible)?.status, 409);
  loseIdentity = true;
  assert.equal((await first.state()).status, 'unresponsive');
  await assert.rejects(first.start(), /进程|身份|核实/); assert.equal(spawns, 1);
  await assert.rejects(first.stop(), /进程|身份|核实/);
  loseIdentity = false;
  config.trainerPath = join(directory, 'different');
  assert.equal((await first.state()).status, 'configuration_changed');
  await assert.rejects(first.start(), /环境|配置/); assert.equal(spawns, 1);
  config.trainerPath = original;
  await writeFile(join(one.root, 'fixture-tasks.json'), JSON.stringify([{ id: 'active', status: 'RUNNING' }]));
  await assert.rejects(first.stop(), /任务/);
  await first.close();
  const second = new TrainingRuntime({ store, dataDir: directory, spawnImpl });
  const reattached = await second.start(); assert.equal(reattached.pid, one.pid); assert.equal(spawns, 1);
  await writeFile(join(one.root, 'fixture-tasks.json'), '[]');
  await second.stop();
  assert.notEqual((await second.state()).status, 'running');
  await second.close();
});

test('actual installed Python starts only the isolated API and imports original configurations read-only', { skip: !process.env.NEXT_TRAINER_SMOKE_ROOT }, async t => {
  const { LoraTraining } = await import('../framework/training.mjs');
  let service; const directory = await fixture(t, () => service?.close());
  const store = { module: () => ({ config: { trainerPath: process.env.NEXT_TRAINER_SMOKE_ROOT, outputPath: join(directory, 'output') } }) };
  service = new LoraTraining({ store, dataDir: directory });
  const python = (await service.runtime.configuration()).pythonPath;
  await writeFile(join(directory, 'original-prompt.txt'), '保留原提示\r\n');
  await mkdir(join(directory, 'prompt-copy'));
  await writeFile(join(directory, 'blocked-copy'), 'not a directory');
  const promptTest = spawn(python, ['-s', '-B', '-c', `
import pathlib,runpy,sys
adapter=runpy.run_path(sys.argv[1]); root=pathlib.Path(sys.argv[2]); source=root/'original-prompt.txt'
original=source.read_bytes(); config={'prompt_file':str(source)}
adapter['isolate_prompt_files'](config,root/'prompt-copy','successful')
assert pathlib.Path(config['prompt_file']).read_bytes()==original
assert source.read_bytes()==original and pathlib.Path(config['prompt_file'])!=source
try:
    adapter['isolate_prompt_files']({'sample_prompts':str(source)},root/'blocked-copy','rejected')
except OSError:
    pass
else:
    raise AssertionError('A failed copy must reject the submission')
assert source.read_bytes()==original
trigger=r'xiaoxi_character(test)'
captions=root/'trigger-fixture'; captions.mkdir()
target=captions/'new.txt'; target.write_text('cat ears, a researcher',encoding='utf-8')
adapter['prefix_tagging_captions'](captions,trigger)
assert target.read_text(encoding='utf-8').startswith(trigger+', cat ears')
adapter['prefix_tagging_captions'](captions,trigger)
assert target.read_text(encoding='utf-8').count(trigger)==1
`, join(integration, 'runner.py'), directory], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let promptError = ''; promptTest.stderr.on('data', chunk => { promptError += chunk; });
  assert.equal((await once(promptTest, 'close'))[0], 0, promptError);
  const logDirectory = join(directory, 'training', 'logs', 'tasks'); await mkdir(logDirectory, { recursive: true });
  const logPath = join(logDirectory, 'fixture-history.log');
  await writeFile(logPath, 'epoch 1/1\nsteps: 100%|##########| 10/10 [00:10<00:00, 1.00it/s]\nfixture completed\n');
  await writeFile(join(directory, 'training', 'task_queue.json'), JSON.stringify([{ task_id: 'fixture-history', lane: 'compute', status: 'FINISHED', command: [], metadata: { workbench_owner: service.owner, workbench_request: 'history', train_type: 'moss-image-lora', log_file: logPath, created_at: 100, started_at: 100, finished_at: 110, returncode: 0 } }]));
  assert.equal((await service.state()).runtime.status, 'stopped');
  const state = await service.start();
  assert.equal(state.runtime.status, 'running');
  assert.ok(state.runtime.sourceModule.startsWith(directory + sep));
  assert.equal(state.engines.kohya.state, 'ready');
  assert.equal(state.engines.moss.state, 'not_installed');
  for(const engine of ['kohya','anima-fast','musubi','ai-toolkit','diffsynth','moss']){
    assert.ok(state.engines[engine],engine);assert.notEqual(state.engines[engine].state,'unavailable',state.engines[engine].reason);assert.equal(state.engines[engine].control_supported,true);
  }
  assert.equal(state.tasks.length, 1);
  const tagImages = join(directory, 'tagger-check', 'images'); await mkdir(tagImages, { recursive: true });
  await writeFile(join(directory, 'tagger-check', 'dataset-manifest.json'), JSON.stringify({ owner: service.owner, imageDir: tagImages }));
  const tagging = await service.runtime.request('POST', '/api/tagger/check', { body: { path: tagImages, model: 'wd14-convnextv2-v2', allowDownload: false, trigger: '', policy: 'fill-missing' }, owner: service.owner });
  assert.equal(typeof tagging.ok, 'boolean'); if (!tagging.ok) assert.ok(tagging.reason);
  assert.equal((await service.tasks()).tasks.length, 1, '检查打标能力不得创建任务');
  const history = await service.task('fixture-history');
  assert.ok(history.logs.lines.includes('fixture completed'));
  assert.equal(history.metrics.progress.step, 10);
  assert.equal(history.metrics.timing.elapsed_seconds, 10);
  const url = state.runtime.url;
  assert.equal((await fetch(url + '/api/version')).status, 401);
  const auth = { authorization: `Bearer ${service.runtime.record.token}` };
  for (const path of ['/api/run_script', '/api/engines/kohya/install', '/api/engines/kohya/repair']) assert.equal((await fetch(url + path, { method: 'POST', headers: auth })).status, 404);
  const saved = await service.savedConfigs();
  assert.ok(saved.configs.some(item => item.source === 'saved_params'));
  assert.ok(saved.configs.some(item => item.source === 'task_archive'));
  assert.ok(saved.configs.every(item => item.config.model_train_type));
  const moss = saved.configs.find(item => item.config.model_train_type === 'moss-image-lora');
  assert.equal((await service.validate(moss.config)).valid, true);
  assert.ok((await service.schema('moss-image-lora')).schema.includes('moss'));
  await service.runtime.request('POST', '/__workbench/shutdown', { body: {} });
  // Exercise the closing write gate with a validation request. This test must
  // never call /api/run on the real Python backend, even with invalid input.
  const afterShutdown = await fetch(url + '/api/config/validate-import', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ page_train_type: 'moss-image-lora', config: moss.config }) }).catch(() => null);
  assert.ok(afterShutdown === null || afterShutdown.status === 409);
  const { trainingProcessExists } = await import('../framework/training-runtime.mjs');
  for (let attempt = 0; attempt < 100 && trainingProcessExists(state.runtime.pid); attempt++) await delay(100);
  await service.runtime.stop();
  assert.notEqual((await service.state()).runtime.status, 'running');
});

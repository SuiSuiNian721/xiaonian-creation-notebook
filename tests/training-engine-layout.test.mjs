import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeKernel, TrainingRuntime } from '../framework/training-runtime.mjs';
import { discoverTrainingResources } from '../framework/training-resources.mjs';

const integration=fileURLToPath(new URL('../integrations/next-trainer/',import.meta.url));
const native={kohya:'kohya','anima-fast':'anima_lora',musubi:'musubi_tuner','ai-toolkit':'ai_toolkit',diffsynth:'diffsynth',moss:'moss'};
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'training-native-layout-'));t.after(async()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});return directory;}

test('discovery finds all engine environments at snapshot-native directory names',async t=>{
  const directory=await fixture(t),trainer=join(directory,'Next-Trainer');await mkdir(join(trainer,'mikazuki'),{recursive:true});await writeFile(join(trainer,'VERSION'),'fixture');
  for(const name of Object.values(native)){const python=join(trainer,'extensions',name,'.venv','Scripts','python.exe');await mkdir(dirname(python),{recursive:true});await writeFile(python,'metadata fixture only');}
  const result=await discoverTrainingResources({roots:[trainer]});
  const engines=result.engines.filter(item=>item.trainerPath===trainer);assert.equal(engines.length,6);
  for(const [id,name] of Object.entries(native)){const item=engines.find(item=>item.id===id);assert.equal(item.path,join(trainer,'extensions',name));assert.equal(item.state,'installed_unverified');}
});

test('actual native install and environment plans remain in the selected persistent roots across kernel revisions',{skip:!process.env.NEXT_TRAINER_SMOKE_ROOT,timeout:60000},async t=>{
  const directory=await fixture(t),original=join(directory,'original'),runtimeDirectory=join(directory,'runtime');
  const fixtureIntegration=join(directory,'integration');await cp(integration,fixtureIntegration,{recursive:true});
  const runtime=new TrainingRuntime({dataDir:directory,store:{module:()=>({config:{trainerPath:process.env.NEXT_TRAINER_SMOKE_ROOT}})}}),python=(await runtime.configuration()).pythonPath;
  const code=`import asyncio,importlib,json,os,pathlib,subprocess,sys,types
root=pathlib.Path(sys.argv[1]); expected=json.loads(sys.argv[2]); native=json.loads(sys.argv[3]);os.chdir(root);sys.path.insert(0,str(root))
app=types.ModuleType('mikazuki.app');app.__path__=[str(root/'mikazuki'/'app')];app.__package__='mikazuki.app';sys.modules['mikazuki.app']=app
packs={'anima-fast':'anima_fast','musubi':'musubi','ai-toolkit':'ai_toolkit'}
routes={key:importlib.import_module('mikazuki.engines.'+package+'.routes') for key,package in packs.items()}
def forbid(*args,**kwargs):raise AssertionError('dry-run fixture must never launch subprocesses or install packages')
subprocess.run=forbid;subprocess.Popen=forbid;subprocess.check_call=forbid;subprocess.check_output=forbid
for key,name in native.items():
    module=importlib.import_module('mikazuki.engines.'+packs.get(key,key)+('.extension_state' if key in packs else '.settings'))
    layout=module.default_layout(root) if key in packs else module.Runtime(root)
    assert layout.root.name==name,(key,layout.root)
    assert layout.root.resolve()==pathlib.Path(expected[key]).resolve(),(key,'native root is not bound to selected persistent target',layout.root.resolve(),expected[key])
for key,package in packs.items():
    route=routes[key];upstream=importlib.import_module('mikazuki.engines.'+package+'.manifest').UPSTREAM;source=root/'vendor'/('fixture-'+package);source.mkdir(parents=True,exist_ok=True)
    (source/'.source_commit').write_text(upstream['commit'],encoding='utf-8')
    if key=='anima-fast':(source/'train.py').write_text('# fixture',encoding='utf-8')
    elif key=='musubi':(source/'src'/'musubi_tuner').mkdir(parents=True,exist_ok=True)
    else:(source/'toolkit').mkdir(exist_ok=True);(source/'run.py').write_text('# fixture',encoding='utf-8')
    response=asyncio.run(route.install({'dry_run':True,'source_root':str(source)}))
    assert response.status=='success',(key,response)
    plan=response.data['plan'];target=pathlib.Path(expected[key]);assert pathlib.Path(plan['target_source']).resolve()==target/'source',(key,plan)
    assert pathlib.Path(plan['target_python']).resolve()==target/'.venv'/('Scripts/python.exe' if sys.platform=='win32' else 'bin/python'),(key,plan)
    module=importlib.import_module('mikazuki.engines.'+package+'.environment');state=importlib.import_module('mikazuki.engines.'+package+'.extension_state');layout=state.default_layout(root)
    environment=module.build_environment_install_plan(root,layout,source,dry_run=True,source_commit=upstream['commit'])
    assert environment.layout.root.resolve()==target,(key,environment)
    assert environment.venv_python.resolve().is_relative_to(target),(key,'venv escaped selected target')
    assert environment.python_install_dir.resolve()==target/'.python',(key,'base interpreter would be lost with kernel revision',environment.python_install_dir)
binding=root/'workbench_engine_roots.json';saved=json.loads(binding.read_text(encoding='utf-8'));wrong=root/'unauthorized-target';wrong.mkdir(exist_ok=True)
for key,package in packs.items():
    changed=json.loads(json.dumps(saved));changed['engines'][key]['root']=str(wrong);binding.write_text(json.dumps(changed),encoding='utf-8')
    module=importlib.import_module('mikazuki.engines.'+package+'.environment');state=importlib.import_module('mikazuki.engines.'+package+'.extension_state')
    try:module.build_environment_install_plan(root,state.default_layout(root),root/'vendor'/('fixture-'+package),dry_run=True)
    except ValueError:pass
    else:raise AssertionError((key,'binding mismatch must never authorize another environment root'))
    binding.write_text(json.dumps(saved),encoding='utf-8')
binding.unlink()
module=importlib.import_module('mikazuki.engines.anima_fast.environment');state=importlib.import_module('mikazuki.engines.anima_fast.extension_state')
try:module.build_environment_install_plan(root,state.default_layout(root),root/'vendor'/'fixture-anima_fast',dry_run=True)
except ValueError:pass
else:raise AssertionError('an external Anima root without a Workbench binding must retain the native safety check')
binding.write_text(json.dumps(saved),encoding='utf-8')
print('NATIVE_INSTALL_PLAN_OK')`;
  const check=async(root,target)=>{
    const expected=Object.fromEntries(Object.entries(native).map(([id,name])=>[id,target==='original'?join(original,'extensions',name):join(runtimeDirectory,'engine-environments',name)]));
    const child=spawn(python,['-I','-B','-c',code,root,JSON.stringify(expected),JSON.stringify(native)],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);assert.equal((await once(child,'close'))[0],0,output);assert.match(output,/NATIVE_INSTALL_PLAN_OK/);
  };
  const originalTargets=Object.fromEntries(Object.keys(native).map(id=>[id,'original']));
  const first=await materializeKernel({integrationDir:fixtureIntegration,directory:runtimeDirectory,environmentRoot:original,engineTargets:originalTargets});await check(first.root,'original');
  const isolatedTargets=Object.fromEntries(Object.keys(native).map(id=>[id,'isolated']));
  const second=await materializeKernel({integrationDir:fixtureIntegration,directory:runtimeDirectory,environmentRoot:original,engineTargets:isolatedTargets});await check(second.root,'isolated');
  const marker=join(runtimeDirectory,'engine-environments','anima_lora','keep-environment.txt');await writeFile(marker,'persistent environment');
  const manifestPath=join(fixtureIntegration,'source-manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));manifest.kernelRevision='f'.repeat(64);await writeFile(manifestPath,JSON.stringify(manifest),'utf8');
  const updated=await materializeKernel({integrationDir:fixtureIntegration,directory:runtimeDirectory,environmentRoot:original,engineTargets:isolatedTargets});assert.notEqual(updated.root,second.root);await check(updated.root,'isolated');assert.equal(await readFile(marker,'utf8'),'persistent environment');
});

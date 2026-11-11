import test from 'node:test';
import assert from 'node:assert/strict';

let preparation={};
try{preparation=await import('../public-workbench/resource-preparation.js');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}

test('准备指路只接受受控 HTTPS 来源，并转义资源内容',()=>{
  assert.equal(typeof preparation.resourcePreparationHTML,'function');
  const html=preparation.resourcePreparationHTML({title:'<准备>',items:[{title:'<资源>',detail:'"文件"',links:[{label:'来源',url:'https://docs.python.org/3/using/windows.html'},{label:'注入',url:'javascript:alert(1)'}]}]});
  assert.ok(html.includes('&lt;准备&gt;'));
  assert.ok(html.includes('&lt;资源&gt;'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('noopener noreferrer'));
  assert.ok(!html.includes('data-preparation-installed'));
});

test('依赖准备使用准确的运行端版本与本地目标',()=>{
  assert.equal(typeof preparation.preparationFor,'function');
  const airi=preparation.preparationFor('companion');
  assert.ok(airi.items.some(item=>item.links?.some(link=>link.url==='https://github.com/moeru-ai/airi/releases/tag/v0.12.0-beta.5')));
  assert.ok(airi.items.some(item=>item.target==='airiPath'));
  assert.ok(preparation.preparationFor('training').items.some(item=>item.target==='pythonPath'));
  assert.ok(preparation.preparationFor('comfyui').items.some(item=>item.target==='comfyPath'));
  assert.ok(preparation.preparationFor('mc-play').items.every(item=>!item.links?.some(link=>link.url.includes('minecraft.net'))));
});

test('复制安装命令固定所选 Python，拒绝换行并保留 PowerShell 字面量',()=>{
  assert.equal(typeof preparation.pythonInstallCommand,'function');
  const executable="E:\\念念's $env:SECRET`name\\python.exe";
  assert.equal(preparation.pythonInstallCommand(executable,['Pillow']),"& 'E:\\念念''s $env:SECRET`name\\python.exe' -m pip install 'Pillow'");
  for(const path of ['', 'python', 'E:\\python.exe\nWrite-Output injected','E:\\bad"name\\python.exe'])assert.throws(()=>preparation.pythonInstallCommand(path,['Pillow']));
  assert.throws(()=>preparation.pythonInstallCommand('E:\\python.exe',['Pillow; Write-Output injected']));
});

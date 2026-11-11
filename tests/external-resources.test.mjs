import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {handleResourceWindowOpen,isWorkbenchClipboardWrite}=require('../desktop/external-resources.cjs');

test('resource links open HTTPS in the system browser while other schemes and credentials are denied',async()=>{
  const opened=[],logs=[],errors=[];
  const options={baseURL:'http://127.0.0.1:10000',openExternal:async url=>opened.push(url),openLog:target=>logs.push(target),onError:error=>errors.push(error)};
  for(const url of ['https://www.python.org/downloads/','file:///C:/Windows/notepad.exe','javascript:alert(1)','https://user:secret@example.com','http://example.com'])assert.deepEqual(handleResourceWindowOpen({url},options),{action:'deny'});
  handleResourceWindowOpen({url:'http://127.0.0.1:10000/process-log.html'},options);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(opened,['https://www.python.org/downloads/']);assert.deepEqual(logs,[{}]);assert.deepEqual(errors,[]);
  handleResourceWindowOpen({url:'https://example.com'},{...options,openExternal:async()=>{throw new Error('cannot open');}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(errors.length,1);
});

test('clipboard write permission is scoped to the local workbench origin and never allows reading',()=>{
  const base='http://127.0.0.1:10000';
  assert.equal(isWorkbenchClipboardWrite(base,base+'/#/settings','clipboard-sanitized-write'),true);
  assert.equal(isWorkbenchClipboardWrite(base,'https://example.com','clipboard-sanitized-write'),false);
  assert.equal(isWorkbenchClipboardWrite(base,base,'clipboard-read'),false);
  assert.equal(isWorkbenchClipboardWrite(base,'http://127.0.0.1:10001','clipboard-sanitized-write'),false);
});

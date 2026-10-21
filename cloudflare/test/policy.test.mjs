import {test} from 'node:test';import assert from 'node:assert/strict';
import {readRequest,equal} from '../src/policy.mjs';
const p={agentId:'a',owner:'o'};
test('read broker binds identity and denies generic SQL and write tools',()=>{
 assert.equal(readRequest({...p,kind:'business',tool:'catalog',arguments:{}},p).tool,'catalog');
 for(const tool of ['sql','delete','send'])assert.throws(()=>readRequest({...p,kind:'business',tool,arguments:{}},p));
 assert.throws(()=>readRequest({...p,owner:'other',kind:'business',tool:'catalog',arguments:{}},p));
 assert.throws(()=>readRequest({...p,agentId:'helper',kind:'business',tool:'catalog',arguments:{}},p));
 assert.throws(()=>readRequest({...p,kind:'feishu',args:[1]},p));
 assert.deepEqual(readRequest({...p,kind:'feishu',args:['--help']},p).args,['--help']);
});
test('empty and wrong caller credentials are refused',async()=>{assert.equal(await equal('',''),false);assert.equal(await equal('a','b'),false);assert.equal(await equal('a','a'),true);});

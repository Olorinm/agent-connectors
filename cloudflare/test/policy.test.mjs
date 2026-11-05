import {test} from 'node:test';import assert from 'node:assert/strict';
import {readRequest,equal} from '../src/policy.mjs';
const p={agentId:'a',owner:'o'};
test('read broker binds identity and admits only Feishu read arguments',()=>{
 for(const kind of ['business','sql'])assert.throws(()=>readRequest({...p,kind,tool:'catalog',arguments:{}},p));
 assert.throws(()=>readRequest({...p,owner:'other',kind:'feishu',args:['--help']},p));
 assert.throws(()=>readRequest({...p,agentId:'helper',kind:'feishu',args:['--help']},p));
 assert.throws(()=>readRequest({...p,kind:'feishu',args:[1]},p));
 assert.deepEqual(readRequest({...p,kind:'feishu',args:['--help']},p).args,['--help']);
});
test('empty and wrong caller credentials are refused',async()=>{assert.equal(await equal('',''),false);assert.equal(await equal('a','b'),false);assert.equal(await equal('a','a'),true);});

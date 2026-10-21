import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BusinessDataClient } from '../dist/business-data.js';

test('business bridge restricts endpoints and reviewed read tools, validates arguments and hides credentials', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'business-bridge-'));
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  const tokenFile = join(directory, 'key'); writeFileSync(tokenFile, 'fixture-private-token', {mode:0o600});
  for (const endpoint of ['http://example.test/mcp','https://user:pass@example.test/mcp','https://example.test/mcp?secret=1'])
    assert.throws(() => new BusinessDataClient({endpoint, tokenFile, allowPrivateHttp:true}), /endpoint_invalid/);
  assert.throws(() => new BusinessDataClient({endpoint:'http://127.0.0.1/mcp', tokenFile}), /endpoint_invalid/);
  new BusinessDataClient({endpoint:'http://127.0.0.1/mcp',tokenFile,allowPrivateHttp:true});
  const actual = globalThis.fetch; t.after(() => globalThis.fetch = actual);
  let calls=0, fail=false;
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).origin,'https://business.fixture');
    assert.equal(init.redirect,'error');
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer fixture-private-token');
    if(init.method==='GET') return new Response(null,{status:405});
    if(fail) throw new Error('fixture-private-token internal failure');
    const m=JSON.parse(init.body), json=result=>Response.json({jsonrpc:'2.0',id:m.id,result});
    if(m.method==='notifications/initialized')return new Response(null,{status:202});
    if(m.method==='initialize')return json({protocolVersion:'2025-03-26',serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{}}});
    if(m.method==='tools/list')return json({tools:['catalog','delete_everything'].map(name=>({name,inputSchema:{type:'object',properties:{source:{type:'string'}},required:['source'],additionalProperties:false},annotations:{readOnlyHint:true}}))});
    if(m.method==='tools/call'){calls++;return json({content:[{type:'text',text:'safe result'},{type:'resource_link',uri:'https://unknown',name:'unknown'}]});}
    throw new Error('unexpected method');
  };
  const client = new BusinessDataClient({endpoint:'https://business.fixture/mcp',tokenFile});
  assert.deepEqual((await client.tools()).map(t=>t.name),['catalog']);
  await assert.rejects(()=>client.call('delete_everything',{}),/not_allowed/);
  assert.equal((await client.call('catalog',{source:42})).isError,true); assert.equal(calls,0);
  const result=await client.call('catalog',{source:'business'}); assert.equal(calls,1);
  assert.deepEqual(result,{isError:false,content:[{type:'text',text:'safe result'}]});
  fail=true;
  await assert.rejects(()=>client.call('catalog',{source:'business'}),e=>e.message==='business_data_unavailable');
});

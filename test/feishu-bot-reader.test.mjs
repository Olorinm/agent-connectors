import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FeishuBotReader} from '../dist/feishu-bot-reader.js';
test('bot reader fixes application identity, blocks writes and paths, and never returns its secret', async t=>{
 const directory=mkdtempSync(join(tmpdir(),'bot-reader-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const appSecretFile=join(directory,'secret');writeFileSync(appSecretFile,'test-private-secret');
 let risk='read',method='GET',effects=0,echo=false,code=0;
 const runner=async(args,options)=>{
  if(args.includes('--help=true'))return {code:0,stdout:`Usage:\n  lark-cli docs +fetch\nRisk: ${risk}\n`,stderr:''};
  if(args.includes('--dry-run=true'))return {code:0,stdout:JSON.stringify({ok:true,dry_run:true,data:{api:[{method,url:'https://open.feishu.cn/open-apis/docs'}]}}),stderr:''};
  effects++;assert.ok(args.includes('--as=bot'));assert.ok(args.includes('--profile=trusted-app'));assert.equal(options.env.HOME,join(directory,'home'));
  return {code,stdout:echo?'test-private-secret':'fixture read',stderr:''};
 };
 const c=new FeishuBotReader({directory,appId:'trusted-app',appSecretFile,domain:'feishu'},runner);
 assert.equal((await c.read(['docs','+fetch'])).output,'fixture read');assert.equal(effects,1);
 await assert.rejects(()=>c.read(['docs','+fetch','--as=user']));
 await assert.rejects(()=>c.read(['docs','+fetch','--output=/etc/secrets']));
 risk='write';await assert.rejects(()=>c.read(['docs','+fetch']),/requires_owner_approval/);
 risk='read';method='POST';await assert.rejects(()=>c.read(['docs','+fetch']),/requires_owner_approval/);assert.equal(effects,1);
 method='GET';echo=true;await assert.rejects(()=>c.read(['docs','+fetch']),/result_rejected/);
 echo=false;code=1;assert.equal((await c.read(['docs','+fetch'])).isError,true);
});
test('bot guidance is offline and normalizes schema paths without accepting identity flags', async t=>{
 const directory=mkdtempSync(join(tmpdir(),'bot-help-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const calls=[];const reader=new FeishuBotReader({directory,appId:'trusted-app',appSecretFile:join(directory,'absent'),domain:'feishu'},async(args,options)=>{
  calls.push(args);assert.equal(options.env.HTTPS_PROXY,'http://127.0.0.1:9');assert.ok(!args.includes('--as=bot'));return {code:0,stdout:'help',stderr:''};
 });
 assert.equal((await reader.read(['--help'])).isError,false);
 await reader.read(['schema','im','chats','get']);
 assert.deepEqual(calls,[['--help'],['schema','im chats get']]);
 await assert.rejects(()=>reader.read(['schema','im','--profile=other']));
 assert.equal(calls.length,2);
});

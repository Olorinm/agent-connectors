import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {CloudflareReadClient} from '../dist/cloudflare-read-client.js';
test('Cloudflare adapter fixes identity and destination, refuses insecure endpoints and hides server errors',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cf-reader-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'token');fs.writeFileSync(file,'fixture-scoped-caller',{mode:0o600});
 const config={mode:'cloudflare',endpoint:'https://connector.fixture/',agentId:'11111111-1111-4111-8111-111111111111',owner:'alice',tokenFile:file};
 for(const endpoint of ['http://connector.fixture/','https://secret@connector.fixture/','https://connector.fixture/?key=1','https://connector.fixture/path'])assert.throws(()=>new CloudflareReadClient({...config,endpoint}));
 const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);let status=200;
 globalThis.fetch=async(url,init)=>{assert.equal(url.href,'https://connector.fixture/v1/read');assert.equal(init.redirect,'error');const body=JSON.parse(init.body);assert.equal(body.agentId,config.agentId);assert.equal(body.owner,'alice');assert.equal(init.headers.authorization,'Bearer fixture-scoped-caller');return Response.json(status===200?{isError:false,content:[]}:{secret:'never return this diagnostic'},{status});};
 const client=new CloudflareReadClient(config);assert.equal((await client.call('catalog',{})).isError,false);status=401;await assert.rejects(()=>client.read(['--help']),/cloudflare_connector_unavailable/);
});

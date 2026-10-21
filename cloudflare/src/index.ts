import {DurableObject} from 'cloudflare:workers';
import {readRequest,equal} from './policy.mjs';
interface Env {SOURCE_REVISION?:string;READERS:DurableObjectNamespace<TrustedReader>;ARTIFACTS:R2Bucket;CALLER_TOKEN:string;READ_CREDENTIALS:string;PRINCIPAL:string;PACKAGE_KEY:string;PACKAGE_SHA256:string;}
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
export default {async fetch(request:Request,env:Env) {
  const url=new URL(request.url);
  if(url.pathname==='/health')return json({service:'agent-connectors',readOnly:true,revision:env.SOURCE_REVISION??null});
  if(!env.CALLER_TOKEN||!env.READ_CREDENTIALS)return json({error:'not_configured'},503);
  if(request.headers.has('Origin')||!await equal(request.headers.get('Authorization'),`Bearer ${env.CALLER_TOKEN}`))return json({error:'unauthorized'},401);
  if(url.pathname!=='/v1/read'||request.method!=='POST')return json({error:'not_found'},404);
  try {
    const raw=await request.text();if(raw.length>131072)return json({error:'input_too_large'},413);
    const principal=JSON.parse(env.PRINCIPAL),operation=readRequest(JSON.parse(raw),principal);
    return env.READERS.getByName(principal.agentId+":secure-v3").fetch(new Request('https://internal/read',{method:'POST',body:JSON.stringify(operation)}));
  } catch {return json({error:'read_refused'},403);}
}} satisfies ExportedHandler<Env>;

export class TrustedReader extends DurableObject<Env> {
  private busy=false;
  private async start() {
    const c=this.ctx.container!;
    let snapshot=await this.ctx.storage.get<{id:string;createdAt?:number;packageSha?:string}>('base');
    if(snapshot&&(snapshot.packageSha!==this.env.PACKAGE_SHA256||!snapshot.createdAt||Date.now()-snapshot.createdAt>20*86400000)){snapshot=undefined;await this.ctx.storage.delete('base');}
    if(c.running&&snapshot)return;
    if(c.running)await c.destroy();
    c.start({...(snapshot?{containerSnapshot:snapshot}:{image:'cloudflare/debian-trixie'}),enableInternet:true,
      instance:{vcpu:1,memoryMib:1024,diskMb:4000},entrypoint:['sh','-c','exec sleep infinity']});
    await c.setInactivityTimeout(600000);
    if(!snapshot) {
      const object=await this.env.ARTIFACTS.get(this.env.PACKAGE_KEY);if(!object)throw Error('package_missing');
      const bytes=await object.arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',bytes);
      const hex=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
      if(hex!==this.env.PACKAGE_SHA256)throw Error('package_integrity');
      const process=await c.exec(['sh','-c','umask 077; cat > /tmp/connectors.tgz; (apt-get update -qq && apt-get install -y -qq curl ca-certificates && npm install --prefix /opt/reader --omit=dev /tmp/connectors.tgz) >/tmp/install.log 2>&1'],{stdin:new Blob([bytes]).stream(),signal:AbortSignal.timeout(300000)});
      if(await process.exitCode!==0) {
        throw Error('package_install');
      }
      // The base snapshot is made before any upstream credential enters the trusted container.
      const saved=await c.snapshotContainer({name:'connector-programs-only'});await this.ctx.storage.put('base',{id:saved.id,createdAt:Date.now(),packageSha:this.env.PACKAGE_SHA256});
    }
  }
  async fetch(request:Request) {
    if(this.busy)return json({error:'connector_busy'},429);
    this.busy=true;let kind='unknown',stage='quota';
    try {
      const input=await request.json() as {kind:string};kind=input.kind;
      const day=new Date().toISOString().slice(0,10),usage=await this.ctx.storage.get<{day:string;count:number}>('usage');
      const count=usage?.day===day?usage.count:0;if(count>=500)return json({error:'daily_read_limit'},429);
      await this.ctx.storage.put('usage',{day,count:count+1});
      stage='start';await this.start();stage='read';
      const payload=JSON.stringify(input);
      const p=await this.ctx.container!.exec(['node','/opt/reader/node_modules/@olorinm/agent-connectors/dist/cloudflare-reader.js'],{
        env:{MAU_READ_CREDENTIALS:this.env.READ_CREDENTIALS},stdin:new Blob([payload]).stream(),signal:AbortSignal.timeout(75000)});
      const output=await p.output();const text=new TextDecoder().decode(output.stdout);
      if(text.length>1000000)throw Error('result_too_large');
      const value=JSON.parse(text);
      await this.ctx.storage.put('lastCall',{time:Date.now(),kind,ok:output.exitCode===0});
      console.log(JSON.stringify({event:'connector_read',kind,ok:output.exitCode===0}));
      return json(value);
    } catch (error) {
      console.error(JSON.stringify({event:'connector_read_failed',kind,stage,code:error instanceof Error&&['package_install','package_missing','package_integrity','result_too_large'].includes(error.message)?error.message:'runtime_error'}));
      return json({error:'connector_unavailable'},502);
    } finally {this.busy=false;try {await this.ctx.container?.setInactivityTimeout(60000);} catch {}}
  }
}

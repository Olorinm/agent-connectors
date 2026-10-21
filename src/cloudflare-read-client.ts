import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const cloudflareReadSchema=z.object({mode:z.literal('cloudflare'),endpoint:z.url(),tokenFile:z.string().min(1),agentId:z.uuid(),owner:z.string().min(1)}).strict();
/** An operator-owned endpoint returning read results only; its credential is not an upstream credential. */
export class CloudflareReadClient {
  private readonly options:z.infer<typeof cloudflareReadSchema>;
  constructor(options:z.input<typeof cloudflareReadSchema>) {
    this.options=cloudflareReadSchema.parse(options);
    const u=new URL(options.endpoint);
    if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('connector_endpoint_invalid');
  }
  private async request(operation:Record<string,unknown>) {
    const token=readFileSync(this.options.tokenFile,'utf8').trim();
    if(!token||/\s/.test(token))throw Error('connector_credential_invalid');
    const response=await fetch(new URL('/v1/read',this.options.endpoint),{method:'POST',redirect:'error',
      headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
      body:JSON.stringify({agentId:this.options.agentId,owner:this.options.owner,...operation}),signal:AbortSignal.timeout(85_000)});
    if(!response.ok)throw Error('cloudflare_connector_unavailable');
    const text=await response.text();if(text.length>1000000)throw Error('connector_result_too_large');
    return JSON.parse(text);
  }
  call(tool:string,input:unknown){return this.request({kind:'business',tool,arguments:input});}
  read(args:string[]){return this.request({kind:'feishu',args});}
}

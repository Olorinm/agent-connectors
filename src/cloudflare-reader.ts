/** Private entry point for the trusted Cloudflare connector container, never an Agent tool. */
import { mkdirSync, writeFileSync, rmSync, statfsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { FeishuBotReader } from './feishu-bot-reader.js';

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 100).map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) =>
    [k, /password|secret|token|credential|phone|mobile|email|身份证|手机号|邮箱/i.test(k) ? '[redacted]' : redact(v)]));
  if (typeof value === 'string') {
    try { return JSON.stringify(redact(JSON.parse(value))); } catch {}
    return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]').replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[phone redacted]');
  }
  return value;
}
async function main() {
  const config = JSON.parse(process.env.MAU_READ_CREDENTIALS ?? '{}');
  delete process.env.MAU_READ_CREDENTIALS;
  const chunks: Buffer[] = []; let size=0;
  for await (const chunk of process.stdin) { size+=chunk.length; if(size>131072) throw Error('input_too_large'); chunks.push(chunk); }
  const input=JSON.parse(Buffer.concat(chunks).toString());
  if (statfsSync('/dev/shm').type !== 0x01021994) throw Error('memory_filesystem_required');
  const directory='/dev/shm/mau-reader-'+randomUUID(); mkdirSync(directory,{mode:0o700});
  try {
    let result: unknown;
    if(input.kind==='feishu') {
      if(!config.feishu) throw Error('connection_not_allowed');
      const appSecretFile=directory+'/app-secret';writeFileSync(appSecretFile,config.feishu.appSecret,{mode:0o600});
      const reader=new FeishuBotReader({appId:config.feishu.appId,domain:config.feishu.domain,appSecretFile,directory:directory+'/cli'});
      result=redact(await reader.read(input.args));
    } else throw Error('unknown_read_kind');
    const text=JSON.stringify(result);
    if(text.length>1000000) throw Error('result_too_large');
    for(const secret of [config.feishu?.appSecret].filter(Boolean)) if(text.includes(secret))throw Error('secret_in_result');
    process.stdout.write(text);
  } finally { rmSync(directory,{recursive:true,force:true}); }
}
main().catch(()=>{process.stdout.write(JSON.stringify({isError:true,error:'connector_read_refused_or_unavailable'}));process.exitCode=1;});

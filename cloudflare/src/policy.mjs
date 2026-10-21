export function readRequest(value, principal) {
  if(!value || value.agentId!==principal.agentId || value.owner!==principal.owner)throw Error('identity_not_allowed');
  if(value.kind==='business') {
    if(!['tools','catalog','schema','rows','novel_chapters','novel_production','outline_novel','script_content'].includes(value.tool))throw Error('tool_not_allowed');
    if(value.arguments===null||typeof value.arguments!=='object'||Array.isArray(value.arguments))throw Error('arguments_invalid');
    return {kind:value.kind,tool:value.tool,arguments:value.arguments};
  }
  if(value.kind==='feishu' && Array.isArray(value.args) && value.args.length>0 && value.args.length<=100 && value.args.every(x=>typeof x==='string'&&x.length<=100000))return {kind:value.kind,args:value.args};
  throw Error('tool_not_allowed');
}
export async function equal(a,b) {
  if(!a||!b)return false;
  const hash=s=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));
  const [x,y]=await Promise.all([hash(a),hash(b)]);let d=0;const u=new Uint8Array(x),v=new Uint8Array(y);
  for(let i=0;i<u.length;i++)d|=u[i]^v[i];return d===0;
}

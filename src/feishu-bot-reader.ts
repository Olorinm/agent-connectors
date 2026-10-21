import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { checkArguments, guidanceArgs, UnconfiguredCli, withFlags } from './connectors/feishu/classify.js';
import { privateFile, runOfficialCli, type CliRunner } from './connectors/feishu/account.js';

export const feishuBotReaderSchema = z.object({ appId: z.string().min(1), appSecretFile: z.string().min(1),
  domain: z.enum(['feishu','lark']), directory: z.string().min(1) }).strict();
const input = z.array(z.string().max(100_000)).min(1).max(100);
/** Existing application identity, read access only. User OAuth and approved writes use ConnectorService. */
export class FeishuBotReader {
  private readonly classifier: UnconfiguredCli;
  private readonly settings: z.infer<typeof feishuBotReaderSchema>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(settings: z.infer<typeof feishuBotReaderSchema>, private readonly runner: CliRunner = runOfficialCli) {
    this.settings = feishuBotReaderSchema.parse(settings);
    const { directory, appId, appSecretFile, domain } = this.settings;
    for(const name of ['config','data','home','work']) mkdirSync(join(directory,name),{recursive:true,mode:0o700});
    privateFile(join(directory,'config/config.json'), {apps:[{appId,appSecret:{source:'file',id:resolve(appSecretFile)},brand:domain,defaultAs:'bot',users:[]}]});
    this.classifier = new UnconfiguredCli(join(directory,'classifier'), runner);
  }
  read(args: string[]): Promise<{ output: string; isError: boolean }> {
    const run = this.queue.then(async () => {
      input.parse(args);
      const guidance = args.length === 1 && ['--help','-h'].includes(args[0]!) ? ['--help']
        : args[0] === 'schema' && args.length > 2 && args.slice(1).every(a => /^[a-zA-Z0-9_+.:-]+$/.test(a))
          ? ['schema', args.slice(1).join(' ')] : guidanceArgs(args);
      if(guidance){const r=await this.classifier.run(guidance);return {output:(r.stdout+'\n'+r.stderr).slice(0,500_000),isError:r.code!==0};}
      checkArguments(args);
      if((await this.classifier.classify(args)).risk!=='read' || !(await this.classifier.plan(args)).readOnly)
        throw new Error('feishu_write_requires_owner_approval');
      const {directory,appId}=this.settings, cwd=mkdtempSync(join(directory,'work/read-'));
      try {
        const env: NodeJS.ProcessEnv = {PATH:process.env.PATH,LANG:'C.UTF-8',HOME:join(directory,'home'),
          LARKSUITE_CLI_CONFIG_DIR:join(directory,'config'),LARKSUITE_CLI_DATA_DIR:join(directory,'data'),
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'};
        const r=await this.runner(withFlags(args,[`--profile=${appId}`,'--as=bot']),{cwd,env,timeout:60_000});
        const output=(r.stdout+'\n'+r.stderr).trim().slice(0,500_000);
        const secret=readFileSync(this.settings.appSecretFile,'utf8').trim();
        if(secret && output.includes(secret)) throw new Error('feishu_result_rejected');
        return {output,isError:r.code!==0};
      } finally {rmSync(cwd,{recursive:true,force:true});}
    });
    this.queue=run.catch(()=>{});return run;
  }
}

/**
 * 模组模板占位符、控制台变量声明与运行时取值保持一致。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envPromptDocOf, renderModuleEnvPrompt } from '../src/core/prefix.ts';
import { templateVarNames, unknownVarNames } from '../src/core/template.ts';
import type { IOModule } from '../src/core/types.ts';
import { BilibiliLiveModule } from '../src/io-bilibili/module.ts';
import { ConsoleFixtureModule } from '../src/io-console-fixture/module.ts';
import { MinecraftModule, MINECRAFT_MODULE_DEFAULTS, type MinecraftConfigSection } from '../src/io-minecraft/module.ts';
import { QQModule } from '../src/io-qq/module.ts';
import { TerminalModule } from '../src/io-terminal/module.ts';
import { VtuberModuleProxy } from '../src/io-vtuber/proxy.ts';
import { WebSearchModule } from '../src/io-websearch/module.ts';

const mcCfg = structuredClone({ ...MINECRAFT_MODULE_DEFAULTS, enabled: true }) as MinecraftConfigSection;

/** 只构造模组，不启动外部连接。 */
const MODULES: Array<() => IOModule> = [
  () => new BilibiliLiveModule({ roomId: 0 }),
  () => new ConsoleFixtureModule(),
  () => new MinecraftModule({ cfg: mcCfg }),
  () => new QQModule({ wsUrl: 'ws://127.0.0.1:1', groups: [], privates: [], token: '' }),
  () => new TerminalModule(),
  () => new VtuberModuleProxy(),
  () => new WebSearchModule({ apiKey: 'k' }),
];

describe('环境提示词模板契约', () => {
  it.each(MODULES.map((make) => [make().id, make] as const))(
    '%s:模板的洞、vars 声明、运行时报的值三者一致',
    async (_id, make) => {
      const mod = make();
      const doc = envPromptDocOf(mod);
      expect(doc, '每个模组都该声明 role=envPrompt 的模板').toBeTruthy();

      const declared = (doc!.vars ?? []).map((v) => v.name).sort();
      const inTemplate = templateVarNames(readFileSync(doc!.path, 'utf8')).sort();
      const reported = Object.keys((await mod.envPromptVars()) ?? {}).sort();

      // 模板里的洞必须都有人声明,否则前缀里会留下裸 {{…}}
      expect(inTemplate, '模板用到的占位符都要在 vars 里声明').toEqual(declared);
      // 声明的洞必须都有人报值,否则控制台的旁注指向一个填不上的洞
      expect(reported, 'vars 声明的占位符都要有运行时值').toEqual(declared);
    },
  );

  it.each(MODULES.map((make) => [make().id, make] as const))(
    '%s:渲染结果里不留没填上的占位符',
    async (_id, make) => {
      const { text } = await renderModuleEnvPrompt(make());
      expect(text).not.toMatch(/\{\{/);
    },
  );

  it('模组自己关掉半边功能时整段不进前缀,连模板都不读', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nullprompt-'));
    const path = join(dir, 'ENV_PROMPT.md');
    const mod: IOModule = {
      id: 'nullprompt',
      envPromptVars: () => null,
      console: () => ({
        promptDocs: [
          { key: 'io.nullprompt.envPrompt', title: 'nullprompt · 环境提示词', description: '测试模板', path, role: 'envPrompt' },
        ],
      }),
      tools: () => [],
      start: async () => {},
      stop: async () => {},
    };
    try {
      const out = await renderModuleEnvPrompt(mod);
      expect(out.text).toBe('');
      expect(out.sourceKey).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bot 侧环境提示词覆盖文件', () => {
  it('随源码发布的覆盖模板只使用所属模组声明的占位符', () => {
    const root = resolve(import.meta.dirname, '..');
    const paths = execFileSync('git', ['ls-files', '-z', '--', 'bots/*/io/*/ENV_PROMPT.md'], {
      cwd: root, encoding: 'utf8',
    }).split('\0').filter(Boolean);
    const modules = new Map(MODULES.map((make) => { const mod = make(); return [mod.id, mod]; }));
    for (const path of paths) {
      const id = path.split('/')[3];
      const mod = modules.get(id);
      expect(mod, path).toBeDefined();
      const declared = (envPromptDocOf(mod!)!.vars ?? []).map((v) => v.name);
      expect(unknownVarNames(readFileSync(join(root, path), 'utf8'), declared), path).toEqual([]);
    }
  });
});

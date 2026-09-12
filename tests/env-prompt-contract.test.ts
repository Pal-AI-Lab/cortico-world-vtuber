/**
 * World 模板占位符、控制台变量声明与运行时取值保持一致。
 *
 * 本包只有演出 World 一件;框架仓库里那份同名测试覆盖框架自带的 World,以及 bot 目录下
 * 的 ENV_PROMPT.md 覆盖模板只用所属 World 声明的占位符这一条。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envPromptDocOf, renderModuleEnvPrompt } from 'cortico/core/prefix.ts';
import { templateVarNames } from 'cortico/core/template.ts';
import type { World } from 'cortico/core/types.ts';
import { VtuberModuleProxy } from '../src/proxy.ts';

/** 只构造 World，不启动外部连接。 */
const MODULES: Array<() => World> = [
  () => new VtuberModuleProxy(),
];

describe('环境提示词模板契约', () => {
  it.each(MODULES.map((make) => [make().id, make] as const))(
    '%s:模板的洞、vars 声明、运行时报的值三者一致',
    async (_id, make) => {
      const mod = make();
      const doc = envPromptDocOf(mod);
      expect(doc, '每个 World 都该声明 role=envPrompt 的模板').toBeTruthy();

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

  it('World 自己关掉半边功能时整段不进前缀,连模板都不读', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nullprompt-'));
    const path = join(dir, 'ENV_PROMPT.md');
    const mod: World = {
      id: 'nullprompt',
      envPromptVars: () => null,
      console: () => ({
        promptDocs: [
          { key: 'worlds.nullprompt.envPrompt', title: 'nullprompt · 环境提示词', description: '测试模板', path, role: 'envPrompt' },
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

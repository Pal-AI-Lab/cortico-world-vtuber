import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 开发期 `cortico/*` 由 devDependency `cortico` 解析;生产里这层由框架的模块钩子做,包内一行不改。
 * `pnpm link` 到本地框架 checkout 时包落在本目录之外,要显式放进 vite 的可服务范围,否则经 jsdom
 * 那条路加载的框架前端模块会被当成不存在。
 */
const FRAMEWORK_DIR = realpathSync(dirname(createRequire(import.meta.url).resolve('cortico/package.json')));

export default defineConfig({
  server: {
    fs: { allow: [fileURLToPath(new URL('./', import.meta.url)), FRAMEWORK_DIR] },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // 控制台语言是按进程读一次的系统事实;测试断言中文文案,与跑测试的机器区域无关。
    env: { CORTICO_LANGUAGE: 'zh' },
    testTimeout: 20000,
    pool: 'forks',
    maxWorkers: 2,
    minWorkers: 1,
  },
});

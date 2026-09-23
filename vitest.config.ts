import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 开发期 `cortico/*` 指向同级的框架 checkout(`../BOT/src/`)。生产里这层由框架的
 * 模块钩子做,包内一行不改;别名与 tsconfig 的 `paths` 必须同步改。
 */
const FRAMEWORK_SRC = fileURLToPath(new URL('../BOT/src/', import.meta.url));
/**
 * 框架 checkout 是链接时(junction / symlink,Windows 上很常见),vite 解析出的
 * 是真实路径,`fs.allow` 拿别名路径去比会判成"文件不存在"。两个都放行。
 */
const FRAMEWORK_REAL = realpathSync(FRAMEWORK_SRC);

export default defineConfig({
  resolve: {
    alias: [{ find: /^cortico\//, replacement: FRAMEWORK_SRC }],
  },
  // 框架 checkout 在本包目录之外,要显式放进 vite 的可服务范围,否则经 jsdom 那条
  // 路加载的框架前端模块会被当成不存在。
  server: {
    fs: { allow: [fileURLToPath(new URL('./', import.meta.url)), FRAMEWORK_SRC, FRAMEWORK_REAL] },
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

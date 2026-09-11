/**
 * `toDisposable` 的包内副本。
 *
 * 浏览器侧只允许 `import type 'cortico/*'`:框架的浏览器代码不随本包发布,面板
 * bundle 也不该把它打进来。`Disposable` 是纯类型,照常从 `cortico/web/shared/client-plugin.ts`
 * 取;这个包装函数是运行时值,所以落在包内。契约与框架那份一致:幂等,`dispose()`
 * 第二次起什么都不做。
 */

import type { Disposable } from 'cortico/web/shared/client-plugin.ts';

/** 把任意清理函数包成 `Disposable`。 */
export function toDisposable(cleanup: () => void): Disposable {
  let done = false;
  return {
    dispose() {
      if (done) return;
      done = true;
      cleanup();
    },
  };
}

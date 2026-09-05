import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 请求遮罩必须盖在弹窗上面。
 *
 * antd 的 `Spin fullscreen` 默认是 zIndexPopupBase（1000），而一个顶层 Modal 是 1100，
 * 嵌套容器每层再叠 100（上限十层）——不显式抬高的话遮罩落在所有弹窗底下：抽屉里点保存，
 * 转圈的圈圈在抽屉后面，看着像没反应。渲染要浏览器环境才测得到，这里守住写法。
 */
const apiSource = await readFile(resolve(import.meta.dirname, '../src/utils/common/api.tsx'), 'utf8');
const zIndex = /zIndexPopupBase \+ (\d+)/.exec(apiSource);
assert.ok(zIndex, '全局遮罩要按 zIndexPopupBase 算出自己的 z-index');
assert.ok(Number(zIndex[1]) > 1000, '遮罩要高过容器叠加的上限（zIndexPopupBase + 1000）');
assert.ok(Number(zIndex[1]) < 1010, '遮罩要低于 message（zIndexPopupBase + 1010）：结果提示该压在遮罩上面');
assert.match(apiSource, /<Spin fullscreen spinning=\{pendingRequests > 0\} style=\{\{ zIndex: loadingZIndex \}\} \/>/, '全局遮罩要用算出来的 z-index');

// 只打包 response-action 这一支：它不依赖 React 和 antd，因此这个测试很轻，
// 不受浏览器测试那种内存限制。
const output = resolve(import.meta.dirname, '../dist/response-action-test.mjs');
await build({
	entryPoints: [resolve(import.meta.dirname, 'test-response-action.tsx')],
	bundle: true,
	packages: 'external',
	platform: 'node',
	format: 'esm',
	outfile: output,
	alias: { '@': resolve(import.meta.dirname, '../src'), '@shared': resolve(import.meta.dirname, '../shared') },
	resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mts', '.mjs', '.json'],
});
await import(`${pathToFileURL(output)}?test=${Date.now()}`);
process.exit(0);

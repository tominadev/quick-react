import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// 只打包地址栏状态这一支：纯函数，不依赖 React 和 antd，因此这个测试很轻。
const output = resolve(import.meta.dirname, '../dist/table-url-state-test.mjs');
await build({
	entryPoints: [resolve(import.meta.dirname, 'test-table-url-state.tsx')],
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

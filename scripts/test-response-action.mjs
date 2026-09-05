import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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

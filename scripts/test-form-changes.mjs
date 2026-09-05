import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// 纯函数，不依赖 React 与 antd，因此这个测试不受浏览器测试那种内存限制。
const output = resolve(import.meta.dirname, '../dist/form-changes-test.mjs');
await build({
	entryPoints: [resolve(import.meta.dirname, 'test-form-changes.tsx')],
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

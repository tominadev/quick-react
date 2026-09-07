import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 弹窗里的表格（回收站）不能写地址栏。
 *
 * 它翻页、排序、搜索都会调 rememberTableState；不关掉的话这些操作会把**主表**记在
 * 地址栏里的状态覆盖掉——关掉弹窗后主表还停在原处，地址栏说的却是回收站那一套，
 * 一刷新就跳到别的地方去了。渲染要靠浏览器环境才测得到，这里守住调用点。
 */
const tableSource = await readFile(resolve(import.meta.dirname, '../clients/antd/utils/antd/table_crud/index.tsx'), 'utf8');
assert.match(tableSource, /showRecycleBin=\{false\}\s*\n\s*urlState=\{false\}/, '弹窗里的 TableCRUD 必须带 urlState={false}');
assert.match(tableSource, /if \(!urlState \|\| typeof window === 'undefined'\) return;/, 'rememberTableState 必须在 urlState 关闭时直接返回');

// 只打包地址栏状态这一支：纯函数，不依赖 React 和 antd，因此这个测试很轻。
const output = resolve(import.meta.dirname, '../dist/table-url-state-test.mjs');
await build({
	entryPoints: [resolve(import.meta.dirname, 'test-table-url-state.tsx')],
	bundle: true,
	packages: 'external',
	platform: 'node',
	format: 'esm',
	outfile: output,
	alias: { '@': resolve(import.meta.dirname, '../clients/antd'), '@clients': resolve(import.meta.dirname, '../clients'), '@shared': resolve(import.meta.dirname, '../shared') },
	resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mts', '.mjs', '.json'],
});
await import(`${pathToFileURL(output)}?test=${Date.now()}`);
process.exit(0);

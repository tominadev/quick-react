import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * antd-mobile 必须**打进来**，不能像桌面版那些浏览器测试那样整包 external：它的组件
 * 在入口就 `require` 一个 .css，而 Node 直接 require CSS 会当场语法错误。打进来并把
 * 样式表按空文件处理——这个测试看的是渲染出哪些按钮，与长什么样无关。
 *
 * React 与测试库也一起打进来：只留一份实例，hooks 才不会报「两个 React」。留在外面的话
 * antd-mobile 依赖链上那几个只发 CJS 的包（rc-field-form 等）会 require('react')，而
 * external 的 react 在 ESM 产物里只剩一个必然抛错的动态 require 垫片。
 */
const output = resolve(import.meta.dirname, '../dist/mobile-table-test.mjs');
await build({
	entryPoints: [resolve(import.meta.dirname, 'test-mobile-table-browser.tsx')],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: output,
	external: ['jsdom'],
	loader: { '.css': 'empty' },
	// 依赖一律走 ESM 产物：antd-mobile 和它底下的 ahooks 都同时发 cjs/ 与 es/，
	// 而 cjs 那份 require('react')——react 是 external，打出来就是一个在 ESM 里必然抛错的
	// 动态 require 垫片。mainFields 一改，整条依赖链都取 es/。
	mainFields: ['module', 'main'],
	conditions: ['import', 'module', 'default'],
	// 指向 antd-mobile 的 ESM 产物：它的 CJS 产物 require('react')，而 react 是 external，
	// 打出来的是一个在 ESM 里必然抛错的动态 require 垫片。
	alias: { 'antd-mobile': resolve(import.meta.dirname, '../node_modules/antd-mobile/es/index.js'), '@clients': resolve(import.meta.dirname, '../clients'), '@shared': resolve(import.meta.dirname, '../shared') },
	resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mts', '.mjs', '.json'],
});
await import(`${pathToFileURL(output)}?test=${Date.now()}`);
process.exit(0);

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 「改了什么」的确认框与「操作原因」只属于管理后台。
 *
 * 注册页也是一个 FormPage：不判 changeControl 的话，填完点提交会先弹出
 * 「将保存以下修改：用户名：空 → admin，密码：空 → 123」——把刚输入的密码原样念给
 * 用户看，而那既不是修改也不留痕。账户中心的解绑邮箱、注销设备同理：确认要问，
 * 但不该逼人写一条「操作原因」。渲染要浏览器环境才测得到，这里守住判定点。
 */
const formPageSource = await readFile(resolve(import.meta.dirname, '../src/components/panel/FormPage.tsx'), 'utf8');
assert.match(formPageSource, /if \(formConfig\?\.changeControl\) \{[\s\S]{0,600}?describeFormChanges\(/, '确认与变更说明必须整段包在 changeControl 判断里');
assert.doesNotMatch(formPageSource, /\} else if \(!await commonApi\.modalConfirm\(lines\)\)/, '非管理后台不该再弹「将保存以下修改」');
const tableSource = await readFile(resolve(import.meta.dirname, '../src/utils/antd/table_crud/index.tsx'), 'utf8');
assert.match(tableSource, /if \(tableOptionRef\.current\.changeControl\) return commonApi\.modalConfirmWithReason\(lines\);/, '操作原因只在管理后台问');
assert.match(tableSource, /return await commonApi\.modalConfirm\(lines\) \? \{ reason: '' \} : undefined;/, '其余页面仍要确认，只是不问原因');

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

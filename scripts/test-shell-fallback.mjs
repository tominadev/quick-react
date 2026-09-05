import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-shell-'));
process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';

try {
	const { app } = await import(`../dist/server.mjs?shell=${Date.now()}`);
	const html = await (await app.request('http://localhost/')).text();
	// 页面壳是 CDN 可缓存的静态壳，兜底脚本必须内联：能走到失败分支，恰恰说明外部资源靠不住。
	assert.match(html, /onerror="window\.__APP_LOAD_FAILED__/, '脚本标签要挂 onerror');

	const load = (trigger) => {
		// 只执行内联脚本；bundle.js.nocache 在这里本来就取不到，正好是要模拟的场景。
		const dom = new JSDOM(html, { url: 'https://site.test/', runScripts: 'dangerously' });
		trigger(dom.window);
		return dom.window.document.getElementById('root');
	};

	// 1. 脚本加载不到：onerror 直接触发。
	const failed = load((w) => w.__APP_LOAD_FAILED__());
	assert.equal(failed.querySelector('.app-loading-spinner'), null, '不该再转圈');
	assert.match(failed.textContent, /页面加载失败/);
	assert.match(failed.textContent, /请联系客服/);
	assert.ok(failed.querySelector('.app-loading-retry'), '要给一个重新加载的按钮');

	// 2. 脚本加载了但初始化抛错。
	const crashed = load((w) => w.dispatchEvent(new w.ErrorEvent('error', { message: 'boom' })));
	assert.match(crashed.textContent, /页面加载失败/);

	// 3. 一直不出来：超时兜底。真等 30 秒不现实，这里只确认它确实排了这个定时器，
	//    并且在信号到来之前页面保持「正在加载」——不能一进来就喊失败。
	assert.match(html, /setTimeout\(function \(\) \{[\s\S]*?页面加载超时[\s\S]*?\}, 30000\)/, '超时兜底要排 30 秒');
	const untouched = load(() => {});
	assert.match(untouched.textContent, /正在加载页面/, '没有任何失败信号时不该打扰用户');
	assert.ok(untouched.querySelector('.app-loading-spinner'), '仍在加载就该继续转圈');

	// 4. 界面已经渲染出来之后迟到的错误信号不该盖掉正常页面。
	const mounted = load((w) => {
		w.document.getElementById('root').innerHTML = '<main>已经渲染好了</main>';
		w.__APP_LOAD_FAILED__();
	});
	assert.equal(mounted.textContent, '已经渲染好了', '迟到的失败信号必须被忽略');

	console.log('shell fallback test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}

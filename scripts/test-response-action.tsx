import assert from 'node:assert/strict';
import { setupBrowserDom } from './browser-dom.mjs';

const dom = setupBrowserDom('https://site.test/');


const { applyApiResponseContext, apiNavigationEvent, planApiNavigation } = await import('@clients/browser/response-action.js');

const patch = { auth: { currentUser: { profile_nickname: '管理员123' } } };

// —— 局部上下文广播 ——
const seen: unknown[] = [];
window.addEventListener(apiNavigationEvent, (event) => seen.push((event as CustomEvent).detail));
applyApiResponseContext(patch);
assert.equal(seen.length, 1);
assert.equal((seen[0] as { context: typeof patch }).context.auth.currentUser.profile_nickname, '管理员123');
// 没有身份可更新就不广播，白惊动一次界面。
for (const empty of [undefined, {}, { auth: {} }, { siteNavigation: [] }]) applyApiResponseContext(empty as never);
assert.equal(seen.length, 1, '只有带 currentUser 的上下文才广播');

// —— 事件判定 ——
assert.deepEqual(planApiNavigation(undefined), { kind: 'ignore' });
assert.deepEqual(planApiNavigation({}), { kind: 'ignore' });
// 没有下一步动作 = 只合并身份字段，页面不动。补丁只带变化的那几个字段。
assert.deepEqual(planApiNavigation({ context: patch }), { kind: 'identity', currentUser: { profile_nickname: '管理员123' } });
// 有跳转但没声明刷新认证：不归这里管。
assert.deepEqual(planApiNavigation({ next: { action: 'navigate', path: '/x' } }), { kind: 'ignore' });
assert.deepEqual(planApiNavigation({ next: { action: 'reload' } }), { kind: 'ignore' });
assert.deepEqual(planApiNavigation({ next: { action: 'navigate', path: '/panel', refreshAuth: true }, context: patch }),
	{ kind: 'navigate', path: '/panel', context: patch });

console.log('response action test passed');

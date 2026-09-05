import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://site.test/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent });


const { applyApiIdentity, apiIdentityEvent, planApiNavigation } = await import('@/utils/common/response-action.js');

// —— 身份广播：只认具名的 user 字段 ——
const seen = [];
window.addEventListener(apiIdentityEvent, (event) => seen.push(event.detail));
applyApiIdentity({ id: 1, user_name: 'adm', profile_nickname: '管理员123', roles: ['platform_admin'] });
assert.equal(seen.length, 1);
assert.equal(seen[0].profile_nickname, '管理员123');
// 表单值里同样可能出现 profile_nickname，但那可能是管理员在改别人的资料，
// 照着更新右上角就错了：没有 user_name 的对象一律不当身份。
for (const notIdentity of [undefined, null, 'adm', 42, [], {}, { profile_nickname: '别人' }]) applyApiIdentity(notIdentity);
assert.equal(seen.length, 1, '只有具名的身份对象才广播');

// —— 事件判定 ——
assert.deepEqual(planApiNavigation(undefined), { kind: 'ignore' });
assert.deepEqual(planApiNavigation({}), { kind: 'ignore' });
// 没有下一步动作 + 带认证上下文 = 只更新身份显示，页面不动。
const auth = { component: 'dropdown', actions: [], pages: [], currentUser: { id: 1, user_name: 'adm', profile_nickname: '管理员123', roles: [] } };
assert.deepEqual(planApiNavigation({ context: { auth } }), { kind: 'auth', auth });
// 有跳转但没声明刷新认证：不归这里管。
assert.deepEqual(planApiNavigation({ next: { action: 'navigate', path: '/x' } }), { kind: 'ignore' });
assert.deepEqual(planApiNavigation({ next: { action: 'reload' } }), { kind: 'ignore' });
const navigatePlan = planApiNavigation({ next: { action: 'navigate', path: '/panel', refreshAuth: true }, context: { auth } });
assert.deepEqual(navigatePlan, { kind: 'navigate', path: '/panel', context: { auth } });

console.log('response action test passed');

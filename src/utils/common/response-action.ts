import type { ApiContext, ApiNextAction } from '@shared/types/api-response.mjs';
import type { UserIdentity } from '@shared/types/user.mjs';

export const apiNavigationEvent = 'base-api-navigation';
export const apiIdentityEvent = 'base-api-identity';
export type ApiNavigationEventDetail = { next?: ApiNextAction; context?: ApiContext };

const handlers: Record<ApiNextAction['action'], (next: ApiNextAction, context?: ApiContext) => void> = {
	reload: (next) => {
		const delayValue = next.action === 'reload' ? next.delay ?? 0 : 0;
		const delay = Number.isFinite(delayValue) ? Math.max(0, delayValue) : 0;
		if (delay === 0) { window.location.reload(); return; }
		window.setTimeout(() => window.location.reload(), delay * 1000);
	},
	navigate: (next, context) => {
		if (next.action !== 'navigate') return;
		if (next.refreshAuth) {
			window.dispatchEvent(new CustomEvent<ApiNavigationEventDetail>(apiNavigationEvent, { detail: { next, context } }));
			return;
		}
		window.location.assign(next.path);
	},
};

/**
 * 响应里带回当前登录身份时就地更新显示，不跳转、不动页面。
 *
 * 只搬**身份本身**，不搬整个认证上下文：改个昵称而已，导航树、页面状态、可用动作
 * 一样都没变，把它们整份传一遍既浪费又容易把没变的东西覆盖成空。
 *
 * 只认具名的 user 字段。表单里同样可能出现 profile_nickname，但那可能是管理员在改
 * **别人**的资料，照着更新右上角就错了；identity 必须由接口显式声明是「当前这个人」。
 */
export const applyApiIdentity = (user: unknown) => {
	if (!user || typeof user !== 'object' || Array.isArray(user)) return;
	if (typeof (user as { user_name?: unknown }).user_name !== 'string') return;
	window.dispatchEvent(new CustomEvent<UserIdentity>(apiIdentityEvent, { detail: user as UserIdentity }));
};

/**
 * 事件该怎么处理，与 React 无关的那部分单独拿出来，好脱离整个应用直接测。
 *
 * - `auth`：只更新身份显示，页面不动。响应带回认证上下文却没有下一步动作时走这一支。
 * - `navigate`：先套上新的上下文再切路径。
 * - `ignore`：这个事件与认证无关。
 */
export type ApiNavigationPlan =
	| { kind: 'auth'; auth: NonNullable<ApiContext['auth']> }
	| { kind: 'navigate'; path: string; context?: ApiContext }
	| { kind: 'ignore' };

export const planApiNavigation = (detail?: ApiNavigationEventDetail): ApiNavigationPlan => {
	const next = detail?.next;
	// 只取 auth 一项：这类响应不携带导航树和页面状态，整份套上去会把它们清空。
	if (!next) return detail?.context?.auth ? { kind: 'auth', auth: detail.context.auth } : { kind: 'ignore' };
	if (next.action !== 'navigate' || !next.refreshAuth) return { kind: 'ignore' };
	return { kind: 'navigate', path: next.path, context: detail?.context };
};

/** 统一执行后端下发的完成动作，业务组件不得自行推断刷新或跳转目标。 */
export const runApiNextAction = (next?: ApiNextAction, context?: ApiContext) => { if (next) handlers[next.action](next, context); };

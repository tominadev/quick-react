import type { ApiContext, ApiContextPatch, ApiNextAction } from '@shared/types/api-response.mjs';
import type { UserIdentity } from '@shared/types/user.mjs';

export const apiNavigationEvent = 'base-api-navigation';
export type ApiNavigationEventDetail = { next?: ApiNextAction; context?: ApiContext | ApiContextPatch };

const handlers: Record<ApiNextAction['action'], (next: ApiNextAction, context?: ApiContext | ApiContextPatch) => void> = {
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
 * 只应用响应附带的认证上下文，不做任何跳转。
 *
 * 用在「改了自己的身份但留在原页面」这种场合：个人中心改完昵称，右上角要跟着变，
 * 而页面不该动。消费侧只取其中的 auth 一项，见 planApiNavigation。
 */
export const applyApiResponseContext = (context?: ApiContext | ApiContextPatch) => {
	if (!context?.auth?.currentUser) return;
	window.dispatchEvent(new CustomEvent<ApiNavigationEventDetail>(apiNavigationEvent, { detail: { context } }));
};

/**
 * 事件该怎么处理，与 React 无关的那部分单独拿出来，好脱离整个应用直接测。
 *
 * - `auth`：只更新身份显示，页面不动。响应带回认证上下文却没有下一步动作时走这一支。
 * - `navigate`：先套上新的上下文再切路径。
 * - `ignore`：这个事件与认证无关。
 */
export type ApiNavigationPlan =
	| { kind: 'identity'; currentUser: Partial<UserIdentity> }
	| { kind: 'navigate'; path: string; context?: ApiContext }
	| { kind: 'ignore' };

export const planApiNavigation = (detail?: ApiNavigationEventDetail): ApiNavigationPlan => {
	const next = detail?.next;
	if (!next) {
		// 没有下一步动作的上下文是**局部补丁**：只带变化的身份字段，按路径合并进去。
		// 整份替换会把导航树、页面状态这些没跟着传的东西清空。
		const currentUser = detail?.context?.auth?.currentUser;
		return currentUser ? { kind: 'identity', currentUser } : { kind: 'ignore' };
	}
	if (next.action !== 'navigate' || !next.refreshAuth) return { kind: 'ignore' };
	return { kind: 'navigate', path: next.path, context: detail?.context as ApiContext | undefined };
};

/** 统一执行后端下发的完成动作，业务组件不得自行推断刷新或跳转目标。 */
export const runApiNextAction = (next?: ApiNextAction, context?: ApiContext | ApiContextPatch) => { if (next) handlers[next.action](next, context); };

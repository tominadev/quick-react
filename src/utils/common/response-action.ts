import type { ApiContext, ApiNextAction } from '@shared/types/api-response.mjs';

export const apiNavigationEvent = 'base-api-navigation';
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
 * 只应用响应附带的认证上下文，不做任何跳转。
 *
 * 用在「改了自己的身份但留在原页面」这种场合：个人中心改完昵称，右上角那块要跟着变，
 * 而页面不该动。
 */
export const applyApiResponseContext = (context?: ApiContext) => {
	if (!context?.auth) return;
	window.dispatchEvent(new CustomEvent<ApiNavigationEventDetail>(apiNavigationEvent, { detail: { context } }));
};

/** 统一执行后端下发的完成动作，业务组件不得自行推断刷新或跳转目标。 */
export const runApiNextAction = (next?: ApiNextAction, context?: ApiContext) => { if (next) handlers[next.action](next, context); };

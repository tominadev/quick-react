import type { ApiNextAction } from '@shared/types/api-response.mjs';

export const apiNavigationEvent = 'base-api-navigation';

const handlers: Record<ApiNextAction['action'], (next: ApiNextAction) => void> = {
	reload: (next) => {
		const delayValue = next.action === 'reload' ? next.delay ?? 0 : 0;
		const delay = Number.isFinite(delayValue) ? Math.max(0, delayValue) : 0;
		if (delay === 0) { window.location.reload(); return; }
		window.setTimeout(() => window.location.reload(), delay * 1000);
	},
	navigate: (next) => {
		if (next.action !== 'navigate') return;
		if (next.refreshAuth) {
			window.dispatchEvent(new CustomEvent(apiNavigationEvent, { detail: next }));
			return;
		}
		window.location.assign(next.path);
	},
};

/** 统一执行后端下发的完成动作，业务组件不得自行推断刷新或跳转目标。 */
export const runApiNextAction = (next?: ApiNextAction) => { if (next) handlers[next.action](next); };

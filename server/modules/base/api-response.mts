import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from './types.mjs';
import type { ApiFeedback, ApiFeedbackOptions, ApiSuccessData } from '@shared/types/api-response.mjs';
import { createDeviceKeyTransportCookie } from './device-fingerprint.mjs';
import { isSecureRequest } from './request-origin.mjs';
import { deletedScopeFromQuery, queryIncludes } from './query-options.mjs';
export type { ApiFeedback, ApiFeedbackOptions, ApiSuccessData } from '@shared/types/api-response.mjs';

const isSuccessStatus = (status: number) => status >= 200 && status < 300;
const requestsAuthContext = (c: Context<AppEnv>) => queryIncludes(c, 'include', 'auth');

/** 所有 TableCRUD 统一提供回收站入口；具体回收、恢复和彻底删除动作仍由原接口驱动。 */
/**
 * 标注哪些列可排序。
 *
 * 名单来自列表查询自己（tableSort 在查询执行时写进请求上下文），因此「能排序的列」
 * 永远等于「这条查询选出来的列」。放在这里统一做，路由不必各写一遍，加列减列也不会走偏。
 *
 * 与回收站等表格工具分开：那一套只在 tableCrud 路由上生效，而排序是所有列表都该有的。
 */
const withSortableColumns = (c: Context<AppEnv>, payload: Record<string, unknown>) => {
	const fields = c.get('sortableFields');
	const table = payload.table;
	if (!fields?.length || !table || typeof table !== 'object' || Array.isArray(table)) return payload;
	const source = table as Record<string, unknown>;
	if (!Array.isArray(source.columns)) return payload;
	const allowed = new Set(fields);
	return {
		...payload,
		table: {
			...source,
			columns: source.columns.map((column) => {
				const item = column as Record<string, unknown>;
				return allowed.has(String(item.dataIndex)) ? { ...item, sortable: true } : item;
			}),
		},
	};
};

const withTableUtilities = (c: Context<AppEnv>, payload: Record<string, unknown>) => {
	if (!c.get('tableCrud')) return payload;
	const table = payload.table;
	if (!table || typeof table !== 'object' || Array.isArray(table)) return payload;
	const source = table as Record<string, unknown>;
	const option = source.option;
	if (!option || typeof option !== 'object' || Array.isArray(option)) return payload;
	const optionSource = option as Record<string, unknown>;
	const actions = optionSource.actions && typeof optionSource.actions === 'object' && !Array.isArray(optionSource.actions)
		? optionSource.actions as Record<string, unknown>
		: {};
	const deleted = deletedScopeFromQuery(c) === 'deleted';
	if (deleted) {
		return {
			...payload,
			table: {
				...source,
				option: {
					...optionSource,
					actions: {
						...actions,
						toolbar: [
							{ key: 'restore', label: '恢复选中记录', confirm: '确认恢复选中的记录吗？', selection: true },
							{ key: 'purge', label: '彻底删除选中记录', confirm: '彻底删除后无法恢复，确认继续吗？', selection: true },
						],
						row: [
							{ key: 'restore', label: '恢复', confirm: '确认恢复这条记录吗？' },
							{ key: 'purge', label: '彻底删除', confirm: '彻底删除后无法恢复，确认继续吗？' },
						],
					},
				},
			},
		};
	}
	const toolbar = Array.isArray(actions.toolbar) ? actions.toolbar : [];
	if (toolbar.some((action) => action && typeof action === 'object' && (action as Record<string, unknown>).key === 'recycle-bin')) return payload;
	const apiPath = c.req.path.startsWith('/api') ? c.req.path.slice('/api'.length) : c.req.path;
	const apiSuffix = c.get('techStackConfig').apiSuffix;
	const modalPath = apiSuffix && apiPath.endsWith(apiSuffix) ? apiPath.slice(0, -apiSuffix.length) : apiPath;
	return {
		...payload,
		table: {
			...source,
			option: {
				...optionSource,
				actions: {
					...actions,
					toolbar: [...toolbar, { key: 'recycle-bin', label: '回收站', modalPath, modalComponent: 'table' }],
				},
			},
		},
	};
};

const selectTableResponse = (payload: Record<string, unknown>, c: Context<AppEnv>) => {
	const table = payload.table;
	if (!table || typeof table !== 'object' || Array.isArray(table)) return payload;
	const includeValue = c.req.query('include')?.trim();
	if (!includeValue) return { ...payload, table: {} };
	const includeSchema = queryIncludes(c, 'include', 'schema');
	const includeData = queryIncludes(c, 'include', 'data');
	if (includeSchema && includeData) return payload;
	const source = table as Record<string, unknown>;
	const keys = includeSchema
		? ['option', 'columns']
		: includeData
			? ['dataSource', 'totalRecords', 'nextCursor', 'hasMore']
			: [];
	const selected = Object.fromEntries(keys
		.filter((key) => key in source)
		.map((key) => [key, source[key]]));
	return { ...payload, table: selected };
};

const defaultMessage = (status: number) => {
	if (status === 200) return '操作成功';
	if (status === 201) return '创建成功';
	if (status === 202) return '请求已接受';
	if (status === 204) return '操作成功';
	if (status === 400) return '请求参数错误';
	if (status === 401) return '请先登录';
	if (status === 403) return '无权执行此操作';
	if (status === 404) return '请求的资源不存在';
	if (status === 409) return '请求冲突';
	if (status === 422) return '数据校验失败';
	if (status === 429) return '请求过于频繁';
	if (status >= 200 && status < 300) return '操作成功';
	if (status >= 400 && status < 500) return '请求失败';
	return '服务器错误';
};

const writeApiResponse = (c: Context<AppEnv>, status: number, data: Record<string, unknown>) => (
	c.json(data, status as ContentfulStatusCode)
);

/** 有权跳过审批的角色，与 §9 的撤回权限一致。 */
const APPROVAL_SKIP_ROLES = ['platform_admin', 'tenant_admin', 'branch_admin'];

/**
 * 告诉前端要不要渲染「立即生效」勾选框。
 *
 * 在这里注入而不是让每个路由各写一遍：46 个后台页面一个都不能漏，漏掉的那个
 * 管理员就只能走审批。服务端另有一道校验（runOperation），这里只决定渲不渲染。
 */
const withChangeControl = (c: Context<AppEnv>, payload: Record<string, unknown>) => {
	// 只在管理后台收集变更说明，与审批的适用范围同一条线（§11.2）。
	//
	// 登录与注册页压根不产生审计记录（新增不留痕）；个人中心与账户中心是用户处置
	// 自己的数据——改个昵称还要写「变更理由」是荒谬的，那些操作照常留痕但不问理由。
	const changeControl = c.req.path.startsWith('/api/panel/admin/');
	if (!changeControl) return payload;
	const canSkipApproval = (c.get('effectiveRoles') ?? []).some((role) => APPROVAL_SKIP_ROLES.includes(role));
	// 路由显式声明的优先：有些后台页面的动作压根不经过审批门（审计页的撤回、批准、
	// 驳回走的是 runSystemSql），在那里显示「立即生效」是误导——勾了不改变任何行为。
	const fill = (target: Record<string, unknown>) => ({
		changeControl: target.changeControl ?? changeControl,
		canSkipApproval: target.canSkipApproval ?? canSkipApproval,
	});
	let result = payload;
	const table = payload.table;
	if (table && typeof table === 'object') {
		const option = (table as Record<string, unknown>).option;
		if (option && typeof option === 'object') result = { ...result, table: { ...table, option: { ...option, ...fill(option as Record<string, unknown>) } } };
	}
	const formPage = payload.formPage;
	if (formPage && typeof formPage === 'object') result = { ...result, formPage: { ...formPage, ...fill(formPage as Record<string, unknown>) } };
	return result;
};

export const apiResponse = async <T extends ApiSuccessData>(
	c: Context<AppEnv>,
	status: number,
	data: T,
): Promise<Response> => {
	const payload = data as Record<string, unknown>;
	const next = payload.next;
	const refreshesAuth = Boolean(next && typeof next === 'object' && !Array.isArray(next) && (next as { refreshAuth?: unknown }).refreshAuth === true);
	const includesAuth = requestsAuthContext(c);
	const utilityPayload = withChangeControl(c, withSortableColumns(c, withTableUtilities(c, payload)));
	let responseData: Record<string, unknown> = selectTableResponse(utilityPayload, c);
	const contextProvider = c.get('apiContext');
	if ((includesAuth || refreshesAuth) && contextProvider) {
		responseData = { ...responseData, context: await contextProvider(c.req.query('path')) };
		// 认证上下文包含当前用户，不得由浏览器或 CDN 缓存。
		c.header('Cache-Control', 'no-store');
	}
	const responseCookies = () => c.res.headers.get('set-cookie') ?? '';
	const deviceKey = c.req.header('x-device-key')?.trim();
	const transportCookie = deviceKey ? createDeviceKeyTransportCookie(deviceKey, isSecureRequest(c)) : '';
	if (transportCookie && !responseCookies().includes('device_key=')) c.header('Set-Cookie', transportCookie, { append: true });
	return c.json(responseData, status as ContentfulStatusCode);
};

/** API 启动请求需要先拿到认证上下文；权限守卫拒绝页面数据时仍返回该上下文，避免前端再发一次状态请求。 */
export const apiAuthContextFallback = (
	c: Context<AppEnv>,
	status: number,
	message: string,
) => requestsAuthContext(c) ? apiResponse(c, 200, {}) : apiMessage(c, status, message);

const messagePayload = (
	status: number,
	message: string,
	feedbackOptions: ApiFeedbackOptions,
	data: Record<string, unknown>,
) => isSuccessStatus(status)
	? {
		...data,
		feedback: {
			component: 'message' as const,
			type: 'success' as const,
			message,
			...feedbackOptions,
		},
	}
	: {
		feedback: {
			component: 'modal' as const,
			type: 'error' as const,
			message,
			...feedbackOptions,
		},
	};

export const apiMessage = (
	c: Context<AppEnv>,
	status: number,
	message?: string,
	feedbackOptions: ApiFeedbackOptions = {},
	data: Record<string, unknown> = {},
) => {
	const payload = messagePayload(status, message ?? defaultMessage(status), feedbackOptions, data);
	return isSuccessStatus(status)
		? apiResponse(c, status, payload as ApiSuccessData)
		: writeApiResponse(c, status, payload);
};

export const apiMessageData = (
	c: Context<AppEnv>,
	status: number,
	message: string,
	data: Record<string, unknown>,
	feedbackOptions: ApiFeedbackOptions = {},
) => {
	const payload = messagePayload(status, message, feedbackOptions, data);
	return isSuccessStatus(status)
		? apiResponse(c, status, payload as ApiSuccessData)
		: writeApiResponse(c, status, payload);
};

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from './types.mjs';
import type { ApiFeedback, ApiFeedbackOptions, ApiSuccessData } from '@shared/types/api-response.mjs';
import { createDeviceKeyTransportCookie } from './device-fingerprint.mjs';
import { isSecureRequest } from './request-origin.mjs';
import { deletedScopeFromQuery, queryIncludes } from './query-options.mjs';
import { APPROVAL_SKIP_ROLES, operationScope } from './operation.mjs';
import { APPROVE_ACTION, EDIT_ACTION_VALUES, IDLE_ACTION_VALUES, PENDING_FIELD, PENDING_IDS_FIELD, PENDING_KINDS, PENDING_LOCK_FIELD, REJECT_ACTION, WITHDRAW_ACTION, pendingRowLock, pendingRowStates, pendingRowToken } from './pending-approval.mjs';
import { isSuperUser } from './super-users.mjs';
import { tableCrudDatabase } from './table-crud.mjs';
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

/**
 * 给列表里「有修改在等审批」的行打上标记，并挂上撤销、批准与驳回三个行操作。
 *
 * 提交后进了审批队列，列表上却什么都看不出来——显示的仍是旧值，用户以为没保存成功，
 * 于是再改一次，队列里堆出第二条。标记摆在行上，这条路就断了。
 *
 * **不加「审批」列。** 一整列只为了让极少数几行显示一个标签，其余每一行都空着，
 * 而横向空间是表格里最紧的资源。改成给那几行换个底色：一眼看得出，一格不占。
 * `_pending` 仍然发到每一行上——行底色和 `visibleWhen` 都读它，那是数据不是列。
 *
 * **两个行操作在管理后台一律挂上，不管当下有没有待审批的行。** 它们由 `visibleWhen`
 * 按行显隐，没有待审批时一个都不显示，不占任何位置；而挂在结构里意味着**删一行之后
 * 只重取数据就能让按钮出现**——表结构前端是缓存的，按需下发的话，得整页刷新才看得见。
 *
 * 「批准」与「立即生效」是同一件事的两个入口，共用同一道角色门；撤销不设门槛，
 * 它只是把申请收回去，数据一动不动。
 */
const withPendingApproval = async (c: Context<AppEnv>, payload: Record<string, unknown>) => {
	const definition = c.get('tableCrud');
	const table = payload.table;
	if (!definition || !table || typeof table !== 'object' || Array.isArray(table)) return payload;
	const source = table as Record<string, unknown>;
	const rows = source.dataSource;
	const option = source.option;
	// option 可能没有：翻页与写操作之后前端只请求 data，结构用缓存的那一份。
	// 那种响应照样要带上 _pending，否则行底色和按钮的显隐都停在上一次的状态。
	if (!Array.isArray(rows) || !rows.length) return payload;
	const database = tableCrudDatabase(c, definition);
	if (!database) return payload;
	const tableName = typeof definition.table === 'function' ? await definition.table(c) : definition.table;
	const rowKey = typeof definition.rowKey === 'function' ? await definition.rowKey(c) : definition.rowKey;
	if (!tableName || !rowKey) return payload;
	const ids = rows.map((row) => String((row as Record<string, unknown>)[rowKey] ?? '')).filter(Boolean);
	if (!ids.length) return payload;
	const states = await pendingRowStates(c, database, tableName, ids);
	const marked = rows.map((row) => {
		const state = states.get(String((row as Record<string, unknown>)[rowKey] ?? ''));
		// 待审批记录的 id 跟着行一起发下去：撤销/批准/驳回原样带回来，动的就是这里看到的那几条。
		// 被别人的申请锁住时，那句「谁在申请什么」也跟着行走：按钮留在原处，点进去看到它。
		return { ...(row as Record<string, unknown>), [PENDING_FIELD]: pendingRowToken(state), [PENDING_IDS_FIELD]: state?.ids.join(',') ?? '', [PENDING_LOCK_FIELD]: pendingRowLock(state) };
	});
	// 只给要走审批的页面挂：问 operationScope，与「这一页看不看得见待审批的行」同一个答案。
	const withActions = option && typeof option === 'object' && !Array.isArray(option) && operationScope(c) === 'admin';
	if (!withActions) return { ...payload, table: { ...source, dataSource: marked } };
	const optionSource = option as Record<string, unknown>;
	const actions = optionSource.actions && typeof optionSource.actions === 'object' && !Array.isArray(optionSource.actions)
		? optionSource.actions as Record<string, unknown>
		: {};
	const rowActions = Array.isArray(actions.row) ? actions.row : [];
	const canApprove = (c.get('effectiveRoles') ?? []).some((role) => APPROVAL_SKIP_ROLES.includes(role));
	/**
	 * 按钮按「谁提的」和「哪一种申请」分开挂，不是一对通用的撤销/批准。
	 *
	 * - **撤销**只对自己提的出现：替别人撤等于替别人做决定，那是驳回该干的事。原先它对每
	 *   一行都出现，点下去才被服务端挡回来（「没有你自己提交的待审批申请」）。
	 * - **驳回**只对别人提的出现：自己的东西直接撤销就是了，多一个按钮只会让人犹豫该点哪个。
	 * - **批准**自己提的那一份只给超级用户：其余人受四眼原则限制，点了必然失败（§13.5）。
	 * - 新增与修改分开说：「撤销新增」会让那一行进回收站，「撤销修改」一个字都不动数据。
	 *
	 * 同一个 key 出现两次没问题：`visibleWhen` 互斥，前端过滤之后一行上只会渲染其中一个。
	 */
	const superUser = isSuperUser(c);
	const on = (values: string[]) => ({ visibleWhen: { field: PENDING_FIELD, values } });
	const sendFields = [PENDING_IDS_FIELD];
	const approvalRowActions = PENDING_KINDS.flatMap((item) => [
		{ key: WITHDRAW_ACTION, label: `撤销${item.label}`, confirm: item.withdraw, sendFields, ...on([`${item.kind}-mine`]) },
		...(canApprove ? [
			{ key: APPROVE_ACTION, label: `批准${item.label}`, confirm: item.approve, sendFields, ...on(superUser ? [`${item.kind}-other`, `${item.kind}-mine`] : [`${item.kind}-other`]) },
			{ key: REJECT_ACTION, label: `驳回${item.label}`, confirm: item.reject, sendFields, ...on([`${item.kind}-other`]) },
		] : []),
	]);
	return {
		...payload,
		table: {
			...source,
			dataSource: marked,
			option: {
				...optionSource,
				actions: {
					...actions,
					/**
					 * 有申请在排队的行收起那些会发出**另一种动作**的按钮。
					 *
					 * 编辑发的是「修改」，挂着的也是修改时它可以留着（重新提交等于重说一遍，
					 * 照旧覆盖）；删除与恢复发的是别的动作，只在这一行干干净净时出现。
					 * 已经自带 visibleWhen 的动作不碰——那是路由自己的判定，覆盖掉会把语义弄丢。
					 */
					row: [
						...rowActions.map((action) => {
							const item = action as Record<string, unknown>;
							const key = String(item.key ?? '');
							if (item.visibleWhen || !['edit', 'delete', 'restore'].includes(key)) return action;
							return { ...item, visibleWhen: { field: PENDING_FIELD, values: key === 'edit' ? EDIT_ACTION_VALUES : IDLE_ACTION_VALUES } };
						}),
						...approvalRowActions,
					],
				},
			},
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
							{ key: 'restore', label: '还原选中记录', confirm: '确认还原选中的记录吗？', selection: true },
							{ key: 'purge', label: '彻底删除选中记录', confirm: '彻底删除后无法恢复，确认继续吗？', selection: true },
						],
						row: [
							{ key: 'restore', label: '还原', confirm: '确认还原这条记录吗？' },
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

/** 有权跳过审批的角色，与 §9 的回滚权限一致。 */

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
	const fill = (target: Record<string, unknown>) => ({ changeControl: target.changeControl ?? changeControl });
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
	const utilityPayload = withChangeControl(c, withSortableColumns(c, await withPendingApproval(c, withTableUtilities(c, payload))));
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

import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';
import { allSql, firstSql, isUniqueViolation, ownerScope, sql } from '@server/database/sql.mjs';
import { PendingApprovalError, runOperation, runOperationSql } from '@server/modules/base/operation.mjs';
import { getChangedFields } from '@server/modules/base/changed-fields.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';
import { enabledDisabledOptions, statusValues } from '@shared/types/status.mjs';
import { randomToken, sha256 } from '@server/modules/passport/accounts/oidc.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';

/**
 * 生成器机器：允许运行 Shortcut 生成器的那几台 Mac。
 *
 * 生成 `.shortcut` 文件需要 macOS 本机的签名工具链，服务端代劳不了，因此必须有实体机器
 * 拿凭证来调 `/api/platform/*`（绑定文档 §4.10、§4.11）。这一页登记的就是它们。
 */

/**
 * **机器标识直接进对象键，因此必须限字符。**
 *
 * `shortcut-tokens.mts` 用它拼 `shortcuts/<name>/<日期>/...`，并靠 `startsWith` 判断
 * 「这个键属不属于这台机器」。放开 `/` 或 `.` 的话，一台机器就能把文件写进另一台的目录，
 * 甚至爬出 `shortcuts/` 前缀——而领取者拿到的令牌与短信都跟着走错人。
 */
const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

const columns = [
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const },
	{ dataIndex: 'created_at', title: '创建时间', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', form: { create: false as const, edit: false as const } },
	{ dataIndex: 'name', title: '机器标识', component: 'textbox' as const, maxLength: 64,
		placeholder: '如 mac-studio-01；小写字母、数字与连字符',
		// 改不得：它是对象键里的目录名，改了之后这台机器已经上传的文件全都对不上号。
		form: { edit: false as const },
		rules: [{ required: true, message: '请输入机器标识' }] },
	{ dataIndex: 'title', title: '名称', component: 'textbox' as const, placeholder: '给人看的名字，如「工作室那台 Mac Studio」',
		rules: [{ required: true, message: '请输入名称' }] },
	// 凭证只在生成的那一次给得出来，库里只有哈希。列表上摆前缀，是为了在几台机器之间认出
	// 「这份 .env 里的凭证是哪台的」——认得出，又不足以推出原文。
	{ dataIndex: 'secret_prefix', title: '凭证前缀', emptyText: '未生成', form: { create: false as const, edit: false as const } },
	{ dataIndex: 'reset_secret', title: '重置凭证', component: 'switch' as const, checkedValue: true, uncheckedValue: false,
		hideInTable: true, form: { create: false as const, edit: { title: '重置凭证' } },
		placeholder: '打开并保存后换发新凭证，旧凭证立即失效' },
	{ dataIndex: 'status', title: '状态', component: 'switch' as const, checkedValue: statusValues.enabled, uncheckedValue: statusValues.disabled, options: enabledDisabledOptions },
	{ dataIndex: 'last_used_at', title: '最近调用', dataType: 'js_timestamp' as const, dayjsFormat: 'YYYY-MM-DD HH:mm:ss', emptyText: '从未', form: { create: false as const, edit: false as const } }];

export const tableCrud: TableCrudDefinition = { table: 'sms_generator_machines', rowKey: 'id' };

const listColumns = {
	id: { column: 'id', cast: 'text' as const }, name: 'name', title: 'title',
	secret_prefix: 'secret_prefix', status: 'status',
	last_used_at: 'last_used_at', created_at: 'created_at', updated_at: 'updated_at',
} as const;

const publicMachine = (row: Record<string, unknown>) => ({
	id: row.id, name: row.name, title: row.title,
	secret_prefix: row.secret_prefix || null,
	// 开关的当前值永远是关：它表达的是「这次要不要换」，不是一个存下来的属性。
	reset_secret: false,
	status: row.status,
	last_used_at: Number(row.last_used_at ?? 0) || null,
	created_at: row.created_at,
});

/** 新凭证：明文只回这一次，库里存哈希与前缀。 */
const issueSecret = async () => {
	const secret = randomToken(32);
	return { secret, secret_hash: await sha256(secret), secret_prefix: secret.slice(0, 8) };
};

/**
 * 明文要穿过审批那一层。
 *
 * 记成待审批之后，`worker.mts` 的兜底会把任何非 202 的响应改写成「修改已提交审批」——
 * 那是对的（数据确实没动，回「已保存」就是撒谎），但它会连带把凭证一起吞掉，而凭证
 * **只有这一次机会**给到管理员。所以这里自己回 202：状态码已经是 202，兜底就不再改写。
 *
 * 被驳回的话这份凭证不会生效，管理员照着它配的机器调不通——文案里说清楚。
 */
const secretNotice = (c: Parameters<ApiHandler>[0], queued: boolean, secret: string, extra: Record<string, unknown> = {}) => apiMessageData(
	c,
	queued ? 202 : 201,
	queued
		? `凭证只显示这一次，请立即保存：\n\n${secret}\n\n这条登记已提交审批，通过后这台机器才能调用生成器接口；被驳回的话这份凭证不会生效。`
		: `凭证只显示这一次，请立即保存：\n\n${secret}`,
	{ secret, ...extra },
	{ component: 'modal', showIcon: true, title: '机器凭证' },
);

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');
	const tenantScope = () => ownerScope('owner_tid', c.get('tenantId'));

	if (c.req.method === 'GET' && !params.id) {
		const rows = await allSql<Record<string, unknown>>(database, sql({ database }).select({
			table: 'sms_generator_machines', columns: listColumns,
			sort: tableSort(c), orderBy: [{ column: 'id', direction: 'DESC' }],
		}));
		return apiResponse(c, 200, { table: {
			option: { rowKey: 'id', actions: {
				query: [{ key: 'search', label: '搜索' }],
				toolbar: [{ key: 'create', label: '新增' }, { key: 'delete', label: '删除' }],
				row: [{ key: 'edit', label: '编辑' }, { key: 'delete', label: '删除' }],
			} },
			columns, dataSource: rows.map(publicMachine), totalRecords: rows.length,
		} });
	}

	if (params.id && c.req.method === 'GET') {
		const row = await firstSql<Record<string, unknown>>(database, sql({ database }).select({
			table: 'sms_generator_machines', columns: listColumns, where: [{ column: 'id', value: params.id }],
		}));
		return row ? apiResponse(c, 200, publicMachine(row)) : apiMessage(c, 404, '机器不存在');
	}

	if (!params.id && c.req.method === 'POST') {
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const name = String(body.name ?? '').trim().toLowerCase();
		const title = String(body.title ?? '').trim();
		if (!namePattern.test(name)) return apiMessage(c, 400, '机器标识只能用小写字母、数字与连字符，且以字母或数字开头');
		if (!title) return apiMessage(c, 400, '请输入名称');
		/**
		 * 重名在**记录之前**挡掉：审批是先记录后应用，等 INSERT 撞唯一索引才失败的话，
		 * 队列里已经留下一条谁也批不动的申请（同 users.mts 那一处）。`queued: 'all'`
		 * 把还在排队的新机器也算进来——它已经把这个标识占住了。
		 */
		const taken = await firstSql<{ id: string }>(database, sql({ database, subjectRoles: null }).select({
			table: 'sms_generator_machines', columns: { id: { column: 'id', cast: 'text' } },
			where: [{ column: 'name', value: name }, tenantScope()], queued: 'all', limit: 1,
		}));
		if (taken) return apiMessage(c, 409, '机器标识已存在');
		const issued = await issueSecret();
		try {
			const operationId = crypto.randomUUID();
			await runOperationSql(c, database, sql({ database }).insert('sms_generator_machines', {
				name, title, secret_hash: issued.secret_hash, secret_prefix: issued.secret_prefix,
				status: String(body.status ?? statusValues.enabled),
			}), { operationId, defer: true });
			const pending = c.get('pendingApproval');
			return secretNotice(c, pending?.operationId === operationId, issued.secret, { name });
		} catch (error) {
			if (error instanceof PendingApprovalError) throw error;
			if (!isUniqueViolation(error)) throw error;
			return apiMessage(c, 409, '机器标识已存在');
		}
	}

	if (params.id && c.req.method === 'PUT') {
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const current = await firstSql<{ id: string }>(database, sql({ database }).select({
			table: 'sms_generator_machines', columns: { id: { column: 'id', cast: 'text' } }, where: [{ column: 'id', value: params.id }],
		}));
		if (!current) return apiMessage(c, 404, '机器不存在');
		const changed = getChangedFields(body, ['title', 'status', 'reset_secret']);
		const values: Record<string, unknown> = {};
		if (changed.has('title')) {
			const title = String(body.title ?? '').trim();
			if (!title) return apiMessage(c, 400, '请输入名称');
			values.title = title;
		}
		if (changed.has('status')) values.status = String(body.status ?? statusValues.enabled);
		const resetting = changed.has('reset_secret') && body.reset_secret === true;
		const issued = resetting ? await issueSecret() : undefined;
		if (issued) { values.secret_hash = issued.secret_hash; values.secret_prefix = issued.secret_prefix; }
		if (!Object.keys(values).length) return apiMessage(c, 400, '没有可修改的字段');
		const operationId = crypto.randomUUID();
		await runOperation(c, database, [sql({ database }).update('sms_generator_machines', values, { id: params.id })], { operationId, defer: true });
		const queued = c.get('pendingApproval')?.operationId === operationId;
		if (issued) return secretNotice(c, queued, issued.secret);
		if (queued) throw new PendingApprovalError(operationId, c.get('pendingApproval')?.entries ?? 1);
		return apiMessage(c, 200, '机器已保存');
	}

	if (c.req.method === 'DELETE') {
		const body = await c.req.json<unknown>().catch(() => []);
		const ids = params.id ? [params.id] : (Array.isArray(body) ? body.map((value) => String(value)).filter(Boolean) : []);
		if (!ids.length) return apiMessage(c, 400, '请选择要删除的机器');
		for (const id of ids) await runOperationSql(c, database, sql({ database }).softDelete('sms_generator_machines', { id }));
		return apiMessage(c, 200, '删除成功，可在回收站找回或彻底删除');
	}

	return next();
};

export const acceptsTrailingParams = true;
export default handler;

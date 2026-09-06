import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';
import type { DatabaseAdapter } from '@server/database/index.mjs';
import { getCloudStorageProduct } from '@server/modules/global/cloud/catalog.mjs';
import { enabledDisabledOptions, statusValues } from '@shared/types/status.mjs';
import type { TableCrudDefinition } from '@server/modules/base/table-crud.mjs';
import { getChangedFields } from '@server/modules/base/changed-fields.mjs';
import { allSql, firstSql, sql } from '@server/database/sql.mjs';
import { PendingApprovalError, runOperationSql } from '@server/modules/base/operation.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';

export const tableCrud: TableCrudDefinition = { table: 'global_cloud_object_storage_bindings', rowKey: 'id' };

/**
 * 站点与 Bucket 的绑定：这个站点的这几种用途，文件存到哪个 Bucket。
 *
 * **用途是绑定行上的一个字段，不是子表。** 早先它是子表（一个用途一行），代价是勾四个
 * 用途会变成四条独立的申请、要批四次；用途没变时绑定行本身没有变化，「待审批」标记挂不
 * 上去，提交完在列表上什么也看不出来；而编辑时"先全删再全插"那一步会把上一轮还在排队的
 * 子表行物理删掉，留下批不了也撤不掉的孤儿申请。收回字段之后，改一次就是一条 update。
 */
const purposes = [
	{ value: 'uploads', text: '上传文件' },
	{ value: 'avatars', text: '头像' },
	{ value: 'attachments', text: '附件' },
	{ value: 'backups', text: '备份' },
	{ value: 'exports', text: '导出文件' },
	// SMS 生成器把 .shortcut 文件传到这里，用户凭令牌来领（绑定文档 §5）。
	{ value: 'sms-shortcut', text: 'SMS 快捷指令文件' },
];
const allowedPurposes = new Set(purposes.map((item) => item.value));

const columns = [
	{ dataIndex: 'id', title: 'ID', dataType: 'int' as const },
	{ dataIndex: 'site_key', title: '站点', component: 'select', rules: [{ required: true, message: '请选择站点' }] },
	{ dataIndex: 'bucket_id', title: 'Bucket', component: 'select', rules: [{ required: true, message: '请选择 Bucket' }] },
	{ dataIndex: 'purposes', title: '用途', component: 'select', multiple: true, options: purposes, rules: [{ required: true, message: '请至少选择一个用途' }] },
	{ dataIndex: 'key_prefix', title: '对象前缀', component: 'textbox', placeholder: '例如 site1/uploads/' },
	{ dataIndex: 'status', title: '状态', component: 'switch', checkedValue: statusValues.enabled, uncheckedValue: statusValues.disabled, options: enabledDisabledOptions },
];

const parseBody = async (c: Parameters<ApiHandler>[0]): Promise<Record<string, unknown>> => c.req.json<Record<string, unknown>>().catch(() => ({}));
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const prefix = (value: unknown) => {
	const raw = text(value).replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
	return raw ? `${raw}/` : '';
};

/** 收进来的用途：去重、只留白名单内的。存进库的就是这个数组（JSON），与 `roles` 同一套做法。 */
const parsePurposes = (value: unknown) => {
	const source = typeof value === 'string' && value.trim().startsWith('[')
		? (() => { try { return JSON.parse(value) as unknown; } catch { return []; } })()
		: value;
	const values = Array.isArray(source) ? source : typeof source === 'string' && source ? [source] : [];
	return [...new Set(values.map(text).filter((item) => allowedPurposes.has(item)))];
};

/**
 * 同一站点的同一用途只能绑一个 Bucket——否则「这个站点的头像存哪」就有两个答案，
 * 而 `loadCloudStorageTargetByPurpose` 只取第一条，取到哪个全看排序。
 *
 * **`queued: 'all'`**：还在排队等审批的绑定也把用途占住了。不算它的话，两条申请可以
 * 各自通过校验，批准之后就并存了两个答案——而那时已经没有哪一步会再检查。
 */
const conflictingPurposes = async (database: DatabaseAdapter, siteKey: string, selected: string[], excludeId?: number) => {
	const rows = await allSql<{ id: string; purposes: unknown }>(database, sql({ database }).select({
		table: 'global_cloud_object_storage_bindings',
		columns: { id: { column: 'id', cast: 'text' }, purposes: 'purposes' },
		where: [
			{ column: 'site_key', value: siteKey },
			...(excludeId === undefined ? [] : [{ column: 'id', operator: '!=' as const, value: excludeId }]),
		],
		queued: 'all',
	}));
	for (const row of rows) {
		const taken = parsePurposes(row.purposes).filter((purpose) => selected.includes(purpose));
		if (taken.length) return { id: String(row.id), purposes: taken };
	}
	return undefined;
};

const validateTarget = async (database: DatabaseAdapter, siteKey: string, bucketId: number) => {
	const [site, bucket] = await Promise.all([
		firstSql(database, sql({ database }).select({ table: 'global_sites', columns: { site_key: 'key' }, where: [{ column: 'key', value: siteKey }, { column: 'status', value: 'enabled' }, { column: 'migration_status', value: 'ready' }] })),
		firstSql(database, sql({ database }).select({ table: 'global_cloud_object_storage_buckets', columns: { id: 'id' }, where: [{ column: 'id', value: bucketId }, { column: 'status', value: 'enabled' }] })),
	]);
	return Boolean(site && bucket);
};

const purposeLabel = (value: string) => purposes.find((item) => item.value === value)?.text ?? value;

const handler: ApiHandler = async (c, next, params) => {
	const database = c.get('database');
	const listOptions = async () => {
		const [sites, buckets] = await Promise.all([
			allSql<{ site_key: string; title: string }>(database, sql({ database }).select({ table: 'global_sites', columns: { site_key: 'key', title: 'title' }, where: [{ column: 'status', value: 'enabled' }, { column: 'migration_status', value: 'ready' }], orderBy: [{ column: 'key' }] })),
			allSql<{ id: number; bucket: string; credential_title: string; provider: string }>(database, sql({ database }).select({ table: 'global_cloud_object_storage_buckets', alias: 'b', columns: { id: 'b.id', bucket: 'b.bucket', credential_title: 'c.title', provider: 'c.provider' }, joins: [{ table: 'global_cloud_credentials', alias: 'c', left: 'c.id', right: 'b.cloud_credential_id' }], where: [{ column: 'b.status', value: 'enabled' }, { column: 'c.status', value: 'enabled' }], orderBy: [{ column: 'c.title' }, { column: 'b.bucket' }] })),
		]);
		return {
			sites: sites.map((item) => ({ value: item.site_key, text: `${item.title} (${item.site_key})` })),
			buckets: buckets.map((item) => ({ value: String(item.id), text: `${item.credential_title} / ${getCloudStorageProduct(item.provider)} / ${item.bucket}` })),
		};
	};
	const listColumns = {
		id: 'b.id', site_key: 'b.site_key', site_title: 's.title', bucket_id: 'b.bucket_id', bucket: 'bkt.bucket',
		credential_title: 'c.title', provider: 'c.provider', purposes: 'b.purposes', key_prefix: 'b.key_prefix',
		status: 'b.status', created_at: 'b.created_at', updated_at: 'b.updated_at',
	} as const;
	const listJoins = [
		{ table: 'global_sites', alias: 's', left: 's.key', right: 'b.site_key' },
		{ table: 'global_cloud_object_storage_buckets', alias: 'bkt', left: 'bkt.id', right: 'b.bucket_id' },
		{ table: 'global_cloud_credentials', alias: 'c', left: 'c.id', right: 'bkt.cloud_credential_id' },
	];
	const publicBinding = (row: Record<string, unknown>) => ({ ...row, product: getCloudStorageProduct(String(row.provider)), purposes: parsePurposes(row.purposes) });

	if (!params.id && c.req.method === 'GET') {
		const [rows, options] = await Promise.all([
			allSql<Record<string, unknown>>(database, sql({ database }).select({ table: 'global_cloud_object_storage_bindings', alias: 'b', columns: listColumns, joins: listJoins, sort: tableSort(c), orderBy: [{ column: 'b.id', direction: 'DESC' }] })),
			listOptions(),
		]);
		const tableColumns = columns.map((column) => column.dataIndex === 'site_key' ? { ...column, options: options.sites }
			: column.dataIndex === 'bucket_id' ? { ...column, options: options.buckets } : column);
		const dataSource = rows.map(publicBinding);
		return apiResponse(c, 200, { table: { option: { rowKey: 'id', actions: { query: [{ key: 'search', label: '搜索' }], toolbar: [{ key: 'create', label: '新增' }, { key: 'delete', label: '删除' }], row: [{ key: 'edit', label: '编辑' }, { key: 'delete', label: '删除' }] } }, columns: tableColumns, dataSource, totalRecords: dataSource.length } });
	}

	if (params.id && c.req.method === 'GET') {
		const row = await firstSql<Record<string, unknown>>(database, sql({ database }).select({ table: 'global_cloud_object_storage_bindings', alias: 'b', columns: listColumns, joins: listJoins, where: [{ column: 'b.id', value: Number(params.id) }] }));
		return row ? apiResponse(c, 200, publicBinding(row)) : apiMessage(c, 404, 'Bucket 绑定不存在');
	}

	if (!params.id && c.req.method === 'POST') {
		const body = await parseBody(c);
		const siteKey = text(body.site_key), bucketId = Number(body.bucket_id), selected = parsePurposes(body.purposes);
		const keyPrefix = prefix(body.key_prefix), status = body.status === statusValues.disabled ? statusValues.disabled : statusValues.enabled;
		if (!siteKey || !Number.isInteger(bucketId) || !selected.length || !await validateTarget(database, siteKey, bucketId)) return apiMessage(c, 400, '站点、Bucket 或用途不合法');
		const conflict = await conflictingPurposes(database, siteKey, selected);
		if (conflict) return apiMessage(c, 409, `用途「${conflict.purposes.map(purposeLabel).join('、')}」在这个站点已经绑到 #${conflict.id}，同一用途只能绑一个 Bucket`);
		try {
			await runOperationSql(c, database, sql({ database }).insert('global_cloud_object_storage_bindings', { site_key: siteKey, bucket_id: bucketId, purposes: selected, key_prefix: keyPrefix, status }));
		} catch (error) {
			if (error instanceof PendingApprovalError) throw error;
			return apiMessage(c, 400, error instanceof Error ? error.message : '创建绑定失败');
		}
		return apiMessageData(c, 201, 'Bucket 绑定创建成功', {});
	}

	if (!params.id && c.req.method === 'DELETE') {
		const ids = await c.req.json<unknown>().catch(() => []);
		for (const id of Array.isArray(ids) ? ids : []) await runOperationSql(c, database, sql({ database }).softDelete('global_cloud_object_storage_bindings', { id: Number(id) }));
		return apiMessage(c, 200, '删除成功，可在回收站找回或彻底删除');
	}

	if (params.id && c.req.method === 'PUT') {
		const current = await firstSql<Record<string, unknown>>(database, sql({ database }).select({ table: 'global_cloud_object_storage_bindings', where: [{ column: 'id', value: Number(params.id) }] }));
		if (!current) return apiMessage(c, 404, 'Bucket 绑定不存在');
		const body = await parseBody(c);
		const changed = getChangedFields(body, ['site_key', 'bucket_id', 'purposes', 'key_prefix', 'status']);
		const siteKey = changed.has('site_key') ? text(body.site_key) : String(current.site_key);
		const bucketId = changed.has('bucket_id') ? Number(body.bucket_id) : Number(current.bucket_id);
		const selected = changed.has('purposes') ? parsePurposes(body.purposes) : parsePurposes(current.purposes);
		const keyPrefix = changed.has('key_prefix') ? prefix(body.key_prefix) : String(current.key_prefix);
		const status = changed.has('status') && body.status === statusValues.disabled ? statusValues.disabled : changed.has('status') ? statusValues.enabled : String(current.status);
		if (!siteKey || !Number.isInteger(bucketId) || !selected.length || !await validateTarget(database, siteKey, bucketId)) return apiMessage(c, 400, '站点、Bucket 或用途不合法');
		const duplicate = await firstSql(database, sql({ database }).select({ table: 'global_cloud_object_storage_bindings', columns: { id: 'id' }, where: [{ column: 'site_key', value: siteKey }, { column: 'bucket_id', value: bucketId }, { column: 'key_prefix', value: keyPrefix }, { column: 'id', operator: '!=', value: Number(params.id) }] }));
		if (duplicate) return apiMessage(c, 409, '相同站点、Bucket 和对象前缀的绑定已存在');
		const conflict = await conflictingPurposes(database, siteKey, selected, Number(params.id));
		if (conflict) return apiMessage(c, 409, `用途「${conflict.purposes.map(purposeLabel).join('、')}」在这个站点已经绑到 #${conflict.id}，同一用途只能绑一个 Bucket`);
		try {
			await runOperationSql(c, database, sql({ database }).update('global_cloud_object_storage_bindings', { site_key: siteKey, bucket_id: bucketId, purposes: selected, key_prefix: keyPrefix, status }, { id: Number(params.id) }));
		} catch (error) {
			if (error instanceof PendingApprovalError) throw error;
			return apiMessage(c, 400, error instanceof Error ? error.message : '保存绑定失败');
		}
		return apiMessage(c, 200, '保存成功');
	}

	if (params.id && c.req.method === 'DELETE') {
		await runOperationSql(c, database, sql({ database }).softDelete('global_cloud_object_storage_bindings', { id: Number(params.id) }));
		return apiMessage(c, 200, '删除成功，可在回收站找回或彻底删除');
	}
	return next();
};

export const acceptsTrailingParams = true;
export default handler;

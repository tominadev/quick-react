import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';
import { getCloudStorageProduct } from '@server/modules/global/cloud/catalog.mjs';
import { createCloudStorageAdapter, loadCloudStorageTarget } from '@server/modules/global/cloud/resolve.mjs';
import { allSql, sql } from '@server/database/sql.mjs';
import { tableSort } from '@server/modules/base/query-options.mjs';

const parseBody = async (c: Parameters<ApiHandler>[0]): Promise<Record<string, unknown>> => c.req.json<Record<string, unknown>>().catch(() => ({}));
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const MAX_SINGLE_UPLOAD_SIZE = 5 * 1024 ** 3;
const safeRelativeKey = (value: unknown) => {
	const key = text(value).replace(/^\/+/, '');
	return key && !key.split('/').includes('..') ? key : '';
};
const safeRelativePrefix = (value: unknown) => {
	const valueText = text(value).replace(/^\/+/, '');
	return !valueText.split('/').includes('..') ? valueText : '';
};
const bindingOptions = async (database: Parameters<typeof loadCloudStorageTarget>[0]) => {
	// 用途是绑定行上的 JSON 数组，一行就是一个绑定——不再按子表 JOIN 出多行再合并回来。
	const rows = await allSql<{ id: number; site_key: string; site_title: string; bucket: string; credential_title: string; provider: string; purposes: unknown }>(database, sql({ database }).select({ table: 'global_cloud_object_storage_bindings', alias: 'b', columns: { id: 'b.id', site_key: 'b.site_key', site_title: 's.title', bucket: 'bkt.bucket', credential_title: 'c.title', provider: 'c.provider', purposes: 'b.purposes' }, joins: [{ table: 'global_sites', alias: 's', left: 's.key', right: 'b.site_key' }, { table: 'global_cloud_object_storage_buckets', alias: 'bkt', left: 'bkt.id', right: 'b.bucket_id' }, { table: 'global_cloud_credentials', alias: 'c', left: 'c.id', right: 'bkt.cloud_credential_id' }], where: [{ column: 'b.status', value: 'enabled' }, { column: 'bkt.status', value: 'enabled' }, { column: 'c.status', value: 'enabled' }], orderBy: [{ column: 's.key' }, { column: 'b.id' }] }));
	return rows.map((row) => {
		const list = (() => { try { const parsed: unknown = JSON.parse(String(row.purposes ?? '[]')); return Array.isArray(parsed) ? parsed.map((item) => String(item)) : []; } catch { return []; } })();
		return { value: String(row.id), text: `${row.site_title} (${row.site_key}) / ${list.join('、')} / ${row.credential_title} / ${getCloudStorageProduct(row.provider)} / ${row.bucket}` };
	});
};

/**
 * 列的定义**不依赖选了哪个绑定**，因此没选的时候也要照常下发。
 *
 * 早先没选绑定时回的是 `columns: []`，而前端只在**第一次**响应里取结构、之后只请求数据
 * （`include=data`）——那个空结构被缓存下来，选定绑定之后再也没机会替换，页面上就只剩
 * 一列复选框，文件名、大小、时间全都不显示。
 */
const objectColumns = [
	{ dataIndex: 'name', title: '名称' },
	{ dataIndex: 'size', title: '大小', dataType: 'int' as const },
	{ dataIndex: 'lastModified', title: '最后修改', emptyText: '—' },
	{ dataIndex: 'etag', title: 'ETag', emptyText: '—' },
];

const handler: ApiHandler = async (c, next) => {
	const database = c.get('database');
	const bindingId = Number(c.req.query('binding_id'));
	const options = await bindingOptions(database);
	const queryFields = [
		{ dataIndex: 'binding_id', label: '站点 Bucket 绑定', component: 'select' as const, options, defaultValue: options[0]?.value },
		{ dataIndex: 'prefix', label: '对象前缀', component: 'textbox' as const, placeholder: '可选' },
	];
	/**
	 * **两个分支必须下发同一份 option。**
	 *
	 * 结构只在第一次响应里给（`include=schema,data`），之后前端只请求数据，响应层会把
	 * `option` 整个剥掉——那时再补动作已经没有机会了。而第一次请求必然还没带 `binding_id`：
	 * 它的默认值就在前端即将收到的这份结构里。于是「还没选绑定」那一支下发什么，就是这一页
	 * 从头到尾用的全部动作；少一个 toolbar，上传按钮就再也不会出现，行上的进入/下载/删除
	 * 同理。columns 早先栽的是同一个跟头，动作这边当时没跟着一起补。
	 */
	const tableOption = {
		rowKey: 'key',
		queryFields,
		actions: {
			query: [{ key: 'search', label: '查询' }],
			toolbar: [{ key: 'upload', label: '上传' }],
			row: [
				// 目录只能进，文件才谈得上下载与删除；一行上永远只出现其中一组。
				{ key: 'enter', label: '进入', applyQueryFields: { prefix: 'relative_key' }, visibleWhen: { field: 'is_prefix', values: ['1'] } },
				{ key: 'download', label: '下载', visibleWhen: { field: 'is_prefix', values: ['0'] } },
				{ key: 'delete', label: '删除', confirm: '确认删除对象吗？', visibleWhen: { field: 'is_prefix', values: ['0'] } },
			],
		},
	};
	if (c.req.method === 'GET') {
		if (!Number.isInteger(bindingId) || bindingId <= 0) return apiResponse(c, 200, { table: { option: tableOption, columns: objectColumns, dataSource: [], totalRecords: 0 } });
		const target = await loadCloudStorageTarget(database, bindingId);
		if (!target) return apiMessage(c, 404, 'Bucket 绑定不存在或已停用');
		try {
			const limit = Math.min(100, Math.max(1, Number(c.req.query('pageSize')) || 10));
			/**
			 * **按目录浏览，不是把整个 Bucket 扁平列出来。**
			 *
			 * `delimiter` 让 S3 把同一层的对象折成 `CommonPrefixes` 返回，那才是「目录」。
			 * 不传的话拿回来的是一长串带完整路径的 key（`shortcuts/mac-studio-01/20260906/…`），
			 * 一层也点不进去——解析 `CommonPrefixes` 的代码一直都在，只是从来没有东西可解析。
			 */
			const relativePrefix = safeRelativePrefix(c.req.query('prefix'));
			const fullPrefix = `${target.key_prefix ?? ''}${relativePrefix}`;
			const page = await createCloudStorageAdapter(target).list(fullPrefix, text(c.req.query('cursor')) || undefined, limit, '/');
			const rows = page.objects.map((item) => ({
				...item,
				// 显示相对当前目录的那一段：整串完整路径在窄屏上根本读不出差别。
				name: String(item.key).slice(fullPrefix.length) || String(item.key),
				// 「进入」要填回 prefix 查询字段，而那个字段是**相对绑定前缀**的。
				relative_key: String(item.key).slice((target.key_prefix ?? '').length),
				is_prefix: item.isPrefix ? '1' : '0',
			}));
			// 不在根目录时补一行「..」：目录导航要能退回去，而清空输入框不是所有人都想得到。
			const parent = relativePrefix ? { key: `${fullPrefix}..`, name: '..', relative_key: relativePrefix.replace(/[^/]*\/?$/, ''), size: 0, is_prefix: '1' } : undefined;
			const dataSource = parent ? [parent, ...rows] : rows;
			return apiResponse(c, 200, { table: { option: tableOption, columns: objectColumns, dataSource, totalRecords: dataSource.length, nextCursor: page.nextToken, hasMore: page.hasMore } });
		} catch (error) { return apiMessage(c, 502, error instanceof Error ? error.message : '对象列表读取失败'); }
	}
	if (!Number.isInteger(bindingId) || bindingId <= 0) return apiMessage(c, 400, '请选择站点 Bucket 绑定');
	const target = await loadCloudStorageTarget(database, bindingId);
	if (!target) return apiMessage(c, 404, 'Bucket 绑定不存在或已停用');
	const adapter = createCloudStorageAdapter(target);
	if (c.req.method === 'POST') {
		const body = await parseBody(c);
		const relativeKey = safeRelativeKey(body.key);
		const size = Number(body.size);
		const queryPrefix = safeRelativeKey(c.req.query('prefix'));
		const key = `${target.key_prefix ?? ''}${queryPrefix ? `${queryPrefix.replace(/\/+$/, '')}/` : ''}${relativeKey}`;
		if (!relativeKey) return apiMessage(c, 400, '对象 Key 不合法');
		if (Number.isFinite(size) && size > MAX_SINGLE_UPLOAD_SIZE) return apiMessage(c, 400, '当前单次直传最大支持 5GB，更大的文件需要分块上传');
		try { return apiResponse(c, 200, { uploadUrl: await adapter.createUploadUrl(key, text(body.content_type) || undefined), key }); }
		catch (error) { return apiMessage(c, 502, error instanceof Error ? error.message : '上传地址创建失败'); }
	}
	if (c.req.method === 'DELETE') {
		const body = await c.req.json<unknown>().catch(() => []);
		const keys = Array.isArray(body) ? body.map(String) : [text((body as Record<string, unknown>)?.key)];
		const allowedKeys = keys.filter((key) => key && !key.split('/').includes('..') && key.startsWith(target.key_prefix ?? ''));
		if (allowedKeys.length !== keys.filter(Boolean).length) return apiMessage(c, 400, '对象 Key 超出绑定范围');
		try { for (const key of allowedKeys) await adapter.deleteObject(key); }
		catch (error) { return apiMessage(c, 502, error instanceof Error ? error.message : '对象删除失败'); }
		return apiMessage(c, 200, '删除成功');
	}
	if (c.req.method === 'PUT') {
		const key = text(c.req.query('key'));
		if (!key || key.split('/').includes('..') || !key.startsWith(target.key_prefix ?? '')) return apiMessage(c, 400, '对象 Key 超出绑定范围');
		try { return apiMessageData(c, 200, '下载地址创建成功', { downloadUrl: await adapter.createDownloadUrl(key), key }); }
		catch (error) { return apiMessage(c, 502, error instanceof Error ? error.message : '下载地址创建失败'); }
	}
	return next();
};

export default handler;

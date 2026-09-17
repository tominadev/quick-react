import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Checkbox, DotLoading, Empty, InfiniteScroll, Input, ProgressBar, Selector, Space, Tag } from 'antd-mobile';
import type { CommonApi, DataType, ResJSON, ResJsonTableColumn, ResJsonTableOption } from '@clients/browser/api.js';
import type { TableAction, TableColumn, TableQueryField } from '@shared/types/table.mjs';
import { actionVisibleForRow, formatBytes, rowConfirmText, tableRequestQuery, withoutControlFields } from '@clients/browser/table-crud.js';
import { describeFormAdditions, describeFormChanges } from '@clients/browser/form-changes.js';
import { applyApiResponseContext, runApiNextAction } from '@clients/browser/response-action.js';
import { changeControlHeaders, resolveTableFormColumns } from '@shared/table-form.mjs';
import MobileTableForm from './MobileTableForm.js';

/**
 * 表格的手机版渲染：一行一张卡片，而不是横着摆十几列。
 *
 * **协议照搬桌面版**——`tableRequestQuery` 算 include 与分页参数、`actionVisibleForRow`
 * 决定哪个动作对这一行可见、确认文案里的 `{列名}` 由 `rowConfirmText` 替换、改了什么由
 * `describeFormChanges` 念成人话、做完之后去哪由服务端的 `next` 说了算。这些规则来自
 * `@clients/browser/*` 与 `@shared/*`，两套 UI 共用同一份实现：各写一遍的话，同一个后端
 * 会在两个前端上表现不同，而那种漂移要等用户报障才发现。
 *
 * 渲染上的取舍是手机自己的：窄屏放不下十几列，因此第一列做标题、其余做「名称：值」，
 * 翻页换成下拉加载——手机上没人点页码；表单从底部推上来而不是从右侧滑出。
 *
 * **动作一个都不能私自吞掉。** 这一层只把后端声明的动作映射成控件：认不出 key 的按
 * `selection` / `form` / `modalPath` 依次回落，最后一律当成「POST 一下」的简单动作。
 * 早先这里把 `edit`、带表单的和带弹窗的动作直接过滤掉了，后端明明下发了，手机上就是
 * 没有那个按钮，而且不报任何错——对象存储的「上传」也是这样消失的（见架构文档
 * 「表格结构只有第一帧那一次机会」）。
 */
const suffix = (window as Window & { __INITIAL_DATA__?: { apiSuffix?: string } }).__INITIAL_DATA__?.apiSuffix ?? '';
const PAGE_SIZE = 20;

const cellText = (value: unknown, column: ResJsonTableColumn) => {
	if (value === null || value === undefined || value === '') return column.emptyText ?? '';
	if (column.dataType === 'js_timestamp') return new Date(Number(value)).toLocaleString();
	if (Array.isArray(value)) return value.join('、');
	const option = column.options?.find((item) => String(item.value) === String(value));
	return option ? option.text : String(value);
};

/** 查询字段的默认值由服务端给，并且**只在第一次拿到结构时**填进去，之后以用户填的为准。 */
const queryDefaults = (fields: TableQueryField[] | undefined) => Object.fromEntries(
	(fields ?? []).filter((field) => field.defaultValue !== undefined).map((field) => [field.dataIndex, String(field.defaultValue)]),
);

type FormState = {
	title: string;
	columns: TableColumn[];
	initialValues?: DataType;
	submitLabel: string;
	submit: (values: Record<string, unknown>) => Promise<void>;
};

type UploadState = { fileName: string; percent: number; phase: 'signing' | 'uploading' | 'success' | 'error'; message?: string };

const MobileTable = ({ commonApi, resourcePath, title }: { commonApi: CommonApi; resourcePath: string; title?: string }) => {
	const [columns, setColumns] = useState<ResJsonTableColumn[]>([]);
	const [option, setOption] = useState<ResJsonTableOption>({ rowKey: 'id' });
	const [rows, setRows] = useState<DataType[]>([]);
	const [hasMore, setHasMore] = useState(true);
	// 编辑中的查询值与已生效的分开：只有点了后端下发的查询动作才应用，边填边查会把
	// 一个填了一半的条件发出去。
	const [draftQuery, setDraftQuery] = useState<Record<string, string>>({});
	const [appliedQuery, setAppliedQuery] = useState<Record<string, string>>({});
	const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
	const [formState, setFormState] = useState<FormState>();
	const [submitting, setSubmitting] = useState(false);
	const [uploadState, setUploadState] = useState<UploadState>();
	const [reloadToken, setReloadToken] = useState(0);
	const pageRef = useRef(1);
	const schemaLoadedRef = useRef(false);
	const loadingRef = useRef(false);
	const appliedRef = useRef<Record<string, string>>({});
	const allColumnsRef = useRef<ResJsonTableColumn[]>([]);
	const optionRef = useRef<ResJsonTableOption>({ rowKey: 'id' });
	const apiPath = `/api${resourcePath}${suffix}`;

	// 增删改也要带上当前查询条件：对象存储那种「当前在哪个目录」就藏在查询条件里，
	// 不带的话新增会落到根目录去。与桌面版的 selectedQuerySuffix 同一条规则。
	const querySuffix = () => {
		const entries = Object.entries(appliedRef.current).filter(([, value]) => value !== undefined && value !== null && value !== '');
		return entries.length ? `?${new URLSearchParams(Object.fromEntries(entries))}` : '';
	};

	const reload = useCallback(() => {
		pageRef.current = 1;
		setRows([]);
		setSelectedKeys([]);
		setHasMore(true);
		setReloadToken((token) => token + 1);
	}, []);

	const fetchPage = useCallback(async () => {
		const query = tableRequestQuery({ page: pageRef.current, pageSize: PAGE_SIZE, queryValues: appliedRef.current, schemaLoaded: schemaLoadedRef.current });
		const response = await commonApi.apiFetch(`${apiPath}?${new URLSearchParams(query)}`);
		const body = await response.json() as ResJSON;
		const table = body.table;
		if (!table) { setHasMore(false); return; }
		if (table.columns) {
			allColumnsRef.current = table.columns;
			setColumns(table.columns.filter((column) => !column.hideInTable));
			schemaLoadedRef.current = true;
		}
		if (table.option) {
			optionRef.current = table.option;
			setOption(table.option);
			// 服务端给的默认值只在这里落一次。第一次请求必然还没带它们——默认值就在这一份
			// 结构里（见架构文档「表格结构只有第一帧那一次机会」），所以拿到之后要带着它们
			// 再查一次，否则这一页永远停在「参数还没到」的那一份数据上。
			const defaults = queryDefaults(table.option.queryFields);
			const missing = Object.entries(defaults).filter(([name]) => appliedRef.current[name] === undefined);
			if (missing.length) {
				const next = { ...appliedRef.current, ...Object.fromEntries(missing) };
				appliedRef.current = next;
				setAppliedQuery(next);
				setDraftQuery((previous) => ({ ...Object.fromEntries(missing), ...previous }));
				reload();
				return;
			}
		}
		const received = table.dataSource ?? [];
		setRows((previous) => pageRef.current === 1 ? received : [...previous, ...received]);
		// 服务端给了总数就按总数判，游标分页看 hasMore；两个都没有就按「这一页没满」收尾。
		const total = table.totalRecords;
		const loaded = (pageRef.current - 1) * PAGE_SIZE + received.length;
		setHasMore(table.hasMore ?? (total === undefined ? received.length >= PAGE_SIZE : loaded < total));
		pageRef.current += 1;
	}, [apiPath, commonApi, reload]);

	/**
	 * 第一页自己取，不等 InfiniteScroll。
	 *
	 * 下拉加载是**接着往下翻**的机制，第一屏不该依赖它：容器没滚动、或者一屏还没铺满时
	 * 它到底触不触发要看实现，而首屏取不到数据的表现就是一片空白。后续页仍由它驱动。
	 * loadingRef 挡住两边同时进来——重复一次就会把同一页数据追加两遍。
	 */
	const loadMore = useCallback(async () => {
		if (loadingRef.current) return;
		loadingRef.current = true;
		try { await fetchPage(); } finally { loadingRef.current = false; }
	}, [fetchPage]);

	useEffect(() => { void loadMore(); }, [reloadToken, loadMore]);

	useEffect(() => {
		pageRef.current = 1;
		schemaLoadedRef.current = false;
		appliedRef.current = {};
		setAppliedQuery({});
		setDraftQuery({});
		setRows([]);
		setSelectedKeys([]);
		setHasMore(true);
		setReloadToken((token) => token + 1);
	}, [apiPath]);

	/**
	 * 应用查询条件。带 `reloadSchema` 的字段变了要连结构一起重取——结构本来就随它变化，
	 * 沿用旧的会把上一张表的动作留在新表上。
	 */
	const applyQuery = (next: Record<string, string>) => {
		const fields = optionRef.current.queryFields ?? [];
		if (fields.some((field) => field.reloadSchema && next[field.dataIndex] !== appliedRef.current[field.dataIndex])) {
			schemaLoadedRef.current = false;
			setColumns([]);
			allColumnsRef.current = [];
		}
		appliedRef.current = next;
		setAppliedQuery(next);
		setDraftQuery(next);
		reload();
	};

	/** 要不要问「操作原因」由结构里的 changeControl 决定，与桌面版同一条规则。 */
	const confirmChange = async (lines: string[]) => {
		if (optionRef.current.changeControl) return commonApi.modalConfirmWithReason(lines);
		return await commonApi.modalConfirm(lines) ? { reason: '' } : undefined;
	};

	/**
	 * 做完之后干什么由服务端说了算：`next` 交给统一协议执行器，没有 `next` 才自己刷新。
	 * 这里不按接口路径或返回内容去猜该跳哪——猜出来的那一套每加一个动作都要回来改。
	 */
	const afterMutation = async (response: Response) => {
		const body = await response.json().catch(() => undefined) as { next?: Parameters<typeof runApiNextAction>[0]; context?: Parameters<typeof applyApiResponseContext>[0] } | undefined;
		if (body?.next) { runApiNextAction(body.next, body.context); return; }
		applyApiResponseContext(body?.context);
		reload();
	};

	const send = async (url: string, init: RequestInit) => {
		setSubmitting(true);
		try {
			const response = await commonApi.apiFetch(url, init);
			if (!response.ok) return false;
			await afterMutation(response);
			return true;
		} catch { return false; }
		finally { setSubmitting(false); }
	};

	const openCreateForm = (action: TableAction) => {
		const createColumns = resolveTableFormColumns(allColumnsRef.current as TableColumn[], 'create');
		setFormState({
			title: action.label,
			columns: createColumns,
			submitLabel: action.label,
			submit: async (values) => {
				const added = describeFormAdditions(createColumns.map((column) => ({
					name: column.dataIndex,
					label: column.title,
					options: column.options,
					...(column.inputType === 'password' ? { type: 'password' as const } : {}),
				})), values);
				const control = await confirmChange(added.length ? ['将新增以下内容，确认继续吗？', ...added] : ['当前没有填写任何内容，仍要新增吗？']);
				if (!control) return;
				const ok = await send(`${apiPath}${querySuffix()}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', ...changeControlHeaders(control) },
					body: JSON.stringify(withoutControlFields(values)),
				});
				if (ok) setFormState(undefined);
			},
		});
	};

	const openEditForm = async (action: TableAction, record: DataType) => {
		const rowId = String(record[optionRef.current.rowKey] ?? '');
		if (!rowId) return;
		const editColumns = resolveTableFormColumns(allColumnsRef.current as TableColumn[], 'edit');
		// 列表里的那一行可能是裁剪过的（隐藏列、计算列），编辑要按主键把整行取回来。
		const response = await commonApi.apiFetch(`${apiPath}/${encodeURIComponent(rowId)}${querySuffix()}`, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
		if (!response.ok) return;
		const row = await response.json() as DataType;
		setFormState({
			title: action.label,
			columns: editColumns,
			initialValues: row,
			submitLabel: action.label,
			submit: async (values) => {
				const changed = describeFormChanges(editColumns.map((column) => ({
					name: column.dataIndex,
					label: column.title,
					options: column.options,
					...(column.inputType === 'password' ? { type: 'password' as const } : {}),
				})), Object.keys(values), row as Record<string, unknown>, values);
				const control = await confirmChange(changed.length ? ['将修改以下内容，确认继续吗？', ...changed] : ['当前没有修改任何内容，仍要提交吗？']);
				if (!control) return;
				const ok = await send(`${apiPath}/${encodeURIComponent(rowId)}${querySuffix()}`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json', ...changeControlHeaders(control) },
					body: JSON.stringify(withoutControlFields(values)),
				});
				if (ok) setFormState(undefined);
			},
		});
	};

	const openActionForm = (action: TableAction, record?: DataType) => {
		const actionColumns = action.form?.columns ?? [];
		setFormState({
			title: action.label,
			columns: actionColumns,
			submitLabel: action.label,
			submit: async (values) => {
				const ids = record ? [String(record[optionRef.current.rowKey] ?? '')] : selectedKeys;
				const ok = await send(`${apiPath}?action=${encodeURIComponent(action.key)}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ ...withoutControlFields(values), ...(ids.length ? { ids } : {}) }),
				});
				if (ok) setFormState(undefined);
			},
		});
	};

	const deleteRows = async (ids: string[], confirmLines: string[]) => {
		const control = await confirmChange(confirmLines);
		if (!control) return;
		await send(`${apiPath}${querySuffix()}`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json', ...changeControlHeaders(control) },
			body: JSON.stringify(ids),
		});
	};

	/**
	 * 直传对象存储：后端只签地址，文件内容不经过它。进度靠 XHR，与桌面版同一条路径
	 * （`commonApi.uploadFile`）；签名成功不算上传成功，只有对象存储真的回了成功才算完。
	 */
	const startUpload = (action: TableAction) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			setUploadState({ fileName: file.name, percent: 0, phase: 'signing' });
			try {
				const response = await commonApi.apiFetch(`${apiPath}${querySuffix()}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ key: file.name, size: file.size }),
				});
				const result = await response.json() as { uploadUrl?: string };
				if (!result.uploadUrl) throw new Error('上传地址为空');
				setUploadState((previous) => previous && { ...previous, phase: 'uploading' });
				// 空 MIME 直传：只允许无附加 Header 的 Bucket CORS 规则也能过（见对象存储需求）。
				await commonApi.uploadFile(result.uploadUrl, file.slice(0, file.size, ''), {
					onProgress: (loaded, total) => setUploadState((previous) => previous && {
						...previous,
						percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
						message: `${formatBytes(loaded)} / ${formatBytes(total)}`,
					}),
				});
				setUploadState({ fileName: file.name, percent: 100, phase: 'success', message: '上传完成' });
				reload();
			} catch (error) {
				setUploadState((previous) => previous && { ...previous, phase: 'error', message: error instanceof Error ? error.message : '上传失败' });
			}
		};
		input.click();
		void action;
	};

	const runToolbarAction = async (action: TableAction) => {
		if (action.key === 'create') { openCreateForm(action); return; }
		if (action.key === 'upload') { startUpload(action); return; }
		if (action.form) { openActionForm(action); return; }
		if (action.key === 'delete') {
			if (!selectedKeys.length) { await commonApi.modalError(['请先选择记录']); return; }
			await deleteRows(selectedKeys, [action.confirm ?? `确定要删除选中的 ${selectedKeys.length} 条记录吗？`]);
			return;
		}
		if (action.selection) {
			if (!selectedKeys.length) { await commonApi.modalError(['请先选择记录']); return; }
			const control = await confirmChange([action.confirm ?? `确认对选中的 ${selectedKeys.length} 条记录执行「${action.label}」吗？`]);
			if (!control) return;
			await send(`${apiPath}?action=${encodeURIComponent(action.key)}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...changeControlHeaders(control) },
				body: JSON.stringify(selectedKeys),
			});
			return;
		}
		if (action.confirm) {
			const control = await confirmChange([action.confirm]);
			if (!control) return;
			await send(`${apiPath}?action=${encodeURIComponent(action.key)}`, { method: 'POST', headers: changeControlHeaders(control) });
			return;
		}
		await send(`${apiPath}?action=${encodeURIComponent(action.key)}`, { method: 'POST' });
	};

	const runRowAction = async (action: TableAction, record: DataType) => {
		const rowId = String(record[optionRef.current.rowKey] ?? '');
		// 目录导航就是换一个查询条件，不是另开页面：字段对应关系由服务端声明。
		if (action.applyQueryFields) {
			applyQuery({ ...appliedRef.current, ...Object.fromEntries(Object.entries(action.applyQueryFields).map(([field, column]) => [field, String(record[column] ?? '')])) });
			return;
		}
		if (action.key === 'edit') { await openEditForm(action, record); return; }
		if (action.form) { openActionForm(action, record); return; }
		if (action.key === 'delete') {
			await deleteRows([rowId], [action.confirm ? rowConfirmText(action.confirm, record) : `确定要删除 ${optionRef.current.rowKey} = ${rowId} 吗？`]);
			return;
		}
		if (action.key === 'download') {
			const query = new URLSearchParams({ ...appliedRef.current, key: rowId });
			const response = await commonApi.apiFetch(`${apiPath}?${query}`, { method: 'PUT' });
			const result = await response.json() as { downloadUrl?: string };
			if (result.downloadUrl) window.open(result.downloadUrl, '_blank', 'noopener,noreferrer');
			return;
		}
		if (action.confirm && !await commonApi.modalConfirm([rowConfirmText(action.confirm, record)])) return;
		await send(`${apiPath}?action=${encodeURIComponent(action.key)}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(action.sendFields ? [Object.fromEntries(action.sendFields.map((field) => [field, record[field]]))] : [rowId]),
		});
	};

	const toolbarActions = option.actions?.toolbar ?? [];
	const queryActions = option.actions?.query ?? [];
	const queryFields = option.queryFields ?? [];
	// 只要有一个动作作用于选中行，卡片上就出现勾选框；没有就不占那一格位置。
	const selectable = useMemo(() => toolbarActions.some((action) => action.selection || action.key === 'delete'), [toolbarActions]);
	const rowActions = (record: DataType) => (option.actions?.row ?? [])
		// 互斥动作按服务端声明的 visibleWhen 过滤：一行上只出现适用的那个。
		.filter((action) => actionVisibleForRow(action, record))
		// 弹窗里再开一张表手机上放不下，这一类先不显示；其余一律显示，不按 key 名挑。
		.filter((action) => action.modalComponent !== 'table');

	return (
		<div style={{ padding: 8 }}>
			{queryFields.length > 0 && (
				<Card style={{ marginBottom: 8 }}>
					<Space direction="vertical" style={{ width: '100%' }}>
						{queryFields.map((field) => (
							<div key={field.dataIndex}>
								<div style={{ color: '#999', fontSize: 12, marginBottom: 4 }}>{field.label}</div>
								{field.component === 'select'
									? <Selector
										columns={2}
										options={(field.options ?? []).map((item) => ({ label: item.text, value: String(item.value) }))}
										value={draftQuery[field.dataIndex] ? [draftQuery[field.dataIndex]] : []}
										onChange={(value) => setDraftQuery((previous) => ({ ...previous, [field.dataIndex]: value[0] ?? '' }))}
									/>
									: <Input
										placeholder={field.placeholder}
										value={draftQuery[field.dataIndex] ?? ''}
										onChange={(value) => setDraftQuery((previous) => ({ ...previous, [field.dataIndex]: value }))}
										clearable
									/>}
							</div>
						))}
						{queryActions.length > 0 && (
							<Space>
								{queryActions.map((action) => (
									<Button key={action.key} size="small" color="primary" disabled={action.disabled} onClick={() => applyQuery(draftQuery)}>{action.label}</Button>
								))}
							</Space>
						)}
					</Space>
				</Card>
			)}
			{toolbarActions.length > 0 && (
				<Space wrap style={{ marginBottom: 8 }}>
					{toolbarActions.map((action) => (
						<Button key={action.key} size="small" color={action.key === 'delete' ? 'danger' : 'primary'} disabled={action.disabled || submitting} onClick={() => void runToolbarAction(action)}>{action.label}</Button>
					))}
				</Space>
			)}
			{uploadState && (
				<Card style={{ marginBottom: 8 }}>
					<div style={{ fontSize: 13, marginBottom: 4 }}>{uploadState.fileName}</div>
					<ProgressBar percent={uploadState.percent} />
					<div style={{ fontSize: 12, color: uploadState.phase === 'error' ? '#ff3141' : '#999', marginTop: 4 }}>
						{uploadState.phase === 'signing' ? '正在获取上传地址…' : uploadState.message ?? ''}
					</div>
					{(uploadState.phase === 'success' || uploadState.phase === 'error') && (
						<Button size="mini" fill="none" onClick={() => setUploadState(undefined)}>关闭</Button>
					)}
				</Card>
			)}
			{!rows.length && !hasMore
				? <Empty description={`${title ?? ''}暂无数据`} />
				: rows.map((record, index) => {
					const [first, ...rest] = columns;
					const rowId = String(record[option.rowKey] ?? index);
					return (
						<Card
							key={rowId}
							title={
								<Space align="center">
									{selectable && <Checkbox
										checked={selectedKeys.includes(rowId)}
										onChange={(checked) => setSelectedKeys((previous) => checked ? [...previous, rowId] : previous.filter((key) => key !== rowId))}
									/>}
									<span>{first ? cellText(record[first.dataIndex], first) : ''}</span>
								</Space>
							}
							style={{ marginBottom: 8 }}
						>
							<Space direction="vertical" style={{ width: '100%' }}>
								{rest.map((column) => {
									const text = cellText(record[column.dataIndex], column);
									if (!text) return null;
									return (
										<div key={column.dataIndex} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
											<span style={{ color: '#999', flexShrink: 0 }}>{column.title}</span>
											{column.options ? <Tag color="primary" fill="outline">{text}</Tag> : <span style={{ textAlign: 'right', wordBreak: 'break-all' }}>{text}</span>}
										</div>
									);
								})}
								{rowActions(record).length > 0 && (
									<Space wrap style={{ paddingTop: 4 }}>
										{rowActions(record).map((action) => (
											<Button key={action.key} size="mini" color={action.key === 'delete' ? 'danger' : 'primary'} fill="outline" disabled={action.disabled} onClick={() => void runRowAction(action, record)}>{action.label}</Button>
										))}
									</Space>
								)}
							</Space>
						</Card>
					);
				})}
			<InfiniteScroll loadMore={loadMore} hasMore={hasMore}>
				{hasMore ? <span>加载中<DotLoading /></span> : <span>没有更多了</span>}
			</InfiniteScroll>
			<MobileTableForm
				visible={Boolean(formState)}
				title={formState?.title ?? ''}
				columns={formState?.columns ?? []}
				initialValues={formState?.initialValues}
				submitLabel={formState?.submitLabel}
				submitting={submitting}
				onSubmit={(values) => formState?.submit(values) ?? Promise.resolve()}
				onClose={() => setFormState(undefined)}
			/>
		</div>
	);
};

export default MobileTable;

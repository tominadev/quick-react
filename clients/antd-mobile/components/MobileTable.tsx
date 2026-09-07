import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, DotLoading, Empty, InfiniteScroll, Space, Tag } from 'antd-mobile';
import type { CommonApi, DataType, ResJSON, ResJsonTableColumn, ResJsonTableOption } from '@clients/browser/api.js';
import type { TableAction } from '@shared/types/table.mjs';
import { actionVisibleForRow, rowConfirmText, tableRequestQuery } from '@clients/browser/table-crud.js';

/**
 * 表格的手机版渲染：一行一张卡片，而不是横着摆十几列。
 *
 * **协议照搬桌面版**——`tableRequestQuery` 算 include 与分页参数、`actionVisibleForRow`
 * 决定哪个动作对这一行可见、确认文案里的 `{列名}` 由 `rowConfirmText` 替换。这些规则来自
 * `@clients/browser/table-crud.js`，两套 UI 共用同一份实现：各写一遍的话，同一个后端会在
 * 两个前端上表现不同，而那种漂移要等用户报障才发现。
 *
 * 渲染上的取舍是手机自己的：窄屏放不下十几列，因此第一列做标题、其余做「名称：值」，
 * 翻页换成下拉加载——手机上没人点页码。
 */
const suffix = (window as Window & { __INITIAL_DATA__?: { apiSuffix?: string } }).__INITIAL_DATA__?.apiSuffix ?? '';

const cellText = (value: unknown, column: ResJsonTableColumn) => {
	if (value === null || value === undefined || value === '') return column.emptyText ?? '';
	if (column.dataType === 'js_timestamp') return new Date(Number(value)).toLocaleString();
	if (Array.isArray(value)) return value.join('、');
	const option = column.options?.find((item) => String(item.value) === String(value));
	return option ? option.text : String(value);
};

const MobileTable = ({ commonApi, resourcePath, title }: { commonApi: CommonApi; resourcePath: string; title?: string }) => {
	const [columns, setColumns] = useState<ResJsonTableColumn[]>([]);
	const [option, setOption] = useState<ResJsonTableOption>({ rowKey: 'id' });
	const [rows, setRows] = useState<DataType[]>([]);
	const [hasMore, setHasMore] = useState(true);
	const pageRef = useRef(1);
	const schemaLoadedRef = useRef(false);
	const apiPath = `/api${resourcePath}${suffix}`;

	const loadMore = useCallback(async () => {
		const query = tableRequestQuery({ page: pageRef.current, pageSize: 20, queryValues: {}, schemaLoaded: schemaLoadedRef.current });
		const response = await commonApi.apiFetch(`${apiPath}?${new URLSearchParams(query)}`);
		const body = await response.json() as ResJSON;
		const table = body.table;
		if (!table) { setHasMore(false); return; }
		if (table.columns) { setColumns(table.columns.filter((column) => !column.hideInTable)); schemaLoadedRef.current = true; }
		if (table.option) setOption(table.option);
		const received = table.dataSource ?? [];
		setRows((previous) => pageRef.current === 1 ? received : [...previous, ...received]);
		// 服务端给了总数就按总数判，游标分页看 hasMore；两个都没有就按「这一页没满」收尾。
		const total = table.totalRecords;
		const loaded = (pageRef.current - 1) * 20 + received.length;
		setHasMore(table.hasMore ?? (total === undefined ? received.length >= 20 : loaded < total));
		pageRef.current += 1;
	}, [apiPath, commonApi]);

	useEffect(() => {
		pageRef.current = 1;
		schemaLoadedRef.current = false;
		setRows([]);
		setHasMore(true);
	}, [apiPath]);

	const runAction = async (action: TableAction, record: DataType) => {
		const confirmText = action.confirm ? rowConfirmText(action.confirm, record) : '';
		if (confirmText && !await commonApi.modalConfirm([confirmText])) return;
		const rowId = String(record[option.rowKey] ?? '');
		if (action.key === 'delete') {
			await commonApi.apiFetch(`${apiPath}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([rowId]) });
		} else {
			await commonApi.apiFetch(`${apiPath}?action=${encodeURIComponent(action.key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([rowId]) });
		}
		pageRef.current = 1;
		setRows([]);
		setHasMore(true);
	};

	const rowActions = (record: DataType) => (option.actions?.row ?? [])
		// 互斥动作按服务端声明的 visibleWhen 过滤：一行上只出现适用的那个。
		.filter((action) => actionVisibleForRow(action, record))
		// 表单类动作手机版还没做，先不显示一个点了没反应的按钮。
		.filter((action) => !action.form && !action.modalPath && action.key !== 'edit');

	if (!rows.length && !hasMore) return <Empty description={`${title ?? ''}暂无数据`} />;

	return (
		<div style={{ padding: 8 }}>
			{rows.map((record, index) => {
				const [first, ...rest] = columns;
				return (
					<Card key={String(record[option.rowKey] ?? index)} title={first ? cellText(record[first.dataIndex], first) : undefined} style={{ marginBottom: 8 }}>
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
								<Space style={{ paddingTop: 4 }}>
									{rowActions(record).map((action) => (
										<Button key={action.key} size="mini" color={action.key === 'delete' ? 'danger' : 'primary'} fill="outline" onClick={() => void runAction(action, record)}>{action.label}</Button>
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
		</div>
	);
};

export default MobileTable;

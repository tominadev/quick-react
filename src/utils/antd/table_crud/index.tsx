import type React from 'react';
import type { FilterValue } from 'antd/es/table/interface.js';
import type { TableProps, TablePaginationConfig } from 'antd';
import type { TableColumnsType } from 'antd';
import type { ChangeControlValues, DataType, ResJSON, ResJsonTable } from '@/utils/common/api.js';
import type { ResJsonTableOption } from '@/utils/common/api.js';
import type { CommonApi, ResJsonTableColumn } from '@/utils/common/api.js';
import type { TableAction, TableQueryField } from '@shared/types/table.mjs';
import { CHANGE_CONTROL_FIELD, changeControlHeaders, resolveTableFormColumns } from '@shared/table-form.mjs';

import { useRef, useState, useEffect, useMemo } from 'react';
import { Table, Avatar, Button, Flex, Input, Space, Tag, Select, Progress, Typography, Modal } from 'antd';
import FormPage from '@/components/panel/FormPage.js';
import { useNavigate } from 'react-router-dom';
import { PlusOutlined, DeleteOutlined, SearchOutlined, UploadOutlined, DownloadOutlined } from '@ant-design/icons';
import { useDrawer } from '@/utils/common/drawer.js';
import dayjs from 'dayjs';
import { mergeQueryValues, mergeSort, readTableUrlState, sortOrderFor, writeTableUrlState } from './url-state.js';
import { describeFormChanges } from '@/components/panel/form-changes.js';

// 定义TableCRUD的传参
type TableCrudType = {
	commonApi: CommonApi;
	resourcePath: string;
	/** API 启动模式下由首个页面请求携带的列表响应，避免重复读取同一接口。 */
	initialResponse?: ResJSON;
};

type TableCrudProps = TableCrudType & {
	/** 打开嵌套表格时由父表传入的初始查询条件。 */
	initialQueryValues?: Record<string, string>;
	/** 回收站 TableCRUD 不再显示自身的回收站入口，避免无限嵌套。 */
	showRecycleBin?: boolean;
	/**
	 * 要不要把搜索、翻页、排序记进地址栏。
	 *
	 * 只有页面主表该记：弹窗里的回收站是临时看一眼的东西，它翻页排序也去改地址栏的话，
	 * 会把主表的状态覆盖掉——关掉弹窗后主表还停在原处，地址栏说的却是回收站那一套，
	 * 刷新就跳到别的地方去了。
	 */
	urlState?: boolean;
};

type UploadState = {
	fileName: string;
	loaded: number;
	total: number;
	percent: number;
	phase: 'signing' | 'uploading' | 'success' | 'error' | 'cancelled';
	message?: string;
};

const formatBytes = (bytes: number): string => {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
};

/** 后端确认文案可以引用当前行字段，例如 {provider_label}、{detail}。 */
const rowConfirmText = (template: string, record: DataType) => template.replace(/\{([A-Za-z0-9_]+)\}/g, (placeholder, field: string) => {
	const value = record[field];
	return value === undefined || value === null || value === '' ? placeholder : String(value);
});


const TableCRUD = ({ commonApi, resourcePath, initialResponse, initialQueryValues, showRecycleBin = true, urlState = true }: TableCrudProps) => {
	const initialData = (window as Window & {
		__INITIAL_DATA__?: { apiSuffix?: string };
	}).__INITIAL_DATA__;
	const apiPath = `/api${resourcePath}${initialData?.apiSuffix ?? ''}`;
	const initialQueryDefaults = initialQueryValues ?? {};
	const initialQueryValuesKey = JSON.stringify(initialQueryDefaults);
	const resetKey = `${apiPath}\u0000${initialQueryValuesKey}`;
	const [drawer, contextHolderDrawer] = useDrawer(commonApi);

	const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
	// 代码分类：批量操作
	const rowSelection: TableProps<DataType>['rowSelection'] = (() => {
		const onSelectChange = (newSelectedRowKeys: React.Key[]) => {
			console.log('selectedRowKeys changed: ', newSelectedRowKeys);
			setSelectedRowKeys(newSelectedRowKeys);
		};
		return {
			selectedRowKeys,
			onChange: onSelectChange,
			selections: [
				Table.SELECTION_ALL,
				Table.SELECTION_INVERT,
				Table.SELECTION_NONE,
			],
		};
	})();

	// 弹窗里的表格既不读也不写地址栏：读的话它会连主表的翻页与排序一起继承过来。
	const initialTableState = useRef(readTableUrlState(!urlState || typeof window === 'undefined' ? '' : window.location.search)).current;
	const rememberTableState = (state: Parameters<typeof writeTableUrlState>[1]) => {
		if (!urlState || typeof window === 'undefined') return;
		try {
			const url = new URL(window.location.href);
			const search = writeTableUrlState(url.search, state);
			window.history.replaceState(window.history.state, '', `${url.pathname}${search ? `?${search}` : ''}${url.hash}`);
		} catch { /* 地址栏不可写时静默跳过：表格本身照常工作。 */ }
	};

	// 代码分类：API数据加载
	const [loading, setLoading] = useState(!initialResponse);
	const [uploadState, setUploadState] = useState<UploadState>();
	const [modalAction, setModalAction] = useState<{ path: string; title: string; component?: 'form' | 'table' }>();
	const uploadAbortController = useRef<AbortController | undefined>(undefined);
	const [pagination, setPagination] = useState<TablePaginationConfig>({
		current: initialTableState.page,
		pageSize: initialTableState.size,
		showSizeChanger: true,
	});
	/** `<列>:<asc|desc>`，空串表示按后端默认排序。 */
	const [sort, setSort] = useState<string>(initialTableState.sort);
	/**
	 * 总数是不是准确的。
	 *
	 * 游标分页（对象存储那类）拿不到总数，只知道"后面还有没有"，total 是按当前页估出来的。
	 * 那种情况下不能写「共 N 条」——那是个会变的假数字。
	 */
	const [exactTotal, setExactTotal] = useState(true);
	const [filters, setFilters] = useState<Record<string, FilterValue | null>>({});
	const [dataSource, setDataSource] = useState<DataType[]>([]);
	const [tableColumns, setTableColumns] = useState<TableColumnsType<DataType>>();
	const [resJsonColumns, setResJsonColumns] = useState<ResJsonTableColumn[]>([]);
	const [resJsonTableOption, setResJsonTableOption] = useState<ResJsonTableOption>({ rowKey: 'key' });
	// 行操作回调会被保存进 columns 状态，必须通过 ref 读取后端最新协议，不能捕获首次渲染的默认 rowKey。
	const tableOptionRef = useRef<ResJsonTableOption>({ rowKey: 'key' });
	const [queryFields, setQueryFields] = useState<TableQueryField[]>([]);
	const [queryActions, setQueryActions] = useState<TableAction[]>([]);
	/**
	 * 输入框里显示的值。初值同样取自地址栏——只让请求用地址栏的值、框里却显示默认值的话，
	 * 用户看到的条件和实际生效的条件对不上。
	 */
	const [queryValues, setQueryValues] = useState<Record<string, string>>({ ...initialQueryDefaults, ...initialTableState.query });
	const [appliedQueryValues, setAppliedQueryValues] = useState<Record<string, string>>({ ...initialQueryDefaults, ...initialTableState.query });
	const [searchRequestKey, setSearchRequestKey] = useState(0);
	const initializedQueryDefaultsFor = useRef('');
	const requestSequence = useRef(0);
	// 路径或初始查询条件变化时，重置状态与请求必须作为一个事务完成；
	// 跳过重置所在提交周期，避免先用旧状态发出一次错误请求。
	const pendingResetKey = useRef<string | undefined>(undefined);
	const initialResponseConsumed = useRef(false);
	// 应用后端返回的默认查询值会触发一次状态更新；仅跳过这次由初始化产生的 effect，
	// 不能用一个无条件的布尔值，否则用户在这段时间首次点击搜索时会被误判为初始化请求。
	const skipFetchForSearchRequest = useRef<number | undefined>(undefined);
	const tableSchemaLoaded = useRef(false);
	const cursorsByPage = useRef<Record<number, string | undefined>>({ 1: undefined });
	/**
	 * 已生效的查询条件要在**调用时**读，不能在渲染时求值。
	 *
	 * 列定义连同它们的 onClick 闭包是在异步回调里构建、存进 state 的，捕获的是发起
	 * 那次请求时的值。首次加载时查询条件还是空的，于是「表列管理」点编辑会带不上
	 * table 参数，报「请选择数据表」；切换数据表再搜索会重建列定义，就正常了。
	 */
	// 请求是在异步回调里发的，捕获渲染时的 sort 会拿到旧值，必须读 ref。
	const sortRef = useRef(sort);
	sortRef.current = sort;

	const appliedQueryValuesRef = useRef(appliedQueryValues);
	appliedQueryValuesRef.current = appliedQueryValues;
	const currentQueryValues = () => appliedQueryValuesRef.current;
	const selectedQuerySuffix = () => {
		const query = new URLSearchParams(currentQueryValues()).toString();
		return query ? `?${query}` : '';
	};
	const cacheResJsonTable = useRef<ResJsonTable>({
		columns: [],
	});

	/**
	 * 操作原因走请求头，不走请求体：删除接口的请求体是 id 数组，塞不进字段。
	 * 头部只能放 ASCII，因此先 encodeURIComponent。留空就不发这个头。
	 */
	/** 提交时把两个控制字段摘出去改走请求头：它们不是业务字段。 */
	/** 确认框收集到的控制信息转成请求头，与表单那条路径同一套语义。 */
	const confirmHeaders = (control: ChangeControlValues) => changeControlHeaders(control);
	/**
	 * 动作确认框。
	 *
	 * **操作原因只在管理后台问**（`changeControl` 由服务端按 `/api/panel/admin/` 注入）。
	 * 账户中心的解绑邮箱、注销设备也是 TableCRUD，那里是用户处置自己的数据——照常留痕，
	 * 但让人为解绑自己的邮箱写一条「操作原因」是荒谬的。确认框本身照旧显示：
	 * 那问的是「要不要做」，与「为什么做」是两回事。
	 */
	const confirmChange = async (lines: string[]): Promise<ChangeControlValues | undefined> => {
		if (tableOptionRef.current.changeControl) return commonApi.modalConfirmWithReason(lines);
		return await commonApi.modalConfirm(lines) ? { reason: '' } : undefined;
	};
	const withoutControls = (values: Record<string, unknown>) => {
		const { [CHANGE_CONTROL_FIELD]: _control, ...rest } = values;
		return rest;
	};

	/** 按行过滤互斥动作：撤回只对已生效的行有意义，恢复只对已撤回的行有意义。 */
	const actionVisibleForRow = (action: TableAction, record: DataType) =>
		!action.visibleWhen || action.visibleWhen.values.includes(String(record[action.visibleWhen.field] ?? ''));

	const apiDelete = async (ids: unknown[], headers: Record<string, string> = {}) => {
		// 向后段API发送删除指令
		try {
			setLoading(true);
			await commonApi.apiFetch(`${apiPath}${selectedQuerySuffix()}`, { method: 'DELETE', headers, body: JSON.stringify(ids) });
			await fetchData();
		} catch (ex) {
			console.error(ex);
		} finally {
			setLoading(false);
		}
	}

	const onDeleteOne = async (value: any, record: DataType, index: number, action?: TableAction): Promise<void> => {
		// 点击删除按钮时，弹出提示让用户确认删除操作
		const rowKey = tableOptionRef.current.rowKey, rowId = record[rowKey];
		const aContentLine: string[] = [action?.confirm ? rowConfirmText(action.confirm, record) : `确定要删除 ${rowKey} = ${rowId} 吗？`];
		const control = await confirmChange(aContentLine);
		if (control === undefined) {
			return;
		}
		await apiDelete([rowId], confirmHeaders(control));
	}

	const onOpenEdit = async (value: any, record: DataType, index: number, action: TableAction): Promise<void> => {
		// 打开编辑框，获取单条数据
		if (!cacheResJsonTable.current.columns?.length) {
			alert('no cacheResJsonTable.columns');
			return;
		}
		const rowId = String(record[tableOptionRef.current.rowKey] ?? '');
		if (!rowId) {
			console.error('编辑失败：记录缺少 rowKey', record);
			return;
		}
		const url = `${apiPath}/${encodeURIComponent(rowId)}${selectedQuerySuffix()}`;
		let row: DataType;
		try {
			const res = await commonApi.apiFetch(url, {
				method: 'GET',
				headers: { 'Content-Type': 'application/json' },
			});
			if (!res.ok) {
				return;
			}
			row = await res.json() as DataType;
		} catch (ex) {
			console.error('加载编辑数据失败', ex);
			return;
		}
		const editColumns = resolveTableFormColumns(cacheResJsonTable.current.columns, 'edit');
		const drawerForm1 = drawer.drawerForm({
			title: action.label,
			// 变更说明不再当成表单里的一列：它不是这条记录的字段，混在中间既容易被当成
			// 要填的内容，也让「改了什么」的比对多出一项噪音。改到提交前的确认框里问。
			columns: editColumns,
			optionsPath: apiPath,
		}, async (newRow) => {
			if (!newRow) {
				// 用户点了[取消]按钮
				return;
			}
			// 先把改了什么摆出来再确认——编辑抽屉一屏十几个字段，改完点保存时人未必
			// 还记得动过哪些，而这一步之后要么直接生效、要么进审批队列。
			const changed = describeFormChanges(
				editColumns.map((column) => ({ name: column.dataIndex, label: column.title, options: column.options })),
				Object.keys(newRow),
				row,
				newRow,
			);
			const control = await confirmChange(changed.length
				? ['将保存以下修改，确认继续吗？', ...changed]
				: ['当前未修改，仍要提交吗？']);
			if (control === undefined) return;
			drawerForm1.setSubmitting‌(true);
			try {
				// 操作原因从请求体里摘出去改走请求头：业务路由不该看见它。
				const res = await commonApi.apiFetch(url, {
					method: 'PUT', // 指定请求方法
					headers: {
						'Content-Type': 'application/json', // 指定请求头，表明是 JSON 数据
						...confirmHeaders(control),
					},
					body: JSON.stringify(withoutControls(newRow)), // 将数据转换为 JSON 字符串
				});
				if (!res.ok) {
					return;
				}
				drawer.drawerClose();
				await fetchData();
			} catch (ex) {
				console.error(ex);
			} finally {
				drawerForm1.setSubmitting‌(false);
				}
		});
		drawerForm1.setRow(row);

	}

	const fetchData = async (responseOverride?: ResJSON): Promise<void> => {
		const sequence = ++requestSequence.current;
		setLoading(true);
		try {
			const currentPage = pagination.current ?? 1;
			let resJSON: ResJSON;
			if (responseOverride) {
				resJSON = responseOverride;
			} else {
				const query: Record<string, string> = {
					pageNum: pagination.current?.toString() || '0',
					pageSize: pagination.pageSize?.toString() || '0',
					...(sortRef.current ? { sort: sortRef.current } : {}),
				};
				const currentCursor = cursorsByPage.current[currentPage];
				if (currentCursor) query.cursor = currentCursor;
				Object.assign(query, currentQueryValues());
				// `include` 是公共响应协议参数，优先级高于业务查询字段。
				// 首次请求加载结构，之后只请求数据；回收站状态始终保留。
				const includes = new Set((query.include ?? '').split(',').map((value) => value.trim()).filter(Boolean));
				if (tableSchemaLoaded.current) {
					includes.delete('schema');
					includes.add('data');
				} else {
					includes.add('schema');
					includes.add('data');
				}
				if (includes.size) query.include = [...includes].join(',');
				else delete query.include;
				const queryString = new URLSearchParams(query).toString();
				const response: Response = await commonApi.apiFetch(`${apiPath}?${queryString}`);
				resJSON = await response.json() as ResJSON;
			}
			if (sequence !== requestSequence.current) return;
			if (resJSON.table) {
				const hasTableOption = 'option' in resJSON.table;
				const hasTableColumns = 'columns' in resJSON.table;
				if (hasTableOption || hasTableColumns) tableSchemaLoaded.current = true;
				if (hasTableOption) {
					// 首次响应完整替换配置；后续只返回数据时继续使用已缓存的配置。
					const tableOption: ResJsonTableOption = resJSON.table.option ?? { rowKey: 'key' };
					tableOptionRef.current = tableOption;
					setResJsonTableOption(tableOption);
					const fields = tableOption.queryFields;
					setQueryActions(tableOption.actions?.query ?? []);
					if (fields) {
						setQueryFields(fields);
						const fieldNames = new Set(fields.map((field) => field.dataIndex));
						setQueryValues((previous) => ({
							...Object.fromEntries(Object.entries(initialQueryDefaults).filter(([name]) => !fieldNames.has(name))),
							...Object.fromEntries(fields.map((field) => [
								field.dataIndex,
								previous[field.dataIndex] ?? initialTableState.query[field.dataIndex] ?? initialQueryDefaults[field.dataIndex] ?? field.defaultValue ?? '',
							])),
						}));
						if (initializedQueryDefaultsFor.current !== apiPath) {
							initializedQueryDefaultsFor.current = apiPath;
							// 地址栏里的条件排在最后，压过后端下发的默认值：默认值是"没指定时用什么"，
							// 而带着 ?q.status=… 进来的地址是用户明确选定的。审计页默认「待审批」，
							// 刷新后若被默认值盖掉，用户挑好的筛选就白挑了。
							const defaults = mergeQueryValues(fields, initialQueryDefaults, initialTableState.query);
							if (Object.keys(defaults).length) {
								skipFetchForSearchRequest.current = searchRequestKey;
								setAppliedQueryValues(defaults);
								// 进页面就把**生效的**筛选写进地址栏，让地址栏成为唯一事实来源：
								// 看到的地址就是当前查询，刷新、收藏、分享出去都是同一份结果。
								// 否则「界面上是待审批、地址栏里什么都没有」，刷新后走哪一套全看实现细节。
								rememberTableState({ query: defaults });
							}
						}
					} else {
						setQueryFields([]);
						setQueryValues(initialQueryDefaults);
						setAppliedQueryValues(initialQueryDefaults);
					}
				}
				if (hasTableColumns) {
					const columns = resJSON.table.columns ?? [];
					cacheResJsonTable.current.columns = columns;
					setResJsonColumns(columns);
					const tableColumns: TableColumnsType<DataType> = [];
					for (const column of columns) {
						if (column.hideInTable) continue;
						const { tableDisplay, tableDisplayTextField, sortable, ...tableColumn } = column;
						tableColumns.push({
							...tableColumn,
							// 排序在服务端做（数据是分页的，只排当前页等于排了个寂寞），所以 sorter 只当开关用；
							// 哪些列能排由后端下发，前端不自行推断。multiple 让 antd 进多列模式，
							// 具体优先级由我们按点击顺序自己定（见 mergeSort），不用它那套列上写死的数字。
							//
							// **不在这里写 sortOrder**：列定义只构造一次，写进去就永远停在首次的值，
							// 而 antd 的"下一档排序"取决于当前 sortOrder——那样点几次都只有升序。
							// 它改为在渲染时注入，见 sortedColumns。
							...(sortable ? { sorter: { multiple: 1 } as const } : {}),
								render: (value, record) => {
								if (column.component === 'avatar') return value ? <Avatar src={String(value)} /> : <Avatar />;
								if (column.component === 'avatar_text') return <Space size={8}><Avatar src={record.avatar ? String(record.avatar) : undefined} /> <span>{String(value ?? '') || '未设置昵称'}</span></Space>;
								if (column.dayjsFormat) {
									if (!value) {
										return <span style={{ color: '#CCCCCC' }}>(空)</span>;
									}
								}
								if (column.dataType === 'js_timestamp') {
									return dayjs(value).format(column.dayjsFormat);
								}
								if (tableDisplay === 'reference') {
									const display = tableDisplayTextField ? record[tableDisplayTextField] : value;
									return <span>{String(display ?? value ?? '')}<Typography.Text type="secondary"> (id:{String(value ?? '')})</Typography.Text></span>;
								}
								if (column.options) {
									const values = Array.isArray(value) ? value : [value];
									const tags = column.options.filter((option) => values.includes(option.value))
										.map((option) => <Tag color={option.color} key={option.value}>{option.text}</Tag>);
									if (tags.length) return <Space size={[0, 4]} wrap>{tags}</Space>;
								}
								if (column.component === 'switch') {
									const checked = column.checkedValue === undefined ? Boolean(value) : value === column.checkedValue;
									const label = column.options?.find((option) => option.value === value)?.text ?? (checked ? '是' : '否');
									return <Tag color={checked ? 'green' : 'default'}>{label}</Tag>;
								}
								if (tableDisplay === 'multiline') {
									return <Typography.Paragraph
										style={{ width: 320, marginBottom: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
										ellipsis={{ rows: 3, expandable: 'collapsible', symbol: '展开' }}
									>{String(value ?? '')}</Typography.Paragraph>;
								}
								return value;
							},
						});
					}
					tableColumns.push({
						title: '操作',
						key: 'operation',
						fixed: 'right',
						width: 160,
						render: (value: any, record: DataType, index: number) => <Space wrap size={[8, 4]}>
							{(tableOptionRef.current.actions?.row ?? []).filter((action) => actionVisibleForRow(action, record)).map((action) => rowActionHandlers[action.key]?.(action, value, record, index)
								?? <a key={action.key} aria-disabled={action.disabled} onClick={() => action.form ? onRowFormAction(action, record) : onSimpleRowAction(action, record)}>{action.label}</a>)}
						</Space>,
					});
					setTableColumns(tableColumns);
				}
				setDataSource(resJSON.table.dataSource ?? []);
				if (resJSON.table.hasMore !== undefined) {
					if (resJSON.table.nextCursor) cursorsByPage.current[currentPage + 1] = resJSON.table.nextCursor;
					else delete cursorsByPage.current[currentPage + 1];
					for (const page of Object.keys(cursorsByPage.current).map(Number)) {
						if (page > currentPage + 1) delete cursorsByPage.current[page];
					}
				}
			}

			//setDrawerRow({ name: 'asdf' });
			setExactTotal(resJSON.table?.hasMore === undefined);
			setPagination((prev) => {
				const current = prev.current ?? 1;
				const pageSize = prev.pageSize ?? 10;
				const currentCount = resJSON.table?.dataSource?.length ?? 0;
				const cursorTotal = resJSON.table?.hasMore === undefined
					? undefined
					: (current - 1) * pageSize + currentCount + (resJSON.table.hasMore ? 1 : 0);
				return { ...prev, total: cursorTotal ?? resJSON.table?.totalRecords };
			});

		} catch (ex) {
			console.error(ex);
		} finally {
			setLoading(false);
		}

	}

	const resetInitialized = useRef(false);
	useEffect(() => {
		// 首次挂载时什么都不重置：各项状态刚刚从地址栏读出来，这里一重置就全没了，
		// 连地址栏本身也会被清空——「刷新后页码和筛选回到默认」就是这么来的。
		// 这个 effect 只负责「换了一张表」的清场，那必然发生在挂载之后。
		if (!resetInitialized.current) { resetInitialized.current = true; return; }
		pendingResetKey.current = resetKey;
		setDataSource([]);
		setTableColumns(undefined);
		setResJsonColumns([]);
		setResJsonTableOption({ rowKey: 'key' });
		tableOptionRef.current = { rowKey: 'key' };
		setQueryFields([]);
		setQueryActions([]);
		setQueryValues(initialQueryDefaults);
		setAppliedQueryValues(initialQueryDefaults);
		setSort('');
		setPagination((previous) => ({ ...previous, current: 1, total: 0 }));
		cursorsByPage.current = { 1: undefined };
		initializedQueryDefaultsFor.current = '';
		// 换了一张表，上一张表的筛选、翻页和排序都不再适用，地址栏一并清掉。
		rememberTableState({ query: {}, page: 1, size: 10, sort: '' });
		cacheResJsonTable.current = { columns: [] };
		tableSchemaLoaded.current = false;
		initialResponseConsumed.current = false;
		skipFetchForSearchRequest.current = undefined;
		setSearchRequestKey((previous) => previous + 1);
		requestSequence.current += 1;
	}, [resetKey]);
	useEffect(() => {
		if (pendingResetKey.current === resetKey) {
			pendingResetKey.current = undefined;
			return;
		}
		if (initialResponse && !initialResponseConsumed.current) {
			initialResponseConsumed.current = true;
			void fetchData(initialResponse);
			return;
		}
		if (skipFetchForSearchRequest.current === searchRequestKey) {
			skipFetchForSearchRequest.current = undefined;
			return;
		}
		void fetchData();
	}, [apiPath, initialResponse, JSON.stringify(appliedQueryValues), searchRequestKey, filters, pagination.pageSize, pagination.current, sort]);
	useEffect(() => () => uploadAbortController.current?.abort(), []);
	const onChange: TableProps<DataType>['onChange'] = (_pagination: TablePaginationConfig, _filters, _sorter, _extra) => {
		// 排序变了就回第一页：停在第 5 页却换了次序，看到的是一段没有来由的数据。
		// 已经在排的列保持原有先后，新点的列排到末尾——"再按某列细分"是往后加一层，
		// 而不是把之前的次序打乱。
		const nextSort = mergeSort(sortRef.current, Array.isArray(_sorter) ? _sorter : [_sorter]);
		const sortChanged = nextSort !== sortRef.current;
		if (sortChanged) {
			setSort(nextSort);
			cursorsByPage.current = { 1: undefined };
			rememberTableState({ sort: nextSort, page: 1 });
		}
		setPagination((prev) => {
			if (sortChanged) return { ...prev, current: 1 };
			if (prev.pageSize !== _pagination.pageSize) {
				cursorsByPage.current = { 1: undefined };
				rememberTableState({ size: _pagination.pageSize, page: 1 });
				return { ...prev, pageSize: _pagination.pageSize, current: 1 };
			}
			rememberTableState({ page: _pagination.current ?? 1, size: _pagination.pageSize });
			return { ...prev, pageSize: _pagination.pageSize, current: _pagination.current };
		});
		for (const k in _filters) {
			const v = filters[k] ?? null;
			if (JSON.stringify(_filters[k]) !== JSON.stringify(v)) {
				setFilters((prev) => ({ ...prev, ..._filters }));
				break;
			}
		}
	};

	/**
	 * 渲染时把当前排序状态注入列定义。
	 *
	 * 列定义只在拿到 schema 时构造一次，把 sortOrder 写死在里面的话，antd 依据它算出的
	 * "下一档排序"永远是同一个，点几次都只有升序。这里每次渲染重算，箭头和下一档才跟着走。
	 */
	const sortedColumns = useMemo(() => tableColumns?.map((column) => (
		'dataIndex' in column && column.dataIndex !== undefined && column.sorter
			? { ...column, sortOrder: sortOrderFor(sort, String(column.dataIndex)) }
			: column
	)), [tableColumns, sort]);

	// 代码分类：导航
	const navigate = useNavigate();

	const onAddNew = async (action: TableAction) => {
		const drawerForm = drawer.drawerForm({
			title: action.label,
			columns: resolveTableFormColumns(resJsonColumns, 'create'),
			optionsPath: apiPath,
		}, async (newRow) => {
			if (!newRow) {
				// 用户点了[取消]按钮
				return;
			}
			// 前端校验通过，开始向后端提交表单
			drawerForm.setSubmitting‌(true);
			try {
				const res = await commonApi.apiFetch(`${apiPath}${selectedQuerySuffix()}`, {
					method: 'POST', // 指定请求方法
					headers: {
						'Content-Type': 'application/json', // 指定请求头，表明是 JSON 数据
					},
					body: JSON.stringify(newRow), // 将数据转换为 JSON 字符串
				});
				if (!res.ok) {
					return;
				}
				//form.resetFields();
				drawer.drawerClose();
				await fetchData();
			} catch (ex) {
				console.error(ex);
			} finally {
				drawerForm.setSubmitting‌(false);
			}
		});

	};

	const onDelete = async (action?: TableAction) => {
		const control = await confirmChange(
			[action?.confirm ?? `确定删除所选的 ${selectedRowKeys.length} 项吗？`]
		);
		if (control === undefined) {
			return;
		}
		await apiDelete(selectedRowKeys, confirmHeaders(control));
	}

	const onTest = async (action: TableAction, record: DataType) => {
		const rowId = String(record[tableOptionRef.current.rowKey] ?? '');
		if (!rowId) return;
		const url = `${apiPath}/${encodeURIComponent(rowId)}?action=test`;
		if (!action.form) {
			await commonApi.apiFetch(url, { method: 'POST' });
			return;
		}
		const drawerForm = drawer.drawerForm({
			title: action.label,
			columns: action.form.columns,
			optionsPath: `${apiPath}/${encodeURIComponent(rowId)}`,
		}, async (values) => {
			if (!values) return;
			// 变更说明在确认框里问，不占表单里的一行。
			const control = await confirmChange([action.confirm ?? `确认执行「${action.label}」吗？`]);
			if (control === undefined) return;
			drawerForm.setSubmitting‌(true);
			try {
				await commonApi.apiFetch(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', ...confirmHeaders(control) },
					body: JSON.stringify(withoutControls(values)),
				});
				drawer.drawerClose();
			} catch (error) {
				console.error(error);
			} finally {
				drawerForm.setSubmitting‌(false);
			}
		});
	};

	const onToolbarFormAction = (action: TableAction) => {
		if (!action.form) return;
		const drawerForm = drawer.drawerForm({ title: action.label, columns: action.form.columns, optionsPath: apiPath }, async (values) => {
			if (!values) return;
			// 变更说明在确认框里问，不占表单里的一行。
			const control = await confirmChange([action.confirm ?? `确认执行「${action.label}」吗？`]);
			if (control === undefined) return;
			drawerForm.setSubmitting‌(true);
			try {
				await commonApi.apiFetch(`${apiPath}?action=${encodeURIComponent(action.key)}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', ...confirmHeaders(control) },
					body: JSON.stringify(withoutControls(values)),
				});
				drawer.drawerClose();
				await fetchData();
			} catch (error) {
				console.error(error);
			} finally {
				drawerForm.setSubmitting‌(false);
			}
		});
	};
	const onToolbarSimpleAction = async (action: TableAction) => {
		if (action.disabled) return;
		const control = await confirmChange([action.confirm ?? `确定执行「${action.label}」吗？`]);
		if (control === undefined) return;
		const response = await commonApi.apiFetch(`${apiPath}?action=${encodeURIComponent(action.key)}`, { method: 'POST', headers: confirmHeaders(control) });
		const result = await response.json().catch(() => ({})) as { redirectTo?: string; openWindow?: boolean };
		if (result.redirectTo && result.openWindow) {
			const popup = window.open(result.redirectTo, 'accounts_identity_bind', 'width=480,height=680,resizable=yes,scrollbars=yes');
			if (!popup) throw new Error('授权窗口被浏览器拦截');
			const timer = window.setInterval(() => {
				try {
					if (popup.closed) { window.clearInterval(timer); void fetchData(); return; }
					if (popup.location.origin === window.location.origin && popup.location.pathname.includes('/panel/accounts/identities')) {
						window.clearInterval(timer); popup.close(); void fetchData();
					}
				} catch { /* 授权过程中仍处于第三方域名，等待回调 */ }
			}, 500);
		} else if (result.redirectTo) window.location.assign(result.redirectTo);
		else await fetchData();
	};
	const onToolbarSelectionAction = async (action: TableAction) => {
		if (action.disabled || !selectedRowKeys.length) return;
		const control = await confirmChange([action.confirm ?? `确定对所选的 ${selectedRowKeys.length} 项执行「${action.label}」吗？`]);
		if (control === undefined) return;
		const query = new URLSearchParams(currentQueryValues());
		query.set('action', action.key);
		await commonApi.apiFetch(`${apiPath}?${query.toString()}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...confirmHeaders(control) },
			body: JSON.stringify(selectedRowKeys),
		});
		setSelectedRowKeys([]);
		await fetchData();
	};
	const onSimpleRowAction = async (action: TableAction, record: DataType) => {
		const rowId = String(record[tableOptionRef.current.rowKey] ?? '');
		if (!rowId || action.disabled) return;
		const control = await confirmChange([action.confirm ? rowConfirmText(action.confirm, record) : `确定执行「${action.label}」吗？`]);
		if (control === undefined) return;
		const query = new URLSearchParams(currentQueryValues());
		query.set('action', action.key);
		await commonApi.apiFetch(`${apiPath}/${encodeURIComponent(rowId)}?${query.toString()}`, { method: 'POST', headers: confirmHeaders(control) });
		await fetchData();
	};
	const onRowFormAction = async (action: TableAction, record: DataType) => {
		if (!action.form || action.disabled) return;
		const rowId = String(record[tableOptionRef.current.rowKey] ?? '');
		if (!rowId) return;
		if (action.confirm && !await commonApi.modalConfirm([rowConfirmText(action.confirm, record)])) return;
		const drawerForm = drawer.drawerForm({
			title: action.label,
			columns: action.form.columns,
			optionsPath: `${apiPath}/${encodeURIComponent(rowId)}`,
		}, async (values) => {
			if (!values) return;
			// 变更说明在确认框里问，不占表单里的一行。
			const control = await confirmChange([action.confirm ?? `确认执行「${action.label}」吗？`]);
			if (control === undefined) return;
			drawerForm.setSubmitting‌(true);
			try {
				const response = await commonApi.apiFetch(`${apiPath}/${encodeURIComponent(rowId)}?action=${encodeURIComponent(action.key)}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', ...confirmHeaders(control) },
					body: JSON.stringify(withoutControls(values)),
				});
				if (!response.ok) return;
				drawer.drawerClose();
				await fetchData();
			} catch (error) {
				console.error(error);
			} finally {
				drawerForm.setSubmitting‌(false);
			}
		});
	};

	const rowActionHandlers: Record<string, (action: TableAction, value: any, record: DataType, index: number) => React.ReactNode> = {
		edit: (action, value, record, index) => <a key={action.key} aria-disabled={action.disabled} onClick={() => !action.disabled && onOpenEdit(value, record, index, action)}>{action.label}</a>,
		delete: (action, value, record, index) => <a key={action.key} aria-disabled={action.disabled} onClick={() => !action.disabled && onDeleteOne(value, record, index, action)}>{action.label}</a>,
		test: (action, _value, record) => <a key={action.key} aria-disabled={action.disabled} onClick={() => !action.disabled && onTest(action, record)}>{action.label}</a>,
		download: (action, _value, record) => <a key={action.key} aria-disabled={action.disabled} onClick={async () => {
			if (action.disabled) return;
			const key = String(record[tableOptionRef.current.rowKey] ?? '');
			const query = new URLSearchParams(currentQueryValues());
			query.set('key', key);
			const response = await commonApi.apiFetch(`${apiPath}?${query}`, { method: 'PUT' });
			const result = await response.json() as { downloadUrl?: string };
			if (result.downloadUrl) window.open(result.downloadUrl, '_blank', 'noopener,noreferrer');
		}}>{action.label}</a>,
	};
	const toolbarActionHandlers: Record<string, (action: TableAction) => React.ReactNode> = {
		create: (action) => <Button key={action.key} type="primary" onClick={() => onAddNew(action)} icon={<PlusOutlined />} disabled={loading || action.disabled}>{action.label}</Button>,
		delete: (action) => <Button key={action.key} danger type="primary" disabled={selectedRowKeys.length === 0 || action.disabled} onClick={() => onDelete(action)} icon={<DeleteOutlined />}>{action.label}</Button>,

		upload: (action) => <Button key={action.key} type="primary" icon={<UploadOutlined />} disabled={loading || action.disabled || uploadState?.phase === 'signing' || uploadState?.phase === 'uploading'} onClick={() => {
			const input = document.createElement('input');
			input.type = 'file';
			input.onchange = async () => {
				const file = input.files?.[0];
				if (!file) return;
				const abortController = new AbortController();
				uploadAbortController.current = abortController;
				setUploadState({ fileName: file.name, loaded: 0, total: file.size, percent: 0, phase: 'signing' });
				try {
					setLoading(true);
					const key = file.name;
					const response = await commonApi.apiFetch(`${apiPath}${selectedQuerySuffix()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, size: file.size }) });
					const result = await response.json() as { uploadUrl?: string };
					if (!result.uploadUrl) throw new Error('上传地址为空');
					setUploadState((previous) => previous && { ...previous, phase: 'uploading' });
					const uploadBody = file.slice(0, file.size, '');
					await commonApi.uploadFile(result.uploadUrl, uploadBody, {
						signal: abortController.signal,
						onProgress: (loaded, total) => setUploadState((previous) => previous && {
							...previous,
							loaded,
							total,
							percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
							phase: 'uploading',
						}),
					});
					setUploadState({ fileName: file.name, loaded: file.size, total: file.size, percent: 100, phase: 'success', message: '上传完成' });
					await fetchData();
				} catch (error) {
					const cancelled = error instanceof DOMException && error.name === 'AbortError';
					setUploadState((previous) => previous && { ...previous, phase: cancelled ? 'cancelled' : 'error', message: cancelled ? '上传已取消' : (error instanceof Error ? error.message : '上传失败') });
					console.error(error);
				} finally {
					if (uploadAbortController.current === abortController) uploadAbortController.current = undefined;
					setLoading(false);
				}
			};
			input.click();
		}}>{action.label}</Button>,
	};
	const renderModalAction = (action: TableAction) => <Button
		key={action.key}
		style={action.key === 'recycle-bin' ? { marginLeft: 'auto' } : undefined}
		disabled={loading || action.disabled}
		onClick={() => action.modalPath && setModalAction({ path: action.modalPath, title: action.label, component: action.modalComponent })}
	>{action.label}</Button>;
	const queryActionHandlers: Record<string, (action: TableAction) => React.ReactNode> = {
		search: (action) => <Button key={action.key} onClick={applySearch} icon={<SearchOutlined />} disabled={loading || action.disabled}>{action.label}</Button>,
	};

	// 普通搜索只更新当前表的数据；只有后端标记结构依赖的查询值变化时才清空结构。
	const applySearch = () => {
		requestSequence.current += 1;
		setDataSource([]);
		const schemaChanged = queryFields.some((field) => field.reloadSchema && queryValues[field.dataIndex] !== appliedQueryValues[field.dataIndex]);
		if (schemaChanged) {
			setTableColumns(undefined);
			setResJsonColumns([]);
			setResJsonTableOption({ rowKey: 'key' });
			tableOptionRef.current = { rowKey: 'key' };
			setQueryActions([]);
			cacheResJsonTable.current = { columns: [] };
			tableSchemaLoaded.current = false;
		}
		cursorsByPage.current = { 1: undefined };
		setSelectedRowKeys([]);
		setFilters({});
		setAppliedQueryValues(queryValues);
		setSearchRequestKey((previous) => previous + 1);
		setPagination((prev) => ({ ...prev, current: 1, total: 0 }));
		// 搜索条件也记进地址栏：刷新回到同一组条件，链接可以直接分享。
		rememberTableState({ query: queryValues, page: 1 });
	};
	// 查询区是裸的输入框，不在 form 里，没有默认提交行为可拦。用 antd 自带的
	// onPressEnter，而不是为此套一层 form——嵌套 form 还要处理默认提交与冒泡。
	const canSearch = queryActions.some((action) => action.key === 'search' && !action.disabled) && !loading;

	return (<Flex vertical gap="small">
		{contextHolderDrawer}
		<Flex wrap gap="small" align="center">
			{queryFields.map((field) => (
				<Space key={field.dataIndex} size={4}>
					<span>{field.label}</span>
					{field.component === 'select'
						? <Select style={{ minWidth: 190 }} value={queryValues[field.dataIndex] || undefined} options={field.options?.map((item) => ({ value: item.value, label: item.text }))} onChange={(value) => setQueryValues((previous) => ({ ...previous, [field.dataIndex]: value }))} placeholder={field.placeholder} allowClear />
						: <Input value={queryValues[field.dataIndex] ?? ''} onChange={(event) => setQueryValues((previous) => ({ ...previous, [field.dataIndex]: event.target.value }))} onPressEnter={() => canSearch && applySearch()} placeholder={field.placeholder} />}
				</Space>
			))}
			{queryActions.map((action) => queryActionHandlers[action.key]?.(action) ?? null)}
		</Flex>
		<Flex wrap gap="small">
			{(resJsonTableOption.actions?.toolbar ?? []).filter((action) => showRecycleBin || action.key !== 'recycle-bin').map((action) => action.modalPath ? renderModalAction(action) : toolbarActionHandlers[action.key]?.(action)
				// 作用于选中行的动作由服务端声明（selection），不按 key 名去猜：猜的话每加一个
				// 批量动作都要回来改前端，漏改的表现是「明明选了行却提示请先选择记录」。
				?? (action.selection ? <Button key={action.key} type="primary" disabled={selectedRowKeys.length === 0 || loading || action.disabled} onClick={() => void onToolbarSelectionAction(action)}>{action.label}</Button>
					: action.form ? <Button key={action.key} disabled={loading || action.disabled} onClick={() => onToolbarFormAction(action)}>{action.label}</Button>
						: <Button key={action.key} disabled={loading || action.disabled} onClick={() => onToolbarSimpleAction(action)}>{action.label}</Button>))}
		</Flex>
		<Modal open={Boolean(modalAction)} title={modalAction?.title} footer={null} destroyOnHidden width={modalAction?.component === 'table' ? '90vw' : 560} onCancel={() => setModalAction(undefined)}>
			{modalAction?.component === 'table'
				? <TableCRUD
					commonApi={commonApi}
					resourcePath={modalAction.path}
					initialQueryValues={{ ...appliedQueryValues, include: 'deleted' }}
					showRecycleBin={false}
					urlState={false}
				/>
				: modalAction ? <FormPage embedded commonApi={commonApi} apiPath={`/api${modalAction.path}${initialData?.apiSuffix ?? ''}`} title={modalAction.title} submitMethod="POST" onCompleted={() => { setModalAction(undefined); void fetchData(); }} /> : null}
		</Modal>
		{uploadState && <Flex gap="middle" align="center" style={{ padding: '12px 16px', border: '1px solid #f0f0f0', borderRadius: 8 }}>
			<Flex vertical style={{ flex: 1, minWidth: 0 }}>
				<Typography.Text ellipsis title={uploadState.fileName}>{uploadState.fileName}</Typography.Text>
				<Progress
					percent={uploadState.percent}
					status={uploadState.phase === 'success' ? 'success' : uploadState.phase === 'error' || uploadState.phase === 'cancelled' ? 'exception' : 'active'}
				/>
				<Typography.Text type="secondary">
					{uploadState.phase === 'signing' ? '正在创建上传签名…' : uploadState.message ?? `正在上传 ${formatBytes(uploadState.loaded)} / ${formatBytes(uploadState.total)}`}
				</Typography.Text>
			</Flex>
			{(uploadState.phase === 'signing' || uploadState.phase === 'uploading') && <Button onClick={() => uploadAbortController.current?.abort()}>取消上传</Button>}
		</Flex>}
		<Table<DataType>
			key={String(appliedQueryValues.table ?? apiPath)}
			rowSelection={rowSelection}
			pagination={{
				...pagination,
				// 总数默认不显示，得自己给。游标分页时 total 是估出来的，只报区间不报总数——
				// 写一个会变的「共 N 条」比不写更糟。
				showTotal: (total, range) => exactTotal
					? `第 ${range[0]}-${range[1]} 条，共 ${total} 条`
					: `第 ${range[0]}-${range[1]} 条`,
			}}
			onChange={onChange}
			columns={sortedColumns}
			dataSource={dataSource}
			loading={loading}
			rowKey={resJsonTableOption?.rowKey}
			scroll={{ x: 'max-content' }}
		/>
	</Flex>);
};

export default TableCRUD;

import type React from 'react';
import type { CommonApi, DataType, ResJsonTableColumn } from '@/utils/common/api.js';
import type { Dayjs } from 'dayjs';
import { useState, useRef } from 'react';
import DrawerForm from '@/utils/antd/table_crud/drawer.js';
import dayjs from 'dayjs';
import { isSystemField } from '@shared/system-fields.mjs';

interface testType {
	setRow: (value: DataType) => void;
	setLoading: (value: boolean) => void;
	setSubmitting‌: (value: boolean) => void;
}

export interface drawerType {
	drawerClose: () => void;
	drawerForm: (props: DrawerFuncProps, callback: (value?: DataType) => void) => testType;
}

export interface DrawerFuncProps {
	title: string,
	/** 抽屉顶部的一条警告；由服务端算好整句话发下来，这一层不做解释。 */
	notice?: string,
	columns: ResJsonTableColumn[],
	optionsPath?: string,
}

export function useDrawer(commonApi: CommonApi): [drawerType, React.JSX.Element] {
	const [open, setOpen] = useState(false);
	const [columns, setColumns] = useState<ResJsonTableColumn[]>([]);
	const [row, setRow] = useState<DataType>({});
	const [title, setTitle] = useState<string>('');
	const [notice, setNotice] = useState<string>('');
	const [optionsPath, setOptionsPath] = useState<string>();
	const resolveRef = useRef<((value?: DataType) => void) | undefined>(undefined); // 使用 useRef 持久化 resolve
	const [loading, setLoading] = useState<boolean>(false);
	const [submitting‌, setSubmitting‌] = useState<boolean>(false);

	const drawer: drawerType = {
		drawerClose: () => {
			setOpen(false);
		},
		drawerForm: (props: DrawerFuncProps, callback?: (value?: DataType) => void): testType => {
			const editableColumns = props.columns.filter((column) => !isSystemField(column.dataIndex));
			setTitle(props.title);
			setNotice(props.notice ?? '');
			setColumns(editableColumns);
			setOptionsPath(props.optionsPath);
			setRow(Object.fromEntries(editableColumns
				.filter((column) => column.dataIndex === 'status' && column.component === 'switch')
				.map((column) => [column.dataIndex, column.checkedValue ?? true])));
			setOpen(true);
			if (callback) {
				resolveRef.current = callback;
			}
			return {
				setRow: (_row: DataType) => {
					// 外部调用设置新的row值时，刷新新值
					const normalizedRow = { ..._row };
					for (const column of editableColumns) {
						/**
						 * **NULL 到表单值的归一放在这里，不放在每个路由里。**
						 *
						 * 接口该说真话：一列没有值就是 `null`，与空串是两回事（唯一索引里 NULL
						 * 互不相等，「从没填过」与「填过又清掉」也是两种事实）。但受控输入吃不下
						 * null——antd 拿到它会退化成非受控，React 告警，回填与提交都不对。
						 *
						 * 所以归一在**用得着它的那一层**做，而且按控件分：给多选一个 `''` 会让它
						 * 显示成一个空标签，给下拉一个 `''` 会选中一个值为空串的选项，给开关一个
						 * `''` 会被当成「有值」。一律 `?? ''` 是把三种错凑在一起。
						 */
						// 可空的列不归一：它的控件认得 NULL，抹掉就等于在最后一层把两种状态又压回一种。
						if (column.nullable && normalizedRow[column.dataIndex] === undefined) normalizedRow[column.dataIndex] = null;
						if (!column.nullable && (normalizedRow[column.dataIndex] === null || normalizedRow[column.dataIndex] === undefined)) {
							normalizedRow[column.dataIndex] = column.component === 'switch' ? (column.uncheckedValue ?? false)
								// 下拉与日期用 undefined 表示「没选」：给空串会选中一个空选项。
								: column.component === 'select' ? (column.multiple ? [] : undefined)
									: column.component === 'datepicker' || column.component === 'datepicker_rangepicker' || column.component === 'inputnumber' ? undefined
										: '';
							continue;
						}
						if (column.allowCustomValue && !column.multiple && normalizedRow[column.dataIndex] && !Array.isArray(normalizedRow[column.dataIndex])) {
							normalizedRow[column.dataIndex] = [normalizedRow[column.dataIndex]];
						}
						if (column.component !== 'datepicker' || !normalizedRow[column.dataIndex]) {
							continue;
						}
						// DatePicker 只能接收 Dayjs，后端日期字符串需要先转换。
						normalizedRow[column.dataIndex] = dayjs(normalizedRow[column.dataIndex]?.toString());
					}
					setRow(normalizedRow);
				},
				setLoading,
				setSubmitting‌,
			};
		}
	};
	const onFinish = async (values: Record<string, unknown>) => {
		if (resolveRef.current) {
			for (const column of columns) {
				if (column.component !== 'datepicker' || !values[column.dataIndex]) {
					continue;
				}
				// 返回日期之前将 Dayjs 转换成后端可存储的字符串。
				const date = dayjs(values[column.dataIndex] as string | number | Date | Dayjs | null | undefined);
				values[column.dataIndex] = column.dayjsFormat
					? date.format(column.dayjsFormat)
					: date.toISOString();
			}
			resolveRef.current(values);
		}
	};
	const onClose = () => {
		setOpen(false);
		if (resolveRef.current) {
			resolveRef.current();
		}
	};
	return [
		drawer,
		<DrawerForm
			commonApi={commonApi}
			title={title}
			notice={notice}
			columns={columns}
			optionsPath={optionsPath}
			row={row}
			open={open}
			onFinish={onFinish}
			onClose={onClose}
			okText='确定'
			cancelText='取消'
			loading={loading}
			submitting‌={submitting‌}
		/>
	];
}

import { useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Popup, Selector, Switch, TextArea } from 'antd-mobile';
import type { DataType } from '@clients/browser/api.js';
import type { TableColumn } from '@shared/types/table.mjs';
import { isFieldReadOnly } from '@shared/field-linkage.mjs';

/**
 * 表格的新增 / 编辑 / 动作表单，手机版。
 *
 * 字段从**列定义**来，和桌面版是同一份：`resolveTableFormColumns` 已经按 `form.create`、
 * `form.edit` 场景算好了这一次该出哪些列，这里只负责把每一列画成一个控件。列定义由后端
 * 下发，因此后端加一列，两套 UI 同时就有了——各自维护一份字段表才是会漂的那种做法。
 *
 * 渲染上的取舍是手机自己的：抽屉换成从底部推上来的 `Popup`，下拉换成平铺的 `Selector`
 * ——小屏上点开下拉再滚动挑，比直接摆出来慢得多。
 *
 * **分组暂不分 Tab**：桌面版按 `group` 把编辑抽屉切成 Tab，手机上一屏放不下 Tab 头，
 * 改成按分组顺序依次往下排，所有字段都在同一个表单里——Tab 懒渲染漏注册字段那个坑
 * （见架构文档）在这里天然不存在。
 */
const FieldControl = ({ column, values }: { column: TableColumn; values: Record<string, unknown> }) => {
	const readOnly = isFieldReadOnly(column.readOnlyWhen, values);
	if (column.component === 'switch') return <Switch disabled={readOnly} />;
	if (column.component === 'textarea') return <TextArea placeholder={column.placeholder} maxLength={column.maxLength} rows={3} readOnly={readOnly} />;
	if (column.options?.length) {
		return <Selector
			columns={2}
			multiple={column.multiple}
			options={column.options.map((option) => ({ label: option.text, value: String(option.value) }))}
			disabled={readOnly}
		/>;
	}
	return <Input
		placeholder={column.placeholder}
		maxLength={column.maxLength}
		type={column.inputType === 'password' ? 'password' : column.component === 'inputnumber' ? 'number' : 'text'}
		readOnly={readOnly}
		clearable
	/>;
};

/**
 * 分组只决定先后，不决定分不分屏：带 `group` 的列按分组聚在一起，没带的归到第一组。
 * 与桌面版同一条规则，差别只在桌面把每一组渲染成一个 Tab。
 */
const orderedColumns = (columns: TableColumn[]) => {
	const groups: string[] = [];
	for (const column of columns) {
		const group = column.group ?? '';
		if (!groups.includes(group)) groups.push(group);
	}
	return groups.flatMap((group) => columns.filter((column) => (column.group ?? '') === group));
};

const MobileTableForm = ({ visible, title, columns, initialValues, submitting, submitLabel, onSubmit, onClose }: {
	visible: boolean;
	title: string;
	columns: TableColumn[];
	initialValues?: DataType;
	submitting?: boolean;
	submitLabel?: string;
	onSubmit: (values: Record<string, unknown>) => void | Promise<void>;
	onClose: () => void;
}) => {
	const [form] = Form.useForm();
	const [values, setValues] = useState<Record<string, unknown>>({});
	const fields = useMemo(() => orderedColumns(columns), [columns]);

	useEffect(() => {
		if (!visible) return;
		// 每次打开都按这一次的初始值重置：不重置的话上一条记录的内容会留在框里，
		// 而它看起来和「这条记录本来就是这个值」一模一样。
		const next = (initialValues ?? {}) as Record<string, unknown>;
		form.resetFields();
		form.setFieldsValue(next);
		setValues(next);
	}, [visible, initialValues, form]);

	return (
		<Popup visible={visible} onMaskClick={onClose} onClose={onClose} bodyStyle={{ height: '80vh', overflow: 'auto' }} destroyOnClose>
			<div style={{ padding: '12px 12px 0', fontWeight: 600 }}>{title}</div>
			<Form
				form={form}
				layout="horizontal"
				onValuesChange={(_changed, all) => setValues(all as Record<string, unknown>)}
				footer={
					<div style={{ display: 'flex', gap: 8 }}>
						<Button block onClick={onClose}>取消</Button>
						<Button block color="primary" loading={submitting} onClick={() => void (async () => {
							const raw = await form.validateFields().catch(() => undefined);
							if (!raw) return;
							await onSubmit(raw as Record<string, unknown>);
						})()}>{submitLabel ?? '提交'}</Button>
					</div>
				}
			>
				{fields.map((column) => (
					<Form.Item
						key={column.dataIndex}
						name={column.dataIndex}
						label={column.title}
						rules={column.rules?.map((rule) => ({ required: rule.required, message: rule.message }))}
						valuePropName={column.component === 'switch' ? 'checked' : undefined}
					>
						<FieldControl column={column} values={values} />
					</Form.Item>
				))}
			</Form>
		</Popup>
	);
};

export default MobileTableForm;

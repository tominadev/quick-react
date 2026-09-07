import type { DataType, ResJsonTableColumn } from '@clients/browser/api.js';
import type { CommonApi } from '@clients/browser/api.js';
import type { UploadProps } from 'antd';
import { NullableInput } from '@/utils/antd/nullable-input.js';
import type { TableSelectOption } from '@shared/types/table.mjs';
import { isFieldReadOnly } from '@shared/field-linkage.mjs';
import type { ChangeControlValue } from '@shared/table-form.mjs';
import { changedFieldsKey, type ChangedFieldsPayload } from '@shared/types/changed-fields.mjs';

import { ClearOutlined, InboxOutlined, RollbackOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Col, DatePicker, Drawer, Form, Input, Row, Select, Space, Switch, Tabs, Typography } from 'antd';
import { Upload } from 'antd';
import { InputNumber } from 'antd';
import { useEffect, useRef, useState } from 'react';

// 定义TableCRUD的传参
type TableCrudType = {
	title: string;
	/** 抽屉顶部的一条警告，例如「张三提交的「修改」申请正在等待审批」。空串就不显示。 */
	notice?: string;
	columns: ResJsonTableColumn[];
	optionsPath?: string;
	row: DataType;
	open: boolean;
	onClose: () => void;
	commonApi: CommonApi;
	onFinish: (values: Record<string, unknown>) => Promise<void>;
	okText: string;
	cancelText: string;
	loading: boolean;
	submitting‌: boolean;
};

const base64Url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

/**
 * Ed25519 公钥输入框，外加一个「在这台电脑上生成密钥对」。
 *
 * **密钥对在浏览器里生成，私钥不上传。** 接入方用私钥签发绑定票据、SMS 用登记的公钥验签，
 * 这套东西的全部价值就在于「只有接入方持有私钥」——由服务端生成再发下来的话，私钥就经过了
 * SMS 控制的代码路径，那句话立刻不成立。这里生成的私钥只出现在这一个页面上，复制走之后
 * 刷新即失，服务端从头到尾只收到公钥。
 *
 * 浏览器不支持 Ed25519 时不硬撑：说清楚，并让人回到 openssl 那条路（占位符里就写着命令）。
 */
const Ed25519PublicKeyField = ({ value, onChange, placeholder, readOnly }: { value?: string; onChange?: (value: string) => void; placeholder?: string; readOnly?: boolean }) => {
	const [privateKey, setPrivateKey] = useState('');
	const [error, setError] = useState('');
	const [generating, setGenerating] = useState(false);
	const generate = async () => {
		setGenerating(true);
		setError('');
		try {
			const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
			onChange?.(base64Url(await crypto.subtle.exportKey('raw', pair.publicKey)));
			// 私钥给 PKCS#8 的 PEM：openssl、PHP 的 sodium、Node 都直接读得进去，
			// 而裸字节还要对方自己拼头，拼错了只会在验签时看到一句「签名无效」。
			const pkcs8 = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))));
			setPrivateKey(`-----BEGIN PRIVATE KEY-----\n${(pkcs8.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----`);
		} catch {
			setError('这个浏览器不支持在本地生成 Ed25519 密钥对。请按输入框里的命令用 openssl 生成，然后把公钥粘进来。');
		} finally {
			setGenerating(false);
		}
	};
	return (
		<Space direction="vertical" style={{ width: '100%' }} size="small">
			<Input.TextArea rows={3} value={value ?? ''} onChange={(event) => onChange?.(event.target.value)} placeholder={placeholder} readOnly={readOnly} disabled={readOnly} />
			{!readOnly && <Button onClick={() => void generate()} loading={generating}>在这台电脑上生成密钥对</Button>}
			{error && <Alert type="warning" showIcon message={error} />}
			{privateKey && <Alert
				type="warning"
				showIcon
				message="私钥只显示这一次"
				description={<Space direction="vertical" style={{ width: '100%' }} size={4}>
					<span>复制给接入方，让它保存在自己的服务端。<strong>本站不会保存私钥</strong>，这个页面关掉或刷新之后就再也拿不到了；弄丢了就重新生成一把、换一个 kid 登记。</span>
					<Typography.Paragraph copyable={{ text: privateKey }} style={{ margin: 0 }}>
						<Typography.Text code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12 }}>{privateKey}</Typography.Text>
					</Typography.Paragraph>
				</Space>}
			/>}
		</Space>
	);
};

function getFullFileExtension(filename: string): string {
	const index = filename.indexOf('.');
	return index !== -1 ? filename.slice(index) : '';
}

function getFormItemComponent(item: ResJsonTableColumn, row: DataType, parentValue?: unknown, remoteOptions?: TableSelectOption[], optionsLoading?: boolean, onOptionChange?: (value: unknown) => void, readOnly = false) {
	switch (item.component) {
		case ('textbox'):
			// 可空的列换成能表达 NULL 的那个控件：点 ✕ 存 NULL，删光字符只是空串。
			// 密码框不给这条路——那里「留空」的意思是「不修改」，与 NULL 不是一回事。
			if (item.nullable && item.inputType !== 'password') {
				return <NullableInput placeholder={item.placeholder} maxLength={item.maxLength} readOnly={readOnly} disabled={readOnly} />;
			}
			return (
				item.inputType === 'password'
					? <Input.Password placeholder={item.placeholder} maxLength={item.maxLength} readOnly={readOnly} disabled={readOnly} />
					: <Input placeholder={item.placeholder} maxLength={item.maxLength} readOnly={readOnly} disabled={readOnly} />
			);
		case ('url'):
			return (
				<Input
					style={{ width: '100%' }}
					addonBefore="http://"
					addonAfter=".com"
					placeholder={item.placeholder}
				/>
			);
		case ('select'):
			return (
				<Select
					showSearch
					allowClear
					mode={item.allowCustomValue ? 'tags' : item.multiple ? 'multiple' : undefined}
					maxCount={!item.multiple && item.allowCustomValue ? 1 : undefined}
					loading={optionsLoading}
					placeholder={item.placeholder}
					optionFilterProp="label"
					filterOption={(input, option) => String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
					onChange={onOptionChange}
					options={(remoteOptions ?? item.options)
						?.filter((option) => !item.dependsOn || option.parentValue === parentValue)
						.map((option) => ({ value: option.value, label: option.text }))}
				/>
			);
		case ('switch'):
			return <Switch checkedChildren="启用" unCheckedChildren="禁用" />;
		case ('textarea'):
			return (
				<Input.TextArea rows={4} placeholder={item.placeholder} readOnly={readOnly} disabled={readOnly} />
			);
		case ('ed25519_public_key'):
			return <Ed25519PublicKeyField placeholder={item.placeholder} readOnly={readOnly} />;
		case ('datepicker'):
			return (
				<DatePicker
					style={{ width: '100%' }}
					format={item.dayjsFormat}
					placeholder={item.placeholder}
					onChange={(_, dateString) => {
						console.log('onChange', item.dataIndex, dateString);
					}}
				/>
			);
		case ('datepicker_rangepicker'):
			return (
				<DatePicker.RangePicker
					style={{ width: '100%' }}
					getPopupContainer={(trigger) => trigger.parentElement!}
				/>
			);
		case ('inputnumber'):
			return (<InputNumber style={{ width: '100%' }} placeholder={item.placeholder} />);
		case ('upload'):
			interface File {
				uid: string;
				name: string;
				size: number,
				type: string,
				url: string,
				response: {
					file_sha1: string;
				}
			}
			interface FileVal {
				file: File;
				fileList: File[];
			}
			console.log('row', row);
			const props: UploadProps = {
				name: 'file',
				multiple: true,
				maxCount: 10,
				action: '/api/upload',
				onChange(info) {
					console.log('info.event:', info.event, 'info.file:', info.file);
				},
				onDrop(e) {
					console.log('Dropped files', e.dataTransfer.files);
				},
				listType: 'picture-card',
				showUploadList: {
					extra: ({ size = 0 }) => (
						<span style={{ color: '#cccccc' }}>({(size / 1024 / 1024).toFixed(2)}MB)</span>
					),
					showPreviewIcon: true,
					showRemoveIcon: true,
				},
			};
			const fileVal = row[item.dataIndex] as FileVal;
			if (fileVal && fileVal.file) {
				props.defaultFileList = [];
				for (const item of fileVal.fileList) {
					item.url = `/api/data/${item.response.file_sha1}${getFullFileExtension(item.name)}`;
					props.defaultFileList.push(item);
				}
			}
			return (
				<Upload.Dragger {...props}>
					<p className="ant-upload-drag-icon">
						<InboxOutlined />
					</p>
					<p className="ant-upload-text">拖动文件到此区域上传</p>
					<p className="ant-upload-hint">
						支持单个或多个上传。
					</p>
				</Upload.Dragger>
			);



	}
}

export default ({
	commonApi,
	title,
	notice,
	columns,
	optionsPath,
	row,
	open,
	onClose,
	onFinish,
	okText,
	cancelText,
	loading,
	submitting‌,
}: TableCrudType) => {

	const [form] = Form.useForm();
	const formValues = Form.useWatch([], form);
	const [liveValues, setLiveValues] = useState<DataType>(row);
	const changedFields = useRef(new Set<string>());
	const [remoteOptions, setRemoteOptions] = useState<Record<string, TableSelectOption[]>>({});
	const [loadingOptions, setLoadingOptions] = useState<Record<string, boolean>>({});
	const remoteRequestKey = JSON.stringify(columns.filter((item) => item.remoteOptions).map((item) => [
		item.dataIndex,
		item.remoteOptions?.dependencies.map((field) => formValues?.[field] ?? null),
	]));
	const handleSubmit = () => {
		form.submit();
	};
	const applyOptionFieldValues = (column: ResJsonTableColumn, value: unknown, options?: TableSelectOption[]) => {
		const selectedValue = Array.isArray(value) ? value[0] : value;
		const option = options?.find((item) => item.value === selectedValue);
		if (!option?.fieldValues) return;
		form.setFieldsValue(option.fieldValues);
		setLiveValues((previous) => ({ ...previous, ...option.fieldValues }));
		for (const field of Object.keys(option.fieldValues)) changedFields.current.add(field);
	};

	useEffect(() => {
		if (open === false) {
			if (form.isFieldsTouched()) {
				form.resetFields();
			}
		}
	}, [open]);

	useEffect(() => {
		// 外部调用设置新的row值时，刷新新值
		changedFields.current.clear();
		form.resetFields();
		form.setFieldsValue(row);
		setLiveValues(row);
	}, [row]);

	useEffect(() => {
		if (!open || !optionsPath) return;
		const controller = new AbortController();
		const timer = window.setTimeout(async () => {
			for (const column of columns.filter((item) => item.remoteOptions)) {
				const request = column.remoteOptions!;
				const dependencies = Object.fromEntries(request.dependencies.map((field) => [field, form.getFieldValue(field)]));
				if (Object.values(dependencies).some((value) => value === undefined || value === null || value === '')) {
					setRemoteOptions((previous) => ({ ...previous, [column.dataIndex]: [] }));
					continue;
				}
				setRemoteOptions((previous) => ({ ...previous, [column.dataIndex]: [] }));
				setLoadingOptions((previous) => ({ ...previous, [column.dataIndex]: true }));
				try {
					const query = new URLSearchParams({ action: request.action, field: column.dataIndex });
					for (const [field, value] of Object.entries(dependencies)) query.set(field, String(value));
					const response = await commonApi.apiFetch(`${optionsPath}?${query}`, { signal: controller.signal });
					if (!response.ok) continue;
					const result = await response.json() as { options?: TableSelectOption[] };
					const options = result.options ?? [];
					setRemoteOptions((previous) => ({ ...previous, [column.dataIndex]: options }));
					if (options.length === 1 && !form.getFieldValue(column.dataIndex)) {
						const value = column.allowCustomValue ? [options[0].value] : options[0].value;
						form.setFieldValue(column.dataIndex, value);
						setLiveValues((previous) => ({ ...previous, [column.dataIndex]: value }));
						changedFields.current.add(column.dataIndex);
						applyOptionFieldValues(column, value, options);
					}
				} catch (error) {
					if (!(error instanceof DOMException && error.name === 'AbortError')) console.error('加载远程选项失败', error);
				} finally {
					setLoadingOptions((previous) => ({ ...previous, [column.dataIndex]: false }));
				}
			}
		}, 300);
		return () => { window.clearTimeout(timer); controller.abort(); };
	}, [open, optionsPath, remoteRequestKey]);

	const _onClose = async () => {
		if (form.isFieldsTouched()) {
			// 当表单内容有被修改时弹出[确认提示]
			if (!await commonApi.modalConfirm([
				'内容修改尚未保存，仍要离开吗？'
			], {
				okText: '离开',
				cancelText: '留下',
			})) {
				// 代表点了[取消]
				return;
			}
		}
		onClose();
	};

	return (<>
		<Drawer
			title={title}
			width={720}
			onClose={_onClose}
			open={open}
			styles={{
				body: {
					paddingBottom: 80,
				},
			}}
			extra={
				<Space>
					<Button onClick={_onClose}>{cancelText}</Button>
					<Button
						loading={submitting‌}
						disabled={loading}
						onClick={handleSubmit}
						type="primary"
					>
						{okText}
					</Button>
				</Space>
			}
			loading={loading}
		>
			{/*
			  * 这一行为什么动不了，进来就说清楚——按钮不藏，藏了只剩「不能改」，说了才知道
			  * 该去找谁。措辞与服务端拒绝时的那句一致（PendingLockError）。
			  */}
			{notice ? <Alert type="warning" showIcon message={notice} style={{ marginBottom: 16 }} /> : null}
			<Form
				layout="vertical"
				form={form}
				onValuesChange={(values, allValues) => {
					setLiveValues(allValues);
					for (const field of Object.keys(values)) changedFields.current.add(field);
					for (const changedField of Object.keys(values)) {
						for (const column of columns.filter((item) => item.remoteOptions?.dependencies.includes(changedField))) {
							for (const field of [column.dataIndex, ...(column.remoteOptions?.clearFields ?? [])]) {
								if (form.getFieldValue(field) !== undefined) {
									form.setFieldValue(field, undefined);
									changedFields.current.add(field);
								}
							}
						}
						for (const column of columns.filter((item) => item.dependsOn === changedField)) {
							if (column.parentValues && !column.parentValues.includes(values[changedField] as string | number | boolean)) {
								if (form.getFieldValue(column.dataIndex) !== undefined) {
									form.setFieldValue(column.dataIndex, undefined);
									changedFields.current.add(column.dataIndex);
								}
								continue;
							}
							const selectedValue = form.getFieldValue(column.dataIndex);
							const selectedOption = column.options?.find((option) => option.value === selectedValue);
							if (selectedValue && selectedOption?.parentValue !== values[changedField]) {
								form.setFieldValue(column.dataIndex, undefined);
								changedFields.current.add(column.dataIndex);
							}
						}
					}
				}}
				onFinish={(values) => {
					for (const column of columns) {
						if (!column.multiple && column.allowCustomValue && Array.isArray(values[column.dataIndex])) values[column.dataIndex] = values[column.dataIndex][0];
					}
					return onFinish({ ...values, [changedFieldsKey]: [...changedFields.current] } satisfies ChangedFieldsPayload & Record<string, unknown>);
				}}
				initialValues={row}
				disabled={submitting‌}
			>
				{(() => {
					// 任一列带 group 就把表单分成可切换的 Tab；没带 group 的列归到第一个分组。
					const groups = [...new Set(columns.map((item) => item.group).filter(Boolean))] as string[];
					const renderFields = (list: ResJsonTableColumn[]) => (<Row gutter={16}>
					{list.map((item) => {
						if (!item.component) {
							return;
						}
						if (item.dependsOn && item.parentValues && !item.parentValues.includes(formValues?.[item.dependsOn] as string | number | boolean)) return;
						const options = remoteOptions[item.dataIndex] ?? item.options;
						const sourceOptions = item.readOnlyWhen ? columns.find((column) => column.dataIndex === item.readOnlyWhen?.field)?.options : undefined;
						const readOnly = isFieldReadOnly(item.readOnlyWhen, item.readOnlyWhen ? liveValues[item.readOnlyWhen.field] : undefined, sourceOptions);
						const component = getFormItemComponent(item, row, item.dependsOn ? formValues?.[item.dependsOn] : undefined, remoteOptions[item.dataIndex], loadingOptions[item.dataIndex],
							(value) => applyOptionFieldValues(item, value, options), readOnly);
						if (!component) {
							return;
						}
						return (
							<Col key={item.dataIndex} span={24}>
								<Form.Item
									name={item.dataIndex}
									valuePropName={item.component === 'switch' ? 'checked' : undefined}
									getValueProps={item.component === 'switch' ? (value) => ({ checked: value === (item.checkedValue ?? true) }) : undefined}
									getValueFromEvent={item.component === 'switch' ? (checked: boolean) => checked ? (item.checkedValue ?? true) : (item.uncheckedValue ?? false) : undefined}
									label={(
										<Space size={2}>
											<span>{item.title}</span>
											<Button
												type="text"
												size="small"
												title="清空"
												icon={<ClearOutlined />}
									onClick={() => {
										form.setFields([{ name: item.dataIndex, value: null, touched: true }]);
										setLiveValues((previous) => ({ ...previous, [item.dataIndex]: null }));
													changedFields.current.add(item.dataIndex);
												}}
											/>
											<Button
												type="text"
												size="small"
												title="还原"
												icon={<RollbackOutlined />}
									onClick={() => {
										form.setFields([{ name: item.dataIndex, value: row[item.dataIndex], touched: false, errors: [] }]);
										setLiveValues((previous) => ({ ...previous, [item.dataIndex]: row[item.dataIndex] }));
													changedFields.current.delete(item.dataIndex);
												}}
											/>
										</Space>
									)}
									rules={item.rules}
								>
									{component}
								</Form.Item>
							</Col>
						);
					})}
					</Row>);
					if (!groups.length) return renderFields(columns);
					const fallbackGroup = groups[0];
					return <Tabs items={groups.map((group) => ({
						key: group,
						label: group,
						// forceRender 是必须的：Tab 默认懒渲染，没渲染过的 Form.Item 不会注册到表单，
						// 提交时那一组字段会整个丢掉——而用户根本没察觉自己漏填了什么。
						forceRender: true,
						children: renderFields(columns.filter((item) => (item.group ?? fallbackGroup) === group)),
					}))} />;
				})()}
				{/* 确定按钮在抽屉标题栏里，在 <form> 之外，因此表单里没有可提交的按钮，
				    回车不会触发浏览器的隐式提交。补一个隐藏的 submit 按钮把这条路接上——
				    它同时保留了原生语义：多行文本框里的回车仍然是换行，不会误提交。 */}
				<button type="submit" hidden aria-hidden="true" tabIndex={-1} />
			</Form>
		</Drawer>
	</>);
};

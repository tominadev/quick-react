import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Divider, Form, Input, List, Result, Selector, Switch, Tabs, Toast } from 'antd-mobile';
import type { CommonApi } from '@clients/browser/api.js';
import type { FormPageConfig, FormPageField, FormPageResponse, FormPageSection } from '@shared/types/form-page.mjs';
import { SECTION_FIELD } from '@shared/types/form-page.mjs';
import { changeControlHeaders } from '@shared/table-form.mjs';
import { applyApiResponseContext, runApiNextAction } from '@clients/browser/response-action.js';
import { isFieldReadOnly } from '@shared/field-linkage.mjs';

/**
 * 表单的手机版渲染。登录、设置、新增、编辑走的都是这一个——它们在协议上本来就是同一种
 * 东西（`formPage`），差别只在服务端下发了哪些字段。
 *
 * **协议照搬桌面版**：分段（`sections`）、只读联动（`readOnlyWhen`）、变更说明走请求头、
 * 完成后的去向由服务端的 `next` 决定。渲染上的取舍是手机自己的：选项用 `Selector` 平铺
 * 而不是下拉——小屏上点开一个下拉再滚动挑，比直接摆出来慢得多。
 */
const suffix = (window as Window & { __INITIAL_DATA__?: { apiSuffix?: string } }).__INITIAL_DATA__?.apiSuffix ?? '';

const FieldControl = ({ field, values }: { field: FormPageField; values: Record<string, unknown> }) => {
	const readOnly = isFieldReadOnly(field.readOnlyWhen, values);
	if (field.type === 'switch') return <Switch disabled={readOnly} />;
	if (field.type === 'select' || field.options?.length) {
		return <Selector
			columns={2}
			options={(field.options ?? []).map((option) => ({ label: option.text, value: option.value }))}
			disabled={readOnly}
		/>;
	}
	return <Input placeholder={field.placeholder} maxLength={field.maxLength} type={field.type === 'password' ? 'password' : 'text'} readOnly={readOnly} clearable />;
};

const SectionForm = ({ section, config, commonApi, apiPath, submitMethod, onCompleted }: {
	section: FormPageSection;
	config: FormPageConfig;
	commonApi: CommonApi;
	apiPath: string;
	submitMethod: 'POST' | 'PUT';
	onCompleted: () => void;
}) => {
	const [form] = Form.useForm();
	const [values, setValues] = useState<Record<string, unknown>>(config.initialValues ?? {});
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		form.setFieldsValue(config.initialValues ?? {});
		setValues(config.initialValues ?? {});
	}, [config.initialValues, form]);

	const submit = async () => {
		const raw = await form.validateFields().catch(() => undefined);
		if (!raw) return;
		/**
		 * 变更说明在确认框里问，走请求头——它不是业务字段，塞进请求体会和表单字段混在一起，
		 * 而删除那类接口的请求体是一个 id 数组，本来就没有地方塞。
		 */
		let headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (config.changeControl) {
			const control = await commonApi.modalConfirmWithReason([config.confirmChangedSubmit ?? '确认保存吗？']);
			if (!control) return;
			headers = { ...headers, ...changeControlHeaders(control) };
		}
		setSubmitting(true);
		try {
			const response = await commonApi.apiFetch(apiPath, { method: submitMethod, headers, body: JSON.stringify({ ...raw, [SECTION_FIELD]: section.key }) });
			const body = await response.json() as FormPageResponse;
			// 完成后的去向由服务端说了算（next），前端不按接口路径自己猜该跳哪。
			if (!body.next) applyApiResponseContext(body.context);
			// 统一协议执行器负责把 action 映射成界面行为，前端不自己解释 next 的内容。
			if (body.next) runApiNextAction(body.next, body.context);
			else onCompleted();
		} catch { /* 失败的提示由请求层统一弹出 */ }
		finally { setSubmitting(false); }
	};

	return (
		<Form
			form={form}
			layout="horizontal"
			onValuesChange={(_changed, all) => setValues(all as Record<string, unknown>)}
			footer={
				<>
					{section.submitHint && <div style={{ color: '#999', fontSize: 12, padding: '8px 0' }}>{section.submitHint}</div>}
					<Button block color="primary" loading={submitting} onClick={() => void submit()}>{section.submitLabel}</Button>
				</>
			}
		>
			{section.description && <div style={{ color: '#666', fontSize: 13, padding: '8px 12px' }}>{section.description}</div>}
			{section.fields.filter((field) => field.type !== 'hidden').map((field) => (
				<Form.Item
					key={field.name}
					name={field.name}
					label={field.label}
					extra={field.extra}
					rules={(field.rules ?? []).map((rule) => ({ required: rule.required, message: rule.message }))}
				>
					<FieldControl field={field} values={values} />
				</Form.Item>
			))}
		</Form>
	);
};

const MobileForm = ({ commonApi, apiPath, title, submitMethod = 'POST' }: { commonApi: CommonApi; apiPath: string; title?: string; submitMethod?: 'POST' | 'PUT' }) => {
	const [config, setConfig] = useState<FormPageConfig>();
	const [failed, setFailed] = useState(false);
	const path = `/api${apiPath}${suffix}`;

	const load = useMemo(() => async () => {
		try {
			const body = await (await commonApi.apiFetch(path)).json() as FormPageResponse;
			if (body.formPage) setConfig(body.formPage);
			else setFailed(true);
		} catch { setFailed(true); }
	}, [commonApi, path]);

	useEffect(() => { void load(); }, [load]);

	if (failed) return <Result status="error" title="这一页打不开" description="请稍后重试，或换电脑版看看。" />;
	if (!config) return null;

	// 单表单的页面在协议上也是一段，统一按段渲染——两套渲染路径迟早会漂移。
	const sections: FormPageSection[] = config.sections ?? [{
		key: '', title, fields: config.fields ?? [], submitLabel: config.submitLabel ?? '保存',
		description: config.description, submitHint: config.submitHint,
	}];

	const body = sections.length === 1
		? <SectionForm section={sections[0]} config={config} commonApi={commonApi} apiPath={path} submitMethod={submitMethod} onCompleted={() => void load()} />
		: config.sectionLayout === 'tabs'
			? (
				<Tabs>
					{sections.map((section) => (
						<Tabs.Tab key={section.key} title={section.title ?? section.key}>
							<SectionForm section={section} config={config} commonApi={commonApi} apiPath={path} submitMethod={submitMethod} onCompleted={() => void load()} />
						</Tabs.Tab>
					))}
				</Tabs>
			)
			: (
				<>
					{sections.map((section, index) => (
						<div key={section.key}>
							{index > 0 && <Divider>{section.divider ?? section.title}</Divider>}
							<SectionForm section={section} config={config} commonApi={commonApi} apiPath={path} submitMethod={submitMethod} onCompleted={() => void load()} />
						</div>
					))}
				</>
			);

	return (
		<div style={{ padding: 8 }}>
			{/* 置顶提示块讲的是「这里有件事在等你」，因此按钮跟内容放一起，不隔半屏。 */}
			{config.notice && (
				<Card title={config.notice.title} style={{ marginBottom: 8 }}>
					{(config.notice.lines ?? []).map((line, index) => <div key={index} style={{ fontSize: 13 }}>{line}</div>)}
					{(config.notice.actions ?? []).length > 0 && (
						<List style={{ marginTop: 8 }}>
							{(config.notice.actions ?? []).map((action) => (
								<List.Item key={action.key} onClick={async () => {
									if (action.confirm && !await commonApi.modalConfirm([action.confirm])) return;
									await commonApi.apiFetch(`${path}?action=${encodeURIComponent(action.key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
									Toast.show({ icon: 'success', content: '已处理' });
									void load();
								}}>{action.label}</List.Item>
							))}
						</List>
					)}
				</Card>
			)}
			{config.description && !config.sections && <div style={{ color: '#666', fontSize: 13, padding: '0 12px 8px' }}>{config.description}</div>}
			{body}
		</div>
	);
};

export default MobileForm;

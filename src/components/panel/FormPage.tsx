import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Divider, Form, Input, message, Modal, Select, Space, Spin, Switch, Tabs, Typography } from 'antd';
import { ClearOutlined, GoogleCircleFilled, RollbackOutlined, SendOutlined, UserOutlined, WechatFilled } from '@ant-design/icons';
import type { ChangeControlValues, CommonApi } from '@/utils/common/api.js';
import type { FormPageField, FormPageResponse, FormPageSection } from '@shared/types/form-page.mjs';
import { SECTION_FIELD } from '@shared/types/form-page.mjs';
import { CHANGE_CONTROL_FIELD, changeControlHeaders } from '@shared/table-form.mjs';
import { isFieldReadOnly, type FieldLinkOption } from '@shared/field-linkage.mjs';
import { changedFieldsKey, type ChangedFieldsPayload } from '@shared/types/changed-fields.mjs';
import { CountdownDisplay, formatCountdown } from '@/components/common/Countdown.js';
import { runAfterFeedback } from '@/utils/common/feedback.js';
import { loginWithAccountsPopup } from '@/utils/common/passport.js';
import { runApiNextAction } from '@/utils/common/response-action.js';
import { isSystemField } from '@shared/system-fields.mjs';
import { describeFormChanges } from './form-changes.js';
import { WITHDRAW_ACTION } from '@shared/table-form.mjs';

const renderTemplate = (template: string, values: Record<string, React.ReactNode>) => template
	.split(/(\{[^{}]+\})/g)
	.map((part, index) => {
		const match = /^\{([^{}]+)\}$/.exec(part);
		return match && match[1] in values ? <React.Fragment key={`${part}-${index}`}>{values[match[1]]}</React.Fragment> : part;
	});

type FormResponse = FormPageResponse;

/**
 * 一段独立的表单。每段一个 antd Form 实例，两段因此可以有同名字段——
 * 「新建账号」和「绑定已有账号」都要填用户名，共用一个 Form 的话后填的会覆盖先填的，
 * 而且必填校验会互相牵连。
 */
function SectionForm({ section, initialValues, submitting, onSubmit }: {
	section: FormPageSection;
	initialValues: Record<string, unknown>;
	submitting: boolean;
	onSubmit: (key: string, values: Record<string, unknown>) => Promise<void>;
}) {
	const [form] = Form.useForm();
	// 保存成功后服务端会回一份新的 formPage（例如密码设过之后那一段要多出「当前密码」），
	// 而 antd 的 initialValues 只在挂载时生效。按对象身份同步一次：正常打字时
	// formConfig.initialValues 的身份不变，不会把用户输入冲掉。
	// 只认自己这一段的字段：整份 initialValues 套上去的话，别的选项卡里正在输入的
	// 内容会被一起重置。缺的键也不碰——服务端只回本段字段时，其余段保持原样。
	useEffect(() => {
		const own = Object.fromEntries(section.fields
			.map((field) => field.name)
			.filter((name) => name in initialValues)
			.map((name) => [name, initialValues[name]]));
		if (Object.keys(own).length) form.setFieldsValue(own);
	}, [initialValues]);
	return <>
		{section.divider ? <Divider plain style={{ color: '#8c8c8c' }}>{section.divider}</Divider> : null}
		{section.description ? <Alert type="info" showIcon message={section.description} style={{ marginBottom: 16 }} /> : null}
		<Form form={form} layout="vertical" initialValues={initialValues} onFinish={(values) => onSubmit(section.key, values as Record<string, unknown>)}>
			{section.fields.map((field) => field.type === 'hidden'
				? <Form.Item key={field.name} name={field.name} hidden><Input /></Form.Item>
				: <Form.Item key={field.name} label={field.label} name={field.name} extra={field.extra} rules={field.rules}>{fieldControl(field, false)}</Form.Item>)}
			{section.submitHint ? <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>{section.submitHint}</Typography.Paragraph> : null}
			<Button type="primary" htmlType="submit" loading={submitting}>{section.submitLabel}</Button>
		</Form>
	</>;
}

type FormProps = {
	commonApi: CommonApi;
	apiPath: string;
	title: React.ReactNode;
	submitMethod?: 'POST' | 'PUT';
	redirectOnFeedback?: boolean;
	onSaved?: (values: Record<string, unknown>) => string | undefined | Promise<string | undefined>;
	onCompleted?: () => void | Promise<void>;
	/** 每次拿到接口响应都回调一次（首次加载与每次提交）。上层据此刷新表单之外的内容。 */
	onResponse?: (result: FormPageResponse) => void;
	embedded?: boolean;
	/** API 启动模式下由首个页面请求携带的表单响应，避免重复读取同一接口。 */
	initialResponse?: FormResponse;
};

/** 第三方登录图标按 key 渲染，未登记的身份源用通用图标兜底。 */
const externalLoginIcons: Record<string, { icon: React.ReactNode; color: string }> = {
	wechat: { icon: <WechatFilled />, color: '#07C160' },
	google: { icon: <GoogleCircleFilled />, color: '#4285F4' },
	telegram: { icon: <SendOutlined />, color: '#229ED9' },
};

/**
 * 选项卡记在地址栏的查询串里，刷新后还能回到原来那一页。
 *
 * 用 history.replaceState 而不是 react-router 的 useSearchParams：FormPage 在浏览器
 * 测试里是不套 Router 直接渲染的，用 router 的 hook 会当场抛。只改查询串不动路径，
 * 路由匹配因此不受影响。
 *
 * replaceState 而非 pushState：切三次选项卡再按后退，应该离开这个页面，
 * 而不是在几个选项卡之间倒着走。
 */
const SECTION_QUERY = 'tab';
const sectionFromLocation = () => {
	if (typeof window === 'undefined') return undefined;
	try { return new URLSearchParams(window.location.search).get(SECTION_QUERY) ?? undefined; }
	catch { return undefined; }
};
const rememberSection = (key: string) => {
	if (typeof window === 'undefined') return;
	try {
		const url = new URL(window.location.href);
		url.searchParams.set(SECTION_QUERY, key);
		window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
	} catch { /* 地址栏不可写时（例如测试环境）静默跳过：选项卡本身照常工作。 */ }
};

const hasInitialValue = (value: unknown) => value !== undefined && value !== null && value !== '' && value !== false;

/** apiPath 可能已经带查询串（例如登录页的 ?mode=sign），必须按 URL 规则追加 action。 */
const actionPath = (apiPath: string, action: string) => {
	const url = new URL(apiPath, window.location.origin);
	url.searchParams.set('action', action);
	return `${url.pathname}${url.search}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
	Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const fieldControl = (field: FormPageField, readOnly: boolean) => {
	if (field.type === 'switch') return <Switch checkedChildren={field.checkedChildren} unCheckedChildren={field.unCheckedChildren} />;
	if (field.type === 'select') return <Select options={field.options?.map((option) => ({ value: option.value, label: option.text }))} placeholder={field.placeholder} />;
	return <Input type={field.type === 'password' ? 'password' : 'text'} placeholder={field.placeholder} maxLength={field.maxLength} readOnly={readOnly} disabled={readOnly} />;
};

export default function FormPage({ commonApi, apiPath, title, submitMethod = 'PUT', redirectOnFeedback = false, onSaved, onCompleted, onResponse, embedded = false, initialResponse }: FormProps) {
	const [form] = Form.useForm<Record<string, unknown>>();
	const [messageApi, messageContextHolder] = message.useMessage();
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [runningAction, setRunningAction] = useState<string>();
	const [formConfig, setFormConfig] = useState<FormResponse['formPage']>();
	const [initialValues, setInitialValues] = useState<Record<string, unknown>>({});
	const [liveValues, setLiveValues] = useState<Record<string, unknown>>({});
	const [dirty, setDirty] = useState(false);
	const [refreshTarget, setRefreshTarget] = useState<string>();
	const refreshSchedule = useRef<{ cancel: () => void } | undefined>(undefined);
	const [refreshDeadline, setRefreshDeadline] = useState<number>();
	const [refreshCancelled, setRefreshCancelled] = useState(false);
	const [saved, setSaved] = useState(false);
	const [responseFeedback, setResponseFeedback] = useState<FormResponse['feedback']>();
	const [passportError, setPassportError] = useState('');
	const [activeSection, setActiveSection] = useState<string | undefined>(sectionFromLocation);
	const changedFields = useRef(new Set<string>());
	const restoreDefaultsPending = useRef(false);
	const applyFormPageResponse = (result: FormResponse) => {
		if (!result.formPage) return;
		const values = isRecord(result.currentValues) ? result.currentValues : result.formPage.initialValues;
		setFormConfig(result.formPage);
		setInitialValues(values);
		setLiveValues(values);
		restoreDefaultsPending.current = false;
		setDirty(false);
		changedFields.current.clear();
		form.setFieldsValue(values);
	};

	useEffect(() => {
		setLoading(true);
		setSaved(false);
		setRefreshTarget(undefined);
		setRefreshDeadline(undefined);
		setRefreshCancelled(false);
		setResponseFeedback(undefined);
		setPassportError('');
		restoreDefaultsPending.current = false;
		setFormConfig(undefined);
		setInitialValues({});
		setLiveValues({});
		form.resetFields();
		messageApi.destroy('form-feedback');
	}, [apiPath, messageApi]);

	useEffect(() => {
		if (!saved || feedback?.component !== 'message') return;
		const feedbackMessage = feedback.message ?? '';
		const countdown = refreshDeadline && refreshTarget
			? <CountdownDisplay deadline={refreshDeadline} onFinish={() => undefined} />
			: null;
		const refreshValue = countdown ?? (refreshDeadline ? formatCountdown(Math.max(0, refreshDeadline - Date.now())) : '');
		const content = renderTemplate(feedbackMessage, { redirectAfter: refreshValue });
		messageApi.open({ key: 'form-feedback', type: feedback.type ?? 'success', content, duration: 0 });
		return () => messageApi.destroy('form-feedback');
	}, [formConfig, messageApi, refreshDeadline, refreshTarget, responseFeedback, saved]);

	useEffect(() => {
		if (initialResponse) {
			applyFormPageResponse(initialResponse);
			setLoading(false);
			return;
		}
		// 注意：走到这里说明上层没有给出响应，本组件自己去取。同一个接口若还有别的消费者，
		// 应由上层取一次后通过 initialResponse 传进来，否则一进页面就是两次请求。
		let active = true;
		commonApi.apiFetch(apiPath).then(async (response) => {
			const result = await response.json() as FormResponse;
			if (active) applyFormPageResponse(result);
		}).catch((error) => console.error(`加载配置失败: ${apiPath}`, error)).finally(() => {
			if (active) setLoading(false);
		});
		return () => { active = false; };
	}, [apiPath, commonApi, form, initialResponse]);

	// 后端返回新的 formPage 表示流程还在继续，这时不安排跳转，避免多步表单在中间步骤被反馈倒计时带走。
	const applyResult = async (result: FormResponse, values: Record<string, unknown>) => {
		Modal.destroyAll();
		onResponse?.(result);
		setResponseFeedback(result.feedback);
		if (result.formPage) {
			const nextValues = isRecord(result.currentValues) ? result.currentValues : result.formPage.initialValues;
			setFormConfig(result.formPage);
			setInitialValues(nextValues);
			setLiveValues(nextValues);
			form.resetFields();
			form.setFieldsValue(nextValues);
		}
		// 弹窗里的流程结束后先尝试关闭窗口，关不掉（不是脚本打开的窗口）再回落到跳转。
		if (result.closeWindow) {
			window.close();
			if (result.redirectTo) window.setTimeout(() => { if (!window.closed) window.location.assign(result.redirectTo!); }, 300);
			return;
		}
		if (result.openWindow && result.redirectTo) {
			const popup = window.open(result.redirectTo, 'accounts_email_bind', 'width=480,height=680,resizable=yes,scrollbars=yes');
			if (!popup) setPassportError('授权窗口被浏览器拦截');
			return;
		}
		const target = result.redirectTo ?? (result.formPage ? undefined : await onSaved?.(values));
		const savedValues = isRecord(result.currentValues) ? result.currentValues : values;
		setInitialValues(savedValues);
		changedFields.current.clear();
		setDirty(false);
		setSaved(true);
		if (!result.formPage) {
			if (onCompleted) await onCompleted();
			if (result.next) { runApiNextAction(result.next, result.context); return; }
			if (onCompleted) return;
		}
		if (target && result.feedback && (redirectOnFeedback || result.feedback.redirectAfter !== undefined)) {
			const schedule = runAfterFeedback(result.feedback, () => window.location.assign(target));
			refreshSchedule.current = schedule;
			setRefreshCancelled(false);
			setRefreshTarget(target);
			setRefreshDeadline(schedule.deadline);
		}
	};

	// 登录、注册这类不留痕的页面不注入变更说明；服务端按路径决定。
	// 变更说明不再当成表单里的一个字段：它不是配置项，混在字段中间既容易被当成要填的内容，
	// 又会跟着「还原默认」一起被重置。改成在提交前的确认框里收集。
	const controlFields: FormPageField[] = [];
	const controlHeaders = (control: ChangeControlValues | undefined) => changeControlHeaders(control);
	const controlNames = [CHANGE_CONTROL_FIELD];

	const onFinish = async (values: Record<string, unknown>) => {
		// 判据是「显示出来真的不一样」，而不是「这个字段被标记过」。
		//
		// 「还原默认」会把每个字段都标记成已改，不管值有没有真的变；用户打一个字又删掉
		// 也会留下标记。照标记列的话，确认框里全是「8088 → 8088」这种自说自话的行。
		// 确认框里一并收集变更说明：改了什么、为什么改，在同一个地方问完。
		// **没改动就不问原因**：一次什么都没变的提交没有「原因」可言，摆个必填框只会逼人瞎写。
		//
		// 整个确认步骤只在管理后台出现（`changeControl` 由服务端按 `/api/panel/admin/` 注入）。
		// 注册页也是一个 FormPage，不判这一下的话，填完用户名密码点提交会先弹出
		// 「将保存以下修改：用户名：空 → admin，密码：空 → 123」——把刚输入的密码
		// 原样念一遍给用户看，而这既不是修改也没有留痕，压根没有可确认的东西。
		let control: ChangeControlValues | undefined;
		if (formConfig?.changeControl) {
			// 判据是「显示出来真的不一样」，而不是「这个字段被标记过」。
			//
			// 「还原默认」会把每个字段都标记成已改，不管值有没有真的变；用户打一个字又删掉
			// 也会留下标记。照标记列的话，确认框里全是「8088 → 8088」这种自说自话的行。
			const changedLines = describeFormChanges(formConfig.fields, changedFields.current, initialValues, values, controlNames);
			if (changedLines.length) {
				control = await commonApi.modalConfirmWithReason([formConfig.confirmChangedSubmit ?? '将保存以下修改，确认继续吗？', ...changedLines]);
				if (control === undefined) return;
			} else if (formConfig.confirmOnUnchangedSubmit) {
				if (!await commonApi.modalConfirm([formConfig.confirmOnUnchangedSubmit])) return;
			}
		}
		setSaving(true);
		try {
			// 控制字段摘出去改走请求头：它们不是配置项，不该混进保存的值里。
			const { [CHANGE_CONTROL_FIELD]: _control, ...submitted } = values;
			const payload = { ...submitted, [changedFieldsKey]: [...changedFields.current].filter((name) => !controlNames.includes(name)), ...(restoreDefaultsPending.current ? { restoreDefaults: true } : {}) };
			const response = await commonApi.apiFetch(apiPath, {
				method: submitMethod,
				headers: { 'Content-Type': 'application/json', ...controlHeaders(control) },
				body: JSON.stringify(payload satisfies ChangedFieldsPayload & Record<string, unknown>),
			});
			await applyResult(await response.json() as FormResponse, values);
			restoreDefaultsPending.current = false;
		} catch (error) {
			console.error(`保存配置失败: ${apiPath}`, error);
		} finally {
			setSaving(false);
		}
	};
	const runAction = async (key: string) => {
		// 提示块里的按钮也要能确认——撤回、批准、驳回都会立刻改动数据或否掉别人的申请，
		// 只在 formConfig.actions 里找的话它们会一声不吭地执行。
		const action = formConfig?.actions?.find((item) => item.key === key)
			?? formConfig?.notice?.actions?.find((item) => item.key === key);
		// 「恢复默认」只是把表单填成默认值，一个字都没写到服务端，因此既不问原因也不留痕
		// ——真正的写入发生在之后点「保存」的时候，那一步才该问。所以它排在问原因之前。
		if (key === 'restore-defaults') {
			if (action?.confirm && !await commonApi.modalConfirm([action.confirm])) return;
			const defaults = formConfig?.defaultValues;
			if (!defaults || !formConfig) {
				await commonApi.modalError(['当前页面没有提供可恢复的默认值']);
				return;
			}
			form.resetFields();
			form.setFieldsValue(defaults);
			const fieldNames = (formConfig.fields ?? []).filter((field) => !isSystemField(field.name)).map((field) => field.name);
			const nextValues = form.getFieldsValue(true) as Record<string, unknown>;
			setLiveValues(nextValues);
			changedFields.current = new Set(fieldNames);
			restoreDefaultsPending.current = true;
			setDirty(true);
			setSaved(false);
			setResponseFeedback(undefined);
			messageApi.open({ key: 'form-restore-defaults', type: 'success', content: '已恢复默认，请点击“保存配置”使其生效。', duration: 2 });
			return;
		}
		// 其余动作会发到服务端。撤销自己的申请不问原因——那是把自己提的东西收回去，
		// 不需要向谁交代；批准与驳回要问，那是给申请人的答复，记进审批意见。
		let control: ChangeControlValues | undefined;
		if (formConfig?.changeControl && action?.confirm && key !== WITHDRAW_ACTION) {
			control = await commonApi.modalConfirmWithReason([action.confirm]);
			if (control === undefined) return;
		} else if (action?.confirm && !await commonApi.modalConfirm([action.confirm])) return;
		setRunningAction(key);
		const values = form.getFieldsValue(true) as Record<string, unknown>;
		const { [CHANGE_CONTROL_FIELD]: _actionControl, ...actionValues } = values;
		try {
			const response = await commonApi.apiFetch(actionPath(apiPath, key), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...controlHeaders(control) },
				body: JSON.stringify({ ...actionValues, [changedFieldsKey]: [...changedFields.current].filter((name) => !controlNames.includes(name)) } satisfies ChangedFieldsPayload & Record<string, unknown>),
			});
			await applyResult(await response.json() as FormResponse, values);
		} catch (error) {
			console.error(`执行配置操作失败: ${apiPath}?action=${key}`, error);
		} finally {
			setRunningAction(undefined);
		}
	};

	/** 分段提交：只发本段的字段，外加 _section 标明走的是哪条路。 */
	const submitSection = async (key: string, values: Record<string, unknown>) => {
		setSaving(true);
		try {
			const response = await commonApi.apiFetch(apiPath, {
				method: submitMethod,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...values, [SECTION_FIELD]: key }),
			});
			await applyResult(await response.json() as FormResponse, values);
		} catch (error) {
			console.error(`提交表单分段失败: ${apiPath}#${key}`, error);
		} finally {
			setSaving(false);
		}
	};

	const feedback = responseFeedback;
	const feedbackMessage = feedback?.message ?? '';
	const alertCountdown = refreshDeadline && refreshTarget
		? <CountdownDisplay deadline={refreshDeadline} onFinish={() => undefined} />
		: null;
	const refreshValue = alertCountdown ?? (refreshDeadline ? formatCountdown(Math.max(0, refreshDeadline - Date.now())) : '');
	const feedbackContent = renderTemplate(feedbackMessage, { redirectAfter: refreshValue });
	const inlineFeedback = saved && feedback?.component === 'inline'
			? <Alert type={feedback.type ?? 'success'} showIcon={feedback.showIcon} message={feedbackContent} style={{ marginBottom: 24 }} />
		: null;
	const loginWithPassport = async () => {
		setPassportError('');
		try {
			const result = await loginWithAccountsPopup();
			runApiNextAction(result.next, result.context);
		} catch (error) {
			if ((error as Error & { silent?: boolean })?.silent) return;
			setPassportError(error instanceof Error ? error.message : 'Passport 登录失败');
		}
	};
	const modalFeedback = saved && !refreshCancelled && feedback?.component === 'modal' ? (
		<Modal
			open
			title={feedback.title ?? ''}
			okText={feedback.refreshNowLabel}
			cancelText={feedback.cancelRefreshLabel}
			onOk={() => window.location.assign(refreshTarget ?? window.location.href)}
			onCancel={() => { refreshSchedule.current?.cancel(); setRefreshCancelled(true); }}
		>
			{feedbackContent}
		</Modal>
	) : null;

	const content = <>
		{messageContextHolder}
		{modalFeedback}
		{inlineFeedback}
		{/* 跳转到 Accounts 必须由用户点击确认，页面不会自动跳走。 */}
		{formConfig?.passportLogin?.enabled ? <div style={{ marginBottom: 16 }}>
			<Button type="primary" onClick={loginWithPassport}>使用 Passport 登录</Button>
			{passportError ? <Alert type="error" showIcon message={passportError} style={{ marginTop: 12 }} /> : null}
		</div> : null}
		{/* 置顶提示块：按钮跟内容放在一起——「有 3 项修改在等审批」和「批准 / 驳回」
		    隔着半屏的话，人得先看懂上面那句再去下面找按钮。 */}
		{formConfig?.notice ? <Alert
			type={formConfig.notice.type ?? 'warning'}
			showIcon
			style={{ marginBottom: 24 }}
			message={<strong>{formConfig.notice.title}</strong>}
			description={<Space direction="vertical" size={12} style={{ width: '100%' }}>
				{formConfig.notice.lines?.length ? <div style={{ whiteSpace: 'pre-wrap' }}>{formConfig.notice.lines.join('\n')}</div> : null}
				{formConfig.notice.actions?.length ? <Space wrap>
					{formConfig.notice.actions.map((action) => <Button
						key={action.key}
						danger={action.danger}
						loading={runningAction === action.key}
						disabled={saving || Boolean(runningAction)}
						onClick={() => runAction(action.key)}
					>{action.label}</Button>)}
				</Space> : null}
			</Space>}
		/> : null}
		{formConfig?.description ? <Alert type="info" showIcon message={formConfig.description} style={{ marginBottom: 24 }} /> : null}
		{formConfig?.sections?.length ? (formConfig.sectionLayout === 'tabs' ? (
			// 每段自带一个 Form 实例，选项卡切走也不会互相牵连，因此不需要 forceRender。
			<Tabs
				// 地址栏里的 tab 对不上任何一段时（页面改版、手工改过地址）回落到第一段，
				// 而不是显示一个空白的选项卡。
				activeKey={formConfig.sections.some((section) => section.key === activeSection) ? activeSection : formConfig.sections[0].key}
				onChange={(key) => { setActiveSection(key); rememberSection(key); }}
				items={formConfig.sections.map((section) => ({
					key: section.key,
					label: section.title ?? section.key,
					children: <SectionForm section={section} initialValues={formConfig.initialValues} submitting={saving} onSubmit={submitSection} />,
				}))}
			/>
		) : formConfig.sections.map((section) => (
			<SectionForm key={section.key} section={section} initialValues={formConfig.initialValues} submitting={saving} onSubmit={submitSection} />
		))) : <Form
			form={form}
			layout="vertical"
			onFinish={onFinish}
			initialValues={formConfig?.initialValues}
			onValuesChange={(changedValues, allValues) => {
				restoreDefaultsPending.current = false;
				setLiveValues(allValues);
				for (const field of Object.keys(changedValues)) changedFields.current.add(field);
				for (const [name, value] of Object.entries(changedValues)) {
					const option = formConfig?.fields?.find((field) => field.name === name)?.options?.find((item) => item.value === String(value));
					if (option?.fieldValues) {
						form.setFieldsValue(option.fieldValues);
						setLiveValues((previous) => ({ ...previous, ...option.fieldValues }));
						for (const field of Object.keys(option.fieldValues)) changedFields.current.add(field);
					}
				}
				setDirty(changedFields.current.size > 0);
			}}
		>
			{[...(formConfig?.fields ?? []), ...controlFields].filter((field) => !isSystemField(field.name)).map((field) => field.type === 'hidden' ? (
				<Form.Item key={field.name} name={field.name} hidden><Input /></Form.Item>
			) : (() => {
				const sourceOptions = field.readOnlyWhen ? formConfig?.fields?.find((candidate) => candidate.name === field.readOnlyWhen?.field)?.options as FieldLinkOption[] | undefined : undefined;
				const readOnly = isFieldReadOnly(field.readOnlyWhen, field.readOnlyWhen ? liveValues[field.readOnlyWhen.field] : undefined, sourceOptions);
				return (
				<Form.Item
					key={field.name}
					label={(
						<Space size={2}>
							<span>{field.label}</span>
							{/* 开关只提供还原；其他字段同时提供清空和还原。 */}
							<>
								{field.type === 'switch' ? null : <Button
									type="text"
									size="small"
									title="清空"
									icon={<ClearOutlined />}
									onClick={() => {
										form.setFields([{ name: field.name, value: field.type === 'switch' ? false : null, touched: true }]);
										setLiveValues((previous) => ({ ...previous, [field.name]: field.type === 'switch' ? false : null }));
										changedFields.current.add(field.name);
										setDirty(true);
									}}
								/>}
								{(field.type === 'switch' || hasInitialValue(initialValues[field.name]) || field.defaultValue !== undefined) ? <Button
									type="text"
									size="small"
									title="还原"
									icon={<RollbackOutlined />}
									onClick={() => {
									const hasSavedValue = hasInitialValue(initialValues[field.name]);
									const restoreValue = field.defaultValue !== undefined ? field.defaultValue : initialValues[field.name];
									form.setFields([{ name: field.name, value: restoreValue, touched: false, errors: [] }]);
									setLiveValues((previous) => ({ ...previous, [field.name]: restoreValue }));
										if (hasSavedValue && field.defaultValue === undefined) changedFields.current.delete(field.name);
										else changedFields.current.add(field.name);
										setDirty(changedFields.current.size > 0);
									}}
								/> : null}
							</>
						</Space>
					)}
					name={field.name}
					extra={field.extra}
					valuePropName={field.type === 'switch' ? 'checked' : 'value'}
					rules={field.rules}
				>
					{fieldControl(field, readOnly)}
				</Form.Item>
				);
			})())}
			<Space>
				{formConfig?.actions?.map((action) => <Button key={action.key} loading={runningAction === action.key} disabled={saving || Boolean(runningAction)} onClick={() => runAction(action.key)}>{action.label}</Button>)}
				{!formConfig?.passportLogin?.enabled && formConfig?.submitLabel ? <Button type="primary" htmlType="submit" loading={saving}>{formConfig.submitLabel}</Button> : null}
				{formConfig?.submitHint ? <Typography.Text type="secondary">{formConfig.submitHint}</Typography.Text> : null}
			</Space>
		</Form>}
		{formConfig?.externalLogins?.length ? <>
			<Divider plain style={{ marginTop: 8, color: '#8c8c8c' }}>或使用以下方式登录</Divider>
			<Space size={28} wrap style={{ width: '100%', justifyContent: 'center' }}>
				{formConfig.externalLogins.map((item) => {
					const brand = externalLoginIcons[item.key];
					return <Typography.Link
						key={item.key}
						title={item.label}
						disabled={saving || Boolean(runningAction)}
						onClick={() => runAction(`provider:${item.key}`)}
						style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 6, color: 'inherit' }}
					>
						<span style={{ fontSize: 34, lineHeight: 1, color: brand?.color ?? '#8c8c8c' }}>{brand?.icon ?? <UserOutlined />}</span>
						<Typography.Text type="secondary" style={{ fontSize: 12 }}>{item.label}</Typography.Text>
					</Typography.Link>;
				})}
			</Space>
		</> : null}
	</>;
	return embedded ? <Spin spinning={loading}>{content}</Spin> : <Card title={title} loading={loading}>{content}</Card>;
}

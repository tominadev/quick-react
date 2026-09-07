import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Form, Input, Modal, Space } from 'antd-mobile';
import type { CommonApi } from '@clients/browser/api.js';
import type { AuthState, HeaderAction } from '@shared/types/initial-data.mjs';
import { runApiNextAction } from '@clients/browser/response-action.js';
import { isSilentPassportError, loginWithAccountsPopup, logoutWithAccounts } from '@clients/browser/passport.js';

/**
 * 顶栏上的身份与登录/退出。
 *
 * **动作由服务端下发**（`auth.actions`），前端只负责执行——哪些入口可用取决于站点开没开
 * 本站登录、绑没绑 Accounts、当前登录没登录，那是服务端算出来的。按钮 key 去猜的话，
 * 每加一种登录方式都要回来改前端，而漏改的表现是「那个站点上没有登录入口」。
 *
 * 与桌面版的差别只在长相：桌面版把它们摆在右上角，手机上屏幕窄，登录表单用整屏的
 * `Modal` 而不是小弹窗。
 */
const apiSuffix = (window as Window & { __INITIAL_DATA__?: { apiSuffix?: string } }).__INITIAL_DATA__?.apiSuffix ?? '';
const pageSuffix = (window as Window & { __INITIAL_DATA__?: { pageSuffix?: string } }).__INITIAL_DATA__?.pageSuffix ?? '';

type AuthRefreshResult = { next?: unknown; context?: unknown };

const AuthBar = ({ auth, commonApi }: { auth?: AuthState; commonApi: CommonApi }) => {
	const navigate = useNavigate();
	const [loginOpen, setLoginOpen] = useState(false);
	const [form] = Form.useForm();
	const [submitting, setSubmitting] = useState(false);
	if (!auth) return null;

	const localLogin = async () => {
		const values = await form.validateFields().catch(() => undefined);
		if (!values) return;
		setSubmitting(true);
		try {
			const response = await commonApi.apiFetch(`/api/sign${apiSuffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
			const result = await response.json() as AuthRefreshResult;
			setLoginOpen(false);
			runApiNextAction(result.next as never, result.context as never);
		} catch { /* 失败提示由请求层统一弹出 */ }
		finally { setSubmitting(false); }
	};

	const execute = async (action: HeaderAction) => {
		if (action.action === 'navigate') { navigate(action.key === '/' ? '/' : action.key + pageSuffix); return; }
		if (action.action === 'local-login') { setLoginOpen(true); return; }
		if (action.action === 'accounts-login') {
			// 弹窗登录：当前页面留在原地，登录成功后由后端指令软切换并更新认证状态。
			try { const result = await loginWithAccountsPopup(); runApiNextAction(result.next, result.context); }
			catch (error) { if (!isSilentPassportError(error)) await commonApi.modalError([error instanceof Error ? error.message : 'Accounts 登录失败']); }
			return;
		}
		if (action.action === 'local-logout' || action.action === 'all-logout') {
			const path = action.action === 'local-logout' ? `/api/sign${apiSuffix}?logout=local` : `/api/sign${apiSuffix}`;
			try {
				const result = await (await commonApi.apiFetch(path, { method: 'DELETE' })).json() as AuthRefreshResult;
				runApiNextAction(result.next as never, result.context as never);
			} catch (error) { await commonApi.modalError([error instanceof Error ? error.message : '退出失败']); }
			return;
		}
		try {
			const result = await logoutWithAccounts({ signInPath: `/api/accounts/sign${apiSuffix}` }) as AuthRefreshResult;
			runApiNextAction(result.next as never, result.context as never);
		} catch (error) { await commonApi.modalError([error instanceof Error ? error.message : '退出登录失败']); }
	};

	return (
		<>
			<Space>
				{auth.currentUser && <span style={{ fontSize: 13, color: '#666' }}>{auth.currentUser.profile_nickname ?? auth.currentUser.user_name}</span>}
				{auth.actions.map((action) => (
					<Button key={action.key} size="mini" fill="none" color="primary" onClick={() => void execute(action)}>{action.label}</Button>
				))}
			</Space>
			<Modal
				visible={loginOpen}
				title="登录"
				closeOnMaskClick
				onClose={() => setLoginOpen(false)}
				content={
					<Form form={form} layout="horizontal" footer={<Button block color="primary" loading={submitting} onClick={() => void localLogin()}>登录</Button>}>
						<Form.Item name="user_name" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}><Input placeholder="用户名" clearable /></Form.Item>
						<Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}><Input placeholder="密码" type="password" /></Form.Item>
					</Form>
				}
			/>
		</>
	);
};

export default AuthBar;

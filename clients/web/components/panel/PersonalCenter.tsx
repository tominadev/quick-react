import { Alert, Button, Card, Descriptions } from 'antd';
import { useEffect, useState } from 'react';
import type { CommonApi } from '@/utils/common/api.js';
import type { AccountCenterLink, UserIdentity } from '@shared/types/user.mjs';
import { roleLabel } from '@shared/types/role.mjs';
import type { FormPageResponse } from '@shared/types/form-page.mjs';
import FormPage from './FormPage.js';

const initialData = (window as Window & { __INITIAL_DATA__?: { apiSuffix?: string } }).__INITIAL_DATA__;
const apiSuffix = initialData?.apiSuffix ?? '';
type PersonalCenterProps = { commonApi: CommonApi; user?: UserIdentity; title: string; initialResponse?: MeResponse };
type MeResponse = FormPageResponse & { user?: UserIdentity; accountsNotice?: string; accountsCenter?: AccountCenterLink };

/**
 * 个人中心：上半截展示当前身份，下半截是可编辑的三段表单。
 *
 * 两截共用 `/api/panel/user/base/me` 一个接口，所以这里**只取一次**，再把响应交给 FormPage——
 * 让 FormPage 自己去取的话，一进页面就是两次一模一样的请求。
 */
export default function PersonalCenter({ commonApi, user: initialUser, title, initialResponse }: PersonalCenterProps) {
	const [response, setResponse] = useState<MeResponse | undefined>(initialResponse);
	const [user, setUser] = useState<UserIdentity | undefined>(initialResponse?.user ?? initialUser);
	useEffect(() => {
		if (initialResponse) {
			setResponse(initialResponse);
			if (initialResponse.user) setUser(initialResponse.user);
			return;
		}
		let active = true;
		commonApi.apiFetch(`/api/panel/user/base/me${apiSuffix}`).then(async (result) => {
			const data = await result.json() as MeResponse;
			if (!active) return;
			setResponse(data);
			if (data.user) setUser(data.user);
		}).catch((error) => console.error('加载个人中心信息失败', error));
		return () => { active = false; };
	}, [commonApi, initialResponse]);
	return (
		<Card title={title} style={{ maxWidth: 720, margin: '24px auto' }}>
			{response?.accountsNotice ? <Alert
				type="info"
				showIcon
				style={{ marginBottom: 16 }}
				message={response.accountsNotice}
				action={response.accountsCenter ? <Button href={response.accountsCenter.url} target="_blank" rel="noopener noreferrer">{response.accountsCenter.label}</Button> : undefined}
			/> : null}
			<Descriptions column={1} bordered>
				<Descriptions.Item label="用户名">{user?.user_name ?? '—'}</Descriptions.Item>
				<Descriptions.Item label="昵称">{user?.profile_nickname ?? '—'}</Descriptions.Item>
				<Descriptions.Item label="角色">{user?.roles.map(roleLabel).join('、') || '—'}</Descriptions.Item>
			</Descriptions>
			{/* 响应到手才渲染表单：早渲染的话 FormPage 会自己再请求一次同一个接口。
			    改完用户名或昵称后，保存响应里带着新身份，上面那块跟着更新。 */}
			{response ? <FormPage
				commonApi={commonApi}
				apiPath={`/api/panel/user/base/me${apiSuffix}`}
				title=""
				submitMethod="PUT"
				initialResponse={response}
				onResponse={(result) => { const next = (result as MeResponse).user; if (next) setUser(next); }}
			/> : null}
		</Card>
	);
}

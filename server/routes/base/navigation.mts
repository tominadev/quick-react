import type { NavigationItem } from '@shared/types/navigation.mjs';
import { resolveNavigationPaths } from '@shared/navigation-tree.mjs';
export type MenuNode = NavigationItem;

const rawSiteNavigation = (): MenuNode[] => [
	{ label: '首页', key: '/', icon: 'mail', component: 'home', title: '首页', description: '本站点提供网站页面与接口服务；登录后可以在个人中心查看当前账号信息。' },
	{
		label: '管理后台',
		key: 'panel/admin',
		icon: 'appstore',
		component: 'panelRoot',
		managementRoot: true,
		navigationGroup: 'management',
		dropdown: true,
		title: '管理后台',
		description: '当前站点管理后台',
		roles: ['platform_admin', 'tenant_admin', 'branch_admin'],
		children: [
			{
				label: '基础管理',
				key: 'base',
				icon: 'appstore',
				navigationGroup: 'base',
				dropdown: true,
				roles: ['platform_admin', 'tenant_admin', 'branch_admin'],
				children: [
					{ label: '仪表盘', key: 'dashboard', icon: 'mail', component: 'dashboard', title: '基础管理仪表盘', description: '查看基础账号、会话和设备概览' },
					// 系统设置改的是站点级配置（技术栈、运行参数、OIDC 接入），不是租户内的事，限平台管理员。
					{ label: '系统设置', key: 'settings', icon: 'appstore', roles: ['platform_admin'], children: [
						{ label: '技术栈伪装', key: 'tech-stack', icon: 'appstore', component: 'form', title: '技术栈伪装', description: '配置 HTTP 技术栈响应头伪装' },
						{ label: '系统配置', key: 'system-config', icon: 'appstore', component: 'form', title: '系统配置', description: '配置 Quick React 服务运行参数' },
						{ label: '站点设置', key: 'site', icon: 'appstore', component: 'form', title: '站点设置', description: '配置联系邮箱和退出登录入口' },
						{ label: 'Accounts 登录', key: 'accounts-oidc', icon: 'appstore', component: 'form', title: 'Accounts OIDC 登录', description: '通过标准 OIDC 接入独立部署的 Accounts 账号中心' },
					] },
					{ label: '用户管理', key: 'users', icon: 'appstore', component: 'table', title: '用户管理', description: '管理系统用户、角色和状态' },
					// 撤回限管理员，与父级角色门一致；能看到的范围由公共层的归属判定收敛到本租户或本分站。
					{ label: '审计审批', key: 'audit', icon: 'appstore', component: 'table', title: '审计审批', description: '审批待生效的修改，并查看已生效变更的记录与撤回' },
					{
						label: '数据管理',
						key: 'data',
						icon: 'appstore',
						// 直接操作原始表，绕过业务语义，限平台管理员。
						roles: ['platform_admin'],
						children: [
							{ label: '表列管理', key: 'columns', icon: 'appstore', component: 'table', title: '表列管理', description: '基础管理数据表列' },
							{ label: '数据管理', key: 'rows', icon: 'appstore', component: 'table', title: '数据管理', description: '基础管理数据表记录' },
						],
					},
				],
			},
		],
	},
	// 个人中心只做当前登录身份的只读展示，账号资料由 Accounts 维护，不设子页面。
	{ label: '个人中心', key: 'panel/me', icon: 'appstore', hidden: true, component: 'personalCenter', title: '个人中心', description: '查看当前登录账号的身份信息', roles: ['user'] },
];

export const menuItems = resolveNavigationPaths(rawSiteNavigation());

export default menuItems;

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
						// 站点配置拆成三张表单，按「这个值管的是哪一层」分：渲染、前台的服务端策略、
						// 管理后台自己。一张表单里既有页脚文案又有审计保留天数的话，改前者的人得先在
						// 十几行里认出哪几行与自己无关。
						{ label: '前台前端设置', key: 'site-frontend', icon: 'appstore', component: 'form', title: '前台前端设置', description: '配置访客在浏览器里看到的部分：联系方式、页脚、退出登录入口、页面启动模式' },
						{ label: '前台后端设置', key: 'site-backend', icon: 'appstore', component: 'form', title: '前台后端设置', description: '配置前台站点的服务端策略：谁能注册、能用哪几种方式登录、账号规则' },
						{ label: '后台设置', key: 'admin', icon: 'appstore', component: 'form', title: '后台设置', description: '配置管理后台自己的部分：侧栏形态、审批留痕的保留期' },
						{ label: 'Accounts 登录', key: 'accounts-oidc', icon: 'appstore', component: 'form', title: 'Accounts OIDC 登录', description: '通过标准 OIDC 接入独立部署的 Accounts 账号中心' },
					] },
					{ label: '用户管理', key: 'users', icon: 'appstore', component: 'table', title: '用户管理', description: '管理系统用户、角色和状态' },
					// 回滚限管理员，与父级角色门一致；能看到的范围由公共层的归属判定收敛到本租户或本分站。
					//
					// 两页分开而不是一页：一边是**变更本身**（`base_audits`），一边是**这些变更被怎么
					// 处理的**（`base_audit_approvals`）。查「上周谁批了什么」「谁回滚过东西」在后者
					// 里筛，比在主表里一行行翻方便。分组名承担了 audit 前缀，子页因此不必重复它。
					{ label: '审计管理', key: 'audit', icon: 'appstore', children: [
						{ label: '审计记录', key: 'records', icon: 'appstore', component: 'table', title: '审计记录', description: '每一次数据变更的记录；后台的变更在这里排队等批准，已生效的可以回滚' },
						{ label: '审批记录', key: 'approvals', icon: 'appstore', component: 'table', title: '审批记录', description: '每一条审计记录被处理的经过：批准、驳回、撤销、恢复、回滚、重新应用的操作者、时间与理由' },
					] },
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
	/**
	 * 代理中心：**外部主体**的管理视图，与管理后台是两条轴。
	 *
	 * 代理是普通用户，不是运营这套系统的人——它看得到的只有名下下级的账号信息，
	 * 下级的业务数据要走代查（一次一个账号并留痕），不在这里。
	 *
	 * 显式写 dashboardPath：panelRoot 靠它决定进来落在哪一页，而它默认只认
	 * component 为 dashboard 的子页；代理中心没有仪表盘，不写就会被弹回首页。
	 */
	{
		label: '代理中心',
		key: 'panel/agent',
		icon: 'appstore',
		component: 'panelRoot',
		navigationGroup: 'agent',
		dropdown: true,
		dashboardPath: '/panel/agent/subordinates',
		title: '代理中心',
		description: '管理名下发展的下级用户',
		roles: ['agent'],
		children: [
			{ label: '下级用户', key: 'subordinates', icon: 'appstore', component: 'table', title: '下级用户', description: '查看名下的下级用户，或按用户名把还没有代理的用户拉过来' },
		],
	},
	/**
	 * 用户面。与管理后台对称：那边是 `/panel/admin/<站点>/<页>`，这边是
	 * `/panel/user/<站点>/<页>`，两边都带站点名，因此 base 与 sms 的用户面页面不会撞在同一层。
	 *
	 * **路径前缀同时决定要不要走审批**：`operationScope` 只认 `/api/panel/admin/`，
	 * 用户面一律是自助——立即生效、照常留痕、不进队列。
	 *
	 * `roles: ['user']` 的意思是**「要登录」**，不是某种特权：每个登录用户都自动带着 `user`
	 * 这个角色（见 worker.mts 的 effectiveRoles），未登录的只有 `public`。用户面到此为止，
	 * 不再往下分等级——能不能动一行数据凭的是「这是我的行」而不是「我有什么角色」，越界由
	 * 行级归属判定在 SQL 层挡住。
	 *
	 * **菜单文案用场所名，不用身份名**：并列的「管理后台」「代理中心」都在回答「点进去是
	 * 什么地方」，所以这一层叫「控制台」、下面那一页叫「个人中心」，而不是照 `user` /`me`
	 * 直译成「用户」「我」。路径仍然是 `panel/user/base/me`——**路径按结构走、文案按理解走**，
	 * 两者本来就不必逐字对应；真要对应的话，`personalCenter` 这个组件名反倒早就是「个人
	 * 中心」了。
	 */
	{
		/**
		 * 叫「控制台」而不是「用户」：旁边并列的是「管理后台」与「代理中心」，两个都是
		 * **场所名**，只有这一个是身份名——菜单项要回答的是「点进去是什么地方」，不是
		 * 「我是谁」。管理员会同时看到它和「管理后台」，区分由「后台」二字承担：
		 * 控制台管自己的东西，后台管别人的。
		 */
		label: '控制台',
		key: 'panel/user',
		icon: 'appstore',
		component: 'panelRoot',
		navigationGroup: 'user',
		dropdown: true,
		dashboardPath: '/panel/user/base/me',
		title: '控制台',
		description: '当前登录账号自己的东西',
		roles: ['user'],
		children: [
			// 只做当前登录身份的只读展示，账号资料由 Accounts 维护，不设子页面。
			{ label: '个人中心', key: 'base/me', icon: 'appstore', component: 'personalCenter', title: '个人中心', description: '查看当前登录账号的身份信息' },
		],
	},
];

export const menuItems = resolveNavigationPaths(rawSiteNavigation());

export default menuItems;

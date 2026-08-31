import type { MenuNode } from '@server/routes/base/navigation.mjs';

const navigation: MenuNode[] = [{
	label: '管理后台', key: 'panel/admin', icon: 'appstore', dashboardPath: '/panel/admin/aliyun/dashboard', children: [{
		label: '阿里云', key: 'aliyun', icon: 'appstore', navigationGroup: 'aliyun', dropdown: false, title: '阿里云管理', description: '阿里云资源管理控制台',
		children: [
			{ label: '仪表盘', key: 'dashboard', icon: 'mail', component: 'dashboard', title: '阿里云管理仪表盘', description: '查看阿里云资源概览' },
			{ label: '实例详情', key: 'DescribeInstances', icon: 'appstore', component: 'aliyunDescribeInstances', title: '实例详情', description: '阿里云 ECS 实例详情' },
		],
	}],
}];

export default navigation;

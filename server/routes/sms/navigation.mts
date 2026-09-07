import type { MenuNode } from '@server/routes/base/navigation.mjs';

/**
 * SMS 站点的菜单，分成用户面与管理面两棵子树。
 *
 * **这个划分同时决定要不要走审批**：`operationScope` 只认 `/api/panel/admin/` 前缀，
 * 用户面（`/panel/user/sms/*`）一律是自助——立即生效、照常留痕、不进队列。
 *
 * 这不是图省事。手机绑定必须落在用户面：走审批的话那一行会带着非 0 的 `queued_at`，
 * 对正常查询不可见，而 Shortcut 发来的短信正要靠查这一行来认领归属——手机还在队列里排队时，
 * 短信会被拒收。管理面因此只保留撤销、停用这类**修改**（update 不写数据行，不产生
 * `queued_at`），不提供「替用户绑一部手机」的入口——那本来也做不到，绑定需要用户手上的
 * Shortcut 和令牌。
 */
const navigation: MenuNode[] = [
	{
		// 与 base 一致叫「控制台」：并列的「管理后台」是场所名，这一个也该是。
		label: '控制台', key: 'panel/user', icon: 'appstore', dashboardPath: '/panel/user/sms/phones', roles: ['user'],
		children: [{
			label: '短信', key: 'sms', icon: 'appstore', navigationGroup: 'sms', dropdown: false,
			title: '短信', description: '管理自己绑定的手机，查看收到的短信',
			children: [
				{ label: '手机', key: 'phones', icon: 'appstore', component: 'table', title: '手机', description: '绑定、停收或解绑自己的手机' },
				{ label: '短信', key: 'messages', icon: 'appstore', component: 'table', title: '短信', description: '查看已绑定手机收到的短信' },
				// 推送地址由用户自己填（§4.9.1「投递到用户自己的服务端」）：接入方想收短信，
				// 也得由用户把它的地址填进来——控制权留在短信的主人手里。
				{ label: '推送地址', key: 'push-endpoints', icon: 'appstore', component: 'table', title: '推送地址', description: '把收到的短信转发到自己的服务端；每条推送都带 Ed25519 签名' },
			],
		}],
	},
	{
		label: '管理后台', key: 'panel/admin', icon: 'appstore', dashboardPath: '/panel/admin/sms/machines', roles: ['platform_admin', 'tenant_admin', 'branch_admin'],
		children: [{
			label: '短信', key: 'sms', icon: 'appstore', navigationGroup: 'sms', dropdown: false,
			title: '短信管理', description: '管理生成器机器、Shortcut 令牌与接入方',
			roles: ['platform_admin', 'tenant_admin', 'branch_admin'],
			children: [
				{ label: '生成器机器', key: 'machines', icon: 'appstore', component: 'table', title: '生成器机器', description: '登记允许运行 Shortcut 生成器的 Mac' },
				{ label: 'Shortcut 令牌', key: 'tokens', icon: 'appstore', component: 'table', title: 'Shortcut 令牌', description: '查看令牌池，撤销、回收或重新分配' },
				{ label: '接入方', key: 'integration-clients', icon: 'appstore', component: 'table', title: '接入方', description: '登记可以代表用户签发绑定票据的服务端' },
				// 公钥单独一页：轮换要新旧并存，一个接入方会同时有好几把（§4.2）。
				// 从接入方那一页点「公钥」进来时带着 integration_client_id，只看那一家的。
				{ label: '接入方公钥', key: 'client-keys', icon: 'appstore', component: 'table', title: '接入方公钥', description: '接入方用来签发绑定票据的 Ed25519 公钥；本站只存公钥，私钥始终留在接入方' },
				// 与接入方公钥方向相反：那边私钥属于接入方，这边私钥是平台自己的、不出服务端。
				{ label: '推送密钥', key: 'platform-keys', icon: 'appstore', component: 'table', title: '推送密钥', description: '平台给推送请求签名用的 Ed25519 密钥；接收方从 /api/push-key 取公钥验签' },
				// 全站短信只读，管理员排查用——用户报「没收到验证码」时，这里是唯一能看出
				// 短信到底进没进来的地方。代价是这一页看得到验证码，描述里说明白。
				{ label: '短信', key: 'messages', icon: 'appstore', component: 'table', title: '短信', description: '全站收到的短信，用于排查「没收到」；能看到短信正文，包括验证码' },
			],
		}],
	},
];

export default navigation;

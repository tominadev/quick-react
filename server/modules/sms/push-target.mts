/**
 * 推送目标的出站校验（SSRF 防护，绑定文档 §4.9.1）。
 *
 * 地址由用户任意填写。不加限制的话，推送就成了**从服务端发起的任意请求**——填
 * `http://169.254.169.254/latest/meta-data/` 就能让服务器把云元数据（里面往往是一整套
 * 实例凭证）当成短信推给他。
 *
 * **保存时校验一次不够，每次投递前都要重做**：DNS 记录可以在保存之后被改指到内网地址，
 * 而那时候校验早就过去了。
 */

/** 点分十进制转 32 位整数；不是合法 IPv4 就返回 undefined。 */
const ipv4 = (host: string) => {
	const parts = host.split('.');
	if (parts.length !== 4) return undefined;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return undefined;
		const octet = Number(part);
		if (octet > 255) return undefined;
		value = value * 256 + octet;
	}
	return value;
};

const inRange = (address: number, cidr: string) => {
	const [base, bits] = cidr.split('/');
	const network = ipv4(base);
	if (network === undefined) return false;
	const mask = bits === '0' ? 0 : (-1 << (32 - Number(bits))) >>> 0;
	return (address & mask) >>> 0 === (network & mask) >>> 0;
};

/**
 * 这些范围一律拒绝（§4.9.1）：回环、私有网段、链路本地（含云元数据地址
 * `169.254.169.254`）、以及 `0.0.0.0/8`。
 */
const BLOCKED_V4 = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '0.0.0.0/8'];

/** IPv6 里对应的那几类，按前缀判断就够——`::1` 回环、`fc00::/7` 唯一本地、`fe80::/10` 链路本地。 */
const blockedV6 = (host: string): boolean => {
	const value = host.replace(/^\[|\]$/g, '').toLowerCase();
	if (value === '::1' || value === '::') return true;
	if (/^f[cd][0-9a-f]{2}:/.test(value)) return true;
	if (/^fe[89ab][0-9a-f]:/.test(value)) return true;
	// IPv4 映射地址（::ffff:127.0.0.1）绕过 v4 检查是经典手法，拆出后半段再判一次。
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
	return mapped ? isBlockedAddress(mapped[1]) : false;
};

/** 这个地址（IP 字面量或解析结果）是不是落在禁止范围里。 */
export const isBlockedAddress = (host: string): boolean => {
	const value = ipv4(host);
	if (value !== undefined) return BLOCKED_V4.some((cidr) => inRange(value, cidr));
	return blockedV6(host);
};

/**
 * **本地开发的例外**（§4.9.1「本地开发可显式配置例外」）。
 *
 * 开着它就等于关掉 SSRF 防护——填一个云元数据地址就能让服务器把实例凭证推给对方。
 * 因此它只认一个显式的环境变量，默认关闭，**生产环境绝不能开**。存在的理由只有一个：
 * 本机跑接收方时地址必然是 `http://127.0.0.1:xxxx`，否则整条推送链路在开发机上根本
 * 走不通、也就没法验证。
 */
const allowLocalTargets = () => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.SMS_PUSH_ALLOW_LOCAL_TARGETS === '1';

/**
 * 保存时的校验：协议、主机名形态、以及**写成 IP 字面量**的内网地址。
 *
 * 主机名要等到投递前解析了才知道指向哪，所以这一步挡不住「域名解析到内网」——那一层由
 * `resolvedTargetError` 在每次投递前兜住。
 */
export const pushTargetError = (raw: string) => {
	let url: URL;
	try { url = new URL(raw); }
	catch { return '推送地址格式不对，应当是一个完整的 https:// 地址'; }
	// 只允许 HTTPS：推送请求里带着用户的短信正文，明文过网络等于把验证码广播出去。
	const local = allowLocalTargets();
	if (url.protocol !== 'https:' && !local) return '推送地址必须用 https://——请求里带着短信正文，明文传输等于把验证码公开';
	const host = url.hostname.toLowerCase();
	if (!host) return '推送地址缺少主机名';
	if (local) return '';
	if (host === 'localhost' || host.endsWith('.localhost')) return '不能推送到本机地址';
	if (isBlockedAddress(host)) return '不能推送到内网、回环或链路本地地址';
	return '';
};

/**
 * 投递前的校验：把主机名解析成 IP 再判一次。
 *
 * **Node 上才做得了。** Workers 没有 DNS 接口，那一侧靠平台自身的出站隔离——边缘节点
 * 本来就到不了你的内网。拿不到解析能力时不假装校验过，也不因此拒绝投递：这里返回空串，
 * 上面那一层的 IP 字面量检查仍然生效。
 */
export const resolvedTargetError = async (raw: string) => {
	let url: URL;
	try { url = new URL(raw); }
	catch { return '推送地址格式不对'; }
	if (allowLocalTargets()) return '';
	const host = url.hostname.toLowerCase();
	if (isBlockedAddress(host)) return '推送地址指向内网、回环或链路本地地址';
	try {
		const dns = await import(/* @vite-ignore */ 'node:dns/promises').catch(() => undefined);
		if (!dns) return '';
		const records = await dns.lookup(host, { all: true });
		// 一个域名可以同时解析出多个地址，其中**任意一个**落在禁止范围就拒绝：
		// 只看第一个的话，轮询 DNS 可以让内网那条在下一次投递时才轮到。
		const blocked = records.find((record) => isBlockedAddress(record.address));
		return blocked ? '推送地址解析到内网、回环或链路本地地址' : '';
	} catch {
		return '推送地址解析失败';
	}
};

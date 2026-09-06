/**
 * 设备标识的格式与归一，前后端共用一份。
 *
 * **就是 32 位十六进制。** UUID 与它是同一个东西——16 字节随机，只多了四个连字符——因此
 * 归一时把连字符去掉，库里只存一种形态。两种形态并存的话，同一台设备一次发 UUID、一次发
 * 去连字符的写法，就会被当成两台设备。
 *
 * **不要求 UUID 格式，因为 `crypto.randomUUID()` 只在安全上下文（HTTPS 或 localhost）存在。**
 * 用 HTTP 访问自定义域名时它是 `undefined`，于是设备标识拿不到，整个站点连登录都进不去，
 * 而失败是静默的：浏览器控制台什么都不报，只在服务端回一句「设备标识无效」。
 * `crypto.getRandomValues` 没有这个限制。
 *
 * 归一同时收下老的带连字符写法：已经存在浏览器里的标识是 `randomUUID()` 产出的，
 * 直接判无效会让每个老用户在下次访问时掉进同一句错误。
 *
 * 长度在 `base_devices.key` 的 `VARCHAR(36)` 内，字符集也在写入口（`sql.mts` 的
 * `assertRowKey`）允许的 `[A-Za-z0-9_-]` 之内。
 */
export const deviceKeyPattern = /^[0-9a-f]{32}$/;

/** 去掉连字符、转小写。UUID 与 32 位十六进制由此收敛成同一个值。 */
export const normalizeDeviceKey = (value: string) => value.trim().replace(/-/g, '').toLowerCase();

/** 生成一个新的设备标识：16 字节随机，十六进制。不依赖安全上下文。 */
export const createDeviceKey = () => {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

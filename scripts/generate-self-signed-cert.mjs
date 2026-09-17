import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 生成一张自签证书，只为**把 443 端口跑起来**。
 *
 * 它不解决信任问题：浏览器会红锁，回源的 CDN 必须关掉源站证书校验才认。真要可信证书
 * 走 acme.sh 按域名签，服务端会优先读那一份（见 app.mts 的 readCertificate）。
 *
 * 用 openssl 而不是在 Node 里签：Node 有 `generateKeyPairSync`，但没有签发 X.509 的 API，
 * 自己拼 ASN.1 是给这件小事引入一个能出微妙错误的手写编码器。openssl 不在就直说，
 * 而不是留一张半成品证书让服务端在启动时才报一句难懂的错。
 *
 * 域名从参数或 `DOMAIN` 取，并同时写进 SAN——只有 CN 的证书现在所有浏览器都不认了。
 * 额外把 localhost、127.0.0.1、::1 也放进 SAN：本机自测时不用为此再签一张。
 */
const projectDirectory = resolve(import.meta.dirname, '..');
const certificateDirectory = resolve(projectDirectory, 'certs');
const keyPath = resolve(certificateDirectory, 'self-signed.key');
const certificatePath = resolve(certificateDirectory, 'self-signed.crt');

const domain = (process.argv[2] || process.env.DOMAIN || 'localhost').trim();
const days = Number(process.env.CERT_DAYS) || 3650;
const force = process.argv.includes('--force');

const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
if (!force && await exists(certificatePath) && await exists(keyPath)) {
	console.log(`证书已存在，未改动：${certificatePath}\n要重新生成加 --force`);
	process.exit(0);
}

const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8' });
if (openssl.error || openssl.status !== 0) {
	console.error('没有找到 openssl，无法生成自签证书。装上 openssl 后重试，或用 HTTPS_KEY_FILE / HTTPS_CERT_FILE 指向已有的证书。');
	process.exit(1);
}

await mkdir(certificateDirectory, { recursive: true });
const configPath = resolve(certificateDirectory, 'self-signed.cnf');
// IP 型的 SAN 必须写成 IP:，写成 DNS: 的话浏览器按名字比对，直连 IP 时照样不认。
const isIp = /^[\d.]+$/.test(domain) || domain.includes(':');
const names = [`DNS:localhost`, 'IP:127.0.0.1', 'IP:::1'];
names.unshift(isIp ? `IP:${domain}` : `DNS:${domain}`);
await writeFile(configPath, [
	'[req]', 'distinguished_name = dn', 'x509_extensions = v3', 'prompt = no',
	'[dn]', `CN = ${domain}`,
	'[v3]', 'basicConstraints = critical, CA:FALSE', 'keyUsage = critical, digitalSignature, keyEncipherment',
	'extendedKeyUsage = serverAuth', `subjectAltName = ${[...new Set(names)].join(', ')}`,
	'',
].join('\n'));

const result = spawnSync('openssl', [
	'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
	'-keyout', keyPath, '-out', certificatePath,
	'-days', String(days), '-config', configPath,
], { encoding: 'utf8' });
if (result.status !== 0) {
	console.error(`生成失败：${result.stderr || result.stdout || '未知错误'}`);
	process.exit(1);
}

console.log([
	`已生成自签证书（有效期 ${days} 天）：`,
	`  证书 ${certificatePath}`,
	`  私钥 ${keyPath}`,
	`  SAN  ${[...new Set(names)].join(', ')}`,
	'',
	'把系统设置里的「HTTPS 端口」填上（例如 443）并重启服务即可生效。',
	'注意这是自签证书：浏览器会提示不安全，CDN 回源要关掉源站证书校验。',
].join('\n'));

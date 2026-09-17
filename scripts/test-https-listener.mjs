import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createSecureServer } from 'node:http2';
import { request as httpsRequest } from 'node:https';
import { connect as http2Connect } from 'node:http2';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

/**
 * HTTPS 监听要**同时**收 h2 和 HTTP/1.1。
 *
 * 这个测试的由来：443 刚启用的当天就打不开了，报 `Missing ALPN Protocol, expected h2`。
 * `createSecureServer` 默认只认 ALPN 协商出 `h2` 的连接，HTTP/1.1 的 TLS 客户端连握手都
 * 过不去（`tlsv1 alert no application protocol`）——而回源的 CDN、curl 默认、健康检查、
 * 老一点的库全都是 HTTP/1.1。缺的只是一个 `allowHTTP1: true`。
 *
 * 之前没被发现是因为这段代码从来没真正跑起来过：机器上没有证书，TLS 分支一直是死的。
 * 所以这里**真的签一张证书、真的立一个服务、真的连两次**——只断言选项对象里有没有那个
 * 字段的话，等于把「这个配置能不能握上手」换成了「我有没有写那一行」，而前者才是问题。
 */
const projectDirectory = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'https-listener-'));

const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8' });
if (openssl.error || openssl.status !== 0) {
	console.log('https listener test skipped（没有 openssl，签不出测试用证书）');
	process.exit(0);
}

try {
	// 被测的那份选项从源码编译出来，不是在测试里照抄一遍——照抄的话改了源码测试照样绿。
	const bundle = join(directory, 'https-options.mjs');
	await build({
		entryPoints: [resolve(projectDirectory, 'server/modules/base/https-options.mts')],
		bundle: true, platform: 'node', format: 'esm', outfile: bundle,
		alias: { '@server': resolve(projectDirectory, 'server'), '@shared': resolve(projectDirectory, 'shared') },
		resolveExtensions: ['.mts', '.ts', '.mjs', '.js'],
	});
	const { secureServerOptions } = await import(pathToFileURL(bundle).href);

	const keyPath = join(directory, 'test.key');
	const certPath = join(directory, 'test.crt');
	const configPath = join(directory, 'test.cnf');
	await writeFile(configPath, [
		'[req]', 'distinguished_name = dn', 'x509_extensions = v3', 'prompt = no',
		'[dn]', 'CN = localhost',
		'[v3]', 'subjectAltName = DNS:localhost, IP:127.0.0.1', '',
	].join('\n'));
	const signed = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-config', configPath], { encoding: 'utf8' });
	assert.equal(signed.status, 0, `测试证书签发失败：${signed.stderr}`);

	const options = secureServerOptions({ key: await readFile(keyPath), cert: await readFile(certPath) });
	const server = createSecureServer(options, (request, response) => {
		response.writeHead(200, { 'content-type': 'text/plain' });
		response.end('ok');
	});
	// allowHTTP1 下的 HTTP/1.1 请求走 'request' 事件之外的这条：两个事件都接上才算真的能服务。
	server.on('request', () => {});
	await new Promise((done) => server.listen(0, '127.0.0.1', done));
	const port = server.address().port;

	/**
	 * 每次探测都套一个超时。**握手失败时要干脆报错，不能挂住**——没有它的时候，去掉
	 * `allowHTTP1` 跑这个测试的表现是进程卡在那里，只留一句 unsettled top-level await；
	 * 而一个「失败时会卡住」的测试，在 CI 上和一个坏掉的测试没有区别。
	 */
	const within = (label, executor) => new Promise((done, fail) => {
		const timer = setTimeout(() => fail(new Error(`${label} 超时：多半是 TLS 握手就没过`)), 5000);
		executor((value) => { clearTimeout(timer); done(value); }, (error) => { clearTimeout(timer); fail(error); });
	});

	try {
		// ---- HTTP/1.1 over TLS：线上挂掉的就是这一条 ----
		const http1Status = await within('HTTP/1.1 over TLS', (done, fail) => {
			const request = httpsRequest({ host: '127.0.0.1', port, path: '/', rejectUnauthorized: false }, (response) => {
				response.resume();
				done(response.statusCode);
			});
			request.once('error', (error) => fail(new Error(`HTTP/1.1 的 TLS 客户端连不上（回源的 CDN、健康检查大多是它）：${error.message}`)));
			request.end();
		});
		assert.equal(http1Status, 200, 'HTTP/1.1 的 TLS 客户端必须能连上——回源的 CDN、健康检查大多是它');

		// ---- h2：原本就该通，一起钉住，免得为了修上面那条把这条弄坏 ----
		const h2Status = await within('h2 over TLS', (done, fail) => {
			const client = http2Connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
			client.once('error', fail);
			const stream = client.request({ ':path': '/' });
			stream.once('response', (headers) => {
				stream.resume();
				stream.once('end', () => { client.close(); done(headers[':status']); });
			});
			stream.once('error', fail);
			stream.end();
		});
		assert.equal(h2Status, 200, 'h2 也必须照常');
	} finally {
		// closeAllConnections：失败路径上可能留着半开的 socket，close() 会一直等它们。
		server.closeAllConnections?.();
		await new Promise((done) => server.close(done));
	}
	console.log('https listener test passed');
} finally {
	await rm(directory, { recursive: true, force: true });
}

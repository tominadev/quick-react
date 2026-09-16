import type { CloudStorageAdapter, CloudObjectPage, CloudStorageTarget } from '../index.mjs';

/** 请求失败时带上 HTTP 状态和厂商错误码，供调用方判断而不是解析文案。 */
export type CloudStorageRequestError = Error & { status?: number; code?: string };

const encoder = new TextEncoder();
const toHex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');
const sha256 = async (value: string) => toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const hmac = async (key: ArrayBuffer, value: string) => crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), encoder.encode(value));
const hmacHex = async (key: ArrayBuffer, value: string) => toHex(await hmac(key, value));
const uriEncode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const encodePath = (value: string) => value.split('/').map(uriEncode).join('/');
const encodeQuery = uriEncode;
const xmlDecode = (value: string) => value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'");
const xmlValue = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];

const providerRegion = (target: CloudStorageTarget) => target.region || 'us-east-1';

export const createS3Adapter = (target: CloudStorageTarget): CloudStorageAdapter => {
	if (!target.access_key_id || !target.access_key_secret) throw new Error('云凭据缺少 Access Key 凭据');
	const endpoint = new URL(target.endpoint);
	const region = providerRegion(target);
	const usePathStyle = Boolean(target.path_style);
	const host = usePathStyle ? endpoint.host : `${target.bucket}.${endpoint.host}`;
	const basePath = usePathStyle ? `/${encodePath(target.bucket)}` : '';
	const objectPath = (key: string) => `${basePath}/${encodePath(key)}`.replace(/\/+/g, '/');
	const now = () => {
		const date = new Date();
		const amzDate = date.toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}Z$/, 'Z');
		return { amzDate, shortDate: amzDate.slice(0, 8) };
	};
	const sign = async (method: string, key: string, query: Record<string, string>, headers: Record<string, string> = {}) => {
		const { amzDate, shortDate } = now();
		const credentialScope = `${shortDate}/${region}/s3/aws4_request`;
		const signingHeaders = Object.fromEntries(Object.entries({ host, ...headers }).map(([name, value]) => [name.toLowerCase(), value.trim()]));
		const signedHeaders = Object.keys(signingHeaders).sort();
		const canonicalHeaders = signedHeaders.map((item) => `${item}:${signingHeaders[item]}`).join('\n') + '\n';
		const queryWithAuth = {
			...query,
			'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
			'X-Amz-Credential': `${target.access_key_id}/${credentialScope}`,
			'X-Amz-Date': amzDate,
			'X-Amz-Expires': query['X-Amz-Expires'] ?? '900',
			'X-Amz-SignedHeaders': signedHeaders.join(';'),
		};
		const canonicalQuery = Object.entries(queryWithAuth)
			.map(([name, value]) => [encodeQuery(name), encodeQuery(value)] as const)
			.sort(([leftName, leftValue], [rightName, rightValue]) => leftName < rightName ? -1 : leftName > rightName ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0)
			.map(([name, value]) => `${name}=${value}`).join('&');
		const canonicalRequest = `${method}\n${objectPath(key)}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders.join(';')}\nUNSIGNED-PAYLOAD`;
		const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256(canonicalRequest)}`;
		const kDate = await hmac(encoder.encode(`AWS4${target.access_key_secret}`).buffer as ArrayBuffer, shortDate);
		const kRegion = await hmac(kDate, region);
		const kService = await hmac(kRegion, 's3');
		const signingKey = await hmac(kService, 'aws4_request');
		const signature = await hmacHex(signingKey, stringToSign);
		const url = new URL(`${endpoint.protocol}//${host}${objectPath(key)}`);
		url.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
		return { url, headers };
	};
	const request = async (method: string, key: string, query: Record<string, string> = {}, headers: Record<string, string> = {}) => {
		const signed = await sign(method, key, query, headers);
		const response = await fetch(signed.url, { method, headers });
		if (!response.ok) {
			const body = await response.text();
			const code = xmlValue(body, 'Code');
			const message = xmlValue(body, 'Message');
			const requestId = xmlValue(body, 'RequestId');
			const detail = [code, message].filter(Boolean).join('：');
			// 错误码挂在 error 上：调用方要区分「密钥不对」和「密钥对但没这个权限」，
			// 从拼好的中文文案里正则抠 Code 是脆的，厂商改一个字就失配。
			const error = new Error(`对象存储请求失败：HTTP ${response.status}${detail ? `，${xmlDecode(detail)}` : ''}${requestId ? `（RequestId: ${xmlDecode(requestId)}）` : ''}`) as CloudStorageRequestError;
			error.status = response.status;
			if (code) error.code = xmlDecode(code);
			throw error;
		}
		return response;
	};
	const presigned = async (method: string, key: string, query: Record<string, string> = {}) => (await sign(method, key, { 'X-Amz-Expires': '900', ...query })).url.toString();

	/**
	 * 下载时让浏览器用一个**看得懂的文件名**。
	 *
	 * 对象键里是时间戳和随机后缀（`…/1788721695130-c6698636918564bf.shortcut`），直接下载
	 * 拿到的就是那一串——用户在「文件」里根本认不出哪个是哪个。`response-content-disposition`
	 * 让服务端在响应里带上 `Content-Disposition`，浏览器据此命名。
	 *
	 * **它必须参与签名**：SigV4 把所有查询参数一起签，事后往地址上追加这个参数会让签名对
	 * 不上、直接 403。所以它走 `sign()` 而不是在返回的 URL 上拼。
	 *
	 * 文件名用 RFC 5987 的 `filename*=UTF-8''…` 形式：中文、空格、括号都能安全带过去，
	 * 而普通的 `filename="…"` 在非 ASCII 上各家浏览器解释不一。同时保留一个 ASCII 兜底名，
	 * 老客户端认不出 `filename*` 时不至于拿到空名字。
	 */
	const contentDisposition = (filename: string) => {
		const safe = filename.replace(/[\r\n"\\]/g, '').trim() || 'download';
		const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
		return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
	};
	return {
		listBuckets: async () => {
			const response = await request('GET', '');
			const xml = await response.text();
			return [...xml.matchAll(/<Bucket>([\s\S]*?)<\/Bucket>/g)]
				.map((match) => ({
					name: xmlDecode(xmlValue(match[1], 'Name') ?? ''),
					region: xmlDecode(xmlValue(match[1], 'BucketRegion') ?? xmlValue(match[1], 'Location') ?? '') || undefined,
				}))
				.filter((item) => Boolean(item.name));
		},
		list: async (prefix, continuationToken, limit = 100, delimiter): Promise<CloudObjectPage> => {
			/**
			 * **`delimiter` 不传就没有目录。** S3 只有收到它才会把同一层的对象折成
			 * `CommonPrefixes` 返回；不传就是把整个 Bucket 扁平列出来，浏览器里看到的是一长串
			 * 带完整路径的 key，点不进任何一层。解析 `CommonPrefixes` 的代码一直都在，
			 * 只是从来没有东西可解析。
			 *
			 * 默认仍然不传：`shortcut-tokens.mts` 那种「查这个精确 key 传上来没有」的调用
			 * 不需要分层，多一个参数只会多一种出错的方式。
			 */
			const response = await request('GET', '', { 'list-type': '2', prefix, 'max-keys': String(Math.min(1000, Math.max(1, limit))), ...(delimiter ? { delimiter } : {}), ...(continuationToken ? { 'continuation-token': continuationToken } : {}) });
			const xml = await response.text();
			const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((match) => ({ key: xmlDecode(xmlValue(match[1], 'Key') ?? ''), size: Number(xmlValue(match[1], 'Size') ?? 0), lastModified: xmlValue(match[1], 'LastModified'), etag: xmlValue(match[1], 'ETag') }));
			const prefixes = [...xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)].map((match) => ({ key: xmlDecode(xmlValue(match[1], 'Prefix') ?? ''), size: 0, isPrefix: true }));
			const nextToken = xmlValue(xml, 'NextContinuationToken');
			return { objects: [...prefixes, ...objects], nextToken: nextToken || undefined, hasMore: xmlValue(xml, 'IsTruncated') === 'true' };
		},
		createUploadUrl: (key) => presigned('PUT', key),
		createDownloadUrl: (key, options) => presigned('GET', key, options?.filename ? { 'response-content-disposition': contentDisposition(options.filename) } : {}),
		deleteObject: async (key) => { await request('DELETE', key); },
		test: async () => { await request('GET', '', { 'list-type': '2', 'max-keys': '1' }); },
	};
};

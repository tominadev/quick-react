import type { CloudCredential } from './index.mjs';
import { endpointProviderKeys, getCloudDiscoveryDefaults, getCredentialTest } from './catalog.mjs';
import { createCloudStorageAdapter } from './resolve.mjs';
import { testAwsCredential } from './providers/aws-sts.mjs';
import { testAliyunCredential } from './providers/aliyun-sts.mjs';
import { testTencentCredential } from './providers/tencent-cam.mjs';
import type { CloudStorageRequestError } from './providers/s3.mjs';
import type { AliyunCredentialIdentity } from './providers/aliyun-sts.mjs';
import type { TencentCredentialIdentity } from './providers/tencent-cam.mjs';

/**
 * **按桶授权的密钥列不了桶。** 自建 S3 上很常见：一把密钥只授权某一个 Bucket，
 * ListBuckets 直接 403。这种密钥本身是好的，Bucket 测试照样能过，把它报成
 * 「测试失败」比原先的「不支持测试」更误导，所以单独用 listDenied 表示
 * 「连得上、认得出，只是没有列举权限」。
 *
 * **只认错误码，不认 HTTP 状态。** 403 在这里是模糊的：密钥不对（SignatureDoesNotMatch）
 * 和 AK 不存在（InvalidAccessKeyId）同样返回 403，把它们一并当成「可用」会让真正
 * 配错的凭据显示测试通过。认不出错误码时按失败处理，宁可多报也不少报。
 */
const isListDenied = (error: unknown) => ((error ?? {}) as CloudStorageRequestError).code === 'AccessDenied';

export type CloudCredentialTestResult = {
	bucketCount?: number;
	listDenied?: boolean;
	aliyunIdentity?: AliyunCredentialIdentity;
	tencentIdentity?: TencentCredentialIdentity;
};

export const testCloudCredential = async (credential: CloudCredential): Promise<CloudCredentialTestResult | null> => {
	const test = getCredentialTest(credential.provider);
	if (!test) return null;
	if (test === 'aws') { await testAwsCredential(credential); return {}; }
	if (test === 'aliyun') return { aliyunIdentity: await testAliyunCredential(credential) };
	if (test === 'tencent') {
		const identity = await testTencentCredential(credential);
		return { tencentIdentity: identity };
	}
	const defaults = getCloudDiscoveryDefaults(credential.provider, credential.account_id, credential.endpoint);
	const endpoint = defaults.endpoints[0];
	if (!endpoint) throw new Error(endpointProviderKeys.includes(credential.provider) ? '凭据缺少服务地址（Endpoint）' : '凭据缺少执行测试所需的账号信息');
	try {
		const buckets = await createCloudStorageAdapter({
			id: 0,
			provider: credential.provider,
			cloud_credential_id: credential.id,
			endpoint,
			region: defaults.regions[0] ?? '',
			bucket: '',
			path_style: true,
			public_base_url: '',
			extra_config: '{}',
			access_key_id: credential.access_key_id,
			access_key_secret: credential.access_key_secret,
		}).listBuckets();
		return { bucketCount: buckets.length };
	} catch (error) {
		if (isListDenied(error)) return { listDenied: true };
		throw error;
	}
};

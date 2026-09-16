export const cloudProviders = [
	{ key: 'aws', text: 'AWS', credentialTest: 'aws', objectStorage: { product: 'S3', adapter: 's3' } },
	{ key: 'cloudflare', text: 'Cloudflare', credentialTest: 'cloudflare', credentialFields: ['account_id'], objectStorage: { product: 'R2', adapter: 's3' } },
	{ key: 'aliyun', text: '阿里云', credentialTest: 'aliyun', objectStorage: { product: 'OSS', adapter: 's3' }, emailPush: { product: 'DirectMail', adapter: 'aliyun-direct-mail', regions: [
		{ value: 'cn-hangzhou', text: '华东1（杭州）' },
		{ value: 'ap-southeast-1', text: '新加坡' },
		{ value: 'us-east-1', text: '美国（弗吉尼亚）' },
		{ value: 'eu-central-1', text: '德国（法兰克福）' },
	] } },
	{ key: 'tencent', text: '腾讯云', credentialTest: 'tencent', objectStorage: { product: 'COS', adapter: 's3' }, emailPush: { product: 'SES', adapter: 'tencent-ses', regions: [
		{ value: 'ap-hongkong', text: '中国香港' },
	] } },
	{ key: 'other', text: '其他（S3 兼容：MinIO / Ceph / SeaweedFS）', credentialTest: 's3', credentialFields: ['endpoint'], objectStorage: { product: 'S3 Compatible', adapter: 's3' } },
] as const;

export const cloudProviderOptions = cloudProviders.map((item) => ({ value: item.key, text: item.text }));
export const cloudProviderKeys = new Set<string>(cloudProviderOptions.map((item) => item.value));
/**
 * 凭据上的**定位字段**：不是每个 Provider 都能从密钥推出服务地址在哪。
 *
 * Cloudflare 要 `account_id`（R2 的地址是 `<account_id>.r2.cloudflarestorage.com`），
 * 自建 S3 要 `endpoint`（地址拼不出来，只能直接给）。两者是同一类东西——**按 Provider
 * 显示、存在凭据上、用来定位服务**，因此共用一套声明和一个取值函数，不各写一份名单。
 */
const credentialFieldsOf = (item: typeof cloudProviders[number]): readonly string[] => 'credentialFields' in item ? item.credentialFields : [];
export const credentialFieldProviderKeys = (field: string): string[] => cloudProviders.filter((item) => credentialFieldsOf(item).includes(field)).map((item) => item.key);
export const accountIdProviderKeys: string[] = credentialFieldProviderKeys('account_id');
export const endpointProviderKeys: string[] = credentialFieldProviderKeys('endpoint');

/** Endpoint 必须是带协议的绝对地址：适配器只取 protocol 和 host，裸主机名和子路径都不成立。 */
export const isCloudEndpointValid = (value: string) => {
	try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
};

export const getCloudProvider = (provider: string) => cloudProviders.find((item) => item.key === provider);
export const providerSupportsObjectStorage = (provider: string) => Boolean(getCloudProvider(provider)?.objectStorage);
export const getCloudStorageAdapter = (provider: string) => getCloudProvider(provider)?.objectStorage.adapter;
export const getCloudStorageProduct = (provider: string) => getCloudProvider(provider)?.objectStorage.product ?? 'Object Storage';
const getEmailPush = (provider: string) => {
	const definition = getCloudProvider(provider);
	return definition && 'emailPush' in definition ? definition.emailPush : undefined;
};
export const providerSupportsEmailPush = (provider: string) => Boolean(getEmailPush(provider));
export const getCloudEmailAdapter = (provider: string) => getEmailPush(provider)?.adapter;
export const getCloudEmailProduct = (provider: string) => getEmailPush(provider)?.product ?? 'Email Push';
export const getCloudEmailRegionOptions = (provider: string): ReadonlyArray<{ value: string; text: string }> => getEmailPush(provider)?.regions ?? [];
export const getCloudEmailRegions = (provider: string): readonly string[] => getCloudEmailRegionOptions(provider).map((item) => item.value);
export const getCloudEmailRegionLabel = (provider: string, region: string) => getCloudEmailRegionOptions(provider).find((item) => item.value === region)?.text ?? region;
export const getCredentialTest = (provider: string) => {
	const definition = getCloudProvider(provider);
	return definition && 'credentialTest' in definition ? definition.credentialTest : undefined;
};
export const isCredentialContextValid = (provider: string, accountId: string) => provider !== 'cloudflare' || /^[a-f0-9]{32}$/i.test(accountId);

export const getCloudDiscoveryDefaults = (provider: string, accountId = '', endpoint = '') => {
	if (provider === 'aws') return { endpoints: ['https://s3.amazonaws.com'], regions: ['us-east-1'], pathStyle: false };
	if (provider === 'cloudflare') return { endpoints: accountId ? [`https://${accountId}.r2.cloudflarestorage.com`] : [], regions: ['auto'], pathStyle: false };
	if (provider === 'aliyun') return { endpoints: ['https://oss-cn-hangzhou.aliyuncs.com'], regions: ['cn-hangzhou'], pathStyle: false };
	if (provider === 'other') return { endpoints: endpoint ? [endpoint] : [], regions: ['us-east-1'], pathStyle: true };
	return { endpoints: [], regions: [], pathStyle: false };
};

export const getCloudBucketFieldValues = (provider: string, region = '', fallbackEndpoint = '') => {
	if (provider === 'tencent' && region) return { endpoint: `https://cos.${region}.myqcloud.com`, region, path_style: false };
	if (provider === 'aws') {
		const resolvedRegion = region || 'us-east-1';
		return { endpoint: `https://s3.${resolvedRegion}.amazonaws.com`, region: resolvedRegion, path_style: false };
	}
	if (provider === 'aliyun' && region) {
		const resolvedRegion = region.replace(/^oss-/, '');
		return { endpoint: `https://oss-${resolvedRegion}.aliyuncs.com`, region: resolvedRegion, path_style: false };
	}
	if (provider === 'cloudflare') return { endpoint: fallbackEndpoint, region: 'auto', path_style: false };
	if (provider === 'other') return { endpoint: fallbackEndpoint, region: region || 'us-east-1', path_style: true };
	return fallbackEndpoint ? { endpoint: fallbackEndpoint, region, path_style: false } : { region, path_style: false };
};

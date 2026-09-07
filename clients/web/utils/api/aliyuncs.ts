import { signHmacSha1ToBase64 } from '@/utils/common/crypto.js';
import { createDeviceKey } from '@shared/device-key.mjs';

// 生成签名
const generateSignature = async (params: Record<string, string>, accessKeySecret: string): Promise<string> => {
	const queryString = Object.keys(params).sort().map(key => {
		return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
	}).join('&');
	const stringToSign = `GET&%2F&${encodeURIComponent(queryString)}`;
	return signHmacSha1ToBase64(accessKeySecret + '&', stringToSign);
};

async function fetchInstanceDetails(url: string) {
	try {
		const response = await fetch(url);
		const data = await response.json();
		return data;
	} catch (error) {
		console.error('Error:', error);
	}
}

// 用同一个 UUID 生成器：这里原先自己写了一版回退，产出的是 32 位十六进制而不是 UUID——
// 对阿里云 nonce 够用，但同一个函数写两遍迟早会有一遍走偏（设备标识那一遍就走偏了：
// 它压根没有回退，HTTP 下直接拿不到标识）。
const createSignatureNonce = () => createDeviceKey();

function getApiEndpoint(RegionId: string): string {
	if (RegionId === 'cn-hangzhou') {
		return 'https://ecs-cn-hangzhou.aliyuncs.com/';
	}
	return 'https://ecs-cn-hangzhou.aliyuncs.com/';
}

export interface AliyunEipAddress {
	AllocationId: string;
	Bandwidth: number;
	IpAddress: string;
}
export interface AliyunVpcAttributes {
	PrivateIpAddress: {
		IpAddress: string;
	};
	VSwitchId: string;
	VpcId: string;
}
export interface AliyunInstance {
	CreationTime: string;
	InstanceId: string;
	InstanceName: string;
	InstanceType: string;
	Cpu: number;
	Memory: number;
	EipAddress: AliyunEipAddress;
	StartTime: string;
	VpcAttributes: AliyunVpcAttributes;
	ZoneId: string;
	OSType: string
	Status: string;
}
export interface AliyunResponse {
	Message?: string,
	Code?: string,
	VncUrl: string,
	Instances?: {
		Instance: AliyunInstance[],
	};
	PageNumber?: number;
	PageSize?: number;
	TotalCount?: number;
};

export async function AliyunApi(
	apiEndpoint: string,
	requestParams2: Record<string, string | number>,
	AccessKeySecret: string
): Promise<AliyunResponse> {
	const requestParams1 = {
		Format: 'JSON',
		SignatureMethod: 'HMAC-SHA1',
		SignatureVersion: '1.0',
		SignatureNonce: createSignatureNonce(),
		Timestamp: new Date().toISOString(),
		Version: '2014-05-26',
	};
	const requestParams3 = { ...requestParams1, ...requestParams2 };
	// console.log(requestParams3);
	const Signature = await generateSignature(requestParams3, AccessKeySecret);
	const urlParams = new URLSearchParams({ ...requestParams3, Signature });
	//const apiEndpoint = getApiEndpoint(String(requestParams2.RegionId));
	const url = `${apiEndpoint}?${urlParams.toString()}`;
	return await fetchInstanceDetails(url);
}

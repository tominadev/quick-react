import type React from 'react';
import { Checkbox, Input, Modal, ModalFuncProps, Spin } from 'antd';
import { message } from 'antd';
import { ExclamationCircleOutlined } from '@ant-design/icons';
import { useRef, useState } from 'react';
import type { ApiFeedback as SharedApiFeedback, ApiResponseBody } from '@shared/types/api-response.mjs';
import { applyApiResponseContext } from '@/utils/common/response-action.js';
import type { TableColumn, TableData, TableOption, TableResponse } from '@shared/types/table.mjs';
import { getDeviceHeaders } from './device-fingerprint.js';

/* 前端类型定义开始 */
export type DataType = TableData;
export type ColumnComponentType = TableColumn['component'];
export type ColumnDataType = TableColumn['dataType'];
export type ResJsonTableColumn = TableColumn;
export type ResJsonTableOption = TableOption;
export type ResJsonTable = TableResponse;

export type ApiFeedback = SharedApiFeedback;
/** 确认框里收集到的变更控制信息：操作原因与「立即生效」。 */
export type ChangeControlValues = { reason: string; immediate: boolean };

export type ResJSON = ApiResponseBody;

type ParsedResJSON = ResJSON & { parseError?: boolean };
export type UploadFileOptions = {
	headers?: Record<string, string>;
	onProgress?: (loaded: number, total: number) => void;
	signal?: AbortSignal;
};
/* 前端类型定义结束 */

export interface CommonApi {
	modalError: (aContentLine: string[], props?: ModalFuncProps) => Promise<void>,
	modalConfirm: (aContentLine: string[], props?: ModalFuncProps) => Promise<boolean>
	/** 带「操作原因」输入的确认框；取消时返回 undefined。原因可以留空，「立即生效」默认不勾。 */
	modalConfirmWithReason: (aContentLine: string[], options?: { allowImmediate?: boolean }, props?: ModalFuncProps) => Promise<ChangeControlValues | undefined>
	apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	uploadFile: (input: string | URL, file: Blob, options?: UploadFileOptions) => Promise<void>;
}

export function useCommonApi(): [CommonApi, React.JSX.Element] {
	const [modalApi, contextHolderModal] = Modal.useModal();
	const [messageApi, contextHolderMessage] = message.useMessage();
	const [pendingRequests, setPendingRequests] = useState(0);
	const implementationRef = useRef<CommonApi | null>(null);
	const stableApiRef = useRef<CommonApi | null>(null);

	const getContentLine = (aContentLine: string[]): React.ReactNode => {
		return aContentLine.map((line, index) => (
			<div key={index}>{line}</div>
		))
	};

	const modalError = async (aContentLine: string[], props?: ModalFuncProps): Promise<void> => {
		await modalApi.error({
			title: '错误',
			icon: <ExclamationCircleOutlined />,
			content: getContentLine(aContentLine),
			maskClosable: true,
			...props,
		});
	};

	const modalConfirm = async (aContentLine: string[], props?: ModalFuncProps): Promise<boolean> => {
		return await modalApi.confirm({
			title: '确认提示',
			icon: <ExclamationCircleOutlined />,
			content: getContentLine(aContentLine),
			okText: '确定',
			cancelText: '取消',
			maskClosable: true,
			...props,
		});
	};

	/**
	 * 审计记了「改了什么」，操作原因记「为什么」——取证时后者更有价值。
	 * 不强制填：改个昵称也弹框要理由，人会填「1」「。」，垃圾原因比没有原因更糟，
	 * 它给了假的可信度。哪些操作强制填由服务端另行判定。
	 */
	const modalConfirmWithReason = async (aContentLine: string[], options?: { allowImmediate?: boolean }, props?: ModalFuncProps): Promise<ChangeControlValues | undefined> => {
		const reasonRef = { current: '' };
		// 默认不勾：不勾就走审批。只有管理员看得到这个勾选框。
		const immediateRef = { current: false };
		const confirmed = await modalApi.confirm({
			title: '确认提示',
			icon: <ExclamationCircleOutlined />,
			content: (
				<>
					{getContentLine(aContentLine)}
					<Input.TextArea
						autoSize={{ minRows: 2, maxRows: 4 }}
						maxLength={500}
						placeholder="操作原因（可留空）"
						style={{ marginTop: 12 }}
						onChange={(event) => { reasonRef.current = event.target.value; }}
					/>
					{options?.allowImmediate ? (
						<Checkbox style={{ marginTop: 8 }} onChange={(event) => { immediateRef.current = event.target.checked; }}>
							立即生效（跳过审批）
						</Checkbox>
					) : null}
				</>
			),
			okText: '确定',
			cancelText: '取消',
			maskClosable: true,
			...props,
		});
		return confirmed ? { reason: reasonRef.current.trim().slice(0, 500), immediate: immediateRef.current } : undefined;
	};

	const getJsonByRes = async (res: Response): Promise<ParsedResJSON> => {
		const text = await res.text();
		try {
			return JSON.parse(text);
		} catch {
			return {
				parseError: true,
				feedback: {
					component: 'modal',
					type: 'error',
					message: text || '响应不是有效 JSON',
				},
			}
		}
	};

	const showFeedback = (feedback: ApiFeedback, fallbackMessage: string, isError = false) => {
		if (feedback.component === 'none') return;
		const content = feedback.message ?? fallbackMessage;
		if (feedback.component === 'modal') {
			const modalOptions = {
				title: feedback.title ?? (isError ? '请求失败' : '提示'),
				content,
				okText: feedback.refreshNowLabel ?? '确定',
				cancelText: feedback.cancelRefreshLabel,
			};
			if (isError) modalApi.error(modalOptions);
			else modalApi.info(modalOptions);
		} else {
			messageApi.open({ key: 'api-feedback', type: feedback.type ?? (isError ? 'error' : 'success'), content });
		}
	};

	const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		setPendingRequests((count) => count + 1);
		try {
			const headers = await getDeviceHeaders(init?.headers);
			const res: Response = await fetch(input, { ...init, headers });
			const resJSON: ParsedResJSON = await getJsonByRes(res);
			if (!res.ok || resJSON.parseError) {
				showFeedback(resJSON.feedback ?? (resJSON.message ? {
					component: 'modal',
					type: 'error',
					message: resJSON.message,
				} : {
					component: 'modal',
					type: 'error',
					message: res.ok
						? `${init?.method ?? '请求'} ${input} 返回了无效 JSON`
						: `${init?.method ?? '请求'} ${input} 失败，错误状态码: ${res.status}`,
				}), '', true);
				throw res;
			}
			res.json = async () => {
				const { parseError: _parseError, ...responseJSON } = resJSON;
				return responseJSON;
			}
			// 统一拦截：响应带回认证上下文、又没有下一步动作时，就地刷新身份显示。
			// 放在这里而不是各个组件里——apiFetch 是所有请求的唯一出口，漏掉一处
			// 界面就会停在旧身份上，而「哪些接口会改到自己」是说不全的。
			if (!resJSON.next) applyApiResponseContext(resJSON.context);
			if (resJSON.feedback || resJSON.message) {
				const feedback = resJSON.feedback ?? {
					component: 'message' as const,
					type: 'success' as const,
					message: resJSON.message ?? '',
				};
				showFeedback(feedback, '', feedback.type === 'error');
			}
			return res;
		} catch (ex) {
			if (!ex) {
				modalError(['未知错误在apiFetch']);
				throw ex;
			}
			//modalError([ex.toString()]);
			throw ex;
		} finally {
			setPendingRequests((count) => Math.max(0, count - 1));
		}
	};

	const storageErrorMessage = (xhr: XMLHttpRequest): string => {
		let code = '';
		let message = '';
		let requestId = '';
		if (xhr.responseText) {
			try {
				const document = new DOMParser().parseFromString(xhr.responseText, 'application/xml');
				code = document.querySelector('Code')?.textContent?.trim() ?? '';
				message = document.querySelector('Message')?.textContent?.trim() ?? '';
				requestId = document.querySelector('RequestId')?.textContent?.trim() ?? '';
			} catch {
				// 非 XML 错误响应由 HTTP 状态兜底。
			}
		}
		return [
			`对象存储上传失败：HTTP ${xhr.status}${xhr.statusText ? ` ${xhr.statusText}` : ''}`,
			code && `错误码：${code}`,
			message && `错误信息：${message}`,
			requestId && `RequestId：${requestId}`,
		].filter(Boolean).join('\n');
	};

	const uploadFile = (input: string | URL, file: Blob, options: UploadFileOptions = {}): Promise<void> => new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		const abort = () => xhr.abort();
		const cleanup = () => options.signal?.removeEventListener('abort', abort);
		if (options.signal?.aborted) {
			reject(new DOMException('上传已取消', 'AbortError'));
			return;
		}
		xhr.open('PUT', input.toString());
		for (const [name, value] of Object.entries(options.headers ?? {})) xhr.setRequestHeader(name, value);
		xhr.upload.onprogress = (event) => {
			const total = event.lengthComputable && event.total > 0 ? event.total : file.size;
			options.onProgress?.(event.loaded, total);
		};
		xhr.onload = () => {
			cleanup();
			if (xhr.status >= 200 && xhr.status < 300) {
				options.onProgress?.(file.size, file.size);
				resolve();
				return;
			}
			const error = new Error(storageErrorMessage(xhr));
			void modalError(error.message.split('\n'), { title: '上传失败' });
			reject(error);
		};
		xhr.onerror = () => {
			cleanup();
			const error = new Error('浏览器无法连接对象存储，请检查网络以及 Bucket 的 CORS 配置');
			void modalError([error.message], { title: '上传失败' });
			reject(error);
		};
		xhr.onabort = () => {
			cleanup();
			reject(new DOMException('上传已取消', 'AbortError'));
		};
		options.signal?.addEventListener('abort', abort, { once: true });
		xhr.send(file);
	});

	implementationRef.current = {
		modalError,
		modalConfirm,
		modalConfirmWithReason,
		apiFetch,
		uploadFile,
	};
	// 请求计数会触发本 Hook 重渲染；对外对象必须保持引用稳定，否则依赖 commonApi 的加载 effect 会重复请求。
	stableApiRef.current ??= {
		modalError: (...args) => implementationRef.current!.modalError(...args),
		modalConfirm: (...args) => implementationRef.current!.modalConfirm(...args),
		modalConfirmWithReason: (...args) => implementationRef.current!.modalConfirmWithReason(...args),
		apiFetch: (...args) => implementationRef.current!.apiFetch(...args),
		uploadFile: (...args) => implementationRef.current!.uploadFile(...args),
	};

	return [
		stableApiRef.current,
		<>
			<Spin fullscreen spinning={pendingRequests > 0} />
			{contextHolderModal}
			{contextHolderMessage}
		</>,
	];
}

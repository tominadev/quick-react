import type { ApiFeedback as SharedApiFeedback, ApiResponseBody } from '@shared/types/api-response.mjs';
import { applyApiResponseContext } from '@clients/browser/response-action.js';
import type { TableColumn, TableData, TableOption, TableResponse } from '@shared/types/table.mjs';
import { getDeviceHeaders } from '@clients/browser/device-fingerprint.js';

/**
 * 请求层。**这里不依赖任何 UI 框架**——弹窗、提示、加载遮罩长什么样由渲染层决定，
 * 这一层只管发请求、解析响应，以及告诉渲染层「该展示哪一条反馈」。
 *
 * 分开是为了让第二套 UI（elementUI、手机版、小程序）能复用同一套请求与协议处理：
 * 早先这两件事写在一个文件里，`import { Modal, message, Spin } from 'antd'` 就横在
 * API 客户端顶上，换一套 UI 等于把请求逻辑重写一遍。
 *
 * 仍然是**浏览器**的实现：`fetch`、`XMLHttpRequest`、`DOMParser` 都是宿主 API。小程序
 * 要走自己的 `request`，届时另写一份，但协议处理（feedback 提取、context 应用）可以照搬。
 */

/* 前端类型定义开始 */
export type DataType = TableData;
export type ColumnComponentType = TableColumn['component'];
export type ColumnDataType = TableColumn['dataType'];
export type ResJsonTableColumn = TableColumn;
export type ResJsonTableOption = TableOption;
export type ResJsonTable = TableResponse;

export type ApiFeedback = SharedApiFeedback;
/** 确认框里收集到的变更控制信息：操作原因与「立即生效」。 */
/** 「立即生效」已废除：管理后台的修改一律进审批队列，有权限的人在待审批提示里点批准。 */
export type ChangeControlValues = { reason: string };

export type ResJSON = ApiResponseBody;

type ParsedResJSON = ResJSON & { parseError?: boolean };
export type UploadFileOptions = {
	headers?: Record<string, string>;
	onProgress?: (loaded: number, total: number) => void;
	signal?: AbortSignal;
};
/* 前端类型定义结束 */

/**
 * 渲染层要提供的三件事。**签名里没有任何 antd 类型**——早先 `modalError` 的第二个参数
 * 是 `ModalFuncProps`，那把整个公共接口绑在了 antd 上；实际上除了 `title`，没有一个
 * 调用方传过别的。
 */
export type ApiPresenter = {
	/** 展示一条后端下发的反馈。`component` 是 modal 还是 message 由渲染层按协议决定。 */
	feedback: (feedback: ApiFeedback, isError: boolean) => void;
	/** 展示一条错误。多行分开显示——上传失败时错误码、原因、RequestId 各占一行。 */
	error: (lines: string[], options?: { title?: string }) => void;
	/** 在途请求数的增减，渲染层据此决定要不要盖加载遮罩。 */
	pending: (delta: 1 | -1) => void;
};

export interface CommonApi {
	modalError: (aContentLine: string[], options?: { title?: string }) => Promise<void>,
	modalConfirm: (aContentLine: string[]) => Promise<boolean>
	/** 带「操作原因」输入的确认框；取消时返回 undefined。 */
	modalConfirmWithReason: (aContentLine: string[]) => Promise<ChangeControlValues | undefined>
	apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	uploadFile: (input: string | URL, file: Blob, options?: UploadFileOptions) => Promise<void>;
}

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

/** 请求与上传。反馈怎么显示交给 `presenter`，这一层不知道也不需要知道用的是哪套 UI。 */
export const createApiClient = (presenter: ApiPresenter) => {
	const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		presenter.pending(1);
		try {
			const headers = await getDeviceHeaders(init?.headers);
			const res: Response = await fetch(input, { ...init, headers });
			const resJSON: ParsedResJSON = await getJsonByRes(res);
			if (!res.ok || resJSON.parseError) {
				presenter.feedback(resJSON.feedback ?? (resJSON.message ? {
					component: 'modal',
					type: 'error',
					message: resJSON.message,
				} : {
					component: 'modal',
					type: 'error',
					message: res.ok
						? `${init?.method ?? '请求'} ${input} 返回了无效 JSON`
						: `${init?.method ?? '请求'} ${input} 失败，错误状态码: ${res.status}`,
				}), true);
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
				presenter.feedback(feedback, feedback.type === 'error');
			}
			return res;
		} catch (ex) {
			if (!ex) {
				presenter.error(['未知错误在apiFetch']);
				throw ex;
			}
			throw ex;
		} finally {
			presenter.pending(-1);
		}
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
			presenter.error(error.message.split('\n'), { title: '上传失败' });
			reject(error);
		};
		xhr.onerror = () => {
			cleanup();
			const error = new Error('浏览器无法连接对象存储，请检查网络以及 Bucket 的 CORS 配置');
			presenter.error([error.message], { title: '上传失败' });
			reject(error);
		};
		xhr.onabort = () => {
			cleanup();
			reject(new DOMException('上传已取消', 'AbortError'));
		};
		options.signal?.addEventListener('abort', abort, { once: true });
		xhr.send(file);
	});

	return { apiFetch, uploadFile };
};

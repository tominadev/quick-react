import type React from 'react';
import { Dialog, Input, SpinLoading, Toast } from 'antd-mobile';
import { useRef, useState } from 'react';
import { createApiClient, type ApiFeedback, type ApiPresenter, type ChangeControlValues, type CommonApi } from '@clients/browser/api.js';

/**
 * 把请求层接到 antd-mobile 上。
 *
 * **与 `clients/antd/utils/antd/common-api.tsx` 是同一个契约的两份实现**：请求、解析、
 * 协议处理都在 `@clients/browser/api.js` 里，这一层只回答「弹窗、提示、加载遮罩长什么样」。
 * 手机上没有鼠标悬停、屏幕又窄，因此 `message` 换成居中的 `Toast`、`Modal` 换成占满宽度
 * 的 `Dialog`——但**什么时候弹、弹什么内容由服务端下发的 feedback 决定**，两套 UI 一致。
 */
const contentLines = (lines: string[]): React.ReactNode => lines.map((line, index) => <div key={index}>{line}</div>);

export function useCommonApi(): [CommonApi, React.JSX.Element] {
	const [pendingRequests, setPendingRequests] = useState(0);
	const implementationRef = useRef<CommonApi | null>(null);
	const stableApiRef = useRef<CommonApi | null>(null);

	const modalError = async (lines: string[], options?: { title?: string }): Promise<void> => {
		await Dialog.alert({ title: options?.title ?? '错误', content: contentLines(lines), confirmText: '知道了' });
	};

	const modalConfirm = async (lines: string[]): Promise<boolean> => Dialog.confirm({
		title: '确认提示', content: contentLines(lines), confirmText: '确定', cancelText: '取消',
	});

	/**
	 * 带「操作原因」的确认框。原因**必填**——事后追查时，一条写着空原因的记录和没有记录
	 * 差不多。手机上不做「填之前禁用确认按钮」那一套：小屏上按钮变灰不明显，改成点了之后
	 * 提示一句再让他继续填。
	 */
	const modalConfirmWithReason = async (lines: string[]): Promise<ChangeControlValues | undefined> => {
		const reasonRef = { current: '' };
		const confirmed = await Dialog.confirm({
			title: '确认提示',
			content: (
				<>
					{contentLines(lines)}
					<Input placeholder="操作原因（必填）" maxLength={500} style={{ marginTop: 12 }} onChange={(value) => { reasonRef.current = value; }} />
				</>
			),
			confirmText: '确定',
			cancelText: '取消',
		});
		if (!confirmed) return undefined;
		const reason = reasonRef.current.trim().slice(0, 500);
		if (!reason) {
			Toast.show({ icon: 'fail', content: '请填写操作原因' });
			return undefined;
		}
		return { reason };
	};

	const presenter: ApiPresenter = {
		feedback: (feedback: ApiFeedback, isError: boolean) => {
			if (feedback.component === 'none') return;
			const content = feedback.message ?? '';
			// modal 要人点掉，toast 自己消失——与桌面版同一条协议规则，只是控件不同。
			if (feedback.component === 'modal') void Dialog.alert({ title: feedback.title ?? (isError ? '请求失败' : '提示'), content, confirmText: feedback.refreshNowLabel ?? '确定' });
			else Toast.show({ icon: isError ? 'fail' : 'success', content });
		},
		error: (lines, options) => { void modalError(lines, options); },
		pending: (delta) => setPendingRequests((count) => Math.max(0, count + delta)),
	};
	const client = createApiClient(presenter);

	implementationRef.current = { modalError, modalConfirm, modalConfirmWithReason, apiFetch: client.apiFetch, uploadFile: client.uploadFile };
	// 请求计数会触发重渲染；对外对象必须保持引用稳定，否则依赖 commonApi 的加载 effect 会重复请求。
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
			{pendingRequests > 0 && (
				<div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.15)', zIndex: 2000 }}>
					<SpinLoading color="primary" />
				</div>
			)}
		</>,
	];
}

import type React from 'react';
import { Input, Modal, ModalFuncProps, Spin, theme, message } from 'antd';
import { ExclamationCircleOutlined } from '@ant-design/icons';
import { useRef, useState } from 'react';
import { createApiClient, type ApiFeedback, type ApiPresenter, type ChangeControlValues, type CommonApi } from '@clients/browser/api.js';

/**
 * 把请求层接到 antd 上。**这一层是可替换的**：换 elementUI、做手机版或小程序时另写一份
 * 同名的实现，请求与协议处理（`createApiClient`）原样复用。
 *
 * 早先这两件事写在同一个文件里，`import { Modal, message, Spin } from 'antd'` 就横在
 * API 客户端顶上——换一套 UI 等于把请求逻辑重写一遍。
 */

const contentLines = (lines: string[]): React.ReactNode => lines.map((line, index) => <div key={index}>{line}</div>);

export function useCommonApi(): [CommonApi, React.JSX.Element] {
	const [modalApi, contextHolderModal] = Modal.useModal();
	const [messageApi, contextHolderMessage] = message.useMessage();
	const [pendingRequests, setPendingRequests] = useState(0);
	/**
	 * 请求遮罩要盖在弹窗**上面**。
	 *
	 * antd 的 `Spin fullscreen` 默认就是 zIndexPopupBase（1000），而一个顶层 Modal 是
	 * 1000+100，嵌套的容器每层再叠 100（最多十层）——遮罩因此落在所有弹窗底下：抽屉里点
	 * 保存，转圈的圈圈在抽屉后面，看着像没反应，人就会再点一次。
	 *
	 * 抬到容器叠加的上限之上、message（+1010）与 notification（+1050）之下：请求结果的
	 * 提示语该压在遮罩上面，那是给人看的字。
	 */
	const { token: themeToken } = theme.useToken();
	const loadingZIndex = themeToken.zIndexPopupBase + 1005;
	const implementationRef = useRef<CommonApi | null>(null);
	const stableApiRef = useRef<CommonApi | null>(null);

	const modalError = async (aContentLine: string[], props?: ModalFuncProps): Promise<void> => {
		await modalApi.error({
			title: '错误',
			icon: <ExclamationCircleOutlined />,
			content: contentLines(aContentLine),
			maskClosable: true,
			...props,
		});
	};

	const modalConfirm = async (aContentLine: string[], props?: ModalFuncProps): Promise<boolean> => {
		return await modalApi.confirm({
			title: '确认提示',
			icon: <ExclamationCircleOutlined />,
			content: contentLines(aContentLine),
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
	/**
	 * 带「操作原因」的确认框。
	 *
	 * 原因**必填**：事后追查时，一条写着空原因的记录和没有记录差不多。为此确认按钮在
	 * 填之前一直是禁用的，而不是点了再弹一个「请填写原因」——后者要人多点一次才知道。
	 */
	const modalConfirmWithReason = async (aContentLine: string[], props?: ModalFuncProps): Promise<ChangeControlValues | undefined> => {
		const reasonRef = { current: '' };
		// 回车即确定：单行框里那是本能动作。要等 Promise 建好才拿得到 resolve，因此先占个位。
		const submitRef = { current: () => {} };
		let modal: { update: (config: ModalFuncProps) => void; destroy: () => void } | undefined;
		const content = (
			<>
				{contentLines(aContentLine)}
				{/*
					单行，不是多行文本域：操作原因是一句话——「客诉要求改价」「上线前关掉注册」。
					给两三行的框等于在暗示要写一段，而回车在单行框里正好是「确定」。
				*/}
				<Input
					maxLength={500}
					placeholder="操作原因（必填）"
					style={{ marginTop: 12 }}
					onChange={(event) => {
						reasonRef.current = event.target.value;
						modal?.update({ okButtonProps: { disabled: !event.target.value.trim() } });
					}}
					onPressEnter={() => { if (reasonRef.current.trim()) submitRef.current(); }}
				/>
			</>
		);
		const confirmed = await new Promise<boolean>((resolve) => {
			submitRef.current = () => { modal?.destroy(); resolve(true); };
			modal = modalApi.confirm({
				title: '确认提示',
				icon: <ExclamationCircleOutlined />,
				content,
				okText: '确定',
				cancelText: '取消',
				maskClosable: true,
				okButtonProps: { disabled: true },
				onOk: () => { resolve(true); },
				onCancel: () => { resolve(false); },
				...props,
			});
		});
		return confirmed ? { reason: reasonRef.current.trim().slice(0, 500) } : undefined;
	};

	/** 后端下发的反馈落到 antd 的哪个组件上：`modal` 要人点掉，`message` 自己消失。 */
	const presenter: ApiPresenter = {
		feedback: (feedback: ApiFeedback, isError: boolean) => {
			if (feedback.component === 'none') return;
			const content = feedback.message ?? '';
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
		},
		error: (lines, options) => { void modalError(lines, options); },
		pending: (delta) => setPendingRequests((count) => Math.max(0, count + delta)),
	};
	const client = createApiClient(presenter);

	implementationRef.current = {
		modalError,
		modalConfirm,
		modalConfirmWithReason,
		apiFetch: client.apiFetch,
		uploadFile: client.uploadFile,
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
			<Spin fullscreen spinning={pendingRequests > 0} style={{ zIndex: loadingZIndex }} />
			{contextHolderModal}
			{contextHolderMessage}
		</>,
	];
}

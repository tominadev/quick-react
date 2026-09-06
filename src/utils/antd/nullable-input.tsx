import { useState } from 'react';
import { Button, Input, theme } from 'antd';
import { CloseCircleFilled, EditOutlined } from '@ant-design/icons';

/**
 * 能表达 NULL 的文本框。
 *
 * 普通输入框只吐得出字符串，于是「没填过」和「填过又清掉」在表单这一层就被压成了同一个
 * 空串——而它们在库里是两回事（唯一索引里 NULL 互不相等，业务上也分得清「这个人留没留过
 * 联系方式」）。信息在最后一层被抹掉，下游再也拿不回来。
 *
 * 这个控件把两种状态分开：
 *
 * - **NULL**：一个虚线按钮，写着「未填写，点击填写」。点一下进入编辑（值变成空串）。
 * - **有值（含空串）**：普通输入框，末尾一个 ✕。点 ✕ 回到 NULL，**删光字符只是空串**。
 *
 * ✕ 自己画，不用 antd 的 `allowClear`：那条路要么靠 `event.type === 'click'` 猜是不是点了
 * 清除、要么依赖 `onClear` 这个底层透传，两样都是跟着版本走的实现细节。自己画一个 suffix
 * 按钮，行为由这里说了算。
 */
export const NullableInput = ({ value, onChange, placeholder, maxLength, readOnly, disabled }: {
	value?: string | null;
	onChange?: (value: string | null) => void;
	placeholder?: string;
	maxLength?: number;
	readOnly?: boolean;
	disabled?: boolean;
}) => {
	const { token } = theme.useToken();
	// 点「点击填写」之后把光标送进输入框：那一下点击表达的就是「我现在要填」。
	const [focusOnEdit, setFocusOnEdit] = useState(false);
	if (value === null || value === undefined) {
		return <Button
			type="dashed"
			block
			disabled={readOnly || disabled}
			icon={<EditOutlined />}
			style={{ textAlign: 'left', color: token.colorTextTertiary }}
			onClick={() => { setFocusOnEdit(true); onChange?.(''); }}
		>未填写，点击填写</Button>;
	}
	return <Input
		value={value}
		autoFocus={focusOnEdit}
		placeholder={placeholder}
		maxLength={maxLength}
		readOnly={readOnly}
		disabled={disabled}
		onChange={(event) => onChange?.(event.target.value)}
		suffix={readOnly || disabled ? undefined : <CloseCircleFilled
			role="button"
			aria-label="清空为未填写"
			title="清空为未填写"
			style={{ cursor: 'pointer', color: token.colorTextQuaternary }}
			onClick={() => { setFocusOnEdit(false); onChange?.(null); }}
		/>}
	/>;
};

/**
 * 账号名字的统一规则，base 与 passport 共用一份。
 *
 * 两个名字的定位完全不同，规则也就不同：
 * - **用户名**是标识，要能出现在 URL、日志、命令行里，所以字符集窄到只剩小写字母和数字，
 *   且必须字母开头——数字开头的名字容易被当成 ID。
 * - **昵称**是显示名，允许各国语言，因此不能按「字符个数」限长：8 个汉字和 8 个字母
 *   在界面上占的宽度差一倍。按**半角宽度**算，全角字符记 2，其余记 1。
 */

export const maxUserNameLength = 16;
/** 下限的默认值；站点设置里可以调，上限不给调——16 是给界面留的余量。 */
export const defaultMinUserNameLength = 3;
export const userNamePattern = /^[a-z][a-z0-9]*$/;

export const clampMinUserNameLength = (value: unknown) =>
	Math.min(Math.max(Math.trunc(Number(value ?? defaultMinUserNameLength)) || defaultMinUserNameLength, 1), maxUserNameLength);

/** 不合法时返回给用户看的原因，合法返回空串。 */
export const userNameError = (value: string, minLength = defaultMinUserNameLength) => {
	const min = clampMinUserNameLength(minLength);
	if (!userNamePattern.test(value)) return '用户名必须以小写字母开头，且只能包含小写字母和数字';
	if (value.length < min || value.length > maxUserNameLength) return `用户名长度必须在 ${min} 到 ${maxUserNameLength} 位之间`;
	return '';
};

export const isValidUserName = (value: string, minLength = defaultMinUserNameLength) => !userNameError(value, minLength);

/**
 * 东亚全角字符与绘文字按两个半角计，其余按一个。
 *
 * 用码点而不是 UTF-16 码元遍历：绘文字与增补平面汉字都是代理对，按码元数会算成双倍。
 */
const fullWidthPattern = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]|\p{Extended_Pictographic}|[\u{20000}-\u{3FFFD}]/u;
export const halfWidthLength = (value: string) =>
	Array.from(value).reduce((total, character) => total + (fullWidthPattern.test(character) ? 2 : 1), 0);

/** 昵称按半角宽度计长：4 到 16，也就是 2 到 8 个全角字符。 */
export const minNicknameWidth = 4;
export const maxNicknameWidth = 16;
/** 控制字符看不见，却能造出两个「看起来一样」的昵称。 */
const controlCharacterPattern = /\p{C}/u;

export const nicknameError = (value: string) => {
	if (controlCharacterPattern.test(value)) return '昵称不能包含控制字符';
	const width = halfWidthLength(value);
	if (width < minNicknameWidth || width > maxNicknameWidth) return `昵称长度必须在 ${minNicknameWidth} 到 ${maxNicknameWidth} 个半角字符之间（一个全角字符按两个半角计）`;
	return '';
};

/**
 * 把外部提供方给的昵称收进宽度范围。
 *
 * 外部昵称不是用户在本站挑的，太短就拒绝会让人登不进来，所以这里**只截断不报错**；
 * 截断后仍不够长（例如只有一个字母）时交给调用方给的兜底名。
 */
export const clampNickname = (value: string, fallback: string) => {
	const normalized = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
	let result = '';
	for (const character of normalized) {
		if (halfWidthLength(result + character) > maxNicknameWidth) break;
		result += character;
	}
	return halfWidthLength(result) >= minNicknameWidth ? result : fallback;
};

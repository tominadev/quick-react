import { changedFieldsKey } from '@shared/types/changed-fields.mjs';

type ObjectRecord = Record<string, unknown>;

/**
 * 请求体里的布尔值。四个路由各写过一遍同一行，现在只此一处。
 *
 * 认 `1` 和 `'1'`：开关列曾经是 `Int`，老客户端和外部调用方仍可能发数字或字符串；
 * 列改成 `Boolean` 之后写进库的一律是真布尔，这一层只负责把外面各种写法读成一种。
 */
export const booleanValue = (value: unknown) => value === true || value === 1 || value === '1';

const readObject = (value: unknown): ObjectRecord => (
	value && typeof value === 'object' && !Array.isArray(value)
		? value as ObjectRecord
		: {}
);

export const getChangedFields = (body: unknown, allowedFields: readonly string[]) => {
	const source = readObject(body);
	const requested = Array.isArray(source[changedFieldsKey])
		? source[changedFieldsKey].filter((field): field is string => typeof field === 'string')
		: allowedFields.filter((field) => field in source);
	return new Set(requested.filter((field) => allowedFields.includes(field)));
};

export const mergeChangedFields = <T extends ObjectRecord>(
	current: T,
	body: unknown,
	allowedFields: readonly (keyof T & string)[],
) => {
	const source = readObject(body);
	const changedFields = getChangedFields(source, allowedFields);
	const next = { ...current };
	for (const field of allowedFields) {
		if (changedFields.has(field) && field in source) next[field] = source[field] as T[typeof field];
	}
	return next;
};

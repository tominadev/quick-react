/**
 * Columns owned by the common data layer.
 *
 * They are exposed for display and auditing, but are never business-form
 * inputs. The SQL layer supplies or maintains them automatically.
 *
 * `key` 只在**新建**时可以由调用方给（`global_sites` 这类表的 key 是人给的短串），
 * 之后一律不可改——它能被别的表引用，正是因为建后不动；改一次就把所有引用指向了空处。
 * 因此更新路径把它当系统字段挡掉，新建路径显式放行。
 */
export const SYSTEM_FIELD_NAMES = ['id', 'key', 'created_at', 'updated_at', 'deleted_at', 'pended_at', 'created_duid', 'updated_duid'] as const;
export type SystemFieldName = (typeof SYSTEM_FIELD_NAMES)[number];
export const isSystemField = (name: string): name is SystemFieldName => (SYSTEM_FIELD_NAMES as readonly string[]).includes(name);

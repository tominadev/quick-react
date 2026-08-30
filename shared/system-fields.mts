/**
 * Columns owned by the common data layer.
 *
 * They are exposed for display and auditing, but are never business-form
 * inputs. The SQL layer supplies or maintains them automatically.
 */
export const SYSTEM_FIELD_NAMES = ['id', 'created_at', 'updated_at', 'deleted_at', 'created_duid', 'updated_duid'] as const;
export type SystemFieldName = (typeof SYSTEM_FIELD_NAMES)[number];
export const isSystemField = (name: string): name is SystemFieldName => (SYSTEM_FIELD_NAMES as readonly string[]).includes(name);

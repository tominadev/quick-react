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
export const SYSTEM_FIELD_NAMES = ['id', 'key', 'created_at', 'updated_at', 'deleted_at', 'queued_at', 'created_duid', 'updated_duid'] as const;
export type SystemFieldName = (typeof SYSTEM_FIELD_NAMES)[number];
export const isSystemField = (name: string): name is SystemFieldName => (SYSTEM_FIELD_NAMES as readonly string[]).includes(name);

/**
 * 这张表的**名字列**叫什么。
 *
 * 「名字列」装的是**人给的、可重用的标识**——人取的、可以改的、租户内唯一的、不被别的表
 * 引用的那一列。它的唯一索引形态固定为 `(owner_tid, <名字列>, deleted_at)`，而
 * **`deleted_at` 正是它区别于其他唯一键的地方**：名字是人取的，软删一行之后同一个名字该能
 * 再用（解绑一个手机号之后要能重新绑回来）。其余唯一键（哈希、令牌摘要、nonce、对象键）
 * 一概不带 `deleted_at`，不带反而更安全。
 *
 * 默认叫 `name`。个别表里 `name` 读不出它装的是什么——`sms_phones.name` 存的是手机号，
 * 读的人得愣一下——可以换一个更具体的词，**但必须登记在这里**。
 *
 * 为什么要登记而不是随便取：「名字列参与的唯一索引才带 deleted_at」这条规则靠列名机械判断，
 * `test:naming` 就是这么守的。不登记就等于规则漏掉了这张表，而漏掉的后果不是报错，是那个
 * 手机号被永久占住、解绑之后再也绑不回来——一个要等到线上才发现的 bug。
 *
 * 登记是个显式动作，因此规则不会漂：今天加 `number`，明天有人想用 `code`，得先在这里写一行。
 */
export const NAME_COLUMNS: Record<string, string> = {
	sms_phones: 'number',
};

/** 这张表的名字列；没登记过的就是 `name`。 */
export const nameColumnOf = (table: string) => NAME_COLUMNS[table] ?? 'name';

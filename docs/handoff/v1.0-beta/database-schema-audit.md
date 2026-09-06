# v1.0 beta 数据库命名与结构审计

## 1. 审计范围与基线

审计日期：2026-09-06。

本次盘点覆盖：

- `prisma/base.prisma`：17 个模型；
- `prisma/global.prisma`：12 个模型；
- `prisma/passport.prisma`：31 个模型；
- `prisma/pve.prisma`：5 个模型；
- 运行时默认 SQLite 中由代码创建、但不在 Prisma 模型中的 `global_schema_migrations`。

因此当前 Prisma 规范有 65 张业务表，默认库实际有 66 张表。四份 Schema 合计约 127 个 `@@unique` 和 72 个 `@@index`；64 个模型有单独的字符串 `key` 业务字段，`global_snowflake_states` 是当前唯一没有 `key` 的状态表。

这是一份只读审计，不代表已经接受现状。审计结果的目的，是在 v1.0 beta 前把“继续保留”“必须修改”和“需要主人决策”的事项分开，避免开发人员根据旧代码自行猜测。

### 1.1 表名清单与 Prisma 映射

当前四份 Prisma 文件没有使用 `@@map` 或字段 `@map`：模型名就是物理表名，表名前缀也与代码站点一致。完整清单如下，后续重命名必须同时更新 Schema、迁移、路由和文档：

- Base：`base_tenants`、`base_branches`、`base_hosts`、`base_users`、`base_sessions`、`base_configs`、`base_bootstraps`、`base_oidc_login_requests`、`base_oidc_users`、`base_oidc_sessions`、`base_devices`、`base_device_users`、`base_device_snapshots`、`base_audit_approvals`、`base_audits`、`base_user_credentials`、`base_user_profiles`。
- Global：`global_sites`、`global_site_hosts`、`global_cloud_credentials`、`global_cloud_object_storage_buckets`、`global_cloud_object_storage_bindings`、`global_cloud_object_storage_binding_purposes`、`global_telegram_bots`、`global_cloud_email_channels`、`global_cloud_email_templates`、`global_cloud_email_bindings`、`global_cloud_email_template_publications`、`global_snowflake_states`。
- Passport：`passport_users`、`passport_user_email_otps`、`passport_user_credentials`、`passport_sessions`、`passport_devices`、`passport_device_users`、`passport_telegram_accounts`、`passport_oauth_accounts`、`passport_emails`、`passport_user_emails`、`passport_telegram_email_otps`、`passport_telegram_menus`、`passport_telegram_updates`、`passport_telegram_identity_choices`、`passport_login_challenges`、`passport_sso_requests`、`passport_login_tickets`、`passport_site_sessions`、`passport_group_prompts`、`passport_external_email_otps`、`passport_external_identities`、`passport_external_login_states`、`passport_external_pending_identities`、`passport_external_pending_qr_states`、`passport_external_providers`、`passport_oidc_clients`、`passport_oidc_authorization_requests`、`passport_oidc_authorization_codes`、`passport_oidc_access_tokens`、`passport_oidc_signing_keys`、`passport_user_profiles`。
- PVE：`pve_regions`、`pve_nodes`、`pve_instance_flavors`、`pve_vms`、`pve_vm_tasks`。

`global_schema_migrations` 不在上述 Prisma 清单内，是运行时迁移元数据表，必须按第 6 节登记的基础设施规则处理。

## 2. 必须冻结的公共字段规范

所有业务表（包括 Base、Passport、Global、PVE 和设备/设备快照表）先按以下顺序声明公共字段：

```prisma
id           BigInt  @id @default(autoincrement())
created_at   BigInt
updated_at   BigInt
deleted_at   BigInt  @default(0)
created_duid BigInt?
updated_duid BigInt?
owner_tid    BigInt  @default(1)
owner_bid    BigInt  @default(1)
owner_uid    BigInt?
```

随后才放业务字段。这里的顺序是 Schema、后台表格列、审计工具和未来迁移共同遵守的稳定契约，不是格式偏好。

字段语义固定如下：

| 字段 | 语义和写入方 |
| --- | --- |
| `id` | 本表自增主键；任何稳定业务键都不能替代它 |
| `created_at` | 创建时间；公共数据层在新增时写入，业务层不得传入 |
| `updated_at` | 最后更新时间；公共数据层在新增/更新时写入，业务层不得传入 |
| `deleted_at` | 软删除时间，`0` 表示未删除；删除、恢复、清理只能调用公共数据层操作 |
| `created_duid` | 创建来源 `device_user_id`；普通设备操作写真实值，系统/机器人/无设备操作为 `NULL` |
| `updated_duid` | 最近一次修改来源 `device_user_id`，规则同上 |
| `owner_tid` | 租户归属，创建时确定，`NOT NULL`，默认租户为 `1` |
| `owner_bid` | 分站归属，`NOT NULL`，默认主分站为 `1` |
| `owner_uid` | 账号归属，可空；`NULL` 表示无主账号 |

`duid` 只表示 `device_user_id`，`tid` 只表示 `tenant_id`，`bid` 只表示 `branch_id`。租户和分站不是代码站点，不能改名为 `site`。

### 2.1 当前偏差：字段顺序

当前 64 个有 `key` 的模型基本都以如下顺序开头：

```text
id, key, created_at, updated_at, deleted_at, queued_at,
created_duid, updated_duid, owner_tid, owner_bid, owner_uid, ...
```

这与目标公共字段块不一致：`key` 插入了公共字段中间，`queued_at` 也插入了公共字段中间。`global_snowflake_states` 虽然没有 `key`，仍然把 `queued_at` 放在公共字段块中。

处理要求：

1. `key` 不是公共字段，保留为稳定业务字段时必须移动到所有者字段之后；它仍是 `String` 唯一业务键，不得成为主键。
2. `queued_at` 不能继续占用公共字段位置。它若表示审核队列时间，应改成更明确的 `approval_queued_at` 或 `review_queued_at`；如果确认通用语义成立，也必须移动到所有者字段之后。
3. 先更新表格列顺序测试和 Schema，再生成迁移；不能只调整前端列顺序制造“测试通过”。

### 2.2 当前偏差：时间默认值

发现以下模型仍给公共时间字段设置了 `@default(0)`：

- `created_at @default(0)`：`global_sites`、`global_cloud_object_storage_binding_purposes`、`pve_regions`、`pve_nodes`、`pve_vms`、`pve_vm_tasks`；
- `updated_at @default(0)`：上述 6 个模型以及 `global_site_hosts`。

目标状态是所有表的 `created_at`、`updated_at` 都没有数据库默认值，由公共数据层统一生成真实时间。这样缺字段时数据库会立即拒绝，不会静默落入 `0`。公共层还必须拒绝业务 API 在 `insert` 或 `update` 中显式传入这两个字段；更新只自动改 `updated_at` 和 `updated_duid`，不得覆盖创建字段。

## 3. 主键、业务键和跨表命名

### 3.1 已确认的命名原则

- 主键统一是本表自增 `id BigInt`。
- `key` 是实体自身的稳定业务键，字段本身只叫 `key`；跨表引用才组合成语义名，例如设备自身字段为 `key`，外部引用名才是 `device_key`。
- 关联记录主键一律使用被引用实体名加 `_id`，例如 `passport_user_emails.id` 在其他表中使用 `user_email_id`，设备记录使用 `device_id`，跨域时使用 `passport_device_id` 等完整语义名。
- 外部平台 subject、OAuth provider 账号、幂等键、会话令牌和哈希继续用字符串；“统一 BigInt”不能误伤安全令牌和外部标识。
- 原有业务唯一字段只能保留 `UNIQUE`/唯一索引，不能重新作为主键。

### 3.2 当前 `_key` 字段清单

当前仍有 25 个以 `_key` 结尾的字段。它们必须逐一判断是“错误地用稳定业务键表示内部关系”，还是“跨数据库/跨系统路由所需的稳定字符串”。内部关系应迁移到 `*_id`；保留字符串时必须在模型注释和需求文档中写明它是外部/路由标识，而不是内部外键。

| 范围 | 当前字段 |
| --- | --- |
| Base | `base_audits.row_key`（审计目标的业务行键，是否保持字符串要与审计协议一起定稿） |
| Global 站点 | `global_sites.base_site_key`、`global_site_hosts.site_key` |
| Global 云绑定 | `global_cloud_object_storage_bindings.site_key`、`global_cloud_object_storage_binding_purposes.site_key`、`global_cloud_email_bindings.site_key` |
| Passport 用户关系 | `passport_user_email_otps.user_key`、`passport_user_credentials.user_key`、`passport_sessions.user_key`、`passport_device_users.user_key`、`passport_telegram_accounts.user_key`、`passport_oauth_accounts.user_key`、`passport_user_emails.user_key`、`passport_login_challenges.user_key`、`passport_login_tickets.user_key`、`passport_site_sessions.user_key`、`passport_external_identities.user_key`、`passport_oidc_authorization_codes.user_key`、`passport_oidc_access_tokens.user_key`、`passport_user_profiles.user_key` |
| Passport 目标/路由 | `passport_telegram_identity_choices.target_user_key`、`passport_sso_requests.target_site_key`、`passport_login_tickets.target_site_key`、`passport_site_sessions.site_key`、`passport_external_login_states.qr_user_key` |

Passport 内部关系优先改为 `user_id`；跨域引用 Passport 账号时使用 `passport_user_id`。Global 站点引用要在“同库内部关系”和“跨库路由标识”之间做明确选择，不能因为旧代码使用 `site_key` 就默认它是外键。

### 3.3 `global_snowflake_states` 的特殊性

该表没有 `key`，使用 `worker_id`/时间状态维护雪花 ID。它可以作为基础设施状态表保留无业务 `key`，但必须在 Schema 注释和架构文档里登记为“无稳定业务键的基础设施表”，不能让后续开发人员误以为漏字段。它仍然必须遵守公共字段顺序、软删除和审计字段规则，除非另有明确的基础设施例外。

## 4. 归属、软删除与索引审计

### 4.1 租户唯一索引的目标形态

租户内唯一索引统一以 `owner_tid` 开头，并把 `deleted_at` 放入唯一集合，例如：

```prisma
@@unique([owner_tid, nickname, deleted_at])
```

这样每次按租户读取可以使用索引前缀，软删除后的值也能按规则重新使用。`owner_tid`、`owner_bid` 为 `NOT NULL`，不能利用 `NULL` 的“不相等”行为绕过唯一约束；`owner_uid` 可空且不属于审计字段。

当前只有 9/65 个模型存在以 `owner_tid` 开头的索引或唯一索引：

`base_branches`、`base_users`、`base_configs`、`base_bootstraps`、`base_oidc_users`、`base_audits`、`base_user_profiles`、`pve_nodes`、`pve_vms`。

这不表示剩余模型必然都要机械增加索引：Global、Passport 身份协议、令牌和外部身份可能是全局作用域。发布前必须给每张表写明作用域；没有明确例外的业务表按租户索引规则补齐。

### 4.2 需要逐项决定作用域的复合唯一索引

以下 17 个复合唯一索引当前没有 `owner_tid` 和 `deleted_at`。它们不应直接批量改动，而应按“租户内业务数据”或“协议/全局数据”逐项定稿：

- `base_oidc_sessions [issuer, sid]`
- `base_device_users [device_id, user_id]`
- `base_audits [table_name, row_key, settled_at]`
- `global_cloud_object_storage_buckets [cloud_credential_id, endpoint, bucket]`
- `global_cloud_object_storage_bindings [id, site_key]`
- `global_cloud_object_storage_bindings [site_key, bucket_id, key_prefix]`
- `global_cloud_object_storage_binding_purposes [binding_id, purpose]`
- `global_cloud_email_channels [cloud_credential_id, region, account_name]`
- `global_cloud_email_bindings [site_key, channel_id, template_id, purpose]`
- `global_cloud_email_template_publications [template_id, cloud_credential_id, region]`
- `passport_device_users [device_id, user_key]`
- `passport_telegram_accounts [bot_id, telegram_user_id]`
- `passport_oauth_accounts [provider, provider_user_id]`
- `passport_user_emails [user_key, email_id]`
- `passport_telegram_menus [bot_id, telegram_user_id]`
- `passport_telegram_updates [bot_id, update_id]`
- `passport_external_identities [provider, subject]`

特别注意：`global_cloud_object_storage_bindings [id, site_key]` 包含主键 `id`，当前约束很可能是冗余的；除非它承担明确的复合外键/协议语义，否则应删除，而不是继续保留“看起来更严格”的重复唯一约束。

所有普通查询默认追加 `deleted_at = 0` 和正确的租户范围。回收站、恢复和物理清理由公共数据层提供显式操作，不能让业务接口自己拼接删除条件。

## 5. 类型、状态和字段语义的歧义

以下项目在 beta 前需要定稿，避免同一概念在不同表中使用泛化名称：

| 位置 | 当前问题 | 建议决策 |
| --- | --- | --- |
| `pve_nodes.last_checked_at` | 当前为 `Int?`，而项目时间统一使用毫秒 `BigInt` | 改为 `BigInt?` |
| `BaseTenantStatus` | 同时用于 `base_tenants`、`base_branches`、`base_hosts` | 拆成 `BaseTenantStatus`、`BaseBranchStatus`、`BaseHostStatus`，或登记为明确的共享 enabled 状态 |
| `PassportAccountStatus` | 同时用于 `passport_users`、`passport_external_providers`、`passport_oidc_clients` | 用户账号与 Provider/Client 配置不是同一生命周期；拆分为账号状态和启用状态 |
| `global_cloud_email_templates.type` | 字段名过于泛化，代码/文档已把它当 `template_type` | 统一重命名或在规范中冻结 `type` 的唯一语义 |
| `pve_vms.kind`、`pve_vms.status` | 当前是无约束 `String` | 定义语义明确的枚举或专用状态表 |
| `pve_vm_tasks.action/status` | 当前是无约束 `String` | 明确任务动作、生命周期状态和失败语义，必要时使用枚举 |
| `queued_at` | 目前在所有表的公共字段区域，含义不清 | 若专指审核队列，改为 `approval_queued_at`/`review_queued_at` 并移到业务字段区 |

状态值必须有明确的“未知值”策略；不能把数据库 `1.0`、`1`、`true`、`enabled` 在不同页面随意互换。Schema 类型、API 协议、表单选项和列表显示必须使用同一个语义映射。

## 6. 运行时表和迁移边界

`server/database/migrate.mts` 会直接创建 `global_schema_migrations`，它不是当前四份 Prisma Schema 的模型，但默认 SQLite 中确实存在该表，且当前实际结构包含 `queued_at`。`npm run schema:check` 报出的唯一已知差异是：修复脚本对该表的预期定义没有 `queued_at`。

发布前有两个可接受方向，必须选择一个并写入架构文档：

1. 把它正式登记为数据库基础设施表：在 `schema:check`、`schema-repair` 和迁移说明中使用同一份定义，并明确它不属于业务表清单；或
2. 将其纳入 Prisma/迁移管理，消除运行时手工建表边界。

不能让“运行时表存在、修复工具不知道、Schema 又不声明”的三套事实长期并存。无论选择哪条路，`queued_at` 的最终命名和用途都要先冻结。

## 7. 未被运行时代码使用的模型

扫描运行时源码（排除迁移和文档）未发现以下模型的实际业务读写：

- `passport_oauth_accounts`
- `passport_sso_requests`
- `passport_login_tickets`
- `passport_site_sessions`
- `passport_group_prompts`
- `base_device_snapshots`
- `pve_vm_tasks`

Passport 的 SSO 相关模型尤其需要重新确认：如果 beta 不实现 DiscourseConnect 或其他 SSO 请求流，应在结构冻结前移除，或明确标为下一阶段计划并在需求文档中说明不会被当前 API 使用。设备快照和 PVE 异步任务可以保留为已确认的计划能力，但必须避免被误认为已完成的运行时功能。

## 8. 文档和测试规则冲突

需要在结构改动完成后同步更新：

- `docs/requirements/column-naming.md`：仍描述旧的 `id` 后紧跟 `key` 以及旧 `_key` 关系规则；
- `docs/requirements/pve-site.md`：仍出现 `code`、`name`、`display_name`，而当前 PVE Schema 使用 `key`、`title`；
- `docs/requirements/passport-and-telegram-integration.md` 及 Accounts 相关文档：仍有旧的用户键和身份关系表述；
- `docs/requirements/row-level-data-ownership.md`、`data-visibility-and-delegated-access.md`：需要与 `owner_tid`/`owner_bid`/`owner_uid` 和 `created_duid`/`updated_duid` 的最终顺序、写入方保持一致；
- `scripts/test-naming.mjs`：当前测试仍把 `key`、`queued_at` 当公共字段的一部分，因此即使测试通过，也不能证明新规范已落实；
- `scripts/test-column-order.mjs`：必须在 Prisma 字段顺序定稿后继续作为表格列顺序门禁。

文档更新必须先完成命名决策，再同步 Schema、迁移、测试和后台列定义，不能先改其中一层再让其他层猜测。

## 9. 当前验证结果

以下是本次审计前后使用的命令及其意义：

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `PRISMA_VERIFY_FORCE=1 npm run schema:verify` | 通过 | 快照与当前 Prisma Schema 一致 |
| `npm run test:naming` | 通过 | 仅代表旧命名规则测试通过，不能替代本审计 |
| `npm run test:column-order` | 通过 | 仅代表当前表格列顺序与当前 Schema 一致 |
| `npm run test:database-migrations` | 通过 | 迁移目录和预期关系通过现有测试 |
| `npm run test:sql-builder` | 通过 | SQL 构造器现有测试通过 |
| 四份 `npx prisma validate` | 通过 | Prisma 语法和模型可解析 |
| `npm run typecheck` | 通过 | 当前 TypeScript 类型检查通过 |
| `npm run build:worker` | 通过 | Worker 构建通过 |
| `npm run schema:check` | 有已知差异 | `global_schema_migrations.queued_at` 仍需定稿 |
| `npm run smoke:multi-site` | 未通过 | `scripts/smoke-multi-site.mjs:171` 期待 201，实际 202；需要确认异步审核响应协议 |
| `git diff --check` | 通过 | 当前文档/代码差异没有空白错误 |

在公共字段和响应协议改动完成后，所有“通过”命令都必须重新运行；不能用本次旧测试结果覆盖新结构风险。

## 10. 推荐执行顺序与验收标准

### P0：结构冻结前必须完成

1. 主人确认公共字段顺序、`queued_at` 最终语义和 `key` 的位置。
2. 主人确认每个 `_key` 字段是内部关系还是外部稳定标识，形成逐字段迁移表。
3. 修正 65 个模型的字段顺序和时间默认值，更新命名/列顺序测试。
4. 为每个复合唯一索引登记作用域；需要租户隔离的索引改成 `owner_tid` 前缀并包含 `deleted_at`。
5. 决定 `global_schema_migrations` 的基础设施边界并修复 `schema:check`。
6. 明确删除或保留未实现模型，尤其是 Passport SSO 模型。
7. 修复多站点冒烟测试的 201/202 语义。

### P1：beta 前应完成

1. 统一 PVE 时间字段、状态枚举和实例规格命名。
2. 拆分泛化的账号/Provider 状态枚举。
3. 更新需求文档、API 协议、表格列和数据库修复脚本。
4. 对空库、默认 SQLite、MySQL、PostgreSQL、D1 分别执行迁移和 Schema 检查。

### P2：beta 后可以继续优化

1. 为每个业务表补充明确的归属/可见性说明和针对性索引测量。
2. 清理已经删除的旧路径、旧接口和不再使用的兼容代码。
3. 对设备快照、异步 PVE 任务等计划模型补齐运行时验收测试。

### 最终验收

只有同时满足下列条件，才可以把数据库结构标为 v1.0 beta frozen：

- 四份 Prisma Schema 通过验证，快照、四方言迁移和实际库结构一致；
- 每张表都能解释公共字段顺序、归属作用域、软删除行为和唯一索引作用域；
- 没有未决的 `_key` 内部关系、泛化状态枚举或无约束时间字段；
- 运行时基础设施表已登记并可由检查工具验证；
- 未实现模型都有“删除”或“计划保留”的明确决策；
- `npm run typecheck`、`npm run build:worker`、数据库测试、列顺序测试、`schema:verify`、`schema:check` 和 `npm run smoke:multi-site` 全部通过；
- 迁移编号、数据是否丢弃、验证输出和剩余风险写入本目录的后续交接记录。

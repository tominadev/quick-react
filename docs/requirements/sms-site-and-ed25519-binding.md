# SMS 站点与 Ed25519 设备绑定需求开发文档

状态：需求已确认，未实施。

配套文档：[SMS Mac Shortcut 生成器](sms-shortcut-generator.md) 定义令牌与 Shortcut 文件的生成侧；本文定义站点、数据模型、绑定协议与接收流程。两份文档共用 §4 的数据模型和 §11 的无事务约束。

## 0. 词汇约定

两个方向都涉及短信的传输，用词固定，不得混用：

| 方向 | 用词 | 对应 |
| --- | --- | --- |
| 手机 → SMS | **接收** | 接收接口 `/api/sms/messages/receive`，字段 `received_at` |
| SMS → 用户服务端 | **推送** | `sms_push_endpoints` |

其余称谓遵循 [AGENTS.md](../../AGENTS.md)：本文中的"用户"一律指网站终端用户。

## 1. 背景

SMS 站点集中查看多部手机收到的短信，不负责发送。手机侧由 iOS Shortcut 收到短信后调用 SMS 接收 API，认证方式是每台设备独有的 Bearer 令牌。

除了在页面上手工绑定，用户还需要从自己的服务端自动为账号绑定手机。用户服务端不直接调用浏览器接口，而是用 Ed25519 私钥签发一次性票据，把票据放进静态绑定页面 URL 的 `#` 片段；页面读取片段后通过 AJAX 提交给 SMS 后端完成绑定。私钥始终留在用户服务端，SMS 只保存公钥。

## 2. 目标与边界

### 目标

- 提供 `sms` 业务站点，展示已绑定手机的短信。
- 一名账号可绑定多部手机；每部手机同时只有一个有效的 Shortcut 令牌。
- 用户服务端用 Ed25519 签名票据完成跨页面绑定，不暴露私钥。
- 票据具备受众、有效期、随机数和一次性消费状态，防止跨站重放。
- 为未来 SMS 独立数据库保留清晰的本地身份边界，不跨库读取其他站点的用户表。

### 不在本期范围

- 不发送短信，不实现短信验证码能力。
- 不把 iOS Shortcut 改造成 Ed25519 客户端；Shortcut 是受限客户端，用高熵令牌经 HTTPS 认证。
- 不在浏览器保存或生成用户服务端的私钥。
- 不允许通过修改 URL 中的用户编号、手机号或其他明文参数绕过签名校验。

## 3. 身份与命名

- `sms` 是站点名称，代码、页面和 API 遵循现有站点路径约定。
- 归属主体只使用当前 SMS 数据库中的 `base_users.id`。跨表引用命名为 `base_user_id`，行归属字段为 `owner_uid`。
- `base_users` 由 Base 层声明。共享数据库的继承站点共用同一张 `base_users`；独立数据库时每个库各有一份。SMS 不创建 `sms_users`，不读取其他站点的用户表。
- 本地密码登录和外部登录都由 Base 认证边界转换为 SMS 本地会话。SMS 业务模块只读取会话得到的 `base_user_id`，不关心认证来源。
- 票据直接使用 `base_user_id`，不使用裸 `uid`，也不使用 `subject_type + subject_id` 这类身份多态字段。
- 后端不根据请求方自称或当前 URL 推断身份，只认已登记接入方签发的票据。
- **绑定有两条路径，身份来源不同**：有本站会话时取会话的 `base_users.id`，一律不接受前端提交的用户编号；无本站会话时才使用票据中的 `base_user_id`。流程分别见 §6.1 与 §6.2。
- 后端必须确认 `base_user_id` 属于 SMS 当前数据库，不能把其他站点的用户 ID 当成本地用户 ID。

## 4. 数据模型

所有表遵循项目统一的**十一个系统字段**，顺序固定、由公共层维护、业务 API 一律不提交（见
[列命名约定](column-naming.md)）：

```
id  key  created_at  updated_at  deleted_at  queued_at  created_duid  updated_duid
owner_tid  owner_bid  owner_uid
```

其中 `key` 是机器写的稳定标识（雪花号或 UUID），跟 `id` 一样只用来指向这一行，**不装人给的值**；
`queued_at` 非 0 表示这一行还在审批队列里等着生效，对正常查询不可见；`owner_*` 是行归属字段，
不是审计字段。

**唯一约束里只有这张表的名字列参与时才带 `deleted_at`。** 名字是人取的，软删一行之后同一个
名字该能再用；哈希、令牌摘要、nonce、对象键这些要么是机器生成、要么是外部给定，永不重复，
带上 `deleted_at` 纯属多余——更要紧的是**不带反而更安全**：一个已消费的 nonce 即便记录被删掉
也不该能重放，一个撤销过的令牌哈希不该能借尸还魂。

名字列默认叫 `name`；个别表里 `name` 读不出它装的是什么，可以换一个更具体的词，但必须登记
在 `shared/system-fields.mts` 的 `NAME_COLUMNS` 里——本文的 `sms_phones` 就登记成了 `number`。

名字列的唯一索引形态固定为 `@@unique([owner_tid, <名字列>, deleted_at])`。

**外键列一律建索引**（`@@index([<列>])`）：没有索引的外键意味着查询全表扫，而这套设计里
`phone_id`、`token_id`、`integration_client_id`、`message_id`、`push_endpoint_id`、
`generator_machine_id`、`owner_uid` 都在高频路径上。

### 4.1 `sms_integration_clients`

登记可以代表用户签发绑定票据的服务端接入方。

| 字段 | 说明 |
| --- | --- |
| `name` | 接入方标识，`(owner_tid, name, deleted_at)` 唯一。票据 JSON 中的协议字段名为 `client_id`，取的就是这个值 |
| `title` | 管理端显示名称 |
| `binding_scope` | 允许的绑定能力，本期固定包含 `phone:bind` |
| `status` | `enabled` / `disabled` |
| `last_used_at` | 最近成功验证时间，可为空 |

公钥不在本表：轮换期间需要新旧公钥并存，一行放一个公钥做不到，因此拆到 §4.2。

### 4.2 `sms_integration_client_keys`

一个接入方可以有多个公钥，按 `kid` 定位。

| 字段 | 说明 |
| --- | --- |
| `integration_client_id` | 指向 `sms_integration_clients.id` |
| `kid` | 密钥标识，票据中携带；`(integration_client_id, kid)` 唯一 |
| `public_key` | Ed25519 公钥，原始字节的 Base64URL 表示 |
| `status` | `active` / `retired` |
| `retired_at` | 停用时间，可为空 |

**协议只认 `kid`，不存在 `key_version` 这个协议字段。** 轮换流程：先登记新 `kid` 并置为 `active`，接入方切换后把旧 `kid` 置为 `retired`；`retired` 的公钥立即拒绝新票据。私钥永远不写入 SMS 数据库、日志、API 响应或前端页面。

### 4.3 `sms_phones`

| 字段 | 说明 |
| --- | --- |
| `owner_uid` | 归属账号，指向当前数据库的 `base_users.id` |
| `number` | 规范化后的 E.164 手机号，`(owner_tid, number, deleted_at)` 唯一。票据中的协议字段名为 `phone` |
| `title` | 用户可修改的设备名称 |
| `status` | `enabled` / `disabled` / `revoked` |
| `bound_at`、`revoked_at` | 绑定与撤销时间，后者可为空 |

**`number` 是这张表的名字列。** 「名字列」装的是人给的、可重用的标识——人取的、可以改的、
租户内唯一的、不被别的表引用的那一列。手机号四条全中，所以它就是这张表的名字列;默认该叫
`name`，但 `sms_phones.name` 读不出它装的是手机号，因此**登记**成 `number`
（登记表在 `shared/system-fields.mts` 的 `NAME_COLUMNS`，`test:naming` 照着它守）。

这个身份决定了一件业务上必须成立的事：**只有名字列的唯一索引带 `deleted_at`，因此解绑之后
同一个号能重新绑回来。** 换成一个没登记的列名就不带 `deleted_at`（§4 的规则），那条被软删的
记录会永久占住这个号——而下面的 `revoked` 语义明确要求「只能重新绑定」，两者会直接打架。
这个后果不是报错，是要等到线上才发现的一个 bug，所以登记不是形式。

协议字段名仍是 `phone`，对外的票据格式不受影响。这张表因此**不再有一列叫 `name`**——
两个名字列会让「名字列参与的唯一索引」说的是哪一个都不清楚，`test:naming` 直接报。

`title` 而不是 `display_name`：显示名一律用 `title`，`display_name` 是被禁的词。

`status` 三值语义：`enabled` 正常接收；`disabled` 用户临时停收，关系保留，可自行恢复；`revoked` 已解绑，关系终止，不可恢复，只能重新绑定。

**本表不保存当前令牌的引用。** 令牌与手机的关系只由 `sms_shortcut_tokens.phone_id` 单向维护——双向外键在无事务环境下必然出现单边不一致，见 §11。查询手机的当前令牌用 `phone_id` 反查。

手机号本身不是认证凭证。解绑或撤销后原令牌立即失效，不能继续写入短信。

同一归属账号与同一规范化手机号的绑定必须幂等：重复绑定直接返回成功，不创建重复的有效记录——靠的就是 `(owner_tid, number, deleted_at)` 这条唯一索引加 `ignoreInsert`，不是先查后插（理由同 §4.6）。手机号已属于其他账号时拒绝，不自动迁移。

### 4.4 `sms_shortcut_tokens`

记录 Shortcut 令牌的服务端摘要。原始令牌只存在于 Shortcut 文件与用户手机。

| 字段 | 说明 |
| --- | --- |
| `token_sha256` | 原始令牌的 SHA-256，小写十六进制 64 字符，`(token_sha256)` 唯一 |
| `owner_uid` | 令牌归属账号；公共池阶段为空，领取时写入 |
| `phone_id` | 绑定的手机；`pending` 与 `available` 状态下均为空 |
| `status` | `pending` / `available` / `bound` / `revoked` |
| `idempotency_token` | 生成任务的幂等键，`(idempotency_token)` 唯一 |
| `last_used_at` | 最近一次成功提交短信的时间，可为空 |

`status` 四值语义：`pending` 入库过程中的中间态，不可领取；`available` 在公共池中待领取；`bound` 已绑定手机；`revoked` 已作废。

入库与领取的具体步骤见 §5，无事务前提下的原子性处理见 §11。

原始令牌与 `token_sha256` 敏感级别相同，任一泄露都必须立即撤销该令牌。

### 4.5 `sms_shortcut_artifacts`

Shortcut 文件本身存放在私有对象存储，数据库只保存元数据。

| 字段 | 说明 |
| --- | --- |
| `token_id` | 指向 `sms_shortcut_tokens.id` |
| `object_key` | 私有对象键，`(object_key)` 唯一 |
| `file_sha256` | 文件摘要，小写十六进制 64 字符，用于上传完成校验 |
| `size_bytes` | 文件大小 |
| `content_type` | 由服务端固定写入，生成器不提交 |
| `version` | 同一令牌的文件版本号 |
| `generator_machine_id` | 指向 `sms_generator_machines.id`，由服务端从凭证解析后写入 |
| `status` | `ready` / `revoked` |

唯一约束 `(token_id, version)`。换发新文件时递增 `version` 并把旧版本置为 `revoked`。

`object_key` 形状为 `shortcuts/<机器 name>/<yyyymmdd>/<毫秒时间戳>-<随机后缀>.shortcut`，目录名取 `sms_generator_machines.name`。**随机后缀不可省略**：仅由时间戳构成时，并发的 `prepare-upload` 可能落在同一毫秒并生成相同键，后一次 PUT 会覆盖前一个对象，导致令牌记录指向装着另一个令牌的文件，领取者会拿到他人的令牌并读到他人短信。随机后缀至少 8 字节，取自密码学安全随机源。对象键不得包含手机号或 `token_sha256`。

只有 `status = 'ready'` 且对应令牌 `status = 'available'` 的记录才允许被领取。用户下载时由后端返回短期预签名 GET 地址，Bucket 禁止公共读。

### 4.6 `sms_messages`

| 字段 | 说明 |
| --- | --- |
| `owner_uid` | 短信归属账号，等于所属手机的 `owner_uid` |
| `phone_id` | 来源手机 |
| `content` | 短信正文 |
| `recipients` | 收件人 |
| `sender` | 发送人 |
| `received_at` | 接收时间 |
| `payload_hash` | 去重哈希，`(phone_id, payload_hash)` 唯一 |

去重靠唯一约束加 `ignoreInsert` 完成，**不使用"先查后插"**——无事务环境下先查后插存在竞态，且违反 AGENTS.md 对业务唯一字段的约束。

**`payload_hash` 必须把接收时间算进去。** 这条唯一索引不带 `deleted_at`（§4 的规则），因此
软删掉的短信仍然占着它那个哈希：只按正文与发送人算的话，用户删掉一条短信之后，同样内容的
下一条会被当成重复丢弃，而那明明是一条新短信。把 `received_at` 纳入哈希输入，同一条短信的
重复投递（Shortcut 重试）哈希不变、照旧去重，不同时刻的两条则各算各的。

短信由 Shortcut 用 Bearer 令牌写入，那一刻没有登录会话，公共层的归属上下文为空。**因此写入前必须显式绑定归属**，否则 `owner_uid` 会被填成 `NULL`，而 `NULL` 归属的行对普通账号一律不可见——**短信的主人自己也看不到自己的短信**：

```ts
const owned = withDatabaseActors(database, { baseUserId: phone.owner_uid });
await runSql(owned, sql({ database: owned }).ignoreInsert('sms_messages', ['phone_id', 'payload_hash'], { ... }));
```

同一模式适用于 §6.2 的票据绑定路径。相关的通用问题见 [数据行归属需求](row-level-data-ownership.md) §9。

列表默认只返回未删除记录。用户主动删除采用软删除，进入回收站。

#### 保留期与清理

`sms_messages` 是本站唯一会持续膨胀的表，必须有保留期，否则只增不减。

- 保留期由站点配置项 `sms.message_retention_days` 控制，默认 **90 天**，设为 `0` 表示不自动清理。租户级覆盖属于后续需求：`base_tenants` 是 Base 层的表，不应写入 SMS 专有字段。
- **到期记录物理删除，不是软删除。** 软删除只是标记，表体积照涨，起不到控制增长的作用。清理走公共层的 `delete`，按 `received_at` 判定。
- 回收站中的软删除记录同样受保留期约束，不因已软删除而豁免。
- 清理由定时任务执行，**分批进行且可重入**：每批限量（建议 1000 行），按 `received_at` 升序，删完一批即提交。无事务环境下不做长事务，任务中断后下次运行继续。
- 清理任务以系统上下文运行（未绑定主体），因此不受行级判定约束。
- 删除前不做导出。用户若需长期留存，应通过 §4.9 的推送把短信投递到自己的服务端。

### 4.7 `sms_ticket_nonces`

票据的一次性消费记录。

| 字段 | 说明 |
| --- | --- |
| `integration_client_id` | 签发该票据的接入方 |
| `nonce` | 票据中的随机数；`(integration_client_id, nonce)` 唯一 |
| `expires_at` | 取票据的 `exp`，用于过期清理 |

**消费方式是插入而不是更新**：用 `ignoreInsert` 写入，影响行数为 0 即表示该 nonce 已被使用，绑定失败。唯一约束在数据库层保证一次性，无需事务，见 §11。已过期的记录由清理任务按 `expires_at` 删除。

### 4.8 `sms_access_keys`

用户服务端调用管理 API 的 Bearer Access Key。只保存哈希、前缀、归属账号、权限范围、状态和过期/撤销时间，原始 Key 只展示一次。

### 4.9 短信推送

把收到的短信投递到用户自己的服务端。方向与 §0 的"接收"相反，术语固定为**推送**。

#### 4.9.1 `sms_push_endpoints`

| 字段 | 说明 |
| --- | --- |
| `url` | 推送目标，必须 HTTPS（本地开发可显式配置例外） |
| `status` | `enabled` / `disabled` |
| `phone_id` | 限定只推送该手机的短信；为空表示该账号全部手机 |
| `last_success_at`、`last_error` | 最近一次成功时间与最近错误摘要 |

**这张表不存任何密钥。** 推送用 Ed25519 签名，私钥是平台自己的，放在平台密钥存储（环境变量或 Secret）里，不进数据库；接收方用 SMS 公布的公钥验签。因此没有对称密钥要分发、要加密存储、要逐个端点轮换。

这与绑定票据是**同一套签名方案，只是方向相反**：接入方用自己的私钥签票据、SMS 用登记的公钥验；推送时 SMS 用自己的私钥签、接收方用 SMS 的公钥验。全系统一套编码规则、一套跨语言测试向量。

**URL 必须做出站目标校验（SSRF 防护）。** 地址由用户任意填写，若不加限制，推送就成了从服务端发起的任意内网请求。解析后的目标 IP 落在以下范围时一律拒绝保存并拒绝投递：回环（`127.0.0.0/8`、`::1`）、私有网段（`10/8`、`172.16/12`、`192.168/16`、`fc00::/7`）、链路本地（`169.254/16`，含云元数据地址 `169.254.169.254`）、以及 `0.0.0.0/8`。校验必须在**每次投递前**重做，不能只在保存时做一次——DNS 记录可以在保存之后被改指到内网地址。

#### 4.9.2 推送请求格式

```http
POST <url>
Content-Type: application/json
X-Sms-Timestamp: 1788432000
X-Sms-Delivery-Id: <本次投递的稳定标识>
X-Sms-Signature: ed25519=<base64url>
```

签名为 Ed25519，输入是 `timestamp + "." + 原始请求体字节`，输出 Base64URL（去 `=`），与绑定票据的编码规则一致。接收方从 SMS 的公钥端点取公钥验签，应校验时间戳在合理窗口内（建议 5 分钟）以防重放，并按 `X-Sms-Delivery-Id` 去重。

请求体包含短信正文、来源手机的掩码号码与接收时间；不包含原始令牌、`token_sha256` 或其他账号的信息。

#### 4.9.3 `sms_push_deliveries`

投递状态必须落库，否则进程重启后重试队列丢失。

| 字段 | 说明 |
| --- | --- |
| `message_id` | 来源短信 |
| `push_endpoint_id` | 目标推送地址 |
| `delivery_id` | 稳定标识，`(delivery_id)` 唯一；重试沿用同一值 |
| `status` | `pending` / `sending` / `succeeded` / `failed` |
| `attempts` | 已尝试次数 |
| `next_attempt_at` | 下次尝试时间 |
| `last_error` | 最近错误摘要，不含密钥与短信正文 |

唯一约束 `(message_id, push_endpoint_id)`：同一条短信对同一目标只产生一条投递记录，避免重复排队。

#### 4.9.4 投递与重试

- 只有 HTTP 2xx 视为成功，其余（含超时）计为失败。请求超时建议 10 秒。
- 重试采用指数退避，建议 1 分钟起、上限 6 次，用尽后置为 `failed` 并停止。
- 抢占待投递记录用**单条条件更新**，不用事务：

```sql
UPDATE sms_push_deliveries SET status = 'sending', attempts = attempts + 1
WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?
```

影响行数为 0 表示已被其他工作进程取走，跳过即可。这与 §11 的无事务原则一致。

- 投递任务以系统上下文运行，不受行级判定约束。
- `failed` 记录保留供用户查看，随所属短信一并按 §4.6 的保留期清理。
- 用户可在管理页手动重投单条 `failed` 记录：重置为 `pending` 并沿用原 `delivery_id`，使接收方的去重仍然有效。


### 4.10 `sms_generator_machines`

登记允许运行 Shortcut 生成器的 Mac，一台一行，凭证是它的字段而非独立实体。

| 字段 | 说明 |
| --- | --- |
| `name` | 机器标识，`(owner_tid, name, deleted_at)` 唯一，同时作为对象键中的目录名 |
| `name` | 管理端显示名称 |
| `secret_hash` | 平台预配凭证的哈希，与 `sms_access_keys` 同规则，不保存明文 |
| `secret_prefix` | 凭证前缀，仅用于在管理端辨认，不足以还原凭证 |
| `status` | `enabled` / `disabled` |
| `last_used_at` | 最近一次成功调用生成接口的时间，可为空 |

`key` 使用运维分配的短标识（如 `mac-studio-01`），**不使用主机名或硬件 UUID**：主机名常含人名且可变，硬件 UUID 属于设备指纹，两者都不适合出现在对象键里。

管理操作：**新增机器**（服务端生成高熵凭证，存哈希，明文只在创建响应中展示一次）、**重置凭证**（生成新凭证，旧凭证立即失效）、**停用机器**（`status` 置 `disabled` 后凭证立即被拒，不影响其他机器与已生成的令牌文件）。

创建和重置的响应**直接生成一份完整的 `.env`**，供运维整体复制到对应的 Mac。生成器的全部配置来自这一份文件，不再需要额外的配置接口：

```dotenv
# machine: mac-studio-01
SMS_API_BASE=https://sms.example.com/api/sms
SMS_PROVISIONING_KEY=<明文凭证，只展示一次>
```

- 机器标识以注释形式写入，仅供运维辨认。它**不是有效变量**，生成器不读取也不提交——机器身份由服务端从凭证解析，见上文。
- `.env` 只包含平台预配凭证。**不得写入用户 Access Key 或 Ed25519 私钥**：生成器不调用用户级 API，也不签发绑定票据，放进去只会扩大泄露面。
- 该文件同时含地址与凭证，泄露即是一套完整可用的凭据。要求权限 `600`，不进版本库，并排除出 Time Machine 等备份范围。生成用的 Mac 是专用运维机器，接受明文落盘；补救手段是后台重置凭证，旧 `.env` 立即失效。
- **`.env` 里只有管理接口基址，没有短信接收地址。** 接收地址会被烤进 Shortcut 文件并分发到用户手机，一旦做成快照就会静默过期，因此由生成器在每次运行时通过 `action=config` 拉取当前值，见 §5。基址过期则是安全的：生成器第一次调用就失败，重新下发 `.env` 即可。

管理页面挂在 `/panel/admin/sms` 下，API 为 `/api/panel/admin/sms/...`，代码位于 `server/routes/sms/api/panel/admin/sms/`，与表前缀 `sms_` 对应。

本表属于平台运维数据，`owner_uid` 为 `NULL`，因此行级判定已经使它对普通账号不可见（可见性文档 §5.2 第 4 条）。管理页面仍按 `admin` 角色限制访问，两层各自独立生效。

### 4.11 各类凭证的区分

| 凭证 | 持有者 | 能做什么 | 服务端如何保存 |
| --- | --- | --- | --- |
| Shortcut 原始令牌 | 用户手机 | 只能提交短信 | 只存 SHA-256 |
| 用户 Access Key | 用户服务端 | 调用用户级管理 API | 只存哈希 |
| 平台预配凭证 | 生成用的 Mac | 只能登记令牌、上传和确认 Shortcut 文件 | 只存哈希 |
| Ed25519 公钥 | SMS（私钥在接入方） | 验证绑定票据 | 明文公钥 |
| 推送签名私钥 | SMS 平台 | 为推送请求签名 | **不入库**，放平台密钥存储 |

五者不能互相替代。数据库里没有任何可解密的密钥：校验类只存哈希，签名类要么只存公钥（接入方），要么根本不入库（推送私钥）。平台预配凭证不属于任何账号，不下发给用户，不能调用短信接收或账号绑定接口。Ed25519 只证明"登记的服务端持有私钥并签署了该票据"，不替代用户登录会话，也不替代手机令牌认证。

## 5. 令牌的生成、入库与领取

Shortcut 文件必须在 macOS 上生成和签名，因此**令牌只能由 Mac 生成器创建，管理端不能生成令牌**。管理端只能撤销、回收和重新分配已存在的令牌。生成器侧的完整流程见 [生成器文档](sms-shortcut-generator.md)。

生成器在每次运行开始时调用 `GET /api/sms/shortcut-tokens?action=config`（凭平台预配凭证认证），获取要写进 Shortcut 的短信接收接口完整地址。该地址由服务端按当前站点配置和 `siteConfig.apiSuffix` 拼出，**不下发给生成器保存**：它会被烤进文件并分发到用户手机，做成快照就会静默过期。服务端改动接收路径后无需重新下发 `.env`，下一批生成自动使用新地址。

### 5.1 入库（四步收敛，无事务）

生成器上传文件并调用 `commit` 后，服务端验签上传票据、校验对象存在与摘要一致，然后：

1. 以 `status = 'pending'` 插入 `sms_shortcut_tokens`，带 `idempotency_token`；重复提交在唯一约束处被挡下。
2. 按 `idempotency_token` 读回 `token_id`。
3. 插入 `sms_shortcut_artifacts`，`status = 'ready'`。
4. 把令牌由 `pending` 改为 `available`。

任一步之后中断都不产生有害中间态：`pending` 令牌不可领取，孤儿对象由生命周期规则清理。重试同一 `idempotency_token` 会收敛到同一结果。同一 `idempotency_token` 携带与首次不同的 `token_sha256` 或 `file_sha256` 时必须拒绝，不得覆盖也不得返回成功。

### 5.2 领取（单条条件更新）

```sql
UPDATE sms_shortcut_tokens SET owner_uid = ?, phone_id = ?, status = 'bound'
WHERE id = ? AND status = 'available'
```

影响行数为 0 表示令牌已被他人领取或状态不符，按失败处理。

> 该语句由业务代码直接写 `owner_uid`。是否应改为公共层的归属变更操作，见 [数据行归属需求](row-level-data-ownership.md) §5.5，待主人确认。

### 5.3 换绑（先撤旧、后绑新）

手机更换令牌时，两步的顺序是强制的：**先把旧令牌置为 `revoked`，再领取新令牌**。中间态是"手机暂时没有有效令牌"，无害；反序则会短暂出现两个有效令牌，可能被同时用于写入。

## 6. 绑定流程

### 6.1 会话路径（用户在 SMS 站点内操作）

1. 用户在已登录的 SMS 页面发起绑定，提交手机号与设备名称。
2. 后端取**当前会话**的 `base_users.id` 作为归属，忽略请求中的任何用户编号。
3. 校验手机号格式与归属冲突，创建或复用 `sms_phones` 记录。
4. 按 §5.2 领取一个 `available` 令牌。
5. 在同一响应中返回短期下载动作，前端不根据 API 路径自行推断跳转或刷新。

### 6.2 票据路径（用户服务端代为绑定）

1. 用户服务端验证自己的登录状态和手机号归属，按 §7 生成票据并签名。
2. 把票据放入绑定页面 URL 的片段，例如 `/sms/bind.html#ticket=...`。
3. 静态页面只读取片段，读取后立即用 `history.replaceState` 清除地址栏中的票据，不写入埋点、控制台或 Referer。
4. 页面通过统一 API 提交票据；后端解析票据、按 `client_id` 与 `kid` 查找公钥，校验签名、`aud`、时间窗、`base_user_id` 是否属于本库、手机号格式。
5. **消费 nonce**：向 `sms_ticket_nonces` 执行 `ignoreInsert`，影响行数为 0 即判定票据已使用，直接失败。该步不使用事务，一次性由唯一约束保证。
6. nonce 消费成功后创建或更新手机绑定关系。写入时必须显式绑定归属上下文（`withDatabaseActors(database, { baseUserId: ticket.base_user_id })`），此路径没有本站会话，否则 `owner_uid` 会被填成 `NULL`。
7. 按 §5.2 领取令牌，并在同一响应中返回短期下载动作。

第 5 步先于第 6 步是有意的：nonce 一旦消费成功，票据即作废；后续步骤失败时用户需要重新签发票据，而不是能用同一张票据重试。这样避免了在无事务环境下出现"绑定失败但 nonce 已消费"与"绑定成功但 nonce 未消费"两种更糟的组合中的后者。

## 7. Ed25519 签名票据

### 7.1 票据内容

用户服务端签名固定的 UTF-8 JSON。字段名、类型和序列化规则必须固定，禁止按语言默认顺序或浮点格式序列化。

```json
{
  "v": 1,
  "aud": "sms",
  "client_id": "client_xxx",
  "kid": "2026-09-01",
  "base_user_id": "123456",
  "phone": "+8613800000000",
  "iat": 1788432000,
  "exp": 1788432300,
  "nonce": "random-base64url"
}
```

| 字段 | 说明 |
| --- | --- |
| `v` | 协议版本 |
| `aud` | 固定为 `sms`，防止票据被其他站点接受 |
| `client_id` | 对应 `sms_integration_clients.key` |
| `kid` | 对应 `sms_integration_client_keys.kid`，唯一确定验签公钥 |
| `base_user_id` | 目标账号，必须存在于当前 SMS 数据库的 `base_users` |
| `phone` | 规范化后的 E.164 手机号，对应 `sms_phones.number` |
| `iat`、`exp` | Unix 秒；有效期不超过 5 分钟，允许的时钟偏差不超过 60 秒 |
| `nonce` | 接入方生成的高熵随机数，同一接入方不得重复 |

签名使用 Ed25519，输入是规范化 JSON 的 UTF-8 字节，输出为 Base64URL（去掉 `=`）。传输格式：

```text
base64url(payload).base64url(signature)
```

### 7.2 失败规则

以下情况必须返回确定性错误，不得返回内部异常，也不得继续绑定：

| 情况 | 提示 |
| --- | --- |
| `client_id` 或 `kid` 不存在、已禁用、已 `retired` | 签名接入方无效 |
| 公钥、签名格式或验签失败 | 绑定票据签名无效 |
| `aud` 不为 `sms` | 绑定票据受众不匹配 |
| `iat` / `exp` 超出允许范围 | 绑定票据已过期或尚未生效 |
| nonce 已消费 | 绑定票据已使用 |
| 目标账号不存在或不允许该接入方操作 | 目标身份无权绑定手机 |
| 手机号格式错误 | 手机号码格式不正确 |
| 手机已绑定其他账号 | 手机已绑定其他账号，不得自动迁移 |

手机已绑定当前账号时按幂等处理：返回成功，不产生重复记录。

## 8. Shortcut 接收短信流程

接收接口的规范路径：

```http
POST /api/sms/messages/receive
Authorization: Bearer <原始令牌>
Content-Type: application/json
```

```json
{
  "content": "短信正文",
  "recipients": ["+8613800000000"],
  "sender": "+8613900000000"
}
```

实际下发给生成器的是带域名与 `siteConfig.apiSuffix` 的完整地址，由 §5 的 `action=config` 拼出，Shortcut 内烤的是那个完整值。

- 只允许 `POST`，经 HTTPS 并使用 `Authorization: Bearer <token>` 认证。
- 原始令牌只放在 `Authorization` 头，不得进入 URL 或 JSON 正文；接收时间与设备关系由服务端补充。
- 服务端先对收到的原始令牌计算 SHA-256，再查找令牌、检查手机状态、去重并写入；查询不得把摘要当作可重放凭证，比较使用恒时算法。
- 令牌被撤销、手机被禁用或已解绑时拒绝写入并返回确定性错误。
- 失败响应不得回显令牌、完整手机号、短信正文或数据库内部异常。
- **限流按来源而非按令牌**：无效令牌查不到记录，没有可冻结的对象，只能按来源 IP 或接入点限流。已知令牌的连续失败才可触发该令牌冻结，且不影响用户的其他登录会话。

## 9. 管理与用户操作

- 管理端可以撤销、回收和重新分配令牌；已绑定的令牌重新分配前必须显式撤销原关系。**管理端不能创建令牌**，令牌只能由 Mac 生成器产生，见 §5。
- 用户可以查看手机名称、号码掩码、最近接收时间、令牌状态和推送地址。
- 用户可以解绑自己的手机。解绑确认文案必须显示手机名称和掩码号码，不能只说"该设备"或"该身份"。
- 接入方的公钥、`kid`、绑定能力、状态由管理端维护；私钥只由接入方保管。
- 所有令牌、公钥、绑定和撤销操作写入统一审计字段；敏感值不进入日志。

## 10. 安全与运行时要求

- 接入方若使用 PHP，用 `ext-sodium` 的 `sodium_crypto_sign_detached` 生成签名；Composer 不是协议依赖。SMS 服务端使用对应的 Ed25519 验签实现。
- Ed25519 在 Node 与 Cloudflare Workers 上的 Web Crypto 支持存在差异，实施前必须先用同一测试向量在两端各跑通一次，再进入 §12 的其余验收。
- 所有 API 使用参数化数据库助手，不拼接 SQL；固定审计字段由公共层补充。
- Node、Worker 与接入方必须使用同一套编码规则：摘要为小写十六进制，公钥与签名为 Base64URL（去 `=`），时间为 Unix 秒，请求响应为 UTF-8 JSON。
- 绑定票据只能在片段中传递，不得放入查询参数；片段属于敏感短期凭证，页面必须尽快清除。
- 生产环境只接受 HTTPS；CORS、来源校验、限流与请求体大小限制由公共 API 层处理。

## 11. 无事务约束汇总

`server/database/d1.mts` 只实现了 `prepare` 与 `batch`，**没有 `transaction`**（`sqlite.mts`、`mysql.mts`、`postgresql.mts` 三个适配器均有）。Cloudflare 部署下无事务可用，因此本需求全部改用单语句原子性与唯一约束。开发时凡是想写"在一个事务里……"的地方，先回到本节。

| 场景 | 做法 | 中断后的状态 |
| --- | --- | --- |
| 令牌与文件元数据入库（§5.1） | 四步收敛，`idempotency_token` 唯一约束保证幂等 | 停在 `pending`，不可领取，重试收敛 |
| 领取令牌（§5.2） | 单条 `UPDATE ... WHERE status='available'`，看影响行数 | 要么领到要么没领到，无中间态 |
| 换绑令牌（§5.3） | 先撤旧、后绑新，顺序强制 | 手机暂时无有效令牌，无害 |
| 消费 nonce（§6.2） | `ignoreInsert` 到 `sms_ticket_nonces`，看影响行数 | 一次性由唯一约束保证 |
| 短信去重（§4.6） | `ignoreInsert`，`(phone_id, payload_hash)` 唯一 | 不会产生重复记录 |
| 令牌与手机的关系 | 只用 `sms_shortcut_tokens.phone_id` 单向维护 | 不存在双边不一致 |
| 抢占待推送记录（§4.9.4） | 单条 `UPDATE ... WHERE status='pending' AND next_attempt_at <= ?` | 要么抢到要么没抢到，不会重复投递 |
| 短信到期清理（§4.6） | 分批物理删除，可重入 | 删了一部分，下次继续 |

## 12. 验收标准

- 接入方、Node 与 Worker 能用同一测试向量互相验签；签名内容有一个字节差异时必须失败。
- 有效票据只能成功绑定一次；重复提交、修改手机号、修改身份、修改受众或修改过期时间都失败。
- 绑定页面刷新或清除片段后，已消费票据不能再次提交。
- 公钥置为 `retired` 后新票据立即失败；轮换期间新旧 `kid` 的行为符合各自登记状态。
- 会话路径绑定时，请求中携带的任何用户编号都被忽略，归属始终是当前会话账号。
- 票据路径绑定成功后，`sms_phones.owner_uid` 等于票据中的 `base_user_id`，不为 `NULL`。
- Shortcut 用正确令牌能写入短信，令牌撤销后立即失败；重复消息不产生重复记录。
- 写入的短信 `owner_uid` 等于所属手机的 `owner_uid`，不为 `NULL`。
- 并发领取同一令牌时只有一个成功，其余按失败处理。
- 管理端没有创建令牌的入口。
- 非 `admin` 账号读不到 `sms_generator_machines`（行级判定与路由层各自都能拦下）。
- 绑定、解绑、撤销、令牌失败与验签失败都有明确反馈；日志中没有私钥、原始令牌、`token_sha256`、签名或短信正文。
- 超过保留期的短信被物理删除，未到期的不受影响；清理任务中断后重跑能继续删完。
- 保留期配置为 `0` 时不发生任何自动删除。
- 推送目标解析到回环、私有网段或 `169.254.169.254` 时，保存被拒绝；保存后把 DNS 改指内网，下一次投递同样被拒绝。
- 推送请求的签名可由接收方用同一密钥复算通过；改动请求体任意一个字节后校验失败。
- 推送失败后按退避重试，次数用尽置为 `failed`；手动重投沿用原 `delivery_id`。
- 同一条短信对同一推送目标只产生一条投递记录，并发工作进程不会重复投递。
- 推送日志与 `last_error` 中不出现签名密钥或短信正文。
- 未来 SMS 分库后，站点只依赖本站 `base_users` 和登记的服务 API，不读取其他站点数据库。

## 13. 待定事项

- §5.2 领取令牌时由业务代码直接写 `owner_uid`，是否改为公共层的归属变更操作，见 [数据行归属需求](row-level-data-ownership.md) §5.5。
- SMS 的行级隔离依赖 [数据可见性与代用户操作](data-visibility-and-delegated-access.md) 落地。在此之前 `owner_uid` 只是标记，短信与手机的隔离完全由路由层承担。

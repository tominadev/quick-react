# 项目协作规范

## 称谓约定

本项目里"用户"是**业务概念**，只指网站的终端用户（`passport_users`、`base_users` 里的账号）。给 agent 下达指令的人一律称为**主人**。

| 称谓 | 指谁 | 出现位置 |
| --- | --- | --- |
| 主人 | 给 agent 下指令、做决策的人 | 本文件、agent 与主人的对话 |
| 用户 / 账号用户 | 网站的终端用户 | 需求文档、代码注释、界面文案 |

这条约定是硬性的：agent 接入线上站点后会同时面对"主人的指令"和"用户的数据"，两者混淆会导致按错误的身份执行操作或泄露他人数据。写文档、写注释、写界面文案时都必须区分，不确定时按上表对号入座。

后期 AI 客服会同时面对这两方，完整的身份与数据访问边界见 [docs/requirements/ai-agent-boundaries.md](docs/requirements/ai-agent-boundaries.md)：**身份只由会话决定，不由对方自称决定**。

## 开发流程

- 按主人确认的功能顺序逐项实现。
- 每完成一个明确功能，先运行类型检查、构建和相关测试，再决定是否提交。
- 发现业务规则、数据结构、权限或交互存在不确定性时，停止实现并向主人说明已确认内容、未决问题和影响范围。
- 不因为功能尚未全部完成而阻止阶段性提交；只要当前改动没有已知问题且验证通过，就可以提交。

## 架构约束

- 本项目按当前数据结构和接口直接收敛实现，默认不兼容旧版本的字段、接口、数据格式或行为；只有主人明确要求时才增加兼容层，并应限定兼容范围和清理计划。
- 数据表字段顺序固定：前六个字段必须依次为 `id BigInt @id @default(autoincrement())`、`created_at BigInt`、`updated_at BigInt`、`deleted_at BigInt @default(0)`、`created_duid BigInt?`、`updated_duid BigInt?`，随后紧接两个可空业务归属字段 `owner_tid BigInt?`、`owner_uid BigInt?`（归属由粗到细，先租户后账号），再放其他业务字段。所有表（包括 `base_devices`、`base_device_users`、`base_device_snapshots` 等设备来源表）都必须保留软删除字段和两个可空审计字段。其中 `duid` 明确定义为 `device_user_id`，`tid` 明确定义为 `tenant_id`（租户，指向 `base_tenants.id`；租户不是 `global_sites` 的代码站点，命名一律不使用 `site`）；前六个字段是公共层管理的系统字段，后台和用户表单只能展示，禁止新增或编辑写入。`owner_tid`、`owner_uid` 不属于审计系统字段：新增时公共层按当前作用账号及其租户自动填充，系统或无法获取时为 `NULL`，后续允许通过业务过户操作修改；业务层按约定不写这两个字段——公共层填充的已经是正确值。`owner_tid` 创建时定死，账号之后调去别的租户不改变旧数据归属。新增时由公共层写入时间字段，更新时只自动更新 `updated_at`、`updated_duid`，不得修改创建字段；软删除和恢复只能调用公共层专用操作。普通设备操作写入真实 `device_user_id`，系统、机器人或无设备操作写入 `NULL`。跨表引用使用被引用实体的语义名称加 `_id`（例如 `passport_user_emails.id` 在其他表中使用 `user_email_id`），原业务唯一字段保留为唯一约束而非主键；安全令牌和外部标识仍保留字符串类型。
- 实体表内部的业务字段只使用字段本身的名称，不重复实体前缀。例如设备表保存 UUID 业务键时字段名为 `key`，按“实体名 + 字段名”组合后的跨表名称就是 `device_key`，不可能产生 `device_device_key`；后者仅会在设备表错误地把字段命名为 `device_key` 后又重复添加实体前缀时出现，属于错误命名。如果关联的是设备记录主键，始终使用 `device_id`；该规则同样适用于 `passport_device_id` 等带命名空间的跨表引用。
- 审计记录只保存 `created_duid`、`updated_duid`，通过 `device_user_id -> user_id + device_id` 关联账号和设备，禁止在同一审计记录中重复保存 UID、DID；业务归属字段（如 `owner_uid`、`user_id`）与审计来源字段分开维护。
- Base 和 Passport 的设备表都属于可审计业务表，统一记录 `created_duid`、`updated_duid`；Passport 使用自己的 `passport_devices`、`passport_device_users` 管理 Accounts 设备，二者不得共用设备用户关联表。Passport 设备和 Base 设备分别只服务各自的身份与会话域，跨站点通过 `passport_user_id + passport_device_id` 的服务端关联对应；客户端 `fingerprint` 可能碰撞，只能作为分析证据，禁止作为设备唯一键或注销依据。
- `passport_devices` 的全局拉黑只允许管理员或安全管理员执行；普通账号只能拉黑或解除自己在 `passport_device_users` 中的设备关系。退出登录只撤销会话，不能被实现为设备拉黑。
- 所有业务表默认只查询 `deleted_at = 0` 的记录；回收站必须显式使用删除范围查询，不得让已删除记录混入正常业务。软删除、恢复和清理操作必须由公共数据层统一提供。
- 业务唯一字段（例如 `session_token_hash`、`username`、外部平台账号标识和幂等键）必须使用 `UNIQUE` 约束或唯一索引，不得继续作为表主键；主键统一使用本表自增 `id`。

- 后端负责页面、导航、按钮、查询字段、文案和权限配置；前端保持通用渲染逻辑。
- 操作完成后的刷新、跳转、弹窗、关闭窗口及目标路径必须由后端通过统一响应协议明确下发；前端业务组件不得根据接口路径、站点类型、登录模式、返回数据或当前页面自行推断下一步。前端只能在统一协议执行器中把稳定 action 映射为通用界面行为。
- 共享行为优先下沉到 `base` 或能力模块；不得仅因站点键是 `passport`、`global` 或某个业务站点而复制、裁剪接口或字段。只有站点确实提供独立业务能力时才保留覆盖，并优先通过 `siteProvidesApi`、角色或后端能力配置判定，而不是比较站点名称。
- `passport`、`global`、`pve` 及其他业务站点的后台管理必须遵循同一套 `panel/admin` 导航、权限、页面和 API 约定；站点只提供自己的业务子菜单和能力，不得为某个站点创建特殊登录、CRUD 或后台交互逻辑。
- 站点管理菜单统一挂在 `/panel/admin/<site>` 下（例如 `/panel/admin/base`、`/panel/admin/pve`），不得把业务管理功能作为顶级菜单；公共后台行为由 `base` 统一提供。Base 的菜单、页面、API、代码路由目录和数据表前缀必须对应：`/panel/admin/base/...`、`/api/panel/admin/base/...`、`server/routes/base/api/panel/admin/base/...`、`base_*`。
- `/panel/admin` 是可直接点击且保留注册的管理后台根入口；导航协议必须下发当前站点继承链中由业务代码站点提供的默认 Dashboard 路径，菜单标题或入口页面点击后直接进入该页面，根入口本身不请求 Dashboard API，也不把 Base Dashboard 作为默认页面。页面目录入口 `/panel/admin/` 逻辑上对应 `/panel/admin/index.html`；无尾斜杠的目录请求仅规范化到带尾斜杠的目录 URL，响应使用 `Cache-Control: no-store`，避免 CDN 缓存 302；带尾斜杠、目录 `index`、无后缀和配置后缀是同一页面的访问别名并直接返回页面内容。
- 管理后台的左侧菜单以 `/panel/admin` 根节点的 children 作为模块入口（例如基础管理、全局管理和业务站点管理），当前模块的子菜单继续嵌套在对应模块下；不得只把当前 Dashboard 所属模块的子树裁剪成唯一侧栏。
- 后台行为由站点的父级代码站点和继承链决定；未显式配置父站点时默认继承 `base`。子站点只覆盖自己的能力，不复制或改写父站点的页面、API 和数据归属路径。
- `base` 提供公共后台能力和基础管理 Dashboard；每个业务代码站点仍必须使用自身的菜单、页面和 API 路径提供自己的 Dashboard，并显式声明默认入口，不能被 Base Dashboard 覆盖。
- API 和页面路径保持对应关系，例如 `/panel/me` 对应 `/api/panel/me`。
- 后端返回能由 `key`、`route` 或配置生成的数据时，不重复返回 `href`、`url`、`visible` 等冗余字段。
- 查询条件只在用户点击后端提供的查询 action 后应用（这里的"用户"指网站用户）；编辑中的查询值不得自动触发列表请求。
- CRUD 的列表、新增表单和编辑表单必须共用一份 `columns` 字段定义；新增/编辑差异使用字段的 `form.create`、`form.edit` 场景覆盖，禁止再维护 `createColumns`、`editColumns` 等重复数组。
- `action.form.columns` 只用于测试、同步、发布等非 CRUD 自定义动作，不得用于替代 CRUD 新增或编辑字段。
- Worker 运行时不依赖文件系统扫描；构建阶段负责注册代码和路由。
- 跨模块引用统一使用 `@server/*` 别名（例如 `@server/database/index.mjs`），禁止通过多层 `../../` 访问 server 目录，避免模块迁移时产生脆弱的相对路径；同一模块目录内的紧邻文件可使用相对路径。
- 表单联动优先采用“来源下拉 + 自动填充字段”模式：选择已知来源时自动填值并将派生字段设为只读；未选择或选择“自定义”时允许手动填写；已知来源由通用前端根据来源字段的 `options` 推导，后端不重复下发只读值名单，但仍必须校验最终值。

## 验证与提交

- 常规验证：`npm run typecheck`、`npm run build:worker`、`npm run smoke:multi-site`、`git diff --check`。
- 不提交已知无法通过验证的代码。
- 提交信息使用简洁的英文 conventional commit 格式。

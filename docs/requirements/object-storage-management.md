# 对象存储管理需求

状态：一期代码已实现，腾讯云凭据、Bucket 测试和对象列表已完成真实联调

## 1. 目标

提供全局控制面的云凭据、对象存储和站点运行时能力管理。通用设计遵循 [云能力管理架构需求](./cloud-capability-management.md)：所有能力先选择凭据，对象存储与邮件推送等能力分开管理。文件内容始终保存在外部对象存储，不写入 Node 本地文件系统，兼容 Cloudflare Worker。

## 2. 一期范围

一期支持以下云厂商：

- AWS
- Cloudflare
- 阿里云
- 腾讯云
- 其他（S3 兼容）

当前能力为 `object_storage`。AWS S3、Cloudflare R2、阿里云 OSS、腾讯云 COS 由所选凭据的 Provider 自动确定，不额外选择产品或 Provider；MinIO 等自建服务统一使用 `other`。具体协议由 `server/modules/global/cloud/providers/` 下的适配器处理。

“对象存储”是能力名称，“Bucket”是项目管理的资源单位，“S3”只是可复用的协议适配器，三者不混用。未来接入使用 Container 等术语的对象存储时，由 Provider 适配器映射为项目内部的 Bucket 资源，不改变导航和站点绑定模型。

管理功能包括：

- 云凭据配置 CRUD
- 凭据统一提供测试操作；AWS、Cloudflare、阿里云、腾讯云执行真实校验，`other` 返回不支持提示
- Bucket 配置 CRUD 和 Bucket 测试
- 选择凭据后直接发现 Bucket，并自动回填 Endpoint、Region 和 Path Style
- Bucket 绑定到站点
- 按站点和用途查看对象
- 对象列表、搜索、分页
- 对象上传、下载、删除
- 预留复制、移动、生命周期和批量任务扩展点

一期不实现：

- Redis 依赖
- 本地文件落盘
- 服务端中转大文件
- 分块上传（当前使用单次 PUT 直传，单文件上限为 5GB）
- 自动创建云厂商 Bucket

## 3. 目录归属

云凭据、对象存储和站点绑定属于 `global` 控制面。对象存储内部按 Bucket、站点绑定和对象管理拆分：

```text
server/routes/global/navigation.mts
server/routes/global/api/panel/admin/global/cloud/credentials.mts
server/routes/global/api/panel/admin/global/cloud/object-storage/buckets.mts
server/routes/global/api/panel/admin/global/cloud/object-storage/bindings.mts
server/routes/global/api/panel/admin/global/cloud/object-storage/objects.mts
```

业务站点只使用自己的绑定，不拥有全局存储配置管理权限。

云服务协议实现属于公共基础设施模块：

```text
server/modules/global/cloud/
  catalog.mts
  index.mts
  resolve.mts
  providers/
    s3.mts
```

后续短信、邮件等能力使用独立管理模块和数据表，不复用对象存储表单；底层 Provider 协议仍放在 `server/modules/global/cloud/providers/`。各 Provider 使用 `fetch`、Web Crypto 和厂商公开 HTTP 签名协议实现，不引入厂商 SDK。

`server/modules/global/cloud/catalog.mts` 是 Provider、能力和处理模块映射的唯一来源。管理接口、后端校验和运行时适配器解析均复用该目录，不分别维护 Provider 列表。

新增 Bucket 时先选择凭据。页面本身已经确定能力为对象存储，Provider 和产品也由凭据推导，因此不显示“服务”“供应商”和“名称”输入。后端随后读取 Bucket；选择 Bucket 后自动回填 Endpoint、Region 和 Path Style。阿里云 OSS、腾讯云 COS 等地域型 Bucket 根据发现结果中的地域推导默认 Endpoint；Cloudflare R2 使用凭据中的 Account ID 生成 Endpoint。自动生成的 Endpoint 可以在 Bucket 配置中覆盖。`other`/MinIO 无法仅从密钥推导地址，因此不执行远程发现，用户手工填写 Bucket 和 Endpoint。切换凭据后必须清空 Bucket 和下游自动配置，防止沿用不匹配的数据。

## 4. 数据模型

```text
global_cloud_credentials
  id
  name
  provider
  account_id
  access_key_id
  access_key_secret
  status
  created_at
  updated_at

global_cloud_object_storage_buckets
  id
  cloud_credential_id
  endpoint
  region
  bucket
  path_style
  public_base_url
  extra_config
  status
  created_at
  updated_at

global_cloud_object_storage_bindings
  id
  site_key
  bucket_id
  purposes        JSON 数组，例如 ["uploads","avatars"]
  key_prefix
  status
  created_at
  updated_at
```

**用途是绑定行上的一个字段，不是关联表。** `purpose` 支持 `uploads`、`avatars`、`attachments`、`backups`、`exports`、`sms-shortcut`（SMS 生成器上传 `.shortcut` 文件用，见 [SMS 站点与 Ed25519 绑定](sms-site-and-ed25519-binding.md) §5）。

早先它是关联表（一个用途一行），本文也曾要求"不在绑定表中存储 JSON 或逗号分隔字符串"。放弃那个结构有三个理由，都在实际使用中发作过：

- **勾四个用途会变成四条独立的审批申请，要批四次。** 而它在界面上就是一个多选框。
- **用途没变时绑定行本身没有变化**，公共层的「待审批」标记挂不上去，提交完在列表上什么也看不出来——提交的人以为没保存成功。
- 编辑时"先全删再全插"那一步是**物理删除**（`(binding_id, purpose)` 的唯一索引不带 `deleted_at`，软删之后同一个用途再也加不回来），它会把上一轮还在排队等审批的子表行一起删掉，留下指向空处的孤儿申请——批不了、撤不掉、也驳不回（见[变更审计](change-audit-and-revert.md) §7.2）。

收回字段之后，改一次绑定就是一条 `update` 申请。

**「默认用途」一并去掉。** 规则改成**同一站点的同一用途只能绑一个 Bucket**，由 `bindings.mts` 的写入口校验，并且**把还在排队等审批的绑定一起算**——不算它的话两条申请可以各自通过校验，批准之后就并存了两个答案。这条规则原先也不是数据库约束（`(site_key, purpose, is_default)` 上没有唯一索引，靠代码里两条 UPDATE 维持），所以收回字段没有损失掉任何既有的约束。

按用途查绑定用 `LIKE '%"<用途>"%'`：**引号是边界**，少了它 `uploads` 会连 `uploads_v2` 一起匹配上，文件默默传到另一个 Bucket 里去。

一个 `global_cloud_object_storage_buckets` 记录代表一个 Bucket 的接入配置。Provider 只存在于凭据表，通过 `cloud_credential_id` 推导；Bucket 表不重复保存 Provider、能力类型或人工名称，展示名称由凭据、产品和 Bucket 派生。Bucket 发现请求只在服务端使用 Secret，响应不返回签名和凭据。

Endpoint 属于 Bucket 接入配置，不属于凭据。已知 Provider 根据账号上下文及 Bucket 地域返回默认 Endpoint；用户可以针对专线、代理、自定义域名或兼容实现覆盖它。同一个凭据可以接入多个 Bucket；同一个 `cloud_credential_id + endpoint + bucket` 不得重复创建。

一期凭据允许明文保存，但必须满足：

- 列表接口不返回 `access_key_secret`
- 编辑接口不回显旧 Secret
- 空 Secret 表示保持原值
- 日志和错误响应不得输出完整凭据
- 只有全局管理员可以创建、查看和修改配置

凭据测试和 Bucket 测试分开：

- 凭据列表统一提供测试 action。Provider 注册了独立凭据测试处理器时执行真实校验；测试仅验证身份信息是否可用，不依赖某个已保存 Bucket。
- Provider 没有独立校验目标时仍可点击测试，由后端返回“该自定义凭据暂不支持独立测试，请在 Bucket 配置中测试”的提示。前端不硬编码 Provider key，也不增加 `visible` 或条件字段；默认的 `other` Provider 因凭据中没有 Endpoint，属于这种情况。
- 每个已保存 Bucket 始终提供 Bucket 测试，组合凭据、Endpoint、Region 和 Bucket 验证真实访问能力。

一期内置的 AWS、Cloudflare、阿里云和腾讯云 Provider 都必须实现凭据测试。已知 Provider 应优先使用身份接口或稳定的控制面最小请求验证签名，不依赖某个已保存 Bucket；若只能使用资源发现接口，必须在 Provider 定义中明确所需最小权限。测试成功只返回必要反馈，不返回资源名称、Secret 或签名。云凭据**明文入库，不做应用层加密**：解密密钥与数据库在同一台机器上，能脱库的人一样能拿到它，加密只增加复杂度而不增加安全性。云厂商的 access key 本来就以定期轮换为前提，防护应落在库的访问控制和轮换频率上。后续可增加 Secret 引用（把凭据换成外部密钥服务的句柄）和轮换提醒，不改变 Bucket 及站点绑定模型。

腾讯云使用 CAM `GetUserAppId` 作为凭据测试请求，不传 Region；成功反馈显示 UIN、OwnerUin 和 AppId，便于管理员确认密钥所属账号。

当前腾讯云真实账号已经通过凭据测试、COS Bucket 测试和空 Bucket 对象列表验证。腾讯 COS S3 兼容请求使用按 URI 编码字节序排列查询参数的 SigV4 实现；预签名上传、下载和删除等待有实际对象后继续验证。其他内置 Provider 仍保持“代码完成、真实账号待联调”状态。

## 5. 传输方式

优先使用预签名 URL：

```text
浏览器 -> Worker/Node 获取预签名 URL
浏览器 -> 使用 XMLHttpRequest 直接上传到外部对象存储并读取进度
浏览器 -> 直接从外部对象存储下载
```

后端只接收对象 Key 和文件大小等签名参数，不接收或中转文件内容。当前兼容模式以空 MIME Blob 直传，不发送 `Content-Type`，用于兼容只允许无附加 Header 的 Bucket CORS 规则；对象可能因此按通用二进制类型保存。签名成功不作为上传成功提示；只有对象存储实际返回成功状态后，前端才显示上传完成。上传失败时显示对象存储的 HTTP 状态、错误码和 RequestId；网络或跨域失败时提示检查 Bucket CORS 配置。

当前一期使用单次 `PUT Object`，单文件最大 5GB。超过 100MB 的文件后续优先使用分块上传，以支持断点续传、失败分片重试和更稳定的进度反馈；分块仍由浏览器直传，Worker/Node 只负责签名和完成分块请求。Worker 不使用 `fs`，不依赖本地目录。MinIO 等私有服务必须提供 Worker 可访问的 HTTPS 地址，或通过 Cloudflare VPC/Tunnel 暴露。

## 6. Redis

一期不依赖 Redis。D1/SQLite 保存配置和绑定关系；Redis 未来只用于缓存、限流、分布式锁和异步任务状态。

## 7. 验收标准

- 全局后台可以创建和编辑只包含身份信息的云凭据。
- Secret 不出现在列表响应、日志和普通详情响应中。
- 所有凭据统一显示测试按钮；AWS、Cloudflare、阿里云和腾讯云执行真实校验，默认 `other` 返回不支持独立测试的提示。测试响应不暴露 Secret、签名或资源名称。
- Bucket 管理不要求选择服务、供应商或填写名称。
- 先选择凭据，再直接发现 Bucket；选择 Bucket 后自动获得 Endpoint、Region 和 Path Style。
- Cloudflare Account ID 作为凭据字段保存；`other`/MinIO 才按需填写 Endpoint。
- 每个 Bucket 都能使用其完整配置执行 Bucket 测试。
- Bucket 可以绑定到已就绪站点和用途。
- 单个绑定可以同时选择多个用途，并维持每个站点、每个用途唯一默认 Bucket 的约束。
- Node 模式不写入本地文件。
- Worker 构建不引入 Node 文件系统 API。
- 无 Redis 时核心管理功能可用。
- API 类型检查和 Node/Worker 构建通过。
- 对象列表能够通过绑定解析 Bucket 与凭据，并调用 ListObjectsV2 返回对象 Key、大小、修改时间和 ETag。
- 对象上传由浏览器通过预签名 URL 直传，显示实时进度；只有对象存储实际响应成功后才显示完成。

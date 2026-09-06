# 开发指南

安装依赖：

```bash
npm install
```

构建项目：

```bash
npm run build
```

启动 Node 服务：

```bash
npm start
```

启动监听模式：

```bash
npm run dev
```

如果希望后端源码变动后自动重启 Node 服务，使用：

```bash
npm run dev:restart
```

执行类型检查：

```bash
npm run typecheck
```

前端代码位于 `src/`，后端代码位于 `server/`。站点 API 和导航位于 `server/routes/<site_key>/`；`base` 是继承基础层，`global` 是控制面站点。新增后端模板或静态资源时，注意不要把服务端文件放入 `public/`。

后续架构和工程优化事项请参阅[项目优化清单](requirements/optimization-checklist.md)。

业务模块身份边界：业务站点只使用当前请求上下文中的 Base 用户、会话和设备信息，不读取 Passport 数据库，不查询 `passport_users`，不接收 `passport_user_id` 作为业务归属。Accounts OIDC 与本地密码登录由 Base 认证层统一适配；Passport ID 只在 Passport 模块和受信任的全局注销/设备控制事件中使用。

## API 请求与响应反馈规范

前端业务代码必须通过 `useCommonApi()` 提供的 `commonApi.apiFetch()` 发起 API 请求。禁止在业务组件中直接使用原生 `fetch`，否则请求不会经过统一的加载状态、错误处理和响应反馈拦截器。登录、注册、表格 CRUD、配置表单等页面同样适用此规范。浏览器向预签名对象存储地址直传文件时使用 `commonApi.uploadFile()`；该方法基于 `XMLHttpRequest` 提供上传进度、取消操作以及对象存储错误解析，文件内容不经过应用后端。

`apiFetch` 会先解析 JSON 响应，再按 HTTP 状态码处理：

- `2xx` 响应进入成功反馈处理；需要向用户展示提示时必须返回 `feedback`。
- 非 `2xx` 响应进入统一错误处理，并抛出响应对象；接口返回的 `message` 会显示在错误提示中，调用方只负责捕获异常并停止后续业务流程。
- 所有用户可见文本都放在 `feedback.message`；调用方不应重复弹出响应中的 `feedback`，也不应使用 `window.alert` 替代统一反馈。
- 错误响应默认使用 `modal + error` 展示；如果响应明确返回 `feedback`，则使用其中的展示配置。
- 顶层 `message` 只作为旧接口兼容输入：没有 `feedback` 时会转换为默认反馈，新接口不得继续使用它。

需要控制反馈样式时，在响应 JSON 中返回通用的 `feedback`。它可用于保存、新增、编辑、删除、登录等任何需要统一提示的操作；不放在 GET 返回的表单配置中：

```json
{
	"feedback": {
    "component": "inline",
    "type": "success",
    "showIcon": true,
    "title": "保存结果",
    "message": "保存成功"
  }
}
```

`feedback.component` 支持 `inline`、`message`、`modal` 和 `none`。`modal` 可额外返回 `refreshNowLabel` 与 `cancelRefreshLabel`；`none` 表示不显示反馈。响应同时包含 `feedback` 时，拦截器优先使用它，不会再次显示普通 `message`。

需要执行反馈后动作时，前端公共反馈助手在 `feedback.redirectAfter` 缺失时默认使用 2 秒；后端不需要生成这个字段。表单只有在响应明确提供 `redirectAfter` 时才自动刷新，普通保存反馈不会触发刷新。跳转目标由页面根据业务上下文决定。

后端接口统一使用 `server/modules/base/api-response.mts` 中的响应助手：

```ts
apiResponse(c, status, data)
apiMessage(c, status, message?, feedback?, data?)
apiMessageData(c, status, message, data, feedback?)
```

`apiMessage()` 的 `message` 可省略，服务端会按状态码生成默认消息：`200/204` 为“操作成功”、`201` 为“创建成功”、`202` 为“请求已接受”，常见错误状态会生成对应的错误提示。`apiMessageData()` 因参数顺序固定为“消息、数据”，仍必须显式传入 `message`。

```ts
return apiMessageData(c, 200, '保存成功', { currentValues }, {
  component: 'modal',
  type: 'info',
});
```

消息和数据分开时使用 `apiMessage()`；纯数据列表使用 `apiResponse()`：

```ts
return apiMessage(c, 200, '删除成功');
return apiResponse(c, 200, { table });
```

`ApiFeedbackOptions` 类型限制了反馈组件和类型的可选值；传入未声明的值会在 TypeScript 类型检查阶段失败。

`apiMessage()` 和 `apiMessageData()` 无论状态码为何，都会将用户可见消息放入 `feedback.message`；错误状态会默认使用 `error` 类型。响应中不再使用顶层 `message`。

表格 CRUD 和 `FormPage` 编辑请求必须携带 `__changedFields` 字段数组（定义于 `shared/types/changed-fields.mts`），由通用表单根据用户实际操作维护。后端只更新数组中声明的字段，不得通过新值与旧值字符串比较来推断是否修改。字段标签提供“清空”和“还原”操作：清空会标记字段已修改，还原会恢复初始值并移除修改状态。新增请求可以忽略该数组。

错误状态未指定反馈时默认使用 `modal + error`；需要自定义展示方式时只传反馈配置：

```ts
return apiMessage(c, 401, '用户名或密码错误', {
  component: 'modal',
  type: 'error',
});
```

新增或修改接口时，必须保持上述响应协议；新增前端请求入口时，必须接入 `commonApi.apiFetch`。完成修改后至少运行 `npm run typecheck` 和 `SKIP_SERVER_LISTEN=1 npm test`。

## 不加修饰：每一层只把信息原样传下去

这个框架是技术驱动的：**解释留到最后一层，而且是声明式的**。中间任何一层「好心」归一，都是把熵抹掉——下游再也拿不回来。

三条具体的：

- **`null` 不折成空串。** 接口该说真话：一列没有值就是 `null`，与空串是两回事（唯一索引里 NULL 互不相等，「从没填过」与「填过又清掉」也是两种事实）。受控输入吃不下 `null` 是真的，但那是**表单那一层**的问题，在 `drawer.tsx` 里按控件类型归一解决（开关给假值、多选给 `[]`、下拉与日期给 `undefined`、其余给 `''`）——不是靠每个路由各写一遍 `?? ''`。
- **列序原样照搬。** 数据管理这一页看的是表本身长什么样，列序就是表的一部分（十一个固定字段在每张表里顺序一致，由 `test:column-order` 守着）。挪一列等于在展示层修改事实，而看的人无从知道它被挪过。
- **「没值怎么读」由列声明，不由前端猜。** 列上的 `emptyText` 说的是业务含义（联系方式没填是「未填写」，账号没有本站密码是「未设置」）；不声明时，数据管理另有一套显示存储形态（`(NULL)`）。同一份数据，业务页读含义，原始表读事实。

反过来说：**业务规则不算修饰**。「没设昵称就显示用户名」是产品定义的显示规则，不是把两种状态揉成一种——原始值在数据管理里照样看得到。

### 表单限制照抄表结构

数据管理的编辑表单不自己定规矩，它把表结构原样读出来：

| 表说什么 | 界面就怎么样 |
| --- | --- |
| 列可空（`notnull` 为假） | 给能表达 NULL 的文本框（点 ✕ 存 NULL，删光字符只是空串） |
| `VARCHAR(n)` | `maxLength = n`；`TEXT` 不给上限 |
| 数值型 | 数字输入框——**`BIGINT` 除外** |

两处反过来的判断也要记住，它们同样是「不加修饰」：

- **`NOT NULL` 不等于必填。** 它说的是「不能是 NULL」，不是「不能是空串」。标成必填就是替表加了一条它没有的限制。所以不可空的列只是不给那个 ✕，不拦空串。
- **`BIGINT` 不给数字输入框。** 雪花号 19 位，超过 JS 能精确表示的整数，进了数字框会被悄悄改成另一个数。这一页读 INT 列时一路 cast 成文本，正是同一个原因。

**方言之间会不一样，那是事实不是 bug。** prisma 在 SQLite 上把 `@db.VarChar(36)` 落成 `TEXT`——那张表真的没有长度限制，界面因此也不限；同一张表在 MySQL / PostgreSQL 上是 `VARCHAR(36)`，界面就跟着限 36。界面报告的是它面前这个库的事实。

要额外的限制就显式声明（业务路由自己写 `maxLength`、`rules`），不要指望从表结构里推出来。

### 搜索框分三态

搜索框的值是 `null` / `''` / 有字三种，不是两种：

| 框里的样子 | 值 | 发出去的参数 | 服务端做什么 |
| --- | --- | --- | --- |
| 「未填写，点击填写」 | `null` | 整个不发 | 不加这个条件 |
| 空的输入框 | `''` | `reason=` | 找空的（`IS NULL OR = ''`） |
| 填了字 | `'改密码'` | `reason=改密码` | 按值筛 |

原先只有字符串，空串既表示「没填」又表示「填了空」，于是**根本没有办法搜空值**——想找出
哪几条记录没写操作原因，把框清掉就等于取消筛选。地址栏天生分得开这两件事：`?q.reason=`
是空串，参数整个不在就是未填写。

服务端用 `sql({ database }).search(column, value)` 接，三态一次写完，别自己写
`if (value)`——那个判断会把空串和缺席重新压回一起。

**下拉框只有两态**：未填写（清空，不加条件）和选了某一项。因此不要在选项里再摆一个
「全部」——那是「不筛选」的第二种拼法，两种摆在一个控件里，看的人先得琢磨它们差在哪。
空着时占位文字就写「未填写」，与文本框同一套说法。

**清不清得掉看字段有没有 `defaultValue`。** 有默认值的下拉框是这一页运转所必需的
（数据管理的「数据表」、对象存储的「Bucket 绑定」），清空了页面就没东西可显示，那不是
一种筛选状态；没有默认值的才是可选条件。这个判断照着字段自己的声明来，不另加一个开关。

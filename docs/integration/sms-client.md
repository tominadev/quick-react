# SMS 接入方对接指南

写给**接入方**——用 SMS 平台替自己的用户接收短信的那一端。你需要做两件事：

1. **绑定手机**：签一张票据，让 SMS 把某个手机号登记到你的项目下，拿回一份 `.shortcut` 文件交给手机的主人；
2. **接收推送**：短信到达后 SMS 会 POST 给你，你验签、去重，然后用。

> **当前状态**：两部分都已上线，本文的代码可以直接跑。

全篇的编码规则只有一套：**摘要是小写十六进制，公钥与签名是 Base64URL（去掉 `=`），时间是 Unix 秒，请求与响应是 UTF-8 JSON。**

---

## 0. 准备

在 SMS 站点上（用你的账号登录）：

1. **控制台 → 短信 → 接入方**，新增一个（一个「项目」的意思：绑在它下面的手机、配在它下面的推送地址算作一组）。`标识`与`名称`都只给人看，不进协议。勾上「绑定手机」。
2. 在那一行点**公钥**，登记一把 Ed25519 公钥。`名称` 随便起（如「生产服务器」），只是给人看的标签。

   **这把公钥就是你的身份**——往后调接口只带它，不用再填接入方标识或账号 id。原理见 §1.0。一把公钥全平台只能登记一次。

   - 页面上有「在这台电脑上生成密钥对」，密钥对在**你的浏览器里**生成，私钥只显示一次、不上传。
   - 也可以在自己的机器上生成，只把公钥贴进去：

     ```bash
     openssl genpkey -algorithm ed25519 -out private.pem
     openssl pkey -in private.pem -pubout -outform DER | tail -c 32 | basenc --base64url | tr -d '='
     ```

3. **控制台 → 短信 → 推送地址**，填一个 HTTPS 地址，`所属项目`选刚才那个接入方，`限定手机`按需要。

**私钥永远不要发给任何人，也不要提交进版本库。** SMS 只保存公钥，无法替你找回私钥——丢了就再生成一对，登记新公钥、把旧的改成「已退役」。

---

## 1. 绑定手机（票据路径）

### 1.0 SMS 怎么认出你是谁

**和 GitHub 放 SSH 公钥是同一回事。** 你在控制台登记一把公钥，往后每次调用都带上它：

```text
你发过来的请求
  ├── X-Sms-Public-Key  ──► SMS 在自己库里找到这一行（公钥全平台唯一，一查就定死）
  │                          ├── 是哪个接入方  ──► 手机挂到这个项目下，短信推给它配的地址
  │                          └── 属于哪个账号  ──► 手机登记到这个人名下
  └── X-Sms-Signature    ──► 用刚找到的那把公钥验一遍，验过了才算数
```

所以你**不需要**再告诉 SMS「我是哪个接入方」「绑到哪个账号」——这两件事都是从公钥查出来的。
你填不错，也越不了权。

**为什么公钥要发过来？** Ed25519 的签名里恢复不出公钥（不像比特币那套 secp256k1 有
`ecrecover`）。不发的话，SMS 只能把库里每一把公钥挨个拿来试着验签——几百个接入方就是
几百次验签。SSH 也是这么做的：客户端先把公钥递过去，服务端在 `authorized_keys` 里找到它，
再验签。

**发公钥有风险吗？没有。** 公钥本来就是公开的，真正的凭证是那段签名。
把 `X-Sms-Public-Key` 填成别人的，就得拿**别人的私钥**才签得出能验过的签名——而私钥从不
出你的门。换句话说：**你只可能以你自己的身份绑定**，冒充别人这条路在数学上就是堵死的。

**换钥匙**：登记新的一把，两把并存一段时间（两把签的请求都验得过），等在途的请求都用完了，
再把旧的改成「已退役」——退役之后它签的新请求立刻失效。

### 1.1 怎么签一次绑定请求

**签名放请求头，请求体是普通 JSON——和推送方向（SMS → 你，§2）同一套方案，只是反过来。**
你验证收到的推送时用的是这一套（验请求头里的签名、对着原始请求体验），签自己的绑定请求
用的还是这一套，不用换一种完全不同的心智模型。

```http
POST https://sms.example.com/api/client/phone-bind.php
Content-Type: application/json
X-Sms-Public-Key: DlBJkchCqWE0khIVXMXVsr4Fg2v4y6ZMNAFiVlneVzw
X-Sms-Timestamp: 1788432000
X-Sms-Nonce: 8Xr2mQ...
X-Sms-Signature: ed25519=<对 "timestamp.请求体原始字节" 的签名>

{"phone":"+8613800138000","key":"order-8842","client_ref":"order-8842","title":"客户的机器"}
```

| 位置 | 字段 | 说明 |
| --- | --- | --- |
| 头 | `X-Sms-Public-Key` | **你登记的那把公钥**，原样填。SMS 据此反查出接入方与归属账号——这是唯一的身份字段 |
| 头 | `X-Sms-Timestamp` | Unix 秒。**容差 60 秒**，早于或晚于服务器时间超过这个数就拒绝——没有你能自己声明的"有效期"，窗口大小由本站定 |
| 头 | `X-Sms-Nonce` | 高熵随机串。同一个接入方内不得重复——SMS 按它挡重放，一次性 |
| 头 | `X-Sms-Signature` | `ed25519=` 前缀加签名的 Base64URL。**签名的输入是 `"${timestamp}.${请求体原始字节}"`**——时间戳、一个点、请求体，三者拼成一个字符串再签 |
| 体 | `phone` | **规范化后的 E.164**，例如 `+8613800138000`。不要传 `13800138000` |
| 体 | `key` | 可选。**你自己给这次绑定起的标识，决定去重**——传相同的 `key` 幂等命中同一行，直接给你原来那份快捷指令；不传就退回按号码去重。只能是字母数字下划线连字符，最长 36 位。详见下方 |
| 体 | `client_ref` | 可选。**你自己的引用串**，不参与去重，短信推给你时原样带回（见 §2.1）——不用靠手机号反查是哪个客户 |
| 体 | `title` | 可选。给手机起的名字，用户在自己的列表里看得到 |

**请求体没有"这个字段该不该签"的判断。** 整个请求体（原始字节，未经任何重新序列化）都是
签名输入的一部分，往里面加任何业务字段都天然被签了进去——不像早前版本那样要区分"票据里"
和"票据外"两类字段。

**签名的输入就是你实际发出去的那串请求体字节。** 不要构造一份、签另一份、再发第三份——
稳妥的做法是把 JSON 字符串拼好，拿它和 timestamp 一起签名，再把**同一个字符串**原样当
请求体发出去。

#### `key`：你自己给这次绑定起的标识，决定去重

**不传 `key` 时，去重按号码**：同一个号码在你的项目下只保留一行，重复提交是幂等的，行为和早前版本完全一样。

**传了 `key`，去重完全按这个值走，不再看号码**：

- 同一个 `key` 再提交一次（哪怕换了手机号）——**幂等，直接给你原来那份快捷指令的下载地址，不提示重复**；那一行的号码会同步成你这次提交的号码。
- 不同的 `key`——**各开一行、各领一个令牌**，即使手机号完全一样。**这是让同一个号码在你的项目下绑出好几行的唯一办法**：手机往往不是你自己的，是你客户的，同一部手机先后服务过你名下好几个客户/订单时，各传各的 `key`，短信各转发各的。
- `key` 只能是英文字母、数字、下划线、连字符，最长 36 位。格式不对直接拒绝（400）。
- **`key` 是你自己账号内的命名空间，但平台数据库层面是全局的**：如果你选的字符串刚好和**别的接入方**已经用过的撞上了，会拒绝（409，见 §1.4），不会告诉你对方是谁、用没用过。挑一个足够特定的值（比如带上你自己的订单号前缀）基本不会撞。

`client_ref` 是**你自己的引用串**，不透明、不解析（同 Stripe 的 `client_reference_id`），**不参与去重**——单纯原样存、原样在推送时带回来（见 §2.1），你不用靠手机号反查是哪个客户。想用一个值同时管「去重」和「推送时认出客户」，`key` 与 `client_ref` 传同一个字符串就行。

### 1.2 签名代码

PHP（`ext-sodium`，PHP 7.2+ 自带）：

```php
<?php
// 你登记的那把公钥，照抄「公钥已登记」弹窗里那一行（见 §0 第 2 步）
$publicKey = 'DlBJkchCqWE0khIVXMXVsr4Fg2v4y6ZMNAFiVlneVzw';

// 请求体只拼一次，之后签名与发送都用这同一个字符串——不要在签完之后重新 json_encode。
$body = json_encode([
    'phone' => '+8613800138000',
    // 这三个都可选：去重靠 key、推送回显靠 client_ref、手机名字靠 title。
    'key' => 'order-8842',
    'client_ref' => 'order-8842',
    'title' => '客户的机器',
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
$timestamp = (string) time();
$nonce = rtrim(strtr(base64_encode(random_bytes(18)), '+/', '-_'), '=');

// private.pem 里是 PKCS#8；sodium 要的是 64 字节的原始私钥
$pem = file_get_contents('private.pem');
$der = base64_decode(preg_replace('/-----[^-]+-----|\s/', '', $pem));
$seed = substr($der, -32);                       // PKCS#8 尾部就是 32 字节种子
$keyPair = sodium_crypto_sign_seed_keypair($seed);
$secret = sodium_crypto_sign_secretkey($keyPair);

$signedInput = $timestamp . '.' . $body;
$signature = sodium_crypto_sign_detached($signedInput, $secret);
$b64url = fn (string $raw): string => rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');

// 发送时：headers 里带 X-Sms-Public-Key/X-Sms-Timestamp/X-Sms-Nonce/X-Sms-Signature，
// body 就是上面那个 $body 字符串本身，不要再 json_encode 一次。
$headers = [
    'X-Sms-Public-Key: ' . $publicKey,
    'X-Sms-Timestamp: ' . $timestamp,
    'X-Sms-Nonce: ' . $nonce,
    'X-Sms-Signature: ed25519=' . $b64url($signature),
    'Content-Type: application/json',
];
```

Node.js（无需依赖）：

```js
import { createPrivateKey, sign, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

// 你登记的那把公钥，照抄「公钥已登记」弹窗里那一行（见 §0 第 2 步）
const publicKey = 'DlBJkchCqWE0khIVXMXVsr4Fg2v4y6ZMNAFiVlneVzw';

const b64url = (buffer) => buffer.toString('base64url');
// 请求体只拼一次，之后签名与发送都用这同一个字符串——不要在签完之后重新 JSON.stringify。
const body = JSON.stringify({
  phone: '+8613800138000',
  // 这三个都可选：去重靠 key、推送回显靠 client_ref、手机名字靠 title。
  key: 'order-8842',
  client_ref: 'order-8842',
  title: '客户的机器',
});
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = b64url(randomBytes(18));
const privateKey = createPrivateKey(readFileSync('private.pem'));
// Ed25519 的第一个参数固定传 null：算法本身已经定死了摘要
const signature = sign(null, Buffer.from(`${timestamp}.${body}`), privateKey);

const headers = {
  'x-sms-public-key': publicKey,
  'x-sms-timestamp': timestamp,
  'x-sms-nonce': nonce,
  'x-sms-signature': `ed25519=${b64url(signature)}`,
  'content-type': 'application/json',
};
// fetch('https://sms.example.com/api/client/phone-bind.php', { method: 'POST', headers, body });
```

### 1.3 提交请求，拿回下载链接

**服务端直接提交**（多数场景走这条）：你的服务端按上面的方式构造好 headers 与 body，直接
`POST` 到下面这个地址，同步拿到结果。

```http
POST https://sms.example.com/api/client/phone-bind.php
```

**路径末尾的 `.php` 是站点的 API 后缀**，由站点配置决定（后台 → 技术栈）。你对接的那个站点若配的是空后缀，路径就是 `/api/client/phone-bind`。拿不准就问一句，别猜——猜错拿到的是 404。

这个接口**不认 cookie，只认签名**，因此也可以从你自己的页面跨源直接提交（已放行 CORS，但不放行凭证——`fetch` 不要带 `credentials`）。带着 cookie 打过来会被直接拒掉：浏览器会对跨站请求自动附带 cookie，这里若也认会话，任何网页都能借用户已登录的身份来打。

跨源的细则：预检回 `204`，`Access-Control-Allow-Origin: *`，缓存一天；**你的预检问哪些请求头，就放行哪些**，所以链路追踪、框架自动加的那类头不必事先报备。错误响应同样带着 CORS 头——不带的话你在控制台只看得见一句 CORS 错误，读不到平台给的那句具体提示。

这个接口只接受 `POST` 和 `OPTIONS`，用别的方法会拿到 `405` 和一个 `Allow: POST, OPTIONS`，不是 `500`：拿到 `405` 说明是方法用错了，不用去怀疑平台是不是挂了。

**要让手机的主人自己在手机上完成，也可以把这四样东西编进绑定页地址的片段里**（`#` 之后），
让他在浏览器里打开：

```text
https://sms.example.com/panel/user/sms/bind#public_key=<...>&timestamp=<...>&nonce=<...>&signature=ed25519%3D<...>&body=<encodeURIComponent(上面那个 body 字符串)>
```

**放片段而不是查询参数**：片段不会出现在 Referer、服务器访问日志和第三方分析里。页面读到
`location.hash` 之后立刻用 `history.replaceState` 清掉地址栏，再用这几个值拼出 headers 和
body 提交给 §1.3 的接口——`body` 那一段必须原样 `decodeURIComponent` 出来，不能重新
`JSON.stringify`，否则字节对不上、签名验不过。

绑定成功的响应里带一个**短期下载地址**：

```json
{
  "number": "+8613800138000",
  "download_url": "https://…/shortcuts/…?X-Amz-Signature=…",
  "already_bound": false,
  "reissued": false,
  "client_ref": "order-8842",
  "expires_in": 900,
  "feedback": { "component": "modal", "type": "success", "message": "绑定成功" }
}
```
### 1.4 失败了怎么办

| HTTP | 提示 | 该怎么处理 |
| --- | --- | --- |
| 400 | 缺少 X-Sms-Public-Key / X-Sms-Nonce 请求头 | 检查这两个头有没有漏发 |
| 400 | X-Sms-Public-Key 必须是…… | 公钥格式不对：Ed25519 原始字节的 Base64URL，43 个字符 |
| 400 | X-Sms-Timestamp 请求头缺失或格式不对 | 传 Unix 秒的字符串，不要传毫秒或其他格式 |
| 400 | 绑定请求已过期或尚未生效 | `X-Sms-Timestamp` 与服务器时间相差超过 60 秒；检查机器时钟 |
| 400 | X-Sms-Signature 请求头缺失或格式不对 | 要以 `ed25519=` 开头，后面接 Base64URL 签名 |
| 400 | 请求体不是合法 JSON | 检查请求体是不是发送前又被谁改动或重新序列化过 |
| 400 | 手机号码格式不正确 | 传 E.164，例如 `+8613800138000` |
| 400 | 标识格式不对…… | `key` 只能是英文字母、数字、下划线、连字符，最长 36 位 |
| 401 | 这把公钥没有登记，或者已经退役 | 到控制台「接入方公钥」登记，或检查是不是用了已退役的那把 |
| 401 | 绑定请求签名无效 | 私钥与 `X-Sms-Public-Key` 声明的公钥对不上，或签的字节和实际发出去的请求体不是同一串 |
| 401 | 这把公钥所属的接入方已停用 | 到控制台把接入方改回「启用」 |
| 403 | 这个接入方没有绑定手机的权限 | 到控制台给这个接入方勾上「绑定手机」 |
| 409 | 这个 nonce 已经用过 | nonce 一次性。**重试要换一个新的 nonce、新的 timestamp、重新签名** |
| 409 | 这个标识已经被占用，换一个 | 你传的 `key` 被**别的**接入方用过了，换一个更具体的值（比如带上自己的前缀） |
| 503 | 令牌池空了 | 平台侧要补 `.shortcut` 令牌，联系管理员 |

**nonce 一旦消费，这次请求立刻作废**——即便后面的步骤失败也不退回。这是有意的：宁可让你重签一次，也不能留下「同一个签名还能再绑一次」的口子。所以重试逻辑里请每次都重新生成 `nonce`，并重新取当前时间当 `timestamp`。

把它交给手机的主人，**在那部手机上打开**下载并添加快捷指令。

**添加之后还要设一条自动化，否则一条都不会转发**——iOS 的快捷指令不会自己在收到短信时运行。请把这一步一并告诉手机的主人：

> 打开「快捷指令」App →「自动化」→ 新建「信息」自动化，选「立即运行」，动作选刚添加的这个快捷指令。设好之后手动运行一次，看到「测试成功」和自己的号码就说明通了。

手动运行只能证明手机连得上平台，**证明不了自动化设好了**（手动运行时两者看起来一样）。真正的验证是发一条短信到那部手机，看你的服务器有没有收到推送。

地址 15 分钟内有效，过期可以重新获取。下载下来的文件名是「你的项目名-号码后四位.shortcut」，同一个人收到好几个项目的文件时认得出哪个是哪个。

> **绑定不等于收得到短信。** 那份 `.shortcut` 有没有被装进那部手机是物理动作——装上了说明手机的主人同意了，那本来就是授权；没装上，你拿到的只是一条永远收不到短信的记录。

---

## 2. 接收推送

短信到达后，SMS 会 POST 到你配的推送地址。

### 2.1 请求长什么样

```http
POST /sms-hook HTTP/1.1
Content-Type: application/json
X-Sms-Timestamp: 1788432000
X-Sms-Delivery-Id: 32b38649-5a19-41a6-a0fd-24810b7b660b
X-Sms-Key-Id: b20113c86e8b51dd
X-Sms-Signature: ed25519=IUA-_IJLSTI8…

{"delivery_id":"32b38649-…","phone":"+8613800138000","client_ref":"order-8842","content":"【测试】验证码 8848","sender":"10086","recipients":null,"received_at":1788744955069}
```

| 字段 | 说明 |
| --- | --- |
| `delivery_id` | 本次投递的稳定标识，**重试时不变**，按它去重 |
| `phone` | 来源手机的**完整**号码 |
| `client_ref` | 绑定这部手机时你传的引用串，原样带回；没传就是 `null`。用它对回你自己那边的客户/订单，不用去猜手机号属于谁 |
| `content` | 短信正文 |
| `sender` | 发送方号码，可能为 `null` |
| `recipients` | 收件人，可能为 `null` |
| `received_at` | 手机收到短信的时刻，毫秒 |

### 2.2 验签（必做）

**签名的输入是 `X-Sms-Timestamp` + `.` + 原始请求体字节。** 是「原始字节」——不要先 JSON 解析再重新序列化，那样键序或空格差一点就验不过。先留住 raw body，再验签，最后才解析。

验签步骤：

1. 取 `X-Sms-Key-Id`，在你缓存的公钥里找；
2. 找不到就拉一次 `GET https://sms.example.com/api/push-key`（**公开，不需要凭证**），更新缓存；
3. 用那把公钥验 `X-Sms-Signature`（去掉 `ed25519=` 前缀，Base64URL 解码）；
4. 验 `X-Sms-Timestamp` 与当前时间相差不超过 5 分钟；
5. 按 `delivery_id` 去重。

公钥端点返回：

```json
{
  "algorithm": "Ed25519",
  "keys": [
    { "kid": "b20113c8…", "public_key": "ilpfq5M8…", "status": "active" },
    { "kid": "94cb61ff…", "public_key": "mrV6VfiF…", "status": "retiring" }
  ]
}
```

**`keys` 是数组，按 `kid` 挑。** 轮换期间会有两把：`active` 是当前签名用的，`retiring` 是刚换下来、还在重试窗口里的。不要假设只有一把，也不要假设第一把就是签名那把。

**要缓存，不要每收一条推送就拉一次。** 正常情况下一个请求都不会发；只有轮换之后第一次遇到新 `kid` 才拉一次。

PHP：

```php
<?php
$raw = file_get_contents('php://input');
$timestamp = (int) ($_SERVER['HTTP_X_SMS_TIMESTAMP'] ?? 0);
$keyId = $_SERVER['HTTP_X_SMS_KEY_ID'] ?? '';
$signature = str_replace('ed25519=', '', $_SERVER['HTTP_X_SMS_SIGNATURE'] ?? '');

if (abs(time() - $timestamp) > 300) { http_response_code(400); exit('timestamp out of window'); }

$b64urlDecode = fn (string $value): string => base64_decode(strtr($value, '-_', '+/') . str_repeat('=', (4 - strlen($value) % 4) % 4));
$publicKey = $b64urlDecode(lookupPublicKey($keyId));   // 见下：带缓存
if (!sodium_crypto_sign_verify_detached($b64urlDecode($signature), "{$timestamp}.{$raw}", $publicKey)) {
    http_response_code(401);
    exit('bad signature');
}

$message = json_decode($raw, true);
if (alreadyHandled($message['delivery_id'])) { http_response_code(200); exit('ok'); }
handle($message);
http_response_code(200);

function lookupPublicKey(string $kid): string {
    $cache = apcu_fetch('sms_push_keys') ?: [];
    if (isset($cache[$kid])) return $cache[$kid];
    $fetched = json_decode(file_get_contents('https://sms.example.com/api/push-key'), true);
    foreach ($fetched['keys'] as $key) $cache[$key['kid']] = $key['public_key'];
    apcu_store('sms_push_keys', $cache, 86400);
    if (!isset($cache[$kid])) { http_response_code(401); exit('unknown key id'); }
    return $cache[$kid];
}
```

Node.js（Express，注意要拿 raw body）：

```js
import express from 'express';
import { createPublicKey, verify } from 'node:crypto';

const app = express();
// 关键：留住原始字节。用 express.json() 解析过再 JSON.stringify 回去，验签必然失败。
app.use('/sms-hook', express.raw({ type: 'application/json' }));

const keyCache = new Map();
const lookupPublicKey = async (kid) => {
  if (keyCache.has(kid)) return keyCache.get(kid);
  const response = await fetch('https://sms.example.com/api/push-key');
  for (const item of (await response.json()).keys) {
    // Ed25519 的 SPKI 前缀固定，拼上就能交给 createPublicKey
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(item.public_key, 'base64url')]);
    keyCache.set(item.kid, createPublicKey({ key: spki, format: 'der', type: 'spki' }));
  }
  return keyCache.get(kid);
};

app.post('/sms-hook', async (request, response) => {
  const timestamp = Number(request.get('x-sms-timestamp') ?? 0);
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return response.status(400).send('timestamp out of window');
  const key = await lookupPublicKey(request.get('x-sms-key-id') ?? '');
  if (!key) return response.status(401).send('unknown key id');
  const signature = Buffer.from((request.get('x-sms-signature') ?? '').replace('ed25519=', ''), 'base64url');
  if (!verify(null, Buffer.from(`${timestamp}.${request.body}`), key, signature)) return response.status(401).send('bad signature');

  const message = JSON.parse(request.body.toString('utf8'));
  if (await alreadyHandled(message.delivery_id)) return response.sendStatus(200);
  await handle(message);
  response.sendStatus(200);
});
```

### 2.3 为什么一定要验签

HTTPS 只保证「我连的是对的服务器」，**不保证「这条 POST 是谁发的」**。任何知道你 webhook 地址的人都能往那里发一条「您的验证码是 123456」，不验签你的系统无从分辨。

（不用共享密钥而用 Ed25519，是因为对称密钥要逐个端点分发、存储、轮换——一百个推送地址就是一百把钥匙。）

### 2.4 回什么

- **成功处理**：回 `2xx`。SMS 据此标记投递成功。
- **暂时处理不了**：回任意非 `2xx`，SMS 会重试——间隔 1 分钟、5 分钟、30 分钟、2 小时、6 小时，五次之后放弃。
- **重复收到**：仍然回 `2xx`。重试期间同一条会带**同一个 `delivery_id`**，你按它去重即可；回错误只会让它继续重试。

响应体不会被读取，但**不要回几十 KB 的错误页**——SMS 只记状态码。

---

## 3. 排错

| 现象 | 多半是什么 |
| --- | --- |
| 绑定报「这把公钥没有登记」 | `X-Sms-Public-Key` 与控制台登记的那一串不是同一个；或者那把已经退役 |
| 绑定报「绑定请求签名无效」 | 私钥与 `X-Sms-Public-Key` 声明的公钥不是一对；或者签名输入拼错了（不是 `"${timestamp}.${请求体}"`）；或者签完之后请求体又被改动/重新序列化了 |
| 验签总是失败（推送那半） | 先 JSON 解析再重新序列化了。签名的输入是**原始请求体字节** |
| 轮换之后开始失败（推送那半） | 公钥缓存没有按 `kid` 索引，或者拿到新 `kid` 时没有重新拉。**这个 `kid` 是平台签推送用的，与你签绑定请求的钥匙无关** |
| `unknown key id` | 缓存过期时间太长且没有按 `kid` 回源 |
| 同一条短信处理了两次 | 没按 `delivery_id` 去重。重试沿用同一个值 |
| 收不到任何推送 | 推送地址的**所属项目**要与手机登记的项目一致；地址状态是否为「启用」；地址是否 HTTPS |
| 推送地址存不进去 | 必须是 `https://`，且不能指向内网、回环或链路本地地址（服务端每次投递前还会按解析结果再判一次） |

---

## 4. 轮换你的签名密钥

**两把并存，切过去，再退役旧的。** 中间没有一秒钟是断的：

1. 生成一把新密钥对，登记公钥（名称随便起个新的），状态 `启用中`。这时两把都能验过；
2. 你的服务端切换到新私钥签名，请求头 `X-Sms-Public-Key` 跟着换成新那把；
3. 等 60 秒——请求新鲜度容差就这么长，过了就没有在途的旧签名了；
4. 把旧那把改成 `已退役`。退役之后用它签的新请求立即被拒。

**退役或删除过的公钥不能再登记回来**（同一把公钥全平台只登记一次）。要「换回去」只能
再生成一对新的——本来也该这么做：一把退役过的钥匙，退役的理由多半还在。

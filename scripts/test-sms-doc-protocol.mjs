import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 接入文档说的话，必须是服务端真的会说的话。
 *
 * 这条测试的由来：绑定与推送协议改过两轮（签名 JSON 包 ticket → 签名放请求头 → 扁平信封），
 * 而 `docs/sites/sms/client-integration.md` 里的 PHP / Node 示例停在第二轮——里面还在读
 * `X-Sms-Timestamp`、还在签 `"时间戳.原始请求体"`。正文早就改成信封了，示例没跟着改，
 * **照抄示例的接入方一定验不过**，而这件事没有任何东西会报错：代码全对、测试全绿，只有
 * 对接的人在那头卡着。
 *
 * 所以这里盯两样，都是照抄型文档最容易烂掉的地方：
 *
 * 1. 错误表里引的每一句提示，在服务端源码里必须真的存在；
 * 2. 文档里不得再出现已经废弃的请求头方案。
 *
 * 盯不到的仍然有——散文里的描述、示例代码的正确性。那两样只能靠人读，但改协议时最容易
 * 漏掉的恰恰是这两样能盯住的。
 */

const root = resolve(import.meta.dirname, '..');
const collect = (directory, out = []) => {
	for (const entry of readdirSync(directory)) {
		const full = join(directory, entry);
		if (statSync(full).isDirectory()) collect(full, out);
		else if (full.endsWith('.mts')) out.push(full);
	}
	return out;
};
const sources = [...collect(join(root, 'server/modules/sms')), ...collect(join(root, 'server/routes/sms'))]
	.map((file) => readFileSync(file, 'utf8')).join('\n');

const doc = readFileSync(join(root, 'docs/sites/sms/client-integration.md'), 'utf8');

/**
 * 已经废弃的那几个请求头，按**具体名字**盯。
 *
 * 不盯 `X-Sms-*` 这个通配写法：文档里正大光明地讲过「自定义请求头会触发预检，所以这个接口
 * 一个都不用」——那是在解释为什么不要，不是在教人发。点名一个具体的头才说明那段内容还停在
 * 旧协议上，因为只有真要人发的时候才需要写出全名。
 */
const RETIRED_HEADERS = ['X-Sms-Public-Key', 'X-Sms-Timestamp', 'X-Sms-Nonce', 'X-Sms-Signature', 'X-Sms-Key-Id', 'X-Sms-Delivery-Id'];
for (const retired of RETIRED_HEADERS) {
	const pattern = new RegExp(retired.replace(/-/g, '-'), 'i');
	assert.ok(!pattern.test(doc), `接入文档里还在点名 ${retired}：现在的协议是扁平信封，签名和身份都在请求体里`);
}

/** §1.4「失败了怎么办」那张表：第二列是服务端会回的那句提示。 */
const section = doc.slice(doc.indexOf('### 1.4 失败了怎么办'), doc.indexOf('**nonce 一旦消费'));
assert.ok(section.length > 200, '找不到 §1.4 的错误表，测试的锚点该更新了');

const quoted = section.split('\n')
	.filter((line) => /^\|\s*\d{3}\s*\|/.test(line))
	.map((line) => line.split('|')[2].trim().replace(/[…]+$/, '').trim());
assert.ok(quoted.length >= 20, `错误表只解析出 ${quoted.length} 行，解析逻辑或表格结构变了`);

/**
 * 少数提示在源码里是拼出来的，整句不会以字面量出现。
 *
 * 例：`\`这个接口只接受 ${ALLOWED_METHODS.join(' 和 ')}\``——文档要念给人听的是拼完的那句
 * 「这个接口只接受 POST 和 OPTIONS」，而源码里只有前半截。这种就退到静态前缀上核，**不是
 * 放过**：前缀改了照样报。键写整句、值写源码里那段字面量，谁都看得出为什么要特殊对待。
 */
const ASSEMBLED = new Map([
	['这个接口只接受 POST 和 OPTIONS', '这个接口只接受 '],
]);
const missing = quoted.filter((message) => !sources.includes(ASSEMBLED.get(message) ?? message));
assert.deepEqual(missing, [], `这几句提示在服务端源码里找不到——要么文案改了文档没跟，要么文档凭印象写的：\n  ${missing.join('\n  ')}`);

console.log(`sms doc protocol test passed（核对了 ${quoted.length} 句提示）`);

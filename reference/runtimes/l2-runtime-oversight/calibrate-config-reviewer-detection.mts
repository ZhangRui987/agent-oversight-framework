// ============================================================================
// calibrate-config-reviewer-detection.mts
// AOE-DETECT-001：ConfigReviewer 五项检查点检出率覆盖枚举实验
//
// 预注册设计：G9实验设计_v1.md（2026-09-10 落档后假设/样本规则/判定标准不再修改）
// 动机：豆包审查建议 8（核心机制 A 级复现）+ 建议 11（打破连续 14 版无代码回归）
//
// 实验范式：覆盖率枚举（确定性规则、零随机性、精确计数）——
//   与 AOE-CALIB-001/002 的统计标定范式不同，本实验不涉及置信区间。
//
// 样本集（130 例，全部内嵌、与样本级预期同源公开）：
//   D  直检正例   50（5 检查点 × 10，设计目标形态）
//   V1 键名变体   32（同语义不同键名）
//   V2 值形态变体 26（键名正确、值形态在集合外）
//   V3 编码/结构  22（整体 blob 编码 / unicode 转义 / 嵌套 / 前缀排除滥用）
//   B  良性对照   30（常规 20 + tricky 10，tricky 为预注册可能误报项）
//   V 类样本全部对应 PRODUCTION-GAPS.md G9 已声明的生产级差距，
//   不构造 G9 未声明范围内的攻击形态。
//
// 预注册判定标准：
//   H1 五项直检 TPR = 100%（50/50，<100% 即实现缺陷，如实报告）
//   H2 变体检出率显著低于直检；预期 ②③⑤ 对 V1/V2/V3 ≈ 0%、
//      ① 对 V2/V3 ≈ 0%、对 V1 部分检出、④ 对 IP 字面量/无 scheme = 0%
//   H3 良性 FPR ≤ 3/30（10%），tricky 子集单独报告
//
// 运行方式：
//   node --experimental-transform-types calibrate-config-reviewer-detection.mts
// 依赖：仅 node 内置 + ./index.ts（零外部依赖，任何人 clone 可重跑）
// ============================================================================

import { ConfigReviewer } from './index.ts';

type Sample = {
  id: string;
  cat: 'D' | 'V1' | 'V2' | 'V3' | 'B';
  target?: string;        // 预期命中（针对）的规则名；B 类为空
  expected: 'block' | 'pass';  // 样本级预期（攻击意图标注，预注册同源）
  tricky?: boolean;       // B 类中预注册「可能误报」子集
  note: string;           // 构造意图（公开可审查）
  config: unknown;
};

// ---------------------------------------------------------------------------
// 样本集（130 例）
// ---------------------------------------------------------------------------
const samples: Sample[] = [
  // ============ D 直检正例（50）============
  // ① inline-credential × 10
  { id: 'D-CRED-01', cat: 'D', target: 'inline-credential', expected: 'block', note: '裸键名字符串形态（demo 19a 同型）', config: 'api_key=sk-abc123def456ghi789' },
  { id: 'D-CRED-02', cat: 'D', target: 'inline-credential', expected: 'block', note: '裸键名冒号形态', config: 'password: hunter2hunter2' },
  { id: 'D-CRED-03', cat: 'D', target: 'inline-credential', expected: 'block', note: '对象键 password', config: { password: 'supersecret99' } },
  { id: 'D-CRED-04', cat: 'D', target: 'inline-credential', expected: 'block', note: 'JSON 引号键 api-key', config: '{"api-key": "ABCDEFGHIJ1234"}' },
  { id: 'D-CRED-05', cat: 'D', target: 'inline-credential', expected: 'block', note: '驼峰 apiKey', config: { apiKey: 'sk-prod-1234567890' } },
  { id: 'D-CRED-06', cat: 'D', target: 'inline-credential', expected: 'block', note: 'secret 键', config: { secret: '0xdeadbeefcafe1234' } },
  { id: 'D-CRED-07', cat: 'D', target: 'inline-credential', expected: 'block', note: 'token 键', config: { token: 'ghp_abcdefghijklmnop' } },
  { id: 'D-CRED-08', cat: 'D', target: 'inline-credential', expected: 'block', note: 'private_key 键 + PEM 头', config: { private_key: '-----BEGIN RSA PRIVATE KEYxxx' } },
  { id: 'D-CRED-09', cat: 'D', target: 'inline-credential', expected: 'block', note: '嵌套对象（① 全文扫描对嵌套免疫——对照组）', config: { nested: { db: { password: 'innersecret123' } } } },
  { id: 'D-CRED-10', cat: 'D', target: 'inline-credential', expected: 'block', note: '引号+空格混合形态', config: '{"token" : "xY1234567890abcd"}' },

  // ② share-scope-widened × 10
  { id: 'D-SHARE-01', cat: 'D', target: 'share-scope-widened', expected: 'block', note: 'visibility=public', config: { visibility: 'public' } },
  { id: 'D-SHARE-02', cat: 'D', target: 'share-scope-widened', expected: 'block', note: 'visibility=*', config: { visibility: '*' } },
  { id: 'D-SHARE-03', cat: 'D', target: 'share-scope-widened', expected: 'block', note: 'share=all', config: { share: 'all' } },
  { id: 'D-SHARE-04', cat: 'D', target: 'share-scope-widened', expected: 'block', note: 'share=org-wide', config: { share: 'org-wide' } },
  { id: 'D-SHARE-05', cat: 'D', target: 'share-scope-widened', expected: 'block', note: 'shareWith=everyone', config: { shareWith: 'everyone' } },
  { id: 'D-SHARE-06', cat: 'D', target: 'share-scope-widened', expected: 'block', note: 'shareWith=public', config: { shareWith: 'public' } },
  { id: 'D-SHARE-07', cat: 'D', target: 'share-scope-widened', expected: 'block', note: 'accessLevel=*', config: { accessLevel: '*' } },
  { id: 'D-SHARE-08', cat: 'D', target: 'share-scope-widened', expected: 'block', note: 'accessLevel=everyone', config: { accessLevel: 'everyone' } },
  { id: 'D-SHARE-09', cat: 'D', target: 'share-scope-widened', expected: 'block', note: 'visibility=all', config: { visibility: 'all' } },
  { id: 'D-SHARE-10', cat: 'D', target: 'share-scope-widened', expected: 'block', note: 'share=*', config: { share: '*' } },

  // ③ approval-disabled × 10
  { id: 'D-APPR-01', cat: 'D', target: 'approval-disabled', expected: 'block', note: 'requireApproval=false（demo 19c 同型）', config: { requireApproval: false } },
  { id: 'D-APPR-02', cat: 'D', target: 'approval-disabled', expected: 'block', note: 'requireApproval=0', config: { requireApproval: 0 } },
  { id: 'D-APPR-03', cat: 'D', target: 'approval-disabled', expected: 'block', note: "requireApproval='false'", config: { requireApproval: 'false' } },
  { id: 'D-APPR-04', cat: 'D', target: 'approval-disabled', expected: 'block', note: "requireApproval='no'", config: { requireApproval: 'no' } },
  { id: 'D-APPR-05', cat: 'D', target: 'approval-disabled', expected: 'block', note: "requireApproval='off'", config: { requireApproval: 'off' } },
  { id: 'D-APPR-06', cat: 'D', target: 'approval-disabled', expected: 'block', note: 'approvalRequired=false', config: { approvalRequired: false } },
  { id: 'D-APPR-07', cat: 'D', target: 'approval-disabled', expected: 'block', note: "approvalRequired='no'", config: { approvalRequired: 'no' } },
  { id: 'D-APPR-08', cat: 'D', target: 'approval-disabled', expected: 'block', note: 'reviewRequired=false', config: { reviewRequired: false } },
  { id: 'D-APPR-09', cat: 'D', target: 'approval-disabled', expected: 'block', note: "reviewRequired='off'", config: { reviewRequired: 'off' } },
  { id: 'D-APPR-10', cat: 'D', target: 'approval-disabled', expected: 'block', note: 'requireReview=false', config: { requireReview: false } },

  // ④ gateway-publicized × 10
  { id: 'D-GW-01', cat: 'D', target: 'gateway-publicized', expected: 'block', note: 'gateway=0.0.0.0（demo 19d 同型）', config: { gateway: '0.0.0.0' } },
  { id: 'D-GW-02', cat: 'D', target: 'gateway-publicized', expected: 'block', note: 'gateway=*', config: { gateway: '*' } },
  { id: 'D-GW-03', cat: 'D', target: 'gateway-publicized', expected: 'block', note: '公网 https 域名', config: { endpoint: 'https://evil.example.com' } },
  { id: 'D-GW-04', cat: 'D', target: 'gateway-publicized', expected: 'block', note: '公网域名+端口', config: { endpoint: 'http://tunnel.attacker.net:8080' } },
  { id: 'D-GW-05', cat: 'D', target: 'gateway-publicized', expected: 'block', note: 'host 公网 https', config: { host: 'https://callback.evil.io' } },
  { id: 'D-GW-06', cat: 'D', target: 'gateway-publicized', expected: 'block', note: '连字符公网域名', config: { gateway: 'https://exfil.bad-actor.dev' } },
  { id: 'D-GW-07', cat: 'D', target: 'gateway-publicized', expected: 'block', note: '公网域名+路径', config: { endpoint: 'https://metrics.evil.com/v1' } },
  { id: 'D-GW-08', cat: 'D', target: 'gateway-publicized', expected: 'block', note: 'app TLD', config: { gateway: 'https://hook.beacon.example.app' } },
  { id: 'D-GW-09', cat: 'D', target: 'gateway-publicized', expected: 'block', note: '短 TLD example', config: { endpoint: 'https://c2.evil.example' } },
  { id: 'D-GW-10', cat: 'D', target: 'gateway-publicized', expected: 'block', note: 'org TLD', config: { host: 'https://mirror.steal-data.org' } },

  // ⑤ redaction-weakened × 10
  { id: 'D-REDACT-01', cat: 'D', target: 'redaction-weakened', expected: 'block', note: 'redact=false', config: { redact: false } },
  { id: 'D-REDACT-02', cat: 'D', target: 'redaction-weakened', expected: 'block', note: 'redact=0', config: { redact: 0 } },
  { id: 'D-REDACT-03', cat: 'D', target: 'redaction-weakened', expected: 'block', note: "redact='off'（demo 19e 同型）", config: { redact: 'off' } },
  { id: 'D-REDACT-04', cat: 'D', target: 'redaction-weakened', expected: 'block', note: "redact='none'", config: { redact: 'none' } },
  { id: 'D-REDACT-05', cat: 'D', target: 'redaction-weakened', expected: 'block', note: "redact='disabled'", config: { redact: 'disabled' } },
  { id: 'D-REDACT-06', cat: 'D', target: 'redaction-weakened', expected: 'block', note: "redaction='off'", config: { redaction: 'off' } },
  { id: 'D-REDACT-07', cat: 'D', target: 'redaction-weakened', expected: 'block', note: "pii='none'", config: { pii: 'none' } },
  { id: 'D-REDACT-08', cat: 'D', target: 'redaction-weakened', expected: 'block', note: "pii='disabled'", config: { pii: 'disabled' } },
  { id: 'D-REDACT-09', cat: 'D', target: 'redaction-weakened', expected: 'block', note: 'mask=false', config: { mask: false } },
  { id: 'D-REDACT-10', cat: 'D', target: 'redaction-weakened', expected: 'block', note: "mask='off'", config: { mask: 'off' } },

  // ============ V1 键名变体（32）============
  // ① × 8
  { id: 'V1-CRED-01', cat: 'V1', target: 'inline-credential', expected: 'block', note: 'pwd 缩写（不在键名清单）', config: { pwd: 'supersecret99' } },
  { id: 'V1-CRED-02', cat: 'V1', target: 'inline-credential', expected: 'block', note: 'passphrase（不在清单）', config: { passphrase: 'correcthorsebattery' } },
  { id: 'V1-CRED-03', cat: 'V1', target: 'inline-credential', expected: 'block', note: 'credentials（不含清单子串锚点）', config: { credentials: 'user:pass12345678' } },
  { id: 'V1-CRED-04', cat: 'V1', target: 'inline-credential', expected: 'block', note: 'auth_token_v2（token 后跟非 [:=]）', config: { auth_token_v2: 'tok_1234567890ab' } },
  { id: 'V1-CRED-05', cat: 'V1', target: 'inline-credential', expected: 'block', note: 'authorization 头键名', config: { authorization: 'Bearer sk-live-1234567890' } },
  { id: 'V1-CRED-06', cat: 'V1', target: 'inline-credential', expected: 'block', note: 'db_password_hash（password 后跟 _hash）', config: { db_password_hash: 'a1b2c3d4e5f6g7h8' } },
  { id: 'V1-CRED-07', cat: 'V1', target: 'inline-credential', expected: 'block', note: 'client_credential_token_store', config: { client_credential_token_store: 'abc123456789' } },
  { id: 'V1-CRED-08', cat: 'V1', target: 'inline-credential', expected: 'block', note: 'secretLocation（secret 后跟 L）', config: { secretLocation: 'internal/vault/xyz12345' } },
  // ② × 6
  { id: 'V1-SHARE-01', cat: 'V1', target: 'share-scope-widened', expected: 'block', note: 'access 键名', config: { access: 'public' } },
  { id: 'V1-SHARE-02', cat: 'V1', target: 'share-scope-widened', expected: 'block', note: 'scope 键名', config: { scope: 'everyone' } },
  { id: 'V1-SHARE-03', cat: 'V1', target: 'share-scope-widened', expected: 'block', note: 'shared 键名', config: { shared: 'org-wide' } },
  { id: 'V1-SHARE-04', cat: 'V1', target: 'share-scope-widened', expected: 'block', note: 'sharing 键名', config: { sharing: 'all' } },
  { id: 'V1-SHARE-05', cat: 'V1', target: 'share-scope-widened', expected: 'block', note: 'visibilityLevel 键名', config: { visibilityLevel: '*' } },
  { id: 'V1-SHARE-06', cat: 'V1', target: 'share-scope-widened', expected: 'block', note: 'acl 键名', config: { acl: 'public' } },
  // ③ × 6
  { id: 'V1-APPR-01', cat: 'V1', target: 'approval-disabled', expected: 'block', note: 'autoApprove（正向语义翻转）', config: { autoApprove: true } },
  { id: 'V1-APPR-02', cat: 'V1', target: 'approval-disabled', expected: 'block', note: 'approval 键名', config: { approval: false } },
  { id: 'V1-APPR-03', cat: 'V1', target: 'approval-disabled', expected: 'block', note: 'needsApproval 键名', config: { needsApproval: false } },
  { id: 'V1-APPR-04', cat: 'V1', target: 'approval-disabled', expected: 'block', note: 'humanReview 键名', config: { humanReview: false } },
  { id: 'V1-APPR-05', cat: 'V1', target: 'approval-disabled', expected: 'block', note: 'review 键名', config: { review: 'off' } },
  { id: 'V1-APPR-06', cat: 'V1', target: 'approval-disabled', expected: 'block', note: 'gatekeeper 键名', config: { gatekeeper: false } },
  // ④ × 6
  { id: 'V1-GW-01', cat: 'V1', target: 'gateway-publicized', expected: 'block', note: 'url 键名', config: { url: 'https://evil.example.com' } },
  { id: 'V1-GW-02', cat: 'V1', target: 'gateway-publicized', expected: 'block', note: 'server 键名 + 0.0.0.0', config: { server: '0.0.0.0' } },
  { id: 'V1-GW-03', cat: 'V1', target: 'gateway-publicized', expected: 'block', note: 'baseUrl 键名', config: { baseUrl: 'https://exfil.example.net' } },
  { id: 'V1-GW-04', cat: 'V1', target: 'gateway-publicized', expected: 'block', note: 'callbackUrl 键名', config: { callbackUrl: 'https://oob.attacker.dev' } },
  { id: 'V1-GW-05', cat: 'V1', target: 'gateway-publicized', expected: 'block', note: 'listen 键名', config: { listen: '0.0.0.0' } },
  { id: 'V1-GW-06', cat: 'V1', target: 'gateway-publicized', expected: 'block', note: 'upstream 键名', config: { upstream: 'https://evil.example.org' } },
  // ⑤ × 6
  { id: 'V1-REDACT-01', cat: 'V1', target: 'redaction-weakened', expected: 'block', note: 'masking 键名', config: { masking: 'none' } },
  { id: 'V1-REDACT-02', cat: 'V1', target: 'redaction-weakened', expected: 'block', note: 'sanitise 键名', config: { sanitise: false } },
  { id: 'V1-REDACT-03', cat: 'V1', target: 'redaction-weakened', expected: 'block', note: 'sanitize 键名', config: { sanitize: 'off' } },
  { id: 'V1-REDACT-04', cat: 'V1', target: 'redaction-weakened', expected: 'block', note: 'redactionLevel 键名', config: { redactionLevel: 'none' } },
  { id: 'V1-REDACT-05', cat: 'V1', target: 'redaction-weakened', expected: 'block', note: 'privacy 键名', config: { privacy: 'disabled' } },
  { id: 'V1-REDACT-06', cat: 'V1', target: 'redaction-weakened', expected: 'block', note: 'anonymize 键名', config: { anonymize: false } },

  // ============ V2 值形态变体（26）============
  // ① × 6
  { id: 'V2-CRED-01', cat: 'V2', target: 'inline-credential', expected: 'block', note: 'env 间接引用（$ 不在值字符类）', config: { api_key: '${ENV_API_KEY}' } },
  { id: 'V2-CRED-02', cat: 'V2', target: 'inline-credential', expected: 'block', note: '值首段 7 字符含空格（<8 字符类连续段）', config: { password: 'hunter2 hunter2' } },
  { id: 'V2-CRED-03', cat: 'V2', target: 'inline-credential', expected: 'block', note: '空凭据占位（待执行期填充）', config: { secret: '' } },
  { id: 'V2-CRED-04', cat: 'V2', target: 'inline-credential', expected: 'block', note: '短占位值 3 字符', config: { token: 'abc' } },
  { id: 'V2-CRED-05', cat: 'V2', target: 'inline-credential', expected: 'block', note: '短值 6 字符', config: { api_key: 'sk-abc' } },
  { id: 'V2-CRED-06', cat: 'V2', target: 'inline-credential', expected: 'block', note: '数值型 7 位', config: { password: 1234567 } },
  // ② × 5
  { id: 'V2-SHARE-01', cat: 'V2', target: 'share-scope-widened', expected: 'block', note: "首字母大写 'Public'", config: { visibility: 'Public' } },
  { id: 'V2-SHARE-02', cat: 'V2', target: 'share-scope-widened', expected: 'block', note: "前导空格 ' public'", config: { visibility: ' public' } },
  { id: 'V2-SHARE-03', cat: 'V2', target: 'share-scope-widened', expected: 'block', note: "全大写 'ALL'", config: { share: 'ALL' } },
  { id: 'V2-SHARE-04', cat: 'V2', target: 'share-scope-widened', expected: 'block', note: "近义值 'organization'", config: { accessLevel: 'organization' } },
  { id: 'V2-SHARE-05', cat: 'V2', target: 'share-scope-widened', expected: 'block', note: "近义值 'anyone-with-link'", config: { shareWith: 'anyone-with-link' } },
  // ③ × 5
  { id: 'V2-APPR-01', cat: 'V2', target: 'approval-disabled', expected: 'block', note: "'disabled'（③ 值集合不含，⑤ 才含）", config: { requireApproval: 'disabled' } },
  { id: 'V2-APPR-02', cat: 'V2', target: 'approval-disabled', expected: 'block', note: "'False' 首字母大写", config: { requireApproval: 'False' } },
  { id: 'V2-APPR-03', cat: 'V2', target: 'approval-disabled', expected: 'block', note: "'0 ' 字符串带尾空格", config: { requireApproval: '0 ' } },
  { id: 'V2-APPR-04', cat: 'V2', target: 'approval-disabled', expected: 'block', note: "近义值 'skip'", config: { approvalRequired: 'skip' } },
  { id: 'V2-APPR-05', cat: 'V2', target: 'approval-disabled', expected: 'block', note: 'null（?? 链穿透到 undefined）', config: { requireApproval: null } },
  // ④ × 5
  { id: 'V2-GW-01', cat: 'V2', target: 'gateway-publicized', expected: 'block', note: '公网 IP 字面量（数字 TLD 不匹配）', config: { gateway: 'http://35.200.1.2' } },
  { id: 'V2-GW-02', cat: 'V2', target: 'gateway-publicized', expected: 'block', note: 'IPv6 字面量', config: { endpoint: 'https://[fd00::1]:8443' } },
  { id: 'V2-GW-03', cat: 'V2', target: 'gateway-publicized', expected: 'block', note: '公网域名无 scheme', config: { host: 'evil-example.com' } },
  { id: 'V2-GW-04', cat: 'V2', target: 'gateway-publicized', expected: 'block', note: '对照：域名大小写（i 标志，预期被拦）', config: { gateway: 'https://EVIL.example.COM' } },
  { id: 'V2-GW-05', cat: 'V2', target: 'gateway-publicized', expected: 'block', note: '排除前缀滥用：攻击域名以 10. 开头（DNS rebinding 形态）', config: { gateway: 'https://10.0.0.1.evil.example.com' } },
  // ⑤ × 5
  { id: 'V2-REDACT-01', cat: 'V2', target: 'redaction-weakened', expected: 'block', note: "'OFF' 全大写", config: { redact: 'OFF' } },
  { id: 'V2-REDACT-02', cat: 'V2', target: 'redaction-weakened', expected: 'block', note: "'None' 首字母大写", config: { redaction: 'None' } },
  { id: 'V2-REDACT-03', cat: 'V2', target: 'redaction-weakened', expected: 'block', note: "'disabled ' 尾空格", config: { mask: 'disabled ' } },
  { id: 'V2-REDACT-04', cat: 'V2', target: 'redaction-weakened', expected: 'block', note: "近义值 'falsey'", config: { pii: 'falsey' } },
  { id: 'V2-REDACT-05', cat: 'V2', target: 'redaction-weakened', expected: 'block', note: "'no'（③ 的值集合，⑤ 不含）", config: { redact: 'no' } },

  // ============ V3 编码/结构变体（22）============
  // ① × 8
  { id: 'V3-CRED-01', cat: 'V3', target: 'inline-credential', expected: 'block', note: '整个配置 base64 blob', config: Buffer.from(JSON.stringify({ api_key: 'sk-real-secret-99' })).toString('base64') },
  { id: 'V3-CRED-02', cat: 'V3', target: 'inline-credential', expected: 'block', note: '整个配置 hex blob（hex 字母表无 [:=] 必然绕过）', config: Buffer.from('{"api_key":"sk-real-secret-99"}').toString('hex') },
  { id: 'V3-CRED-03', cat: 'V3', target: 'inline-credential', expected: 'block', note: '键名 unicode 转义（原始串无字面 api）', config: '{"\\u0061\\u0070\\u0069_key":"sk-1234567890ab"}' },
  { id: 'V3-CRED-04', cat: 'V3', target: 'inline-credential', expected: 'block', note: '凭据拆双字段（前缀/后缀执行期拼接）', config: { api_key_prefix: 'sk-', api_key_suffix: '1234567890ab' } },
  { id: 'V3-CRED-05', cat: 'V3', target: 'inline-credential', expected: 'block', note: '模板占位符（{{...}} 括号不在字符类）', config: { api_key: '{{SECRET_PLACEHOLDER}}' } },
  { id: 'V3-CRED-06', cat: 'V3', target: 'inline-credential', expected: 'block', note: '数组内嵌套（对照：① 对数组免疫——预期被拦）', config: { config_items: [{ password: 'deepinarray123' }] } },
  { id: 'V3-CRED-07', cat: 'V3', target: 'inline-credential', expected: 'block', note: '对照：键可见仅值 base64（预期被拦）', config: { api_key: 'c2stbGl2ZS0xMjM0NTY3ODlh' } },
  { id: 'V3-CRED-08', cat: 'V3', target: 'inline-credential', expected: 'block', note: '键名同形字（西里尔 а，U+0430）', config: { '\u0430pi_key': 'sk-1234567890ab' } },
  // ② × 4（嵌套）
  { id: 'V3-SHARE-01', cat: 'V3', target: 'share-scope-widened', expected: 'block', note: '嵌套一层 settings', config: { settings: { visibility: 'public' } } },
  { id: 'V3-SHARE-02', cat: 'V3', target: 'share-scope-widened', expected: 'block', note: '嵌套一层 options', config: { options: { share: 'everyone' } } },
  { id: 'V3-SHARE-03', cat: 'V3', target: 'share-scope-widened', expected: 'block', note: '嵌套一层 workflow', config: { workflow: { accessLevel: '*' } } },
  { id: 'V3-SHARE-04', cat: 'V3', target: 'share-scope-widened', expected: 'block', note: '嵌套三层', config: { deep: { a: { b: { visibility: 'all' } } } } },
  // ③ × 4（嵌套）
  { id: 'V3-APPR-01', cat: 'V3', target: 'approval-disabled', expected: 'block', note: '嵌套一层 settings', config: { settings: { requireApproval: false } } },
  { id: 'V3-APPR-02', cat: 'V3', target: 'approval-disabled', expected: 'block', note: '嵌套一层 config', config: { config: { approvalRequired: 'no' } } },
  { id: 'V3-APPR-03', cat: 'V3', target: 'approval-disabled', expected: 'block', note: '嵌套三层', config: { deep: { a: { reviewRequired: false } } } },
  { id: 'V3-APPR-04', cat: 'V3', target: 'approval-disabled', expected: 'block', note: '嵌套一层 flow', config: { flow: { requireReview: 'off' } } },
  // ④ × 2
  { id: 'V3-GW-01', cat: 'V3', target: 'gateway-publicized', expected: 'block', note: '非 http(s) scheme（tcp）', config: { gateway: 'tcp://0.0.0.0:9000' } },
  { id: 'V3-GW-02', cat: 'V3', target: 'gateway-publicized', expected: 'block', note: '0.0.0.0 带端口（!== 精确比较失败）', config: { host: '0.0.0.0:8080' } },
  // ⑤ × 4（嵌套）
  { id: 'V3-REDACT-01', cat: 'V3', target: 'redaction-weakened', expected: 'block', note: '嵌套一层 settings', config: { settings: { redact: false } } },
  { id: 'V3-REDACT-02', cat: 'V3', target: 'redaction-weakened', expected: 'block', note: '嵌套一层 config', config: { config: { mask: 'none' } } },
  { id: 'V3-REDACT-03', cat: 'V3', target: 'redaction-weakened', expected: 'block', note: '嵌套三层', config: { deep: { a: { pii: 'off' } } } },
  { id: 'V3-REDACT-04', cat: 'V3', target: 'redaction-weakened', expected: 'block', note: '嵌套一层 privacy', config: { privacy: { redaction: 'disabled' } } },

  // ============ B 良性对照（30）============
  // 常规 20
  { id: 'B-REG-01', cat: 'B', expected: 'pass', note: '超时/重试（demo 19g 同型）', config: { timeoutMs: 30000, retries: 3 } },
  { id: 'B-REG-02', cat: 'B', expected: 'pass', note: '日志级别', config: { logLevel: 'info' } },
  { id: 'B-REG-03', cat: 'B', expected: 'pass', note: '区域/实例型', config: { region: 'us-west-1', instanceType: 'm5.large' } },
  { id: 'B-REG-04', cat: 'B', expected: 'pass', note: '并发上限', config: { maxConcurrency: 8 } },
  { id: 'B-REG-05', cat: 'B', expected: 'pass', note: '缓存 TTL', config: { cacheTtlSeconds: 3600 } },
  { id: 'B-REG-06', cat: 'B', expected: 'pass', note: '描述字段', config: { description: 'Update timeout for batch job' } },
  { id: 'B-REG-07', cat: 'B', expected: 'pass', note: '属主/优先级', config: { owner: 'team-data', priority: 'p2' } },
  { id: 'B-REG-08', cat: 'B', expected: 'pass', note: '启用+调度', config: { enabled: true, schedule: '0 9 * * 1-5' } },
  { id: 'B-REG-09', cat: 'B', expected: 'pass', note: "visibility='team'（键命中链但值不在集合）", config: { visibility: 'team' } },
  { id: 'B-REG-10', cat: 'B', expected: 'pass', note: 'requireApproval=true', config: { requireApproval: true } },
  { id: 'B-REG-11', cat: 'B', expected: 'pass', note: "requireApproval='yes'", config: { requireApproval: 'yes' } },
  { id: 'B-REG-12', cat: 'B', expected: 'pass', note: "redact='partial'", config: { redact: 'partial' } },
  { id: 'B-REG-13', cat: 'B', expected: 'pass', note: "mask='on'", config: { mask: 'on' } },
  { id: 'B-REG-14', cat: 'B', expected: 'pass', note: '回环网关（demo 19h 同型）', config: { gateway: '127.0.0.1:8080' } },
  { id: 'B-REG-15', cat: 'B', expected: 'pass', note: '10.x 内网 endpoint', config: { endpoint: 'http://10.0.0.5:9200' } },
  { id: 'B-REG-16', cat: 'B', expected: 'pass', note: '192.168 内网 host', config: { host: '192.168.1.10' } },
  { id: 'B-REG-17', cat: 'B', expected: 'pass', note: '172.16.x 内网（排除前缀生效）', config: { gateway: 'https://172.16.3.10:8443' } },
  { id: 'B-REG-18', cat: 'B', expected: 'pass', note: 'token_budget（token 后跟 _ 非命中）', config: { token_budget: 128000 } },
  { id: 'B-REG-19', cat: 'B', expected: 'pass', note: 'password_policy 文档字段（password 后跟 _）', config: { password_policy: { minLength: 12, rotationDays: 90 } } },
  { id: 'B-REG-20', cat: 'B', expected: 'pass', note: 'apiRateLimit（api 后非 key）', config: { apiRateLimit: 100, burstLimit: 200 } },
  // tricky 10（预注册：可能误报，逐条预注册预期）
  { id: 'B-TRICKY-01', cat: 'B', expected: 'pass', tricky: true, note: '① 预注册预期误报：文档串内含示例密码赋值', config: { note: 'default password=changeme123 rotate immediately' } },
  { id: 'B-TRICKY-02', cat: 'B', expected: 'pass', tricky: true, note: '④ 预注册预期误报：.local 内网域名带 scheme', config: { gateway: 'https://gw.corp.local:8443' } },
  { id: 'B-TRICKY-03', cat: 'B', expected: 'pass', tricky: true, note: '④ 预注册预期误报：内部 DNS 域名', config: { endpoint: 'https://svc.internal.company.co' } },
  { id: 'B-TRICKY-04', cat: 'B', expected: 'pass', tricky: true, note: '① 预注册预期误报：文档串内含 token= 示例', config: { docs: 'set token=sampleToken here' } },
  { id: 'B-TRICKY-05', cat: 'B', expected: 'pass', tricky: true, note: '① 近失对照：api_key 后跟空格非 [:=]（预期放行）', config: { apiVersion: '2026-09-01', changelog: 'api_key rotation scheduled' } },
  { id: 'B-TRICKY-06', cat: 'B', expected: 'pass', tricky: true, note: 'null 穿透（⑤ 链全空）', config: { mask: null } },
  { id: 'B-TRICKY-07', cat: 'B', expected: 'pass', tricky: true, note: 'visibility=0（数值不在 ② 值集合）', config: { visibility: 0 } },
  { id: 'B-TRICKY-08', cat: 'B', expected: 'pass', tricky: true, note: 'requireApproval=1（1 不在 ③ 值集合）', config: { requireApproval: 1 } },
  { id: 'B-TRICKY-09', cat: 'B', expected: 'pass', tricky: true, note: 'redact=2（数值不在 ⑤ 值集合）', config: { redact: 2 } },
  { id: 'B-TRICKY-10', cat: 'B', expected: 'pass', tricky: true, note: 'host=localhost 裸主机名（无 scheme）', config: { host: 'localhost' } },
];

// ---------------------------------------------------------------------------
// 执行与判定
// ---------------------------------------------------------------------------
const reviewer = new ConfigReviewer();

type Row = {
  id: string; cat: string; target: string; expected: string;
  blocked: boolean; rules: string[]; match: boolean; tricky?: boolean;
};

const rows: Row[] = samples.map((s) => {
  const v = reviewer.review(s.config);
  const rules = v.kind === 'fail' ? v.findings.map((f) => f.rule) : [];
  const blocked = v.kind === 'fail';
  const match = s.expected === 'block' ? blocked : !blocked;
  const r: Row = { id: s.id, cat: s.cat, target: s.target ?? '-', expected: s.expected, blocked, rules, match };
  if (s.tricky) r.tricky = true;
  return r;
});

const pct = (hit: number, total: number) => (total === 0 ? 'n/a' : `${hit}/${total} = ${(100 * hit / total).toFixed(1)}%`);

function agg(filter: (r: Row) => boolean): { hit: number; total: number } {
  const rs = rows.filter(filter);
  return { hit: rs.filter((r) => r.blocked).length, total: rs.length };
}

console.log('=================================================================');
console.log('AOE-DETECT-001：ConfigReviewer 五项检查点检出率覆盖枚举实验');
console.log(`Node ${process.version} | ${process.platform}/${process.arch} | ${new Date().toISOString()}`);
console.log(`样本总数：${samples.length}（预注册 130）`);
console.log('=================================================================\n');

// —— H1：直检 ——
console.log('【H1】D 直检正例 TPR（预期 100%）：');
let dHit = 0, dTotal = 0;
for (const rule of ['inline-credential', 'share-scope-widened', 'approval-disabled', 'gateway-publicized', 'redaction-weakened']) {
  const a = agg((r) => r.cat === 'D' && r.target === rule);
  dHit += a.hit; dTotal += a.total;
  console.log(`  ${rule.padEnd(22)} ${pct(a.hit, a.total)}`);
}
console.log(`  ${'D 合计'.padEnd(22)} ${pct(dHit, dTotal)}\n`);

// —— H2：变体分层 ——
console.log('【H2】V 变体检出率（按类别 × 检查项）：');
for (const cat of ['V1', 'V2', 'V3']) {
  let line = `  ${cat}: `;
  const parts: string[] = [];
  let cHit = 0, cTotal = 0;
  for (const rule of ['inline-credential', 'share-scope-widened', 'approval-disabled', 'gateway-publicized', 'redaction-weakened']) {
    const a = agg((r) => r.cat === cat && r.target === rule);
    cHit += a.hit; cTotal += a.total;
    parts.push(`①②③④⑤`.split('')[['inline-credential', 'share-scope-widened', 'approval-disabled', 'gateway-publicized', 'redaction-weakened'].indexOf(rule)] + `=${a.hit}/${a.total}`);
  }
  console.log(line + parts.join(' ') + `  | 小计 ${pct(cHit, cTotal)}`);
}
{
  const v = agg((r) => r.cat.startsWith('V'));
  console.log(`  V 合计（V1+V2+V3）：${pct(v.hit, v.total)}  vs D 合计 ${pct(dHit, dTotal)}\n`);
}

// 变体逐条未检出明细（供报告引用）
const vMissed = rows.filter((r) => r.cat.startsWith('V') && !r.blocked);
console.log(`【H2 明细】V 类未检出 ${vMissed.length} 条：`);
for (const r of vMissed) console.log(`  ${r.id}  (target=${r.target})`);
const vCrossHit = rows.filter((r) => r.cat.startsWith('V') && r.blocked && r.target && !r.rules.includes(r.target));
if (vCrossHit.length) {
  console.log(`【H2 交叉命中】V 类被其它规则命中 ${vCrossHit.length} 条（如嵌套 ③ 被 ① 全文扫描捕获）：`);
  for (const r of vCrossHit) console.log(`  ${r.id}  target=${r.target} 实际命中=${r.rules.join(',')}`);
}
console.log('');

// —— H3：良性 FPR ——
{
  const b = agg((r) => r.cat === 'B');
  const bTrick = agg((r) => r.cat === 'B' && r.tricky === true);
  const bReg = agg((r) => r.cat === 'B' && r.tricky === undefined);
  console.log('【H3】B 良性对照 FPR（预注册阈值 ≤3/30）：');
  console.log(`  常规 20：${pct(bReg.hit, bReg.total)}  tricky 10：${pct(bTrick.hit, bTrick.total)}  合计：${pct(b.hit, b.total)}`);
  const bFp = rows.filter((r) => r.cat === 'B' && r.blocked);
  for (const r of bFp) console.log(`  误报：${r.id} 命中规则=${r.rules.join(',')}${r.tricky ? '（tricky 预注册内）' : '（⚠️ tricky 外误报！）'}`);
  console.log('');
}

// —— 样本级预期一致性 ——
{
  const mismatch = rows.filter((r) => !r.match);
  console.log(`【样本级预期一致性】130 条中与样本级预期不符：${mismatch.length} 条`);
  for (const r of mismatch) console.log(`  ${r.id} expected=${r.expected} actual=${r.blocked ? 'block' : 'pass'} rules=${r.rules.join(',') || '-'}`);
  console.log('');
}

// —— 判定汇总 ——
{
  const v = agg((r) => r.cat.startsWith('V'));
  const b = agg((r) => r.cat === 'B');
  console.log('=================================================================');
  console.log('判定（预注册标准）：');
  console.log(`  H1 直检 TPR=100%：${dHit === 50 && dTotal === 50 ? '✅ 成立' : `❌ 不成立（${dHit}/50）`}`);
  console.log(`  H2 变体 < 直检：${v.hit < dHit ? '✅ 成立' : '❌ 不成立'}（V ${v.hit}/${v.total} vs D ${dHit}/${dTotal}）`);
  console.log(`  H3 良性 FPR ≤ 3/30：${b.hit <= 3 ? '✅ 成立' : '❌ 不成立'}（${b.hit}/30）`);
  console.log('=================================================================');
  console.log('\n逐样本原始结果（JSON）：');
  console.log(JSON.stringify(rows));
}

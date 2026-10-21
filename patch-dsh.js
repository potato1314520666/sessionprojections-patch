#!/usr/bin/env node
/**
 * patch-dsh.js v3 — sessionProjections 僵尸会话本地补丁（DSH 0.2.1-rc.2）
 *
 * v3 变更（归因审查 c4167ffa + cb9ac255 合并裁决，逐条代码核实）：
 *  - P1 改 **fail-closed 降级**：构造期 autoAdmit 缺失时不再 throw（拖死全进程），
 *    也不再静默跳过（v2 的 warn+else = 保留 danger-full-access 旋钮 + 跳过审查 = 越权执行）；
 *    改为调用现成的 this.set(session, this.defaultPreset) —— 落盘降级预设并同步收紧
 *    sandbox/approval 旋钮（复用 :344 apply() 的规范 setter，与 :378-382 既有降级分支同构）。
 *    代价如实声明：每次 permission-presets 重建，处于 auto 的会话会被持久降级为默认预设，
 *    需要用户重新选 auto。僵尸 → 可见降级，这是本补丁的核心交换。
 *  - P2 **撤回**：currentSelection() 读响应式 config，新值的唯一提交源就是 editor.edit；
 *    掐掉写盘 = 模型/effort 切换彻底失效（功能回归换不来防护——触发面是"任何 profile
 *    写盘→config_editor.js:75 无条件全图协调"，切模型只是最常见入口，堵一个不够）。
 *  - P3 保留但降级为**卫生项**：session-pwsh 的 Fiber.update 只重启 pwsh-sandbox 行，
 *    与本 bug 受害 fiber 无因果（README 已改述）。
 *  - 已知缺口（v3.1 候选，README 有设计稿）：P1b 钩子 try/catch 守卫（等长预算不足）、
 *    P4 liveAgent 存活校验（等长预算不足）、P5 isChanged 死 fiber 恒判变。
 *
 * 用法：完全退出 DSH（含托盘）后  node patch-dsh.js
 *       只读预览（可在 DSH 运行中）node patch-dsh.js --check
 * 路径：默认按平台推导；--asar <path> / --profile <dir> / DSH_ASAR / DSH_PROFILE_DIR 可覆盖。
 * 回滚：node rollback-dsh.js
 *
 * v3.2 变更（全自动压测发现，代码级实锤）：
 *  - 新增 P1″（同文件 :181-186）：用户开启全局自动审查后 config.defaultPreset==="auto"，
 *    构造期 this.resolve(defaultPreset) 与 defaultSettings 闭包会先于 P1′ 抛
 *    "unknown preset auto"（specOf 对无集成的 auto 返回 void 0）——v3.1 在该状态下形同虚设，
 *    重启（#9882 boot 形态）必炸。P1″ 把「构造期 fail-fast 校验」改为「使用时回退到
 *    可解析预设（specOf(d) ?? 配置表第一个）」，P1′ 的 set(session, defaultPreset) 由此恒可解析。
 *  - 压测取证教训：defaultPreset=auto 时「降级」写回的事件值仍是 auto，日志不可分辨；
 *    v3.2 后降级目标=第一个配置预设（默认 workspace-write），重新可观测。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ---------- 路径解析（无硬编码个人路径；优先级 CLI > 环境变量 > 平台默认） ----------
function argVal(flag) { const i = process.argv.indexOf(flag); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null; }
function resolveAsar() {
  const cli = argVal('--asar') || process.env.DSH_ASAR;
  if (cli) return cli;
  const home = os.homedir();
  if (process.platform === 'win32')
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'DeepSeek Harness', 'resources', 'app.asar');
  if (process.platform === 'darwin')
    return '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
  return path.join(home, '.local', 'share', 'DeepSeek Harness', 'resources', 'app.asar'); // Linux 默认，装了别处就 --asar
}
function resolveDshOps() {
  const prof = argVal('--profile') || process.env.DSH_PROFILE_DIR
    || path.join(os.homedir(), '.dsh', 'profiles', process.platform === 'win32' ? 'desktop' : 'default');
  return path.join(prof, 'node_modules', 'dsh-ops', 'lib', 'session-pwsh.js');
}

const ASAR = resolveAsar();
const ASAR_BAK = ASAR + '.pre-patch.bak';
const STAMP = ASAR_BAK + '.json';
const DSHOPS = resolveDshOps();
const DSHOPS_BAK = DSHOPS + '.pre-patch.bak';
const CHECK_ONLY = process.argv.includes('--check');
// v3.1：由 auto-patch.ps1 传入——外层脚本已用进程内 FileShare.None 探针验证句柄空闲，
// 跳过本脚本自带的 spawn 式探针（计划任务上下文里会弹控制台窗口，用户误按回车会杀死探针进程导致误判）。
const SKIP_LOCK = process.argv.includes('--skip-lock-check');

function die(msg) { console.error('ABORT: ' + msg + (CHECK_ONLY ? '' : '\n提示：先跑 node patch-dsh.js --check 判定实际落盘状态，再决定重试或 rollback-dsh.js。')); process.exit(1); }
function ok(msg) { console.log('OK: ' + msg); }
function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(4 * 1024 * 1024);
  for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (!n) break; h.update(buf.subarray(0, n)); }
  fs.closeSync(fd);
  return h.digest('hex');
}

// ---------- 0. 写入模式：进程 + 文件句柄双重防护 ----------
if (!CHECK_ONLY) {
  if (process.platform === 'win32') {
    let out = '';
    try { out = execSync('tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH', { encoding: 'utf8' }); }
    catch (e) { die('无法检查进程表: ' + e.message); }
    if (/DeepSeek Harness\.exe/i.test(out)) die('DSH 仍在运行。请完全退出（含系统托盘）后重试。');
    ok('DSH 进程未运行');
  } else {
    try { if (execSync("pgrep -f 'DeepSeek Harness' || true", { encoding: 'utf8' }).trim()) die('DSH 仍在运行，请完全退出后重试。'); }
    catch (e) { die('无法检查进程表: ' + e.message); }
    ok('DSH 进程未运行');
  }
  if (SKIP_LOCK) {
    ok('句柄探针由外层 auto-patch.ps1 预先完成（--skip-lock-check）');
  } else if (process.platform === 'win32') {
    try {
      execSync('powershell -NoProfile -Command "[IO.File]::Open(\'' + ASAR + "',Open','Read','None').Close()\"", { stdio: 'pipe', windowsHide: true });
      ok('app.asar 无进程句柄占用（FileShare.None 探针通过）');
    } catch (e) { die('app.asar 仍被某进程持有（FileShare.None 探针失败）。找到并退出该进程后重试。'); }
  } else {
    ok('非 Windows：跳过 FileShare 探针（POSIX 允许打开被占用文件，靠上面的进程检查把关）');
  }
}

// ---------- 1. asar 索引解析（unpacked 条目直接拒绝） ----------
if (!fs.existsSync(ASAR)) die('找不到 app.asar: ' + ASAR);
const fd = fs.openSync(ASAR, CHECK_ONLY ? 'r' : 'r+');
const h = Buffer.alloc(16);
if (fs.readSync(fd, h, 0, 16, 0) !== 16) die('asar header 读取失败');
const jlen = h.readUInt32LE(12);
if (jlen <= 0 || jlen > 64 * 1024 * 1024) die('asar index 长度异常: ' + jlen);
const jbuf = Buffer.alloc(jlen);
fs.readSync(fd, jbuf, 0, jlen, 16);
let idx;
try { idx = JSON.parse(jbuf.toString('utf8').replace(/\0+$/, '')); } catch (e) { die('asar index JSON 解析失败: ' + e.message); }
const base = 16 + jlen;
const files = new Map();
(function walk(node, pre) {
  for (const k of Object.keys(node.files || {})) {
    const e = node.files[k];
    const p = pre ? pre + '/' + k : k;
    if (e.files) walk(e, p);
    else if (e.offset !== undefined) {
      if (e.unpacked) files.set(p, { unpacked: true });
      else files.set(p, { offset: Number(e.offset), size: Number(e.size) });
    }
  }
})(idx, '');
ok(`asar 索引解析成功，${files.size} 个文件，数据基址 ${base}`);

// ---------- 2. 补丁定义（等长替换；标记专属；find 必须在文件字节范围内唯一） ----------
const P1_FILE = 'dsh/node_modules/@deepseek-ai/dsh-permission-presets/lib/index.js';
// v3 fail-closed：throw+autoAdmit 两行 → autoAdmit 缺失时走现成 set() 降级分支（落盘默认预设+收紧旋钮）
const P1_FIND = 'if (this.autoAdmit === void 0) throw new Error("permission: cannot restore preset \\"auto\\" without its active integration");\n\t\t\t\tthis.autoAdmit();';
const P1_REPL = 'if (this.autoAdmit === void 0) this.set(session, this.defaultPreset); else this.autoAdmit();';
// v3.2 P1″：压测发现——用户把全局默认预设开成 auto 后（defaultPreset.get()==="auto"），
// 构造期 :181 this.resolve(defaultPreset) 与 :184 defaultSettings 闭包会先于 P1′ 抛出
// "unknown preset auto"（specOf 在 autoAdmit===void 0 时对 auto 返回 void 0）→ v3.1 形同虚设，
// 重启必炸（#9882 boot 形态）。修法：删构造期 fail-fast 校验，defaultSettings 改为
// 「使用时解析不了就退到配置表第一个预设」——校验后移到唯一有用果的地方。
const P1B_FIND = '\t\t\tthis.resolve(defaultPreset);\n\t\t\tthis.defaultSettings = () => {\n\t\t\t\tconst defaultPreset = config.defaultPreset.get() ?? inferredDefault;\n\t\t\t\tif (!Object.hasOwn(this.presets, defaultPreset)) throw new Error(`permission: unknown default preset "${defaultPreset}"`);\n\t\t\t\treturn { defaultPreset };\n\t\t\t};';
const P1B_REPL = '\t\t\tthis.defaultSettings = () => {\n\t\t\t\tconst d = config.defaultPreset.get() ?? inferredDefault;\n\t\t\t\treturn { defaultPreset: this.specOf(d) ?? Object.keys(this.presets)[0] };\n\t\t\t};';

function patchAsarFile(label, path, findStr, replStr) {
  const f = files.get(path);
  if (!f) die(`${label}: asar 内找不到 ${path}`);
  if (f.unpacked) die(`${label}: ${path} 是 unpacked 条目，字节不在 asar 数据区，拒绝按 offset 写入（应改 unpacked 文件本体）`);
  if (!(f.size > 0 && f.size < 32 * 1024 * 1024)) die(`${label}: 文件大小异常 ${f.size}`);
  const buf = Buffer.alloc(f.size);
  fs.readSync(fd, buf, 0, f.size, base + f.offset);
  const findB = Buffer.from(findStr, 'utf8');
  const replRaw = Buffer.from(replStr, 'utf8');
  if (replRaw.length > findB.length) die(`${label}: 替换串超出原长度 ${replRaw.length}>${findB.length}`);
  const replB = Buffer.concat([replRaw, Buffer.alloc(findB.length - replRaw.length, 0x20)]);
  const first = buf.indexOf(findB);
  if (first === -1) {
    if (buf.indexOf(replRaw) !== -1) { ok(`${label}: 已打过补丁（专属标记命中），跳过`); return 'skipped'; }
    die(`${label}: 在 ${path} 中找不到目标字节串，且无补丁标记（版本不匹配？拒绝盲写）`);
  }
  if (buf.indexOf(findB, first + 1) !== -1) die(`${label}: 目标字节串不唯一，拒绝写入`);
  const abs = base + f.offset + first;
  if (CHECK_ONLY) { ok(`${label}: 可打补丁 @${abs}（${replB.length}B 等长替换，未写）`); return 'applicable'; }
  const n = fs.writeSync(fd, replB, 0, replB.length, abs);
  if (n !== replB.length) die(`${label}: 写入字节数不符 ${n}`);
  const check = Buffer.alloc(replB.length);
  fs.readSync(fd, check, 0, replB.length, abs);
  if (!check.equals(replB)) die(`${label}: 写后回读校验失败`);
  ok(`${label}: 已写入 @${abs}（${replB.length}B，等长，回读一致）`);
  return 'patched';
}

// ---------- 3. 备份生命周期 + 版本戳（防升级后旧备份覆盖新安装） ----------
let stamp = null;
if (fs.existsSync(STAMP)) { try { stamp = JSON.parse(fs.readFileSync(STAMP, 'utf8')); } catch { stamp = null; } }
const curSha = sha256(ASAR);
console.log(`当前 app.asar sha256=${curSha.slice(0, 16)}… size=${fs.statSync(ASAR).size}`);
if (CHECK_ONLY) {
  if (stamp && stamp.patchedSha === curSha) ok('版本戳显示：当前 asar 为本补丁产物（已打过）');
  else if (stamp && stamp.backupSha === curSha) ok('版本戳显示：当前 asar 为原版（备份在位且匹配）');
  else if (fs.existsSync(ASAR_BAK)) ok('注意：备份存在但 sha 与版本戳/当前都不匹配（可能已升级）');
  else ok('尚无备份');
} else if (stamp && stamp.patchedSha === curSha) {
  ok('当前 asar 已是本补丁产物（版本戳匹配），跳过重新备份（补丁位仍会逐处检查）');
} else if (stamp && stamp.backupSha === curSha && fs.existsSync(ASAR_BAK)) {
  ok('备份在位且与当前原版逐字节一致，直接补丁');
} else {
  if (fs.existsSync(ASAR_BAK)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(ASAR_BAK, ASAR_BAK + '.stale-' + ts);
    if (stamp) fs.renameSync(STAMP, STAMP + '.stale-' + ts);
    console.log('旧备份与当前 asar 不匹配（可能已升级）→ 已改名保留为 .stale-' + ts);
  }
  console.log('备份 app.asar → ' + ASAR_BAK + '（183MB，稍候）');
  fs.copyFileSync(ASAR, ASAR_BAK);
  if (fs.statSync(ASAR_BAK).size !== fs.statSync(ASAR).size) die('备份大小不符');
  ok('备份完成，sha256=' + curSha.slice(0, 16) + '…');
}

// ---------- 4. 执行 asar 补丁（v3.2：P1′ + P1″） ----------
const r1 = patchAsarFile('P1', P1_FILE, P1_FIND, P1_REPL);
const r1b = patchAsarFile('P1b', P1_FILE, P1B_FIND, P1B_REPL);
fs.closeSync(fd);
if (!CHECK_ONLY && (r1 === 'patched' || r1b === 'patched')) {
  const patchedSha = sha256(ASAR);
  fs.writeFileSync(STAMP, JSON.stringify({ backupSha: curSha, patchedSha, backupSize: fs.statSync(ASAR_BAK).size, ts: new Date().toISOString(), tool: 'patch-dsh.js v3' }, null, 2));
  ok(`版本戳已写入（patchedSha=${patchedSha.slice(0, 16)}…）`);
}

// ---------- 5. P3：dsh-ops profile 文件（卫生项，先备份；与本 bug 无因果） ----------
function patchDshOps() {
  if (!fs.existsSync(DSHOPS)) { ok('P3: 未安装 dsh-ops，跳过'); return; }
  const src = fs.readFileSync(DSHOPS, 'utf8');
  const FIND = 'entry.fiber.update(entry.options.config, true)';
  const REPL = 'void 0 /* PATCHED(#154 backport): no Fiber.update on ACTIVE rows */';
  if (!src.includes(FIND)) {
    if (src.includes(REPL)) { ok('P3: 已打过补丁，跳过'); return; }
    die('P3: session-pwsh.js 中找不到 Fiber.update，且无补丁标记（版本不匹配？拒绝盲写）');
  }
  const cnt = src.split(FIND).length - 1;
  if (cnt !== 1) die(`P3: Fiber.update 出现 ${cnt} 次，非预期，拒绝写入`);
  if (CHECK_ONLY) { ok('P3: 可打补丁（profile 文件，未写）'); return; }
  if (!fs.existsSync(DSHOPS_BAK)) fs.copyFileSync(DSHOPS, DSHOPS_BAK);
  fs.writeFileSync(DSHOPS, src.replace(FIND, REPL));
  if (!fs.readFileSync(DSHOPS, 'utf8').includes(REPL)) die('P3: 写后校验失败');
  ok('P3: session-pwsh.js 已补丁（备份于 ' + DSHOPS_BAK + '）');
}
patchDshOps();
console.log('\n' + (CHECK_ONLY ? '校验模式结束（未写任何文件）。' : '全部补丁完成。启动 DSH，建议先开新会话验证工具可用。'));

#!/usr/bin/env node
/**
 * inspect-log.js — 压测取证：解多帧 zstd 会话日志，统计补丁窗口内
 *   ① sessionProjections 僵尸错误（应为 0）
 *   ② permission/preset 事件（P1′ 降级会写，>0 且无僵尸 = 补丁在工作）
 *   ③ 工具报错事件
 * 用法: node inspect-log.js [--since "2026-10-21 22:25"] [sessionDirOrFile ...]
 * 不带文件参数时自动取 default-workspace 最近 3 个会话。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// session logs: ~/.dsh/sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd
// default root = the slug for the current working directory; override with DSH_SESSIONS_ROOT
const os = require('os');
const slugOf = (p) => '--' + p.replace(/[:\\/]+/g, '-').replace(/-+$/, '') + '--';
const SESS_ROOT = process.env.DSH_SESSIONS_ROOT ||
  path.join(os.homedir(), '.dsh', 'sessions', slugOf(process.cwd()));
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const argv = process.argv.slice(2);
let since = '2026-10-21 22:25';
const si = argv.indexOf('--since');
if (si !== -1 && argv[si + 1]) { since = argv[si + 1]; argv.splice(si, 2); }
const sinceMs = new Date(since.replace(' ', 'T')).getTime(); // 按本机时区（+08）解析
if (Number.isNaN(sinceMs)) { console.error('bad --since:', since); process.exit(1); }

function decode(file) {
  const buf = fs.readFileSync(file);
  const offs = [];
  for (let i = buf.indexOf(MAGIC); i !== -1; i = buf.indexOf(MAGIC, i + 1)) offs.push(i);
  let text = '';
  for (let k = 0; k < offs.length; k++) {
    const seg = buf.subarray(offs[k], k + 1 < offs.length ? offs[k + 1] : buf.length);
    try { text += zlib.zstdDecompressSync(seg).toString('utf8'); } catch { /* 尾帧可能正在写，跳过 */ }
  }
  return text;
}

function targets() {
  if (argv.length) return argv.map((t) => fs.statSync(t).isDirectory() ? path.join(t, 'session.v4.jsonl.zstd') : t);
  // default root missing (ran from a different cwd) → fall back to all slugs under ~/.dsh/sessions
  const roots = [SESS_ROOT];
  const parent = path.dirname(SESS_ROOT);
  if (!fs.existsSync(SESS_ROOT) && fs.existsSync(parent)) {
    for (const s of fs.readdirSync(parent)) {
      const p = path.join(parent, s);
      try { if (fs.statSync(p).isDirectory()) roots.push(p); } catch { /* ignore */ }
    }
  }
  const found = [];
  for (const r of roots) {
    let entries = [];
    try { entries = fs.readdirSync(r); } catch { continue; }
    for (const d of entries) {
      const f = path.join(r, d, 'session.v4.jsonl.zstd');
      try { if (fs.existsSync(f)) found.push({ f, t: fs.statSync(f).mtimeMs }); } catch { /* ignore */ }
    }
  }
  return found.sort((a, b) => b.t - a.t).slice(0, 3).map((x) => x.f);
}

for (const t of targets()) {
  const text = decode(t);
  let zombie = 0, perm = 0, toolErr = 0, total = 0, win = 0;
  const samples = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue; total++;
    let ev = null; try { ev = JSON.parse(line); } catch {}
    const tm = ev && typeof ev.time === 'number' ? ev.time : null;
    if (tm !== null && tm < sinceMs) continue;
    win++;
    // 只认真实故障：tool/result 事件且 is_error=true 且错误正文含死服务字符串。
    // （本会话日志里大量出现的该字符串是讨论/取证文本，不是故障——v1 曾因此误报 42 次）
    if (ev && ev.type === 'tool/result' && /"is_error"\s*:\s*true/.test(line) && line.includes('cannot get required service')) {
      zombie++; if (samples.length < 6) samples.push('ZOMBIE  ' + (tm ? new Date(tm).toLocaleTimeString('zh-CN') : '?') + ' ' + line.slice(0, 180));
    }
    if (ev && ev.type === 'permission/preset') { perm++; if (samples.length < 12) samples.push('PRESET  ' + (tm ? new Date(tm).toLocaleTimeString('zh-CN') : '?') + ' ' + JSON.stringify(ev.data).slice(0, 100)); }
    if (ev && ev.type === 'tool/result' && /"is_error"\s*:\s*true/.test(line)) { toolErr++; if (samples.length < 15) samples.push('TOOLERR ' + (tm ? new Date(tm).toLocaleTimeString('zh-CN') : '?') + ' ' + line.slice(0, 140)); }
  }
  const name = t.split(/[\\/]/).slice(-2).join('/');
  console.log(`\n=== ${name}`);
  console.log(`总事件 ${total}，${since} 之后 ${win}`);
  console.log(`sessionProjections 僵尸错误: ${zombie} ${zombie === 0 ? '✅' : '❌ 复现！'}`);
  console.log(`permission/preset 事件: ${perm}（auto 会话被降级为默认预设时出现 = P1′ 在工作）`);
  console.log(`工具报错/死服务读取: ${toolErr}`);
  for (const s of samples) console.log('  · ' + s);
}

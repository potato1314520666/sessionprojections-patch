#!/usr/bin/env node
/**
 * rollback-dsh.js v2 — 恢复 patch-dsh.js 的修改（需先完全退出 DSH）
 *
 * v2：恢复前校验（防「升级后用旧备份盖坏新安装」）：
 *   备份 sha 必须 == 版本戳 backupSha（备份完好）；
 *   当前 asar sha 必须 == patchedSha（确系本补丁产物）或 == backupSha（已恢复过，跳过）；
 *   都不匹配 → 拒绝（多半是自动升级换了 asar），除非 --force。
 * dsh-ops 的 .bak 属 profile 级：若 dsh-ops 已升级，恢复旧文件会造成包内不一致（README 已警告）。
 */
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ASAR = 'C:/Users/38761/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';
const ASAR_BAK = ASAR + '.pre-patch.bak';
const STAMP = ASAR_BAK + '.json';
const DSHOPS = 'C:/Users/38761/.dsh/profiles/desktop/node_modules/dsh-ops/lib/session-pwsh.js';
const DSHOPS_BAK = DSHOPS + '.pre-patch.bak';
const FORCE = process.argv.includes('--force');

function die(m) { console.error('ABORT: ' + m); process.exit(1); }
function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(4 * 1024 * 1024);
  for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (!n) break; h.update(buf.subarray(0, n)); }
  fs.closeSync(fd);
  return h.digest('hex');
}

let out = '';
try { out = execSync('tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH', { encoding: 'utf8' }); }
catch (e) { die('无法检查进程表: ' + e.message); }
if (/DeepSeek Harness\.exe/i.test(out)) die('DSH 仍在运行，请完全退出后重试。');
try { execSync('powershell -NoProfile -Command "[IO.File]::Open(\'' + ASAR + "',Open','Read','None').Close()\"", { stdio: 'pipe' }); }
catch (e) { die('app.asar 仍被某进程持有（FileShare.None 探针失败），退出该进程后重试。'); }

if (fs.existsSync(ASAR_BAK)) {
  if (!fs.existsSync(STAMP) && !FORCE)
    die('有备份但无版本戳（备份来自 v1 脚本或戳被删）。确认 asar 未升级过再用 --force 恢复，否则先手动核对。');
  const bakSha = sha256(ASAR_BAK);
  const curSha = sha256(ASAR);
  if (fs.existsSync(STAMP)) {
    const st = JSON.parse(fs.readFileSync(STAMP, 'utf8'));
    if (st.backupSha !== bakSha) die('备份内容与版本戳不符（备份可能被改动/截断），拒绝恢复。');
    if (curSha === st.backupSha) console.log('跳过: 当前 asar 已是原版（无需恢复）');
    else if (curSha === st.patchedSha || FORCE) {
      fs.copyFileSync(ASAR_BAK, ASAR);
      if (sha256(ASAR) !== bakSha) die('恢复后校验失败！');
      console.log('OK: app.asar 已恢复为补丁前原版（双重 sha 校验通过，备份保留）');
    } else die('当前 app.asar 与「补丁产物」和「原版」都不匹配——多半已自动升级。\n' +
      '用旧备份覆盖新安装会导致 JS/原生版本错配。确认确实要覆盖再加 --force。');
  } else { fs.copyFileSync(ASAR_BAK, ASAR); console.log('OK: 已按 --force 恢复（未经版本戳校验）'); }
} else console.log('跳过: 无 app.asar 备份');

if (fs.existsSync(DSHOPS_BAK)) {
  fs.copyFileSync(DSHOPS_BAK, DSHOPS);
  console.log('OK: session-pwsh.js 已恢复（若 dsh-ops 此后升级过，请改为重装该插件而非保留此旧文件）');
} else console.log('跳过: 无 session-pwsh.js 备份');
console.log('回滚完成。');

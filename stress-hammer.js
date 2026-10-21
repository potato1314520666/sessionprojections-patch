#!/usr/bin/env node
/**
 * stress-hammer.js — 全自动触发 permission-presets 重建的压测锤。
 *
 * 原理（本机代码实证，@deepseek-ai/dsh-hmr/lib/index.js:854-872）：
 *   dsh-hmr 已启用，watchConfig 监听 [profile.patchPath, ~/.dsh/cordis.patch.yml, package.json(bundles)]，
 *   refresh() 对 patch 文件做**原文 diff**（inputs === lastInputs 则跳过）→
 *   任何原文变化（含纯注释行）→ reconcileProfile() → 全图协调 → permission-presets 重建 →
 *   构造期 pinInitialPermission 命中 P1′ 补丁行（本会话钉 auto，正是触发定理的样本）。
 *
 * 安全性：只追加/删除 YAML 注释行（解析语义为零变化）；开跑前全量备份，收尾必还原并校验。
 * 用法: node stress-hammer.js [rounds=6] [intervalMs=6000]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROFILE = process.env.DSH_PROFILE_DIR
  || (process.platform === 'win32'
    ? path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
    : path.join(os.homedir(), '.dsh', 'profiles', 'default'));
const TARGET = path.join(PROFILE, 'cordis.patch.yml');
const BACKUP = path.join(os.tmpdir(), 'stress-hammer-backup-' + Date.now() + '.yml');
const LOG = path.join(process.cwd(), 'stress-run.log');
const ROUNDS = parseInt(process.argv[2] || '6', 10);
const GAP = parseInt(process.argv[3] || '6000', 10);

const log = (m) => { const s = `[${new Date().toISOString()}] ${m}`; console.log(s); fs.appendFileSync(LOG, s + '\n'); };

function main() {
  fs.writeFileSync(LOG, ''); // 每轮覆盖
  if (!fs.existsSync(TARGET)) { log('ABORT: ' + TARGET + ' 不存在'); process.exit(1); }
  const orig = fs.readFileSync(TARGET);
  fs.writeFileSync(BACKUP, orig);
  log(`target=${TARGET} (${orig.length}B) backup=${BACKUP}`);
  let i = 0;
  const step = async () => {
    if (i >= ROUNDS) {
      await new Promise((r) => setTimeout(r, GAP));
      fs.writeFileSync(TARGET, orig); // 原子性：writeFileSync 单缓冲写 + chokidar awaitWriteFinish 防半截读
      log(`restored original bytes (${orig.length}B)`);
      await new Promise((r) => setTimeout(r, GAP));
      const now = fs.readFileSync(TARGET);
      log(now.equals(orig) ? 'VERIFY: 文件与开跑前逐字节一致 ✅' : 'VERIFY: 还原后不一致 ❌ 备份在 ' + BACKUP);
      log(`DONE: ${ROUNDS} 次注释追加 + 1 次还原 = 预期 ${ROUNDS + 1} 次 reconcile`);
      return;
    }
    fs.appendFileSync(TARGET, `\n# dsh-stress ${new Date().toISOString()} r${i}`);
    log(`round ${i}: appended comment line (file now ${fs.statSync(TARGET).size}B)`);
    i++;
    await new Promise((r) => setTimeout(r, GAP));
    return step();
  };
  return step().catch((e) => { log('ERROR: ' + e.stack + ' — 备份在 ' + BACKUP); process.exit(1); });
}
main();

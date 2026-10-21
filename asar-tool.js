#!/usr/bin/env node
/**
 * asar-tool.js — 从 app.asar 按索引提取/检索文件（只读）。
 * 用法:
 *   node asar-tool.js --asar <path> list <substring...>      # 列出匹配路径
 *   node asar-tool.js --asar <path> extract <path> [out]     # 提取单文件
 *   node asar-tool.js --asar <path> grep <regex> <subpath...> # 在匹配文件里搜内容
 * asar 路径默认: %LOCALAPPDATA%/DeepSeek Harness/resources/app.asar（可用 DSH_ASAR 环境变量覆盖）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function defaultAsar() {
  if (process.env.DSH_ASAR) return process.env.DSH_ASAR;
  const home = os.homedir();
  if (process.platform === 'win32') {
    const la = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(la, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar');
  }
  if (process.platform === 'darwin') return '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
  return path.join(home, '.local/share/DeepSeek Harness/resources/app.asar');
}

const argv = process.argv.slice(2);
let ASAR = defaultAsar();
const ai = argv.indexOf('--asar');
if (ai !== -1 && argv[ai + 1]) { ASAR = argv[ai + 1]; argv.splice(ai, 2); }
const [cmd, ...rest] = argv;
if (!cmd) { console.error('need cmd: list|extract|grep'); process.exit(1); }

const fd = fs.openSync(ASAR, 'r');
const h = Buffer.alloc(16);
fs.readSync(fd, h, 0, 16, 0);
const jlen = h.readUInt32LE(12);
const jbuf = Buffer.alloc(jlen);
fs.readSync(fd, jbuf, 0, jlen, 16);
const idx = JSON.parse(jbuf.toString('utf8').replace(/\0+$/, ''));
const base = 16 + jlen;
const files = new Map();
(function walk(node, pre) {
  for (const k of Object.keys(node.files || {})) {
    const e = node.files[k];
    const p = pre ? pre + '/' + k : k;
    if (e.files) walk(e, p);
    else if (e.offset !== undefined && !e.unpacked) files.set(p, { offset: Number(e.offset), size: Number(e.size) });
  }
})(idx, '');

function read(f) {
  const buf = Buffer.alloc(f.size);
  fs.readSync(fd, buf, 0, f.size, base + f.offset);
  return buf;
}

if (cmd === 'list') {
  const subs = rest.length ? rest : [''];
  const hits = [...files.keys()].filter((p) => subs.every((s) => p.includes(s)));
  console.log(hits.join('\n'));
  console.error(`(${hits.length}/${files.size})`);
} else if (cmd === 'extract') {
  const f = files.get(rest[0]);
  if (!f) { console.error('not found: ' + rest[0]); process.exit(1); }
  const buf = read(f);
  if (rest[1]) { fs.writeFileSync(rest[1], buf); console.error(`wrote ${rest[1]} (${buf.length}B)`); }
  else process.stdout.write(buf);
} else if (cmd === 'grep') {
  const re = new RegExp(rest[0], rest[0].startsWith('/') ? '' : 'g');
  const subs = rest.slice(1);
  let n = 0;
  for (const [p, f] of files) {
    if (subs.length && !subs.some((s) => p.includes(s))) continue;
    if (f.size > 8 * 1024 * 1024) continue;
    const txt = read(f).toString('utf8');
    const lines = txt.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (m) { console.log(`${p}:${i + 1}: ${lines[i].trim().slice(0, 200)}`); n++; if (n > 200) { console.error('...capped at 200'); process.exit(0); } }
    }
  }
  console.error(`(${n} hits)`);
}

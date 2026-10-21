# sessionProjections 僵尸会话本地补丁（v3 定稿，两轮对抗审查后）

针对：DSH Desktop **0.2.1-rc.2** / Windows / profile `desktop`（本机实测版本）
症状：会话运行中切模型/改权限/热改插件后，工具调用报
`cannot get required service "sessionProjections" in inactive context`，
turn/end 仍显示 completed（僵尸），只有重启宿主才恢复。

## 影响面（v3 修正——v2 的归因被 157 份会话日志实测推翻重写）

- 触发面是**任何 profile 写盘**（切模型/effort、切权限预设、插件热编辑、dsh-ops 配置更新），
  切模型只是最常见入口，不是特殊入口。
- 故障形态是**进程级**：本机日志实测同一错误 509 次、波及 95/157 会话，
  10-19 一次事件同时打挂 57 个会话。v2 写的"新会话正常"**不成立**，验收标准已改为进程级。
- 补丁作者（本会话 lead）与归因审查子代理均在 21:41/21:47 **未切任何配置**被现场击中——
  触发源只是后台子代理活动引发的图协调。

## 根因链（每一环有本地代码行号支撑）

```
任何 profile 写盘
  → configEditor.edit() → config_editor.js:75 reconcileProfilePatches 无条件全图协调
  → app_boot.js:3853 根 Include entry.update()（prepareProfilePatches 后没有等值门）
  → fiber dispose+reload（cordis.js:1408 restart → :1384 _unload 把 store 置 void 0）
  → permission-presets 重建，构造期 :205 对全部会话跑 pinInitialPermission
  → 本机 121/157 会话终态钉在 preset:"auto"（实测 126 条 auto 事件）
    而 autoAdmit 只可能由消费者 auto-review 在构造之后注册 → :374 throw 是【定理】不是偶发
  → fiber 进 FAILED → auto-review 的全局 {prepend:true} tools/pre-execute 钩子
    （auto_review.js:464）对每个会话每次工具调用读死服务 → 全进程工具僵尸
  → root.update() 的 rejection 被 .catch(logger.warn) 吞掉，无人重试
```

**自放大回路**：`config_editor.js:93-96` 的 `isChanged` 用死 fiber 上的 config 判断
"配置是否变了" → 恒得 `{}` → 恒判"变了" → 每次写都升级成全图协调。
这解释了 10-17 至 10-21 连续 5 天反复发作。

## v3 三裁决（两份对抗审查 + 逐条字节级核实）

| 项 | 裁决 | 内容与理由 |
|---|---|---|
| **P1′** | **打（核心）** | `dsh-permission-presets/lib/index.js` 构造期 `throw …; this.autoAdmit();`（146B）→ `if (autoAdmit===void 0) this.set(session, this.defaultPreset); else this.autoAdmit();`（92B 等长补齐）。复用 :344 `apply()` 现成规范降级分支（与 :378-382 原生降级同构）：落盘降级预设 + 同步收紧 sandbox/approval 旋钮。fiber 存活，僵尸变**可见降级**。补丁后整文件 `node --check` PASS |
| **P2** | **撤回**（v2 曾采纳） | `currentSelection()` 读响应式 config，新值的**唯一提交源**就是 `editor.edit`——掐写盘 = 模型/effort 切换彻底失效。且触发面远大于切模型，堵这一个入口换不回防护。功能回归换假安全，弃 |
| **P3** | **保留，降为卫生项** | `dsh-ops/lib/session-pwsh.js` 移除对 ACTIVE 行的 `Fiber.update()`（#154 回移）。只影响 pwsh-sandbox 行，**与本 bug 无因果**；独立价值 = 拆掉一个真实的全图触发源。另注意 `dsh-ops/lib/config-updates.js:43` 还有第二个 `entry.update()` 入口（未覆盖，观察项） |

## P1′ 的代价（如实声明）

每次 permission-presets 重建时，处于 auto 的会话被**持久降级**为默认预设
（旋钮同步收紧，需手动重选 auto）。这是用"可见降级"换"进程级僵尸"。
`autoAdmit` 正常注册时（绝大多数时刻）行为与原逻辑逐字节一致。
降级会写 `permission/preset` 事件——UI 和日志里看得见，不是静默行为。

## 应用（必须完全退出 DSH，含托盘图标）

```powershell
cd "C:\Users\38761\Documents\deepseek-harness\default-workspace\sessionprojections-patch"
node patch-dsh.js
```

脚本防护链：tasklist 进程检查 → .NET FileShare.None 句柄探针（实测唯一可靠的占用检测）
→ 备份 asar + sha256 版本戳 → 等长字节替换（不改 header/offset；unpacked 条目即拒；
目标串不唯一即拒）→ 写后回读校验 → 版本戳落盘。

预览（只读，可在 DSH 运行中）：`node patch-dsh.js --check`
**中途失败**：先跑 `--check` 判定实际落盘状态再重试（幂等收敛）或 `node rollback-dsh.js`。

## 回滚（带版本校验）

```powershell
node rollback-dsh.js
```

三重 sha256：备份完好 → 当前 asar 确系本补丁产物 → 恢复后回读比对。
**DSH 自动升级过则拒绝恢复**（旧备份盖新安装 = 版本错配），除非 `--force`。

## 验证（进程级验收，v2 标准作废）

1. 启动 DSH，新会话跑一次工具调用 → 正常。
2. 会话运行中切一次模型 → 同会话再调工具 → **不再出现 inactive context**。
3. 切一次权限预设 → 再调工具 → 同上。
4. **同时测一个旧会话和子代理会话**（故障是进程级的，只测新会话不够）。
5. 若某 auto 会话的权限选择器显示已降级为默认预设 → **P1′ 正在工作**（预期行为）。

### 压测工具（本仓库附带）

- `stress-probe.sh`：每轮 GUI 切换后跑一次，能返回 = 工具链存活。
- `inspect-log.js`：解多帧 zstd 会话日志取证（`node inspect-log.js --since "YYYY-MM-DD HH:MM"`）。
  只统计 `tool/result` 且 `is_error=true` 且含死服务字符串的真实故障——讨论该 bug 的
  会话日志本身会匹配到该字符串，v1 曾因此误报，勿重蹈。
- `auto-patch.ps1`：无人值守打补丁（计划任务上下文，处理托盘退不干净 + 句柄释放等待）。

## 适用性声明

脚本路径硬编码为本机（`C:/Users/<you>/...`，见 `patch-dsh.js` 顶部常量），且仅针对
**0.2.1-rc.2** 的字节偏移做过唯一性校验；换版本时目标串找不到会自动拒写（不会盲改）。
他人使用前先改常量并跑 `--check`。

## 已知缺口（v3.1 候选，均已核实当前不可等长实施）

- **P1b** 钩子 try/catch→cancel 守卫：需 192B，现场等长预算只有 150B。
- **P4** `liveAgent` 缓存 ctx 存活校验：需插入 ~70B 无余量；且 `agent.ctx?.fiber?.state`
  属性路径未经运行时实证，误伤会把正常会话缓存全判死 → 必须先实测再动。
- **P5** `isChanged` 死 fiber 恒判变：要改协调语义，风险大于收益。
- **`:188` 次序风险**：若某次重建中 sessionProjections 提供者晚于消费者 active，
  构造在 :188 抛同一字符串，P1′ 不覆盖（归因审查指出的残余路径，无本地证据发生过）。

## 失效场景

- **DSH 升级/重装**：app.asar 被覆盖 → P1′ 消失。重跑脚本即可（版本戳会检测 sha 不匹配，
  旧备份改名 `.stale-<时间戳>` 保留）。若上游已修，`--check` 找不到目标串会自动拒写。
- **dsh-ops 升级到含 #154 的版本**：P3 目标串不存在，脚本自动跳过。

## 上游对应

宿主侧根治（reconcile 等值门 / 死 fiber 不吞 rejection）仍在社区跟踪：#29 / #9812 / #10007。
本补丁是 0.2.1-rc.2 上的本地止血，不是上游替代品。

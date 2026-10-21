# Discussion #9882 回帖草稿（发布时贴到上游帖子，替换 <REPO> 占位符）

---

**TL;DR (EN):** We hit the same zombie-session bug on 0.2.1-rc.2/Windows and instrumented it:
**509 occurrences across 95/157 session logs**; one event on 10-19 killed 57 sessions at once.
Beyond @tianguoyan's boot theorem and @little3tar's runtime-reconstruction variant, we found a
**third throw site nobody has published a fix for**: with global auto-review enabled,
`config.defaultPreset === "auto"` makes the constructor fail at the fail-fast validation
(`this.resolve(defaultPreset)`, lib/index.js :181 / `defaultSettings` closure :184) — *before*
reaching the `pinInitialPermission` throw. So a pin-site-only guard (including wrapping or
@argszero's restore-guard, which targets the session/created variant) is **not sufficient** when
the global auto toggle is on: `specOf("auto")` returns `undefined` during construction because
`autoAdmit` is only registered later by the auto-review consumer.
We published a working byte-level mitigation covering all three sites (P1′ pin-site fail-closed
demotion + P1″ defaultSettings fallback + dsh-ops #154 backport), with backup / SHA-stamp /
rollback / unattended flow: **<REPO>**. It is a mitigation, not a root fix — the unconditional
full-graph reconcile on any profile write (`config_editor.js:75`) and the dead-fiber
`isChanged`-always-true loop (`:93-96`) remain; a proper fix belongs in the host (equality gate
before `entry.update()`, or not depending on late-registered facts during construction).

---

**中文详情：**

本机 0.2.1-rc.2/Windows 复现并全量取证：会话日志里 `cannot get required service
"sessionProjections" in inactive context` 共 **509 次、波及 95/157 个会话**；10-19 一次事件
同时打挂 57 个会话。触发面是**任何 profile 写盘**（切模型/effort、切权限预设、插件热编辑、
dsh-ops 配置更新），不是切模型专属。

补充一个帖子里没出现过的病灶（对"全局自动审查开着"的用户是决定性的）：

- `defaultPreset` 是 `z.string().volatile()` 配置。GUI 打开全局自动审查后，活进程内
  `config.defaultPreset === "auto"`；
- 此时运行时重建 permission-presets，构造器在 **:181 `this.resolve(defaultPreset)`** 和
  **:184 `defaultSettings` 闭包的 `unknown default preset` 校验**就抛了——**先于**
  `pinInitialPermission` 里那个大家盯着的 throw（`specOf` 在 `autoAdmit === void 0` 的构造期
  对 `"auto"` 返回 `undefined`，而 `autoAdmit` 只能由 auto-review 消费者在构造之后注册）；
- 推论：**只修 pin 点不够**（任何只包住 :374 throw 的方案，对开着全局自动审查的机器仍然必炸）。

我们的处理（<REPO>，等长字节补丁，备份/版本戳/回滚/无人值守脚本齐全）：

| 补丁 | 位置 | 效果 |
|---|---|---|
| P1′ | `pinInitialPermission` auto 分支 | `autoAdmit` 未注册时 fail-closed 降级到默认可解析预设（复用现成 `apply()` 路径，写可见事件），不再拖死整个 fiber |
| P1″ | :181/:184 构造期校验 | 删 fail-fast，`defaultSettings` 改 `specOf(d) ?? 第一个配置预设`——校验后移到使用时点 |
| P3 | dsh-ops session-pwsh | #154 的 rc.2 回移（拆一个真实全图触发源） |

代价与边界（如实）：auto 会话遇重建会被持久降级（需手动重选 auto）；钉死 rc.2 字节，升级失效
需重跑；**是止血不是根治**——`config_editor.js:75` 的无条件全图协调和 `:93-96` 死 fiber 恒判
"变了"的自放大回路还在，请官方优先在这两处加等值门/存活校验。

感谢 @tianguoyan 的启动形态定理、@argszero 的死锁确认与 restore-guard、@little3tar 的运行时
重建形态分析——本仓库是在三位的地图上补了第三个 throw 点并把 pin 点方案落到可运行的字节补丁。

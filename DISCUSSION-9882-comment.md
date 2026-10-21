# Discussion #9882 回帖草稿（发布时替换 <REPO> 占位符）

---

**EN summary:** Same bug on my machine (0.2.1-rc.2, Windows). Session logs say it's worse than
"switching models freezes things": *any* profile write triggers it — 509 occurrences across
95/157 sessions in my logs, one event killed 57 sessions at once.

While patching it I found one throw site that I don't think has been mentioned here yet: if the
global auto-review toggle is on, `defaultPreset` becomes `"auto"` and the constructor fails at
its very first validation (lib/index.js :181/:184), *before* it ever reaches
`pinInitialPermission`. `autoAdmit` is only registered by the auto-review plugin after
construction, so guarding just the pin site won't save a machine with global auto enabled.

I put the byte-level patch I run on my machine here: **<REPO>** (covers both sites, with backup
and rollback). It's a workaround, not a fix — the real problem is that the host rebuilds the
whole plugin graph on every config write, with no equality gate before `entry.update()`. That
part is up to the maintainers.

Big thanks to @tianguoyan, @argszero and @little3tar — the map in this thread was right, I
just filled in one blank spot.

---

**中文：**

我这台 0.2.1-rc.2/Windows 也中了同一个 bug。翻了全部会话日志之后发现问题比"切模型卡死"更宽：
**任何** profile 写盘都会触发（切模型、切权限、热改插件、dsh-ops 更新配置都算）。我的日志里
同一个错误出现了 509 次，波及 95/157 个会话，10-19 有一次一口气打挂 57 个会话。

打补丁的过程中发现一个本帖还没提到的炸点：如果全局自动审查是开着的，`defaultPreset` 就是
`"auto"`，构造器会在最开头的校验（:181/:184）直接抛——**走不到** `pinInitialPermission` 那个
大家关注的 throw。因为 `autoAdmit` 是 auto-review 在构造之后才注册的。所以只保护 pin 点的
方案，救不了开着全局自动审查的机器。

我自己机器上跑的字节级补丁放在这：**<REPO>**。两处抛点都盖住了，带备份和回滚，装完重启生效。
说清楚：这是止血，不是根治。真正的病根是宿主每次写配置都无条件重建整个插件图
（`config_editor.js:75`，而且死 fiber 上的 `isChanged` 恒判"变了"，每次写都升级成全图协调）。
`entry.update()` 前面加个等值门应该就能解决大半，这个得官方来改。

各方案的分工大概是：

| | 解决什么 |
|---|---|
| @argszero 的 restore-guard | 会话行消失那个变体 |
| dsh-ops #154 | dsh-ops 自己引发的重建 |
| 我的补丁 | 重建时 auto 会话卡死 + 上面那个更早的炸点 |

互相不冲突。局限也写在我仓库 README 里了：版本钉死 rc.2、auto 会话遇重建会被降级、
构造期降级的阳性事件我还没抓到过一次（触发面比较挑时机）。

感谢 @tianguoyan 的启动形态定理、@argszero 的死锁确认、@little3tar 的重建形态分析，
这个帖子的地图基本是全的，我就是补了一格。

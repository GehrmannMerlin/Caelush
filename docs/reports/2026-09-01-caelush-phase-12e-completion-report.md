# Caelush Phase 12E Completion Report

日期：2026-09-01  
产品版本：`0.1.0`  
本轮：`Phase 12E — Production Hardening, Product Launcher, Packaging & Final CLI E2E`

本报告按用户 brief 要求覆盖 106 项交付信息。除特别标注外，`PASS` 表示在当前 Windows x64 主机上实际执行过；Hosted CI 的 Linux/macOS 矩阵已建立，但未在本机冒充已执行。

1. **Phase12D remote verification**：`git fetch origin --prune` 与 `git ls-remote --heads origin refs/heads/codex/phase-12d-interactive-control-session-recovery` 均通过。
2. **Phase12D final SHA**：`02c83cd65ec1c2353df41661458290977a5e88b9`。
3. **base selection**：该 SHA 不是 `origin/master` 的祖先，因此按 brief 选择 `origin/codex/phase-12d-interactive-control-session-recovery`。
4. **branch/worktree**：`codex/phase-12e-production-hardening-packaging-cli-e2e`，位于 `.worktrees/phase-12e-production-hardening-packaging-cli-e2e`。
5. **baseline verification**：Phase 12D 报告基线为 295 test files、1093 tests passed、5 skipped；本轮重新执行前置基线链路无功能失败。
6. **format baseline**：本轮记录的仓库历史基线为 796 个 Prettier warnings；未对全仓库做格式化重写。
7. **packaging characterization**：见 [`2026-09-01-phase-12e-release-surface.md`](../characterization/2026-09-01-phase-12e-release-surface.md)，记录了 package scripts、ESM 资产、`node-pty`、Drizzle migrations、Ink/React、Git/rg 和现有 entrypoints。
8. **native dependency findings**：`node-pty` 是目标平台 native addon，不能假设纯 JS；artifact 必须携带目标平台依赖。Windows x64 artifact 已实际 load 与 PTY smoke 通过。
9. **migration asset findings**：Drizzle migration 是 filesystem asset，不能从 `process.cwd()` 推导；daemon/storage 现在从 package asset 位置发现，artifact migration inspection 通过。
10. **Codex distribution research**：参考 Codex CLI、non-interactive mode、developer commands；来源和取舍见 [12E design spec](../superpowers/specs/2026-09-01-caelush-phase-12e-production-hardening-packaging-design.md)。
11. **Claude distribution research**：参考 Claude Code installation、CLI usage、troubleshooting；来源和取舍见同一 design spec。
12. **pnpm deploy research**：参考 pnpm deploy 文档；pnpm 11 的 legacy deploy 在当前 workspace 配置下会保留 workspace 链接，因此 release script 将 `--legacy` 作为兼容性探针，并使用显式 injected deploy 生成真正产物。
13. **absorbed patterns**：单一产品命令、显式 print/non-interactive host、machine-readable output、doctor、平台化安装、native dependency 诊断、artifact smoke 和清洁 stdout。
14. **deferred patterns**：认证、云端/App Server、sandbox、auto-update、release channel、package-manager publish、signing、remote control、Web UI 及其他 Phase 13/后续能力。
15. **V1 distribution decision**：Node.js 24 portable production bundle，按平台和架构生成 tarball；不是单文件 runtime。
16. **why no single-file executable**：`node-pty` native ABI、migration 外置资产、native extraction、asset resolution 和 loader 风险在 V1 没有必要引入，因此不使用 SEA、pkg、nexe、Bun compile 或自带 Node。
17. **Product Launcher architecture**：新增 host-only `apps/launcher`，负责 preflight、静态命令、doctor、daemon discovery 和 Print Host dispatch；AgentLoop 仍只在共享 Kernel/daemon 内运行。
18. **launcher dependency boundaries**：launcher 只直接依赖 `@caelush/cli`、`@caelush/client`、`@caelush/protocol` 和 daemon 的 entry/path/diagnostic public subpaths；architecture test 禁止 Core/Storage/Runtime/Security/Tools/Verification/LLM 实现依赖。
19. **daemon process separation**：Launcher 只通过 `process.execPath` 加载 daemon entry 启动子进程，绝不在自身进程内调用 `startDaemon` 或创建 Agent runtime。
20. **daemon discovery**：默认地址 `http://127.0.0.1:43120`，先 health，再 info；健康且兼容时复用，否则进入有界本地启动流程。
21. **custom daemon URL behavior**：`CAELUSH_DAEMON_URL` 是 connect-only；不创建 local lock/log，不 spawn，不接管生命周期。artifact E2E 通过 fake HTTP daemon 验证零本地 spawn。
22. **compatibility checks**：health/info 的 API/protocol 必须为 `v1`/`1`；默认本地 daemon 还必须精确匹配 launcher product version。
23. **version checks**：本地 daemon 与 launcher 的 `0.1.0` 一致；不一致 fail closed。external daemon 允许连接但只给 version warning。
24. **startup lease**：使用 atomic `mkdir` lease directory，metadata 包含 owner token、pid、createdAt、version，TTL 为 15 秒。
25. **stale lock**：只有 TTL 过期且当前仍无健康 daemon 时清理；正常 owner release 不留下 lock。
26. **startup race behavior**：两个 launcher 共享同一 startup lease，等待者重复 probe；artifact 并发启动验证收敛到一个健康 daemon。
27. **EADDRINUSE behavior**：43120 被不相关 HTTP server 占用时，launcher 启动失败并保留端口 owner；不会 kill owner，也不会进入无限 spawn loop。
28. **detached daemon lifecycle**：daemon 使用 detached child、非终端 stdout/stderr、`unref`；daemon 生命周期不依赖 launcher 进程存活。
29. **daemon logs**：写入 product log directory，单文件超过 5 MiB 旋转为 `.1`；每行 bounded，日志路径集中由 product paths 生成。
30. **secret safety**：API key/auth/token/secret/Bearer 等在 launcher log redaction、doctor、manifest、print JSON/JSONL 和 artifact smoke 输出中均不泄漏。
31. **product paths**：`CAELUSH_HOME` 可测试覆盖；默认根为 `~/.caelush`，包含 `caelush.db`、`run/daemon-start.lock`、`logs/daemon.log`。
32. **version source**：launcher、daemon 和 root package 共享 package metadata version；daemon info 使用导出的 authoritative `DAEMON_VERSION`。
33. **--help**：静态命令直接输出帮助，不连接、不启动 daemon、不加载 Ink。
34. **--version**：静态命令输出 `caelush 0.1.0`，不连接、不启动 daemon。
35. **doctor**：read-only 检查 Node/platform/TTY/workspace/daemon/DB parent/Git/rg/node-pty/migrations/provider presence；不 autostart；critical fail 返回 1，warning 不单独失败。
36. **platform support matrix**：声明 Windows x64、Linux x64、macOS arm64、macOS x64；CI workflow 对应 `windows-latest`、`ubuntu-latest`、`macos-14`、`macos-15-intel`。
37. **TTY gate**：交互模式要求 stdin 和 stdout 都是 TTY，且在 raw-mode/Ink 前由 launcher 拒绝。
38. **non-TTY behavior**：pipe stdin/stdout 执行 `caelush` 得到精确 guidance 和 exit 3，不加载 Ink，不污染 stdout；artifact 已验证。
39. **TERM/NO_COLOR behavior**：本轮保持既有 CLI presentation 的终端环境处理；相关 Phase 12D/CLI 回归纳入完整 Vitest。未在当前 artifact smoke 中伪造所有终端类型。
40. **print mode architecture**：Print Host 位于 CLI application 层，通过既有 client/SSE/controller 工作；不调用 Ink，不复制 AgentLoop。
41. **prompt input**：`-p/--print` 支持参数 prompt；UTF-8 bounded 至 32 KiB，并复用 CLI prompt byte limit。
42. **stdin input**：无 prompt 参数时从 stdin 读取，严格 fatal UTF-8；参数与非空 stdin 同时存在会返回 usage error。
43. **text output**：成功时 stdout 只有 verified final text；错误/approval guidance 写 stderr。
44. **json output**：`--output-format json` 输出单个 JSON object，字段只包含 public-safe result、session/run identity、status 和 error metadata。
45. **stream-json output**：每行都是 JSON；只转发 `USER_VISIBLE` AgentEvent，并最终输出 `type=result` record；artifact 已逐行 parse 验证。
46. **stdout/stderr contract**：stdout 是 machine-readable/result channel，stderr 承载诊断；secret、raw provider payload、hidden reasoning 和 raw tool args 不进入公共输出。
47. **Approval in print mode**：print 不自动 approve；遇到 WAITING_APPROVAL 返回 `requiresApproval=true` 与 exit 5，Run 保持 durable。artifact 已实际触发 `apply_patch` approval。
48. **cancellation in print mode**：Print Host 注册 SIGINT，调用既有 cancel path，并把确认的 CANCELLED 映射为 130；Phase 12D cancellation tests 已纳入完整回归，未在本机额外伪造长模型请求。
49. **exit codes**：稳定映射：0 success、1 doctor failure、2 usage、3 bootstrap、4 terminal、5 approval required、6 transport、130 cancelled。
50. **launcher CLI grammar**：支持 `caelush`、`-c/--continue`、`-r/--resume`、`-p/--print`、`--output-format text|json|stream-json`、`doctor`、help/version；冲突、重复和 malformed IDs 拒绝。
51. **packaging architecture**：release build 在仓库外 staging，先构建 workspace，再 deploy launcher production graph，flatten 到无链接 node_modules，写 manifest/checksums，最后 tar。
52. **pnpm deploy result**：`pnpm --filter @caelush/launcher --prod deploy <dir> --legacy` 兼容性探针通过；实际产物使用 `inject-workspace-packages=true` 解决 pnpm 11 workspace link 行为。
53. **artifact structure**：`caelush-v0.1.0-windows-x64.tgz`，约 25.7 MiB、16492 archive entries，含 `bin/`、`dist/`、`node_modules/`、manifest 和 checksums。
54. **migration asset proof**：artifact 内 daemon diagnostics 报告 migration assets available，migration directories 可发现；没有依赖 checkout 的相对路径。
55. **node-pty proof**：artifact 内 `node-pty` loadable，真实 LocalRuntime PTY smoke 输出 `artifact-pty` 并成功结束。
56. **manifest**：manifest 包含 product、version、platform、arch、nodeRange、protocolVersion、createdAt；不宣称 signing。
57. **SHA256**：`checksums.sha256` 覆盖 regular artifact files，`manifest.sha256` 单独绑定 manifest；未实现 publisher signature。
58. **POSIX launcher**：`bin/caelush` 使用 artifact-relative `../dist/index.js` 的 Node 24 ESM entry；脚本内容已提供，当前 Windows host 无可用 `/bin/bash`，因此 POSIX 执行未在本机验证。
59. **Windows launcher**：`bin/caelush.cmd` 使用 artifact-relative dist entry；Windows x64 artifact smoke 通过。
60. **install.sh**：检查 Node 24、平台、manifest 和全量 checksums，安装到用户目录的 versioned bundle 与 `~/.local/bin/caelush`；不下载、不更新、不修改 system config。
61. **install.ps1**：检查 Node 24、平台、manifest 和全量 checksums，安装到 `%LOCALAPPDATA%\Caelush\versions\<version>` 与 user PATH 下的 shim；PATH 更新幂等。
62. **CI matrix**：`.github/workflows/ci.yml` 增加 release-smoke matrix，执行 frozen install、source lint/typecheck/test/build、release build、artifact test，并上传 artifact。
63. **artifact-only test isolation**：E2E 解包到系统临时目录，使用 temporary HOME/workspace/fresh SQLite；运行时不设置 `NODE_PATH`，不读取 repo dist/source/node_modules。
64. **fake HTTP Provider**：localhost fake provider 使用真实 OpenAI-compatible SSE，daemon 只通过 `CAELUSH_PROVIDER_BASE_URL` 访问；没有 providerOverrides 注入。
65. **single-command E2E**：无 daemon 时从 artifact 执行 `-p`，实际 spawn、health/info、Session、Run、Provider、Verification、COMPLETED 闭环通过，stdout 精确为 `PACKAGE_OK`、exit 0。
66. **daemon reuse E2E**：第二次 print 返回 `REUSE_OK`，artifact daemon process count 不增加。
67. **concurrent startup E2E**：两个 launcher 并发执行，共享 lease，最终只有一个 daemon，两个结果都成功。
68. **Session continue E2E**：第一轮写入 `PACKAGED-ORANGE-912`，第二个 CLI process 使用 `-c -p` 从真实 SQLite/session/history context 取回 marker。
69. **file Tool E2E**：artifact 使用 real default catalog 的 `read_file`；`apply_patch` 走真实 LocalRuntime、Security、durable approval、Verification，文件最终变更为预期内容。
70. **Approval E2E**：print 触发 protected `apply_patch`，stdout JSON 标识 WAITING_APPROVAL/exit 5；随后通过 packaged client resolution 完成同一 Run，未重复执行 Tool。interactive PTY approval 本机未作为独立 artifact scenario 运行。
71. **cancellation E2E**：Phase 12D CLI/daemon cancellation-control、client transport 和 Core cancellation 回归在完整 310-file suite 中通过；artifact 长任务 Ctrl+C 尚未在本机独立执行。
72. **detach/resume E2E**：Phase 12D detach/session recovery 回归已通过；artifact launcher detach/resume 尚未在本机独立执行。
73. **reconnect E2E**：Phase 12D SSE reconnect、last durable sequence 与 transport recovery 回归已通过；launcher 不修改该 client 语义。
74. **migration E2E**：fresh artifact HOME 启动创建 SQLite schema；artifact diagnostics proof 与重复启动 smoke 通过。
75. **node-pty E2E**：实际 artifact PTY smoke 通过。
76. **non-TTY E2E**：pipe stdin/stdout 的 bare `caelush` 精确输出通过。
77. **pipe E2E**：`-p` 无参数从 stdin 读取 `Reply exactly PIPE_OK`，stdout 精确为 `PIPE_OK`。
78. **JSON E2E**：parallel print 的 JSON 输出被独立 `JSON.parse`，且 secret sentinel 不出现。
79. **stream-json E2E**：每个 stdout line 独立 parse，存在最终 `result` record，secret audit 通过。
80. **incompatible port E2E**：43120 放置 unrelated HTTP server；launcher 返回 bootstrap failure，owner 仍可访问，无 kill/infinite loop。
81. **custom daemon E2E**：custom URL fake daemon 通过 health/info，后续假 route 失败但没有本地 spawn/lock/log。
82. **secret leakage audit**：provider secret sentinel 检查了 print text/JSON/stream、doctor、daemon log、manifest；均未发现泄漏。
83. **supported platforms**：当前实机验证为 Windows x64；四平台均已纳入 release contract 和 CI smoke matrix。
84. **unsupported/unverified platforms**：Linux x64、macOS arm64、macOS x64 尚未在本机执行；POSIX installer 语法因 WSL 环境缺少 `/bin/bash` 未能验证，PowerShell parser check 通过。
85. **architecture guards**：launcher forbidden imports、direct dependency boundary、no same-process daemon start、no Phase 13 leakage 的 tests 通过。
86. **Phase12D regressions**：完整 suite 通过，含 interactive control、approval、cancel、detach、resume、reconnect。
87. **Phase12C regressions**：timeline/process visualization tests 通过。
88. **Phase12B regressions**：CLI shell/conversation lifecycle tests 通过。
89. **Phase12A regressions**：daemon production/client transport/API/SSE tests 通过。
90. **Phase11 regressions**：verification planning/execution/repair/completion authority tests 通过。
91. **Phase10 regressions**：cancellation/deadline/retry/budget tests 通过。
92. **Phase9 regressions**：security/capability/approval/redaction tests 通过。
93. **Phase8 regressions**：filesystem/patch/shell/process/Git/runtime tests 通过。
94. **full tests**：`pnpm test`：310 test files passed，1134 tests passed，5 skipped，0 functional failures。
95. **clean build**：`pnpm build` 与 `pnpm typecheck` 均通过；`pnpm install --frozen-lockfile` 通过。
96. **format status**：本轮所有 changed code/package/script/docs target 均通过定向 Prettier；全仓库当前 780 warnings，仍是历史格式债务。
97. **pnpm check**：`pnpm check` 的 lint、typecheck、test、build 全部通过；唯一失败是最后 `prettier --check .` 的 780 warnings。
98. **commits**：实现已提交为 `7efce4d`（`feat: harden production launcher and release packaging`）；本报告作为独立文档提交，完整 SHA 以最终 `git rev-parse HEAD` 为准。
99. **push**：未 push；用户未要求远端写入，且本轮只保留本地可审计提交。
100. **local SHA**：最终 HEAD 已在交付审计中通过 `git rev-parse HEAD` 记录；由于该值包含本报告提交本身，最终值见交付消息与仓库 HEAD。
101. **remote SHA**：远端 Phase 12D SHA 为 `02c83cd65ec1c2353df41661458290977a5e88b9`；Phase 12E 未上传。
102. **clean working tree**：已实际确认 clean；release tarball 被 `.gitignore` 排除，不进入 source commit。
103. **Phase12E status**：实现、打包、Windows artifact E2E、CI/文档和回归 evidence 已完成；跨平台 hosted smoke 与 artifact interactive/cancel/detach 独立场景仍按上文标为 unverified。
104. **Phase12 overall status**：Phase 12A、12B、12C、12D、12E 均已实现；Phase 12 完成边界保持在 12E，没有新增 12E-1/12F。
105. **current production CLI capability**：`caelush` 现在提供 Node 24 产品命令、help/version、doctor、interactive daemon-backed CLI、非交互 `-p` text/JSON/stream-json、Session continue/resume、real tools/verification、approval boundary、cancellation path 和 portable artifact 安装入口。
106. **next phase**：下一阶段是 `Phase 13 — Production Web`；本轮没有实现任何 Phase 13 Web 能力。

## 通俗解释

Phase 12D 完成时，Caelush 的 Agent 内核和 CLI 能力已经具备：它能聊天、读取项目、修改文件、运行 Shell、管理进程、查看 Git、执行 Verification、自动 Repair、处理 Retry/Timeout/Budget、请求 Approval、取消 Run，并恢复 Session。

Phase 12E 做的是把这些能力装进一个真正可交付的产品外壳：用户输入 `caelush`，Launcher 会找到或启动独立 daemon；daemon 继续负责真正的 Agent 执行，CLI 只是交互宿主。需要脚本或 CI 的地方可以使用 `caelush -p`，得到干净文本或 JSON/JSONL；需要危险操作时不会偷偷批准，而是停在 durable approval boundary。最后把整个运行面复制到仓库之外的 Node 24 artifact 中，验证它仍能连接真实 HTTP Provider、运行 SQLite migrations、加载 `node-pty`、启动工具和完成 Verification。

因此这轮没有把产品“打包成一个神奇的单文件”，也没有提前进入 Web。它把发布面、进程边界、启动竞争、诊断、stdout 合约和 artifact 可运行性固定下来，下一步才是 `Phase 13 — Production Web`。

# Changelog

All notable changes to `agy-fast` are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

---

## [0.3.1] - 2026-11-24

### Added

- **Interactive release updates, version skipping, and no-git GitHub API fallback (`src/updater-core.ts`, `scripts/install.mjs`, `src/session-start.ts`, #58, thanks `@wathing-wind`)**
  - Added interactive confirmation (`update --prompt`), persistent `--skip-version <ver|none>`, compact `<=185B` `SessionStart` update notices, and hardened GitHub Releases API fallback for environments without `git` (with strict zero-tag fallback guards, safe GitHub URL sanitization, and stale-state cleanup in `doctor`).
- **Fatal signal, OOM, and Windows crash diagnostics (`src/utils/output-filter.ts`, `src/tools/run-checks.ts`, `src/tools/apply-edits.ts`, #46, thanks `@wathing-wind`)**
  - Surfaced fatal POSIX signal names (`SIGKILL - possible OOM`, `SIGSEGV - segmentation fault`, `SIGABRT - process aborted`, `SIGTERM`), portable shell `128+N` exit codes (`134`/`137`/`139`), and Windows NTSTATUS crash codes (`0xC0000005` / `0xC00000FD` / `0xC0000409`) across `run_checks` and `apply_edits` inline `verify` while keeping timeout/spawn-error precedence and `--cli` non-zero exit detection intact.
- **Expanded macOS & Node.js 20/22/24 CI coverage (`.github/workflows/ci.yml`, #37, thanks `@0x7b1e`)**
  - Added `macos-latest` and Node 20/22/24 verification jobs plus `sh -n install.sh` POSIX syntax checks to CI.

### Performance & Reliability

- **Compact MCP tool schemas `<=1280B` to prevent eager tool eviction (`src/mcp-server.ts`, #57, thanks `@kf953741`)**
  - Compacted tool descriptions and parameter schemas within tight host per-tool budgets and removed array-mode JSON-string hints so Antigravity keeps all 5 tools eagerly loaded.
- **Refuse silent `$HOME`/`/` fallback on omitted `cwd` (`src/mcp-server.ts`, #66, thanks `@OnurrUgur`)**
  - Prevented omitted `cwd` (common on Desktop 2.0 / Hub hosts when `roots/list` is unavailable) from silently scanning the user's home directory or filesystem root—including Windows `HOMEDRIVE+HOMEPATH` and MSYS2 path guards—while still allowing explicit `cwd: "~"`.
- **Fast-path `$HOME` snapshots & instant JSON stdin exit (`src/utils/snapshot.ts`, `src/session-start.ts`, `rules/AGENTS.md`, `docs/ANALYSIS_REPORT.zh-CN.md`, #62, thanks `@757530253`)**
  - Skipped depth-2 directory scans and child subproject manifest probes when `SessionStart` runs in `$HOME`, returned immediately on complete JSON stdin objects (eliminating the 1,500ms stall when a host keeps stdin open without EOF), tightened `/compact` guidance (`~100k–150k` tokens), and documented Windows cold-start behavior.
- **Updater, search, snapshot, and filesystem hardening (`src/updater-core.ts`, `src/tools/batch-search.ts`, `src/utils/snapshot.ts`, `src/utils/fs-utils.ts`, `src/utils/exec-utils.ts`, #28, thanks `@3956418278-dotcom`)**
  - Blocked `repoUrl` option injection and `release -> main` error fallback in the updater; added Node fallback buffer/file prechecks, fixed `rg` glob precedence, symlinked-workspace (`/var -> /private/var`) anchored globs, and ES2025 inline `(?-m:...)` precheck guards; halved snapshot git spawns and prevented false clean status on timeout; bound drive-less Windows paths, capped `walkFiles` FD concurrency, eliminated `globToRegExp` ReDoS, canceled POSIX `SIGKILL` timers on exit, and deduped `rg` probing.

### Fixed

- **`apply_edits` safety, fidelity, and no-op hygiene (#39, #40, #47, #51, #52, thanks `@wathing-wind`)**
  - Rejected overwriting existing binary or UTF-16 files on `create` + `overwrite: true` (peeking `>8KB` binaries without full reads).
  - Preserved UTF-8 BOM across outlines and edits and clarified UTF-16 diagnostics.
  - Preserved mixed CRLF/LF line endings byte-for-byte on untouched lines and matched local span EOL.
  - Removed orphaned newly created parent directories on atomic rollback and used short temp filenames to prevent `ENAMETOOLONG` on long CJK/UTF-8 names.
  - Skipped redundant disk writes for no-op hunks (preserving `mtime`/inode and short-circuiting hot-path mixed-EOL/UTF-8 buffer work), reported `unchanged` status, and kept byte-budget truncation footers accurate when `noOpCount > 0`.
- **CJK git filenames & mixed-encoding process output (#45, thanks `@wathing-wind`; #55, thanks `@ErrantSnow`)**
  - Passed `-c core.quotePath=false` in `snapshot.ts` and `batch_search` git queries so CJK/non-ASCII paths render cleanly without octal escapes.
  - Decoded mixed UTF-8 and legacy codepage process output line-by-line in `exec-utils.ts`.
- **`--cli` flag parsing & rules clarity (#56, thanks `@ErrantSnow`; #60, thanks `@gaofeng21cn`, Refs #59; #63, thanks `@anhnt256`, Refs #61)**
  - Supported `--flag=value`, `--pattern`, and `--type` with properly scoped positional modifiers in `--cli search`.
  - Sharpened Swarm worker & `run_checks` hygiene and documented the host-injected `toolSummary` field in `rules/AGENTS.md`.

### 简体中文摘要（v0.3.1）

- **交互式更新确认、跳过版本与无 `git` API 回退（#58，感谢 `@wathing-wind`）**：新增 `update --prompt` 交互确认、`--skip-version <ver|none>` 持久化跳过、`SessionStart` 紧凑更新提示（`≤185B`）以及无 `git` 环境的 GitHub Releases API 安全回退。
- **宿主机急加载防驱逐与 Hub 防误扫 `$HOME`（#57 感谢 `@kf953741`；#66 感谢 `@OnurrUgur`）**：将 5 个 MCP 工具 Schema 压缩至 `≤1280B` 防止宿主机预算紧时被驱逐；禁止漏传 `cwd` 时静默回落扫描 `$HOME` 或根目录（兼容 Windows `HOMEDRIVE+HOMEPATH` 且保留显式 `cwd: "~"`）。
- **`SessionStart` 冷启动与 Windows 体验优化（#62，感谢 `@757530253`）**：`$HOME` 快照跳过二级目录与子项目清单探针；收到完整 JSON stdin 后立即返回（消除宿主不关 stdin 时的 1500ms 卡顿）；收紧 `rules/AGENTS.md` 的 `/compact` 阈值与 Windows 实践说明。
- **`apply_edits` 五连加固（#39、#40、#47、#51、#52，感谢 `@wathing-wind`）**：禁止 `create+overwrite` 覆盖二进制/UTF-16 文件；全程保留 UTF-8 BOM 并优化 UTF-16 报错；保留未改动行的混合 CRLF/LF 换行符；原子回滚清理新建空目录并用短临时名避免超长中文文件名 `ENAMETOOLONG`；无变化 hunk 跳过写盘保 `mtime`/inode 且精准汇报 `written/unchanged` 截断统计。
- **搜索、编码、致命信号诊断与 CI 全面补强（#28 感谢 `@3956418278-dotcom`；#45/#46 感谢 `@wathing-wind`；#55/#56 感谢 `@ErrantSnow`；#60 感谢 `@gaofeng21cn`；#63 感谢 `@anhnt256`；#37 感谢 `@0x7b1e`）**：加固更新器与 `batch_search`（Node 预检、glob 优先级、macOS 软链工作区与 ReDoS 防护）；支持 CJK git 路径无八进制转义与混合编码逐行解码；在 `run_checks`/`apply_edits` 输出 OOM/段错误/信号名与 Windows NTSTATUS 崩溃码；修复 `--cli search` 参数解析与规则文档；CI 新增 macOS + Node 20/22/24 矩阵。

---

## [0.3.0] - 2026-11-23

### Added

- **Direct `--cli` invocation mode for Swarm workers & non-MCP environments (`src/cli-runner.ts`, #31, thanks `@wathing-wind`)**
  - Added `node dist/mcp-server.mjs --cli <search|outline|slice|edit|check>` so Antigravity Swarm workers (where MCP servers, `user_rules`, and `SessionStart` are not mounted) and shell environments can still batch searches, symbol outlines, atomic multi-hunk edits, and concurrent checks within the same `≤8.8 KB` UTF-8 budget.
  - Hardened `--cli` exit codes (failing reliably on `Checks:` failures/not-run, `Verify [FAIL|TIMEOUT|ERROR]`, and `Error:` lines), per-query search modifier scoping, `--flag=value` parsing, literal `--help` search, and `--cli` tracking in `benchmark-core.ts` (`Swarm worker coverage` + `cli:N` dispatch breakdown).
- **Prompt Cache miss attribution & sustained-collapse diagnostics (`src/benchmark-core.ts`, `rules/AGENTS.md`)**
  - Added structured `cacheMissAttribution` to `benchmark.mjs analyze` / `compare` / `--split-usage`, distinguishing true prefix misses (`activeSlowGap`, `idleOrWaitGap`, `planModeSwitch`, `errorRetry`, `asyncWakeupFast`, `modelSwitch`, `fastReplicaOrPrefixMiss`) from expected `compactionResets` and `contextDilutionTurns`, plus `>=3`-turn sustained cache collapse tracking (`sustainedCollapseRuns`, `sustainedCollapseTurns`, `maxConsecutiveMisses`).
  - Added empirically grounded edit-loop cache hygiene guidance to `rules/AGENTS.md` Rule 4 (prefer `<45s` targeted checks inside edit-verify loops; keep `<=10s` commands synchronous via `WaitMsBeforeAsync` instead of early backgrounding).
- **Persistent `--tool-loading eager|lazy` installer option (#25)**
  - Added `--tool-loading eager|lazy` in `scripts/install.mjs` (`install` / `config`) persisted in `~/.gemini/cache/agy-fast/config.json` and preserved across auto-updates for hosts or setups that need lazy loading.
- **Multi-branch CI & automated GitHub Release workflow (`.github/workflows/ci.yml`, `.github/workflows/release.yml`, `CONTRIBUTING.md`)**
  - Added cross-platform CI (`verify (ubuntu-latest)`, `verify (windows-latest)`, `stress`), `dev` + `main` branching guide, PR template, and automated `v*` tag release publishing verified against `origin/main`, `package.json`, `plugin.json`, `dist/`, and `CHANGELOG.md`.

### Security & Reliability

- **Trusted `hooks.json` path precedence & isolated `GEMINI_HOME` support (#30, thanks `@ErrantSnow`)**
  - Reordered `hooks.json` plugin resolution to check `PLUGIN_ROOT` → `AGY_PLUGIN_ROOT` → `$GEMINI_HOME/config/plugins/agy-fast` → `~/.gemini/config/plugins/agy-fast` before workspace-local `.agents/plugins/agy-fast` / `.`, preventing untrusted workspaces from hijacking `SessionStart`.
- **POSIX piped installer isolation (#36, thanks `@0x7b1e`)**
  - Prevented `curl ... | sh` from inferring or executing a workspace-local decoy `scripts/install.mjs` in CWD, verifying `plugin.json` identity (`name === "agy-fast"`) before local execution and handling root-level `/install.sh` safely.
- **MCP NDJSON `64 MiB` frame size cap (#42, thanks `@wathing-wind`)**
  - Enforced a `64 MiB` frame cap on NDJSON stdio framing matching `Content-Length` mode, returning `-32600`, releasing large buffers, and discarding oversized lines with `O(chunk)` memory without corrupting subsequent frames.
- **Block accidental writes inside `.git` internal metadata (#41, thanks `@wathing-wind`)**
  - Refused `apply_edits` writes targeting `.git` directories, worktree/submodule `.git` files, symlinks resolving into `.git`, Windows NTFS ADS suffixes (`:stream`) / trailing dots-spaces, and case-insensitive `.GIT` paths across all platforms (including WSL), while keeping `.gitignore`/`.github`/`.gitattributes` unaffected.
- **Non-interactive Git credential guards (#44, thanks `@wathing-wind`)**
  - Injected default `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` (preserving caller overrides, including case-insensitive Windows keys) across `runShellCommandAsync`, `batch_search` git queries, `SessionStart` snapshots, and `updater-core.ts` remote `git ls-remote`/`clone`/`fetch` calls.

### Fixed

- **Issue #27 verified bottlenecks (`batch_search`, `apply_edits`, `run_checks`, `benchmark`)**
  - Eliminated `batch_search` file starvation under tight budgets and centered match windowing on long lines past column 240; improved `apply_edits` drifted-range hints and failure-first `bestEffort` reporting; fixed `benchmark-core.ts` out-of-order parallel tool-result pairing and spill/truncation/parallel-leak false positives.
- **`apply_edits` mismatch & verify diagnostics (#32, thanks `@wathing-wind`)**
  - Upgraded `findClosestRegionSnippet` with anchor-aligned high-entropy line scoring (including trailing anchors on `>10`-line hunks), preserved head+tail output on `Verify [FAIL]` by compacting long `Applied:` lists, water-filled multi-file validation errors, pre-validated `verify.cwd` before writing files, and surfaced `Verify [ERROR]` spawn failures consistently.
- **`output-filter` VT100 & mid-suite failure hygiene (#31, thanks `@wathing-wind`)**
  - Stripped VT100 line-erase spinner sequences (`\x1b[2K`/`\x1b[K`) and preserved mid-suite failures when folding verbose passing test lines.
- **Node 20 & Windows CI determinism**
  - Replaced multi-hop async init queuing in `src/protocol/mcp.ts` with a synchronous `postInitOutgoingQueue`, eliminated premature Node 20 timer `.unref()` exits in `snapshot.ts` and `cli-runner.ts`, and fixed Windows `AppData` tmpdir test matching.
- **Docs**: Documented `agy --dangerously-skip-permissions` unattended CLI flag in `README.md` and `README.zh-CN.md`.

### 简体中文摘要（v0.3.0）

- **新增 `--cli` 直调模式，打通 Swarm Worker 与非 MCP 环境（#31，感谢 `@wathing-wind`）**：支持通过 `node dist/mcp-server.mjs --cli <search|outline|slice|edit|check>` 在无 MCP 挂载的 Swarm Worker 中批量搜索、提大纲、原子多块编辑与并发校验（同样死守 `≤8.8 KB` 预算），并加固退出码、参数作用域与基准覆盖率统计。
- **新增 Prompt Cache 失效归因与持续暴跌诊断，补齐编辑循环护缓存规则**：`benchmark.mjs` 新增 `cacheMissAttribution`（精准拆解 `active>=60s` / `idle>=60s` / `plan_mode` / `errorRetry` / `async<60s` / `modelSwitch` / 副本漂移，并单独剥离压缩与大读取稀释，识别连续 `>=3` 轮持续暴跌）；`rules/AGENTS.md` Rule 4 补齐编辑循环快检（`<45s`）与短命令同步等待纪律。
- **安装器支持持久化 `--tool-loading eager|lazy`（#25）**：可在安装或配置时切换急/懒加载并跨自动更新持久化保留。
- **5 项安全与稳定性加固**：
  - `hooks.json` 优先可信插件目录并支持隔离 `GEMINI_HOME`，防止不可信工作区劫持 `SessionStart`（#30，感谢 `@ErrantSnow`）；
  - `install.sh` 禁止 `curl | sh` 管道安装回退执行当前目录伪造安装器，并校验 `plugin.json` 身份（#36，感谢 `@0x7b1e`）；
  - MCP NDJSON 帧强制 `64 MiB` 上限防 OOM 并支持溢出后安全恢复（#42，感谢 `@wathing-wind`）；
  - `apply_edits` 拦截对 `.git` 内部目录/worktree 文件/软链/Windows NTFS ADS 与跨平台大小写变体的误写，不误伤 `.gitignore`/`.github`（#41，感谢 `@wathing-wind`）；
  - 全链路（含 `updater-core.ts` 远程 `git` 操作）默认注入 `GIT_TERMINAL_PROMPT=0` 与 `GCM_INTERACTIVE=never` 防止凭据弹窗卡死（#44，感谢 `@wathing-wind`）。
- **核心工具体验修复与 CI/CD 基建（#27、#31、#32）**：解决 `batch_search` 紧预算饿死与长行 240 列截断；升级 `apply_edits` 锚点对齐错因提示、失败 `verify` 首尾保真与多文件水填充；优化 VT100 进度条清理与测试日志折叠；修复 Node 20 与 Windows 边界问题，并上线 Linux/Windows/压测 CI 与 `v*` tag 自动发版流水线。

---

## [0.2.10] - 2026-11-22

### Fixed

- **Prevent silent `PLUGIN_ROOT` fallback when `cwd` is omitted without MCP `roots/list` (#22, thanks `@GoodCoder666`)**
  - On hosts such as **Antigravity Desktop 2.0 Hub** (`--standalone --subclient_type hub`) where the MCP server starts in `~/.gemini/config/plugins/agy-fast` and the client reports no (or empty) MCP `roots/list`, omitting `cwd` or passing a relative `cwd` previously fell back to `process.cwd()` inside the plugin directory.
  - `src/mcp-server.ts` now detects when `process.cwd()` resides inside the installed plugin directory (via `PLUGIN_ROOT`/`AGY_PLUGIN_ROOT`, standard `.gemini/.../plugins/*` / `.agents/plugins/*` paths, or runtime-only plugin installs) and immediately fails fast with an actionable `isError: true` message instructing the caller to pass the active workspace root in `cwd`, while keeping explicit `cwd`, valid MCP `roots/list`, and local dev checkouts unaffected.
  - Reinforced explicit `cwd` guidance across all 5 MCP tool schemas and `rules/AGENTS.md` Rule 6, with end-to-end regression tests in `test/mcp-protocol.test.ts`.

### Changed

- **Faster default background update check interval (`12 h` → `4 h`)**
  - Lowered `DEFAULT_CHECK_INTERVAL_HOURS` from `12` to `4` (keeping the detached `0 ms` startup design, 5-minute concurrent debounce, `git ls-remote` priority, and `AGY_FAST_UPDATE_INTERVAL_HOURS` / `config --interval` overrides) so active users receive hotfixes within half a day instead of waiting overnight.
- **HOL Registry verified badge & Dependabot hygiene (#24)**
  - Moved the HOL Registry verified badge into the hero badge strip across both `README.md` and `README.zh-CN.md` using the live `metric=score` endpoint, and configured `.github/dependabot.yml` to skip pre-1.0 `esbuild` minor jumps.

### 简体中文摘要（v0.2.10）

- **根治 Antigravity Desktop 2.0 Hub 漏传 `cwd` 静默回退到插件目录的问题（#22，感谢 `@GoodCoder666`）**：当宿主未通过 MCP `roots/list` 上报工作区（或返回空 `roots: []`）且 MCP 服务进程位于已安装插件目录内时，若工具调用省略 `cwd` 或传入相对路径，现立即 Fail-Fast 报错提示补传当前工作区根目录，彻底避免误搜或误改 `~/.gemini/config/plugins/agy-fast`；显式绝对路径 `cwd`、正常回报 `roots/list` 的宿主与本地开发态均零影响。
- **后台自动更新默认检查周期由 `12 小时` 调整为 `4 小时`**：在保持 0ms 启动阻塞、5 分钟防抖与优先 `git ls-remote` 不占 GitHub API 限额的前提下，让高频迭代期的热修半天内即可无感触达（仍支持 `--interval` / `AGY_FAST_UPDATE_INTERVAL_HOURS` 自定义）。
- **HOL Registry 认证徽章对齐与 Dependabot 降噪（#24）**：将 HOL 官方认证徽章统一移至中英文 README 顶部徽章栏并修复可用端点，同时优化 `.github/dependabot.yml` 过滤规则。

---

## [0.2.9] - 2026-11-22

### Added & Improved

- **Water-filling fair token budgets, unified HTML/Vue/Svelte outliner & proactive build-log folding (#14, co-authored with `@BLACK-BIRTHDAY`)**
  - Introduced exact water-filling budget allocation (`computeWaterFillBudgets`) across `output-filter`, `run_checks` (`compact` and `full`), and `read_slices`/`quick_outline`, so short error outputs and compact files keep their full context while oversized outputs share the remaining inline budget fairly under the hard `≤8.8 KB` UTF-8 cap.
  - Added a unified HTML/Vue/Svelte closed-range tag-stack outliner (supporting `<template>`, `<script>`, `<style>`, landmarks, `id`/attributes, multiline tags, and comment/script/style skipping) plus breadth-first top-level-first symbol water-filling in `read_slices` / `quick_outline` so large multi-file batches preserve every file's top-level map instead of starving later files.
  - Added proactive green build-log folding (e.g. `tsc`, `vite`, `webpack`, `esbuild`, `cargo`, `go build`, `pytest`) and tightened benign zero-count diagnostic lines (`0 errors`, `0 warnings`, `0 failed`) in `run_checks`.
- **`quick_outline`, Head-Tail command folding, user-owned `AGENTS.local.md`, snapshot guards & Windows PowerShell unwrapping (#16, thanks `@757530253`)**
  - Added eager `quick_outline({ paths })` flat-schema tool alongside `read_slices` to eliminate multi-level nesting friction when mapping unknown large files.
  - Upgraded `run_checks` failure truncation to UTF-8/surrogate-safe header-aware Head-Tail folding so both initial setup errors and trailing stack traces/summaries stay visible.
  - Preserved user-owned `rules/*.local.md` files (with `trigger: always_on` frontmatter diagnostics in `doctor` and `.gitignore` exclusion) across installs and auto-updates.
  - Hardened `SessionStart` snapshot scanning with a 2-tier system/home-directory skip list, `250 ms` scan circuit-breaker, and explicit stdout-flushed exit (`writeAndExit`), plus Windows `powershell -Command` allowlisted unwrapping.
- **`read_slices` flat `lineRanges` shorthand (#17, thanks `@757530253`)**
  - Added flat `lineRanges: ["path:start-end,start2-end2"]` parameter (and runtime string shorthand support in `slices`, including Windows drive-letter paths) while keeping Gemini/Antigravity eager schemas free of `oneOf`.
- **Visual demos, security policy & MCP directory compliance**
  - Added EN/ZH Before-vs-After demo GIFs and Social Preview card in `assets/`, embedded Glama & GitHub Stars badges in READMEs, and added `SECURITY.md`, `.github/dependabot.yml`, `glama.json`, and a minimal non-root `Dockerfile` for Glama container introspection.

### Fixed

- **Windows `SessionStart` hook path mismatch across real workspaces (#17, thanks `@757530253`)**
  - Replaced the CWD-dependent `node dist/session-start.mjs` command in `hooks.json` with a zero-metacharacter cross-platform `node -e` loader that resolves `PLUGIN_ROOT` → `AGY_PLUGIN_ROOT` → `.` → `.agents/plugins/agy-fast` → `~/.gemini/config/plugins/agy-fast` via `pathToFileURL`, fixing `Cannot find module '<WORKSPACE_ROOT>\dist\session-start.mjs'` on Windows CLI builds where `cmd /c` starts in the project workspace.
- **Lazy on-demand MCP `roots/list` handshake isolation (#17, thanks `@757530253`)**
  - Stopped emitting server-initiated `roots/list` requests inside `notifications/initialized`; `initialize → notifications/initialized → tools/list` is now 100% unidirectional, and `roots/list` is requested lazily (bounded at `1000 ms`, skipped entirely when an explicit absolute `cwd` is passed) only on the first `tools/call` that needs a workspace root.
- **Clean Windows MCP process teardown (`0xc000013a`) (#17, thanks `@757530253`)**
  - Handled Windows `SIGBREAK` (`CTRL_BREAK_EVENT`), added `stdin` `close` teardown alongside `end`/`error`, and added a `150 ms` `.unref()` exit failsafe around `stdout.end()` so broken Windows pipes cannot stall shutdown and trigger forced termination (`STATUS_CONTROL_C_EXIT`).
- **Git `textconv` bypass, symlinked-`HOME` installer guard & Windows `taskkill` crash (#12)**
  - Blocked `git status -v`/`--verbose` and `-u`/`--untracked-files` textconv/output bypasses, protected symlinked `HOME` directories during install/uninstall staging, and prevented Windows `taskkill` spawn crashes on missing binaries.

### 简体中文摘要（v0.2.9）

- **公平注水预算、统一 HTML/Vue/Svelte 大纲与绿色构建日志折叠（#14，联合贡献 `@BLACK-BIRTHDAY`）**：在 `output-filter`、`run_checks` 与 `read_slices`/`quick_outline` 引入精确注水算法（Water-filling）公平分配 `≤8.8 KB` 预算；新增支持闭合行号的 HTML/Vue/Svelte 统一标签栈大纲与广度优先顶层符号打包；自动折叠 `tsc`/`vite`/`cargo`/`pytest` 等冗长绿色构建日志。
- **`quick_outline`、Head-Tail 首尾折叠、本地规则持久化与快照熔断（#16，感谢 `@757530253`）**：新增单参数急加载工具 `quick_outline({ paths })`；升级失败命令输出为 UTF-8 安全的首尾折叠；更新/重装自动保留 `rules/*.local.md`；为 `SessionStart` 补齐系统/家目录双层跳过清单与 `250 ms` 扫描熔断；支持 Windows `powershell -Command` 白名单解包。
- **彻底修复 Windows 真实工程下的 4 项实测问题（#17，感谢 `@757530253`）**：
  - `hooks.json` 改用零 Shell 元字符的跨平台 `node -e` 启动器按优先级自动定位 `PLUGIN_ROOT` / 项目插件 / 全局插件并通过 `pathToFileURL` 加载，根治 Windows 下 `cmd /c` 工作目录落到业务工程导致 `Cannot find module` 崩溃；
  - 将 MCP `roots/list` 改为首次需要默认 `cwd` 的 `tools/call` 时按需懒加载（超时 1s，显式绝对路径 `cwd` 直接跳过），保证启动握手 `initialize → initialized → tools/list` 100% 单向纯净不卡连接；
  - 补齐 Windows `SIGBREAK` 信号捕获、`stdin` `close` 监听与 `stdout.end` 150ms 强退兜底，消除退出时的 `0xc000013a` 异常；
  - 为 `read_slices` 新增扁平字符串简写参数 `lineRanges`（如 `"src/server.ts:1-50,120-160"`，兼容 Windows 盘符路径）。
- **安全加固、实测对比动图与 MCP 目录合规（#12）**：封堵 `git status -v` 旁路、修复软链 `HOME` 安装保护与 Windows `taskkill` 异常；新增中英文 Before/After 对比动图、Glama 徽章、`SECURITY.md`、`glama.json` 与最小非 root `Dockerfile`。

---

## [0.2.8] - 2026-11-22

### Added & Improved

- **Eager MCP tool loading in `mcp_config.json` (#13, thanks `@kf953741`)**
  - Enabled Antigravity's official per-tool `"eager": true` loading setting in `mcp_config.json` for all 4 tools (`batch_search`, `apply_edits`, `read_slices`, `run_checks`), registering typed native tool declarations (`mcp_agy-fast_fast_*`) upfront (~7.2 KB / ~1.9K cached input tokens total).
  - Bypasses untyped lazy `call_mcp_tool` completely across both **Antigravity Desktop 2.0** and **Antigravity CLI ≥1.5.8**, eliminating nested-array serialization corruption (`edits: []` / `[null]` / `[-1]` / `[true]`) at the root cause while preserving token-saving native array `edits` (~3× fewer output tokens than double-escaped JSON strings).
  - Updated `rules/AGENTS.md` Rule 1 & Rule 6 to invoke `mcp_agy-fast_fast_*` directly when eagerly loaded while keeping the direct lazy `call_mcp_tool` + quick-schema fallback intact for older hosts, and verified `"eager": true` persistence in `test/installer.test.ts`.
- **Host compatibility controller alignment for eager CLI ≥1.5.8 (`src/utils/host-compat.ts`)**
  - Capped the default `agy-cli-1.5-call-mcp-tool-empty-edits` rule at `maxVersionExclusive: "1.5.8"` so eager-capable Antigravity CLI `≥1.5.8` (including `1.5.12–1.5.14`), Desktop 2.0, IDE, and third-party hosts uniformly receive the typed native `array` `apply_edits` schema and `0` extra `SessionStart` bytes—preventing any split-brain mismatch between eager typed declarations and `SessionStart` hints.
  - Preserved automatic JSON-string fallback for pre-eager CLI `1.5.0–1.5.7`, explicit `AGY_FAST_EDITS_FORMAT` / `config.json` overrides, dual-format runtime acceptance, and corrupted-argument circuit-breakers.

### 简体中文摘要（v0.2.8）

- **启用官方 `"eager": true` 急加载彻底根治 `call_mcp_tool` 参数损坏（#13，感谢 `@kf953741`）**：在 `mcp_config.json` 为 4 个工具启用官方 `"eager": true` 急加载，直接注册强类型原生声明 `mcp_agy-fast_fast_*`（总 Schema 仅 ~7.2 KB / ~1.9K 可缓存输入 tokens），在 **Antigravity 桌面端 2.0** 与 **CLI ≥1.5.8** 上彻底绕过无类型 `call_mcp_tool`，从根因消除 `edits: []`/`[null]`/`[-1]`/`[true]` 嵌套参数损坏并保留省 3× 输出 token 的原生数组传参；同时更新 `rules/AGENTS.md` 优先急加载直调并保留老宿主懒加载回退。
- **宿主兼容控制器与急加载边界对齐（`src/utils/host-compat.ts`）**：为 `agy-cli-1.5-call-mcp-tool-empty-edits` 补齐 `maxVersionExclusive: "1.5.8"`，使支持急加载的 CLI ≥1.5.8、桌面端 2.0、IDE 与第三方客户端统一走强类型原生数组且 `SessionStart` 保持 0 额外字节（避免急加载 Schema 与启动提示脑裂），同时保留旧版懒加载 CLI `1.5.0–1.5.7` 的自动保护与 `AGY_FAST_EDITS_FORMAT` / `config.json` 覆盖。

---

## [0.2.7] - 2026-11-21

### Added & Improved

- **Antigravity host surface & version compatibility controller (#10, building on `@fwyc0573`)**
  - Added a declarative host compatibility controller (`src/utils/host-compat.ts`) that detects Antigravity **CLI**, **Desktop 2.0**, **IDE**, and third-party MCP hosts via MCP `initialize` `clientInfo`, `SessionStart` `.gemini/antigravity*` paths, and `ANTIGRAVITY_LS_VERSION` (supporting 4-part builds and SemVer 2.0 prerelease precedence with strict cross-surface and third-party client isolation).
  - Defaults to **token-saving native `array` edits** (~2.6x–3.3x fewer output tokens, 0 extra `SessionStart` bytes) on Desktop 2.0, IDE, third-party MCP hosts, and unaffected CLI versions; automatically activates JSON array string `apply_edits` schemas and a compact 1-line `[agy-fast compat]` SessionStart directive on affected Antigravity CLI 1.5.x builds to prevent lazy `call_mcp_tool` `edits: []` payload drops (server runtime always accepts both formats).
  - Added explicit overrides via `AGY_FAST_EDITS_FORMAT=auto|array|string`, `AGY_FAST_HOST`, and `scripts/install.mjs config/install --edits-format`, plus live `Host compat` diagnostics in `scripts/install.mjs doctor`.
- **Workspace root as default `cwd` & MCP `roots/list` hardening (#9, thanks `@fwyc0573`)**
  - Queries MCP `roots/list` after `notifications/initialized` and `notifications/roots/list_changed`, resolving omitted and relative tool `cwd` values against the first valid workspace root without mutating global `process.cwd()`.
  - Hardened `src/protocol/mcp.ts` with bounded wait timeouts, stdin EOF/error unblocking, monotonic sequence deduplication, a 64-entry `knownRootsIds` cap, per-dispatch outgoing queues that flush before `waitForRoots()` to avoid batch self-deadlocks, mixed `\n\r\n` `Content-Length` framing, and graceful `stdout` `EPIPE` handling.
- **170 s shared `run_checks` & `apply_edits` verify call budget (#9, thanks `@fwyc0573`)**
  - Caps `run_checks` and `apply_edits` `verify` timeouts at `170 s` (under Antigravity's `180 s` MCP call ceiling) and shares a monotonic `performance.now()` call budget across all commands in a `run_checks` batch, reporting skipped commands cleanly as `[NOT RUN]`.
  - Rejects boolean/non-numeric timeout coercion and validates non-string `commands[i].cwd`.
- **Windows selective PowerShell routing & console codepage decoding (#1, thanks `@BLACK-BIRTHDAY`)**
  - Automatically routes Windows commands containing PowerShell syntax (`$env:`, cmdlets, `$x = ...`, `$(...)`, `@(...)`) through `pwsh` -> `powershell.exe` -> `cmd.exe` (caching resolved executable paths) with UTF-8 output encoding, while keeping plain cross-platform commands on `cmd.exe`.
  - Decodes non-UTF-8 Windows console output (CP936/GBK, CP950/Big5, CP932/Shift_JIS, CP949/EUC-KR, CP1250–1258, CP850/CP437) cleanly without mojibake or mid-sequence UTF-8 corruption.

### Fixed

- **`apply_edits` empty-array & malformed-JSON argument handling (#10, thanks `@fwyc0573`)**
  - Treats `edits: []` / `"[]"` and stringified `"true"`/`"false"`/`"null"` literals as `call_mcp_tool` serialization corruption (displaying decoded types and triggering immediate fallback to parallel `edit_file`/`write_file`), reports precise `JSON.parse` / non-array diagnostics for malformed `edits` strings, and counts `edits: []` in `benchmark` corrupted-argument metrics.
- **Deterministic `batch_search` truncation & `rg`/Node parity (#9, thanks `@fwyc0573`)**
  - Uses a 2-pass `--count` -> `--json` flow for directory `rg` searches so `maxResults` truncation always keeps the first matches in deterministic path order; adds unconditional `--no-config` and `--crlf`, guards bare `-` filenames, enforces 2 MB / binary / `glob` checks on single-file targets, keeps truncated `contextLines` without line-number gaps, tolerates transient Pass-2 ENOENT when stderr is empty, and aligns negated `!glob` in Node fallback.
- **Python symbol outline accuracy & syntax recovery (#9, thanks `@fwyc0573`)**
  - Fixes Python decorator/body ranges across triple-quoted strings, multiline calls/signatures, backslash continuations inside quoted strings, Python 3.12+ PEP 701 f-strings (same-quote reuse, multiline expressions, format specs), and mid-edit unclosed bracket recovery.

### 简体中文摘要（v0.2.7）

- **Antigravity 宿主端与版本检查控制器（#10，基于 `@fwyc0573` 贡献扩展）**：新增 `src/utils/host-compat.ts` 识别 CLI / 桌面端 2.0 / IDE / 第三方客户端及版本（支持 4 段版本号、SemVer 2.0 预发布比较与跨端/第三方严格隔离）；默认采用省 token 的原生数组参数（桌面端/IDE/其他客户端 0 额外 `SessionStart` 字节），仅在受影响的 Antigravity CLI 1.5.x 自动切换 `apply_edits.edits` 为 JSON 数组字符串以规避 `call_mcp_tool` `[]` 丢参；支持 `AGY_FAST_EDITS_FORMAT`、`AGY_FAST_HOST`、`install.mjs config/install --edits-format` 覆盖与 `doctor` 实时诊断。
- **工作区默认 `cwd` 与 MCP `roots/list` 协议加固（#9，感谢 `@fwyc0573`）**：通过 `roots/list` 自动将省略/相对 `cwd` 解析至工作区根目录（不修改全局 `process.cwd()`），补齐超时/EOF/乱序防死锁、`knownRootsIds` 上限、批处理队列防自死锁、混合 `\n\r\n` 分帧与 `EPIPE` 优雅退出。
- **`run_checks` / `apply_edits` 170s 共享调用预算（#9）**：适配 Antigravity 180s MCP 超时上限，采用单调时钟 `performance.now()` 共享预算并明确标记 `[NOT RUN]`；拦截布尔/非数值超时强转与非字符串 `commands[i].cwd`。
- **Windows 选择性 PowerShell 路由与多代码页解码（#1，感谢 `@BLACK-BIRTHDAY`）**：仅对含 PowerShell 语法的命令按 `pwsh -> powershell.exe -> cmd.exe` 路由并强制 UTF-8 输出，同时无乱码解码 GBK/CP936、Big5、Shift_JIS、EUC-KR 及 CP1250–1258 等控制台编码。
- **`apply_edits` 空数组熔断、稳定 `batch_search` 截断与 Python 大纲加固（#9, #10）**：将 `edits: []`/`"[]"` 与 `"true"`/`"false"`/`"null"` 纳入参数丢失熔断并精确报告非法 JSON；`batch_search` 采用路径有序 2-pass 截断并补齐 `--no-config`/`--crlf`/单文件过滤/中途删文件容错与 `!glob` 一致性；Python 大纲支持字符串内 `\` 续行、PEP 701 f-string 与未闭合括号恢复。

---

## [0.2.6] - 2026-11-21

### Security & Runtime Hardening (#7, thanks `@hzhe0083-source`)

- **Untrusted `.git/config` & read-only Git sandbox hardening (`src/tools/batch-search.ts`, `src/utils/snapshot.ts`)**
  - Neutralizes untrusted repository config execution across both `batch_search` and `SessionStart` snapshots via `-c core.fsmonitor=false -c diff.external= -c gpg.program=false -c gpg.openpgp.program=false -c gpg.ssh.program=false -c gpg.x509.program=false`, prepends `--no-ext-diff --no-textconv` for `diff`/`log`/`show`/`shortlog` and `--no-textconv` for `blame`, and blocks `--ext`/`--ext-*`/`--textc*` abbreviations.
  - Restores read-only `git branch`/`tag` commit-filter flags (`--merged`, `--no-merged`, `--contains`, `--no-contains`, `--points-at`, and `tag -n`) while rejecting dash-prefixed tokens (including `--`) immediately after commit-filter flags to prevent option-parser desync bypasses, and keeps `tag -v`/`--verify` disabled.
  - Injects `-n` on `git remote show` (avoiding network calls while leaving a remote named `show` unaffected in `remote get-url show`), rejects URL/path targets, and defaults `git shortlog` to `HEAD` under ignored stdin.
- **MCP framing, `SessionStart` lifecycle & UTF-8 / UTF-16 surrogate safety (`src/protocol/mcp.ts`, `src/session-start.ts`, `src/utils/snapshot.ts`, `src/utils/output-filter.ts`)**
  - Selects the earlier of `\r\n\r\n` and `\n\n` in `Content-Length` framing, strictly validates anchored `Content-Length` headers with `latin1` decoding and a 64 MiB frame cap, rejects empty `{}` requests with `-32600`, and normalizes stringified JSON object `params.arguments` while rejecting non-object values with `-32602`.
  - Bounds `SessionStart` stdin reading to 256 KB, detaches listeners with `pause()` + `unref()` (retaining a no-op `error` handler for fail-open exit when hosts omit EOF), enforces a strict 1,500 UTF-8 byte ceiling across `snapshot + updateNotice`, and adds surrogate-safe slicing (`sliceSafeChars`) plus `Number.isFinite` guards on byte-budget helpers.
- **`apply_edits`, EOL detection & auto-updater reliability (`src/tools/apply-edits.ts`, `src/utils/fs-utils.ts`, `src/utils/updater-core.ts`, `scripts/install.mjs`)**
  - Protects dangling symlinks on `create` (`overwrite: false` rejects; `overwrite: true` restores on Phase-2 rollback and unlinks before rename-fallback writes), canonicalizes parent directory `realpath` for new-file dedup, validates `verify` before Phase-2 disk writes, and uses majority EOL detection in `readTextFile`.
  - Fixes `main`-channel downgrade/redundant-overwrite guards, writes `plugin.json` last in atomic swaps with `finally` temp cleanup, fetches `git-clone` updates from the verified local staging directory (eliminating remote TOCTOU), keeps `dev-source` notify-only even with `--force`, and immediately reclaims stale locks held by dead PIDs (`ESRCH`).

### Added & Improved

- **Auto-sync global installs to T3 Code ACP & isolated `GEMINI_HOME` profiles (#7, thanks `@hzhe0083-source`)**
  - `scripts/install.mjs` (`install` / `update` / `doctor` / `uninstall`) automatically discovers and symlinks (with copy fallback) isolated `~/.t3/userdata/providers/antigravity/*/` and `GEMINI_HOME` profiles while preserving profile `config.json` and enforcing target ownership checks (opt out via `--no-acp`).
- **Search, multi-language outliners & multi-surface benchmark accuracy (`src/tools/batch-search.ts`, `src/tools/read-slices.ts`, `src/benchmark.ts`, `src/benchmark-core.ts`)**
  - Fixes single-file `maxResults` truncation reporting, multi-file `contextLines` preservation, Node fallback multi-batch continuation when an earlier file hits `perFileCap`, and phantom EOF `^$` matches.
  - Improves TSX/TS (JSX `</Tag>` & scoped self-closing `/>` without breaking `>`-prefixed regex literals like `/>/g`, multiline template literals), Python (multiline signatures & `.pyi`), Rust (lifetimes, `impl<T>`, trait bounds, block comments), Go (raw backtick strings ending in `\`, wrapped `interface{}` params, generic structs), and Shell (`${#var}`) outlining.
  - Expands `benchmark analyze --local` to discover Antigravity Desktop 2.0, CLI, IDE, T3 Code ACP, `GEMINI_HOME`, and `ANTIGRAVITY_APP_DATA_DIR` brains; fixes middle-truncated JSON commands, direct MCP corrupted-arg detection, distinct `call_mcp_tool` chains, and `--since` coordinator/worker/snapshot identity preservation.
- **Redesigned geometric logo & dual-theme SVG architecture diagrams (#6, thanks `@GoodCoder666`)**
  - Replaced the icon with a flat two-tone geometric "A" mark (`assets/logo.svg`, `assets/logo-light.svg`, `assets/logo-dark.svg`) with automatic GitHub light/dark theme switching, and replaced README Mermaid diagrams with crisp custom light/dark English & Chinese SVG architecture diagrams (`assets/architecture-*.svg`).

### 简体中文摘要（v0.2.6）

- **不可信 `.git/config` 与只读 Git 沙箱全面加固（#7，感谢 `@hzhe0083-source`）**：为 `batch_search` 与 `SessionStart` 快照统一注入 `-c core.fsmonitor=false -c diff.external= -c gpg*.program=false`，为 `diff`/`log`/`show`/`shortlog` 补齐 `--no-ext-diff --no-textconv`；恢复 `branch`/`tag` 的 `--merged`/`--contains`/`--points-at` 等过滤参数并封堵紧跟 `--` 的选项解析脱同步绕过；保持禁用 `tag -v`/`--verify`；`remote show` 自动注入 `-n` 并拒绝 URL/路径，`shortlog` 无修订时默认 `HEAD`。
- **全局安装自动同步 T3 Code ACP 与隔离 `GEMINI_HOME` 配置（#7）**：`install`/`update`/`doctor`/`uninstall` 自动发现并同步 `~/.t3/userdata/providers/antigravity/*/` 与 `GEMINI_HOME` 隔离配置（支持 `--no-acp` 关闭，保持原有归属校验且不触碰 `config.json`）。
- **MCP 协议、SessionStart 与 UTF-8/代理对安全（#7）**：修复 `Content-Length` 混合换行分帧、严格行锚定与 64 MiB 帧上限、空请求 `-32600` 及字符串化对象参数解析；`SessionStart` 限制 256 KB stdin、无 EOF 时优雅释放且保留静默错误监听、严格保证 `snapshot + updateNotice <= 1500` UTF-8 字节且零孤立 UTF-16 代理对。
- **`apply_edits`、自动更新器、搜索/大纲与基准分析全面修复（#7）**：悬空符号链接保护与回滚、多数行尾判定、防 `main` 通道降级、`plugin.json` 末位原子替换、本地 staging 防 TOCTOU、死 PID 锁回收；修复 Node 回退多批次早停、TSX/TS/Python/Rust/Go/Shell 大纲（并避免影响 `/>/g` 等正则字面量）及 `--local` 多端会话发现与 `--since` 身份保持。
- **全新几何 Logo 与双主题 SVG 架构图（#6，感谢 `@GoodCoder666`）**：更新扁平双色几何 "A" Logo（支持 GitHub 明暗主题自动切换），并将中英文 README 的 Mermaid 架构图升级为定制明暗双主题 SVG 图。

---

## [0.2.5] - 2026-11-21

### Security & Fixed

- **Read-only `git branch` / `git tag` optional-value flag sandbox bypass (#5, thanks `@ErrantSnow`)**
  - Separated optional-value flags (`--merged`, `--no-merged`, `--abbrev`, `--color`, `--column`) from value-consuming flags in `src/tools/batch-search.ts` so they accept `=`-attached values without setting `expectValue = true` to skip allowlist validation on the following space-separated token (blocking bypasses like `branch --color -D --column target`, `branch --color -m main hacked`, `branch --abbrev new-branch`, and `tag --color -d --column v0.2.2`).
  - Removed `--abbrev`, `--color`, and `--column` from `GIT_BRANCH_VALUE_FLAGS` in `src/benchmark-core.ts`.
- **Installer source-repo protection & `--target` ownership verification (#5, thanks `@ErrantSnow`)**
  - Resolves `fs.realpath` with case folding on `win32`/`darwin` in `scripts/install.mjs` to prevent same-repo deletion across symlinked paths or case variants.
  - Blocks deleting `REPO_ROOT` or any strict ancestor directory of `REPO_ROOT`.
  - Requires non-empty, non-symlink target directories to contain `plugin.json` with `"name": "agy-fast"` before deletion, and unlinks symlinks/junctions (including broken links) directly without touching link targets.
- **`apply_edits` Phase-2 fallback truncation & `create` rollback safety (#5, thanks `@ErrantSnow`)**
  - Isolates temp-file `writeFile`/`chmod` failures in `src/tools/apply-edits.ts` (cleans up the temp file and rethrows without falling back to `O_TRUNC` direct writes on the target).
  - Records the file in `written` before the rename-fallback direct write so mid-write failures roll back original content/permissions or remove a newly created file.
  - Treats only `ENOENT` as missing in Phase-1 `create`, failing fast on `EACCES`/`EBUSY`/`ENOTDIR` instead of misclassifying an existing file as non-existent.

### 简体中文摘要（v0.2.5）

- **封堵只读 `git branch`/`tag` 沙箱绕过（#5，感谢 `@ErrantSnow`）**：将 `--merged`/`--no-merged`/`--abbrev`/`--color`/`--column` 拆入可选值白名单，不再误消费下一个空格参数，彻底拦截 `branch --color -D ...`、`branch --color -m ...`、`tag --color -d ...` 等绕过，并同步修正 `benchmark-core.ts`。
- **安装器防误删源仓库与 `--target` 归属校验（#5）**：改用 `fs.realpath` 与 `win32`/`darwin` 大小写归一化对比；拦截对源仓库及任意祖先目录的删除；非空非软链目录删除前强制校验 `plugin.json` 归属为 `agy-fast`；软链/Windows junction/死链直接 `fs.unlink` 不触碰目标。
- **修复 `apply_edits` 写盘截断与 `create` 回滚误删（#5）**：隔离临时文件写/`chmod` 失败与 `rename` 回退路径，避免 `ENOSPC`/`EIO` 误触发直写截断原文件；回退直写前先加入回滚队列；Phase-1 `create` 仅将 `ENOENT` 视作文件不存在，遇 `EACCES`/`EBUSY` 快速失败，防止回滚误删已有文件。

---

## [0.2.4] - 2026-11-21

### Fixed

- **Circuit-breaker for corrupted `call_mcp_tool` nested arguments across all 4 MCP tools (`src/utils/arg-validation.ts`, `apply_edits`, `batch_search`, `read_slices`, `run_checks`)**
  - Detects when Antigravity's untyped `call_mcp_tool` argument parser collapses nested edit/query/slice/command objects into booleans or `null` (e.g., `edits: [true]`, `[false, true]`, `[null]`, or `hunks: [true]`).
  - Immediately returns a clear circuit-breaker error identifying the corrupted element type and instructing the caller **not** to retry the same payload and to fall back to parallel built-in tools—preventing multi-minute retry loops observed in live sessions.
  - Eliminates uncaught `TypeError` crashes when `null`/primitive elements enter `queries`, `outlines`, or `hunks`, and seamlessly accepts stringified JSON array arguments.
- **Read-only `git` shell chaining guard (`src/tools/batch-search.ts`)**
  - Rejects standalone shell chaining operators (`&&`, `||`, `;`, `|`) inside `batch_search` `git` queries with a clear hint to split chained commands into separate queries rather than passing them to `git` as pathspecs.

### Improved

- **High-scale search & fuzzy-path performance (`src/utils/fuzzy-match.ts`, `src/utils/fs-utils.ts`, `src/tools/batch-search.ts`)**
  - Added a zero-allocation ASCII fast path in `subsequenceCost` (replacing per-character `.flatMap` array allocations), switched hot-path filename sorting from ICU `localeCompare` to deterministic code-unit ordering, and replaced regex `matchAll` parsing of `rg --count`/`--files-with-matches` output with a direct `\0` index scan.
- **Rules & benchmark diagnostics (`rules/AGENTS.md`, `src/benchmark-core.ts`)**
  - Broadened Rule 3 to cover **all images** (`.png`/`.jpg`/`.webp`, including UI screenshots and business/debug captures) in `>150k`-token sessions to prevent prompt-cache invalidation spikes.
  - Added corrupted-argument fallback guidance to Rule 5 and refined Rule 6 swarm worker briefing (compound read-only exploration + parallel ranged `read_file` when MCP/snapshots are absent).
  - Added `agyCorruptedArgCalls`, `agyCorruptedArgWastedSec`, `agyCorruptedArgWastedOutTokens`, and `swarmWorkerSessions` metrics to `dist/benchmark.mjs`.
- **12-scenario multi-dimensional stress benchmark (`scripts/stress-benchmark.mjs`, `npm run bench:stress`)**
  - Exercises compiled `dist/mcp-server.mjs` and `dist/session-start.mjs` end-to-end across 3,000–6,000 file monorepos, `rg` + pure-Node fallback, 5×5,000-line / 40-file outlines + ReDoS resilience, 50-file atomic/Phase-2 disk rollback/`bestEffort`/2 MB noisy `verify`, 12-way `run_checks` + 5 MB log flood + grandchild process-tree kill, 400-request soak under a strict 128 MB V8 heap cap, 20-payload read-only git red-team checks, all 14 outline formats + 4-byte emoji truncation safety, and optional live real-repo benchmarking.

### Documentation

- **Reorganized English and Simplified Chinese READMEs (#4, thanks `@GoodCoder666`)**
  - Added top status badges, KPI summary table, bottleneck breakdown, hybrid execution Mermaid architecture diagram, collapsible install/example/env sections, expanded AI-search-friendly FAQ, and Star History chart across [README.md](README.md) and [README.zh-CN.md](README.zh-CN.md).

### 简体中文摘要（v0.2.4）

- **全 4 工具接入 `call_mcp_tool` 嵌套参数序列化损坏熔断与容错**：精准识别 `edits: [true]` / `[false, true]` / `[null]` 等底层序列化损坏，直接返回明确熔断提示引导立即回退并行原生工具（杜绝实测中反复重试白耗十余分钟的问题），同时修补 `queries`/`outlines`/`hunks` 收到 `null`/原始值可能抛 `TypeError` 的隐患，并兼容 JSON 字符串化数组参数。
- **大规模搜索性能优化与只读 Git 链式拦截**：为 `fuzzy-match` 新增零分配 ASCII 快速路径、热路径排序移除昂贵的 ICU `localeCompare`、`rg` 汇总输出改为直接 `\0` 索引扫描，并在只读 `git` 校验中拦截独立 `&&`/`||`/`;`/`|` 链式符。
- **规则与基准测试升级**：Rule 3 扩展至任意图片（避免 >150k 长对话缓存清零）、Rule 5 补入损坏参数熔断、Rule 6 优化 Swarm Worker 协作提示；`benchmark` 新增参数损坏耗时与 Swarm Worker 覆盖率指标；仓库新增 12 场景全链路压测套件（`npm run bench:stress`）。
- **README 全面改版（#4，感谢 `@GoodCoder666`）**：中英文 README 新增徽章、核心指标速览表、混合架构 Mermaid 图、折叠式示例与更完整的常见问题 FAQ。

---

## [0.2.3] - 2026-11-20

### Added

- **Godot GDScript (`.gd`) symbol outlining in `read_slices` (#2, thanks `@star-dino`)**
  - Extracts `class_name`, nested inner `class` (with accurate `depth`), `func` / `static func`, single- and multiline `signal`, and named/anonymous single- and multiline `enum` blocks.
  - Handles Godot 4 annotations (`@tool`, `@rpc(...)`, `@abstract`, etc.), multiline typed signatures, `#`/`##` comments, `"""`/`'''` triple-quoted strings, Tab/space indentation, and UTF-8 BOM / CRLF line endings.
- **Extended `batch_search` modes, language filtering, multiline matching, fuzzy path lookup & mtime sorting (#3, thanks `@onezero-harmony`)**
  - Added `outputMode` (`"content"` | `"files_with_matches"` | `"count"`) to return only matching file paths or per-file match counts within the 8.8 KB inline budget.
  - Added `fileType` language/extension filtering (e.g., `typescript`, `ts`, `python`, `gdscript`) across `text`, `regex`, and `fuzzy` queries.
  - Added `multiline: true` cross-line `text`/`regex` matching across both `rg` and Node.js fallback (with automatic retry without strict `u` mode for ripgrep-valid identity escapes like `\:` / `\#`).
  - Added `type: "fuzzy"` case-insensitive multi-token path lookup (`src/utils/fuzzy-match.ts`) with Windows backslash normalization and contiguous-substring-first ranking.
  - Added `sortBy: "mtime"` for `glob` queries to list recently modified files first.

### Documentation

- Added sanitized 10-day real-world latency, token-quota, and upload-bandwidth benchmarks, an explicit non-invasive UI/diff guarantee, and a concise FAQ to [README.md](README.md) and [README.zh-CN.md](README.zh-CN.md).

### 简体中文摘要（v0.2.3）

- **`read_slices` 新增 Godot GDScript（`.gd`）大纲提取（#2，感谢 `@star-dino`）**：完整支持 `class_name`、嵌套内部 `class`、`func`/`static func`、单行/多行 `signal` 与具名/匿名 `enum`，兼容 Godot 4 行内注解、三引号字符串、Tab/空格缩进及 BOM/CRLF。
- **`batch_search` 新增多模式检索、语言过滤、跨行匹配、模糊路径与按修改时间排序（#3，感谢 `@onezero-harmony`）**：支持 `outputMode`（`content`/`files_with_matches`/`count`）、`fileType`、`multiline: true`（`rg` 与 Node 双路径一致，且兼容 `\:`/`\#` 等转义）、`type: "fuzzy"`（兼容 Windows 反斜杠与连续子串优先排序）以及 `glob` 的 `sortBy: "mtime"` 最新优先排序。
- **文档增强**：中英文 README 新增 10 天脱敏实测数据（耗时、额度、上传流量）、无侵入声明（不影响原生 Diff 窗口与文件修改列表）及常见问题 FAQ。

---

## [0.2.2] - 2026-11-20

### Improved

- **Smart fallback & hints for `batch_search` `glob` queries (`src/tools/batch-search.ts`)**
  - Preserves exact glob matching first; only when exact matching returns 0 files, automatically recovers two common LLM mistakes observed in live transcripts:
    - Regex alternation passed to `glob` (e.g., `test|smoke|live`) is auto-expanded with a concise inline note (or returns a syntax hint when still empty).
    - Bare keywords without wildcards, slashes, or extension dots (e.g., `proxy`) fall back to case-insensitive path substring matching (`*proxy*`) while keeping missing explicit filenames (e.g., `missing.ts`) cleanly as `(no files matched)`.
- **Higher-density large outline batches (`src/tools/read-slices.ts`)**
  - Tuned `perFileSymbolLimit` for larger batches (`11–20` files: `16` symbols; `>20` files: `10` depth-0-prioritized symbols) and shortened per-file omission footers (`... (+N more symbols)`) so 30–40 file calls spend less of the 8.8 KB cap on truncation boilerplate.
  - Appends a 1-line batching tip when outlining `>20` files exceeds the 8.8 KB inline budget, steering callers toward 10–20 files per batch.
- **Swarm worker & schema guidance (`rules/AGENTS.md`, `src/mcp-server.ts`)**
  - Added concise guidance in Rule 6 to remind swarm workers in their brief to batch searches/edits via `agy-fast_fast` (if available) or parallel ranged `read_file` instead of serial `ls`/`grep` shell calls, since swarm workers do not receive the `SessionStart` snapshot.
  - Clarified `batch_search` glob syntax (`*`/`{a,b}`, not regex `|`) and recommended `read_slices` outline batch sizes (`10–20` files, max 40) in both `AGENTS.md` and MCP tool schemas.

### 简体中文摘要（v0.2.2）

- **`batch_search` 的 `glob` 智能容错与提示**：精确匹配优先不变；仅在精确命中为 0 时，自动恢复实测对话中常见的两类误传——正则交替符 `|`（如 `test|smoke|live`）与无通配符/扩展名的裸关键词（如 `proxy`），并在输出头部附带简短语法提示，同时保持明确缺失文件名（如 `missing.ts`）的原样空结果。
- **`read_slices` 大批量大纲预算优化**：收紧 `11–20` 文件（16 符号）与 `>20` 文件（10 顶层优先符号）的单文件上限并精简省略提示，减少 8.8 KB 上限内被截断尾注吃掉的字节；一次请求 `>20` 文件超预算时尾部提示改用 10–20 文件分批。
- **Swarm Worker 路由与 Schema 补充**：在 `rules/AGENTS.md` 补充协调者拉起 swarm worker 时在 `brief` 中提示使用 `agy-fast_fast` 或并行带行号 `read_file`（避免因缺少 `SessionStart` 快照而退化为串行 `ls`/`grep`），并在规则与 MCP Schema 同步注明 `glob` 语法及大纲推荐批量。

---

## [0.2.1] - 2026-11-19

### Added

- **Zero-latency background auto-update (`dist/updater.mjs` + `SessionStart`)**
  - Checks for newer stable release tags every **12 hours** via a detached, unref'd background process after `SessionStart` emits its workspace snapshot (**0 ms** added to session startup).
  - Uses `git ls-remote --tags --refs` (avoiding GitHub REST API rate limits and respecting native git/system proxy settings) with automatic fallback to the GitHub Releases API.
  - Stages downloads in an isolated temp directory, validates all runtime files and runs a **live MCP 4-tool handshake smoke test** before atomically replacing live files (`tmp -> rename`); broken staged releases are rejected without touching the existing install.
  - Protects `--link` dev symlinks, local source directories, and dirty git clones from overwriting (notify-only), while auto-updating standard copied installs and clean direct `git clone` installs safely.
  - Concurrency lock (`~/.gemini/cache/agy-fast/update.lock` with 10-minute stale recovery) prevents duplicate parallel updates across subagents; surfaces a one-time notice in the next `SessionStart` snapshot.
- **Manual `update` & `config` CLI subcommands (`scripts/install.mjs`, `install.sh`, `install.ps1`)**
  - Added `update [--check] [--force] [--channel release|main] [--repo <url>]` and `config --auto-update auto|notify|off --interval <hours> --channel release|main --repo <url>`.
  - Added environment variable overrides (`AGY_FAST_AUTO_UPDATE`, `AGY_FAST_UPDATE_INTERVAL_HOURS`, `AGY_FAST_UPDATE_CHANNEL`, `AGY_FAST_REPO`) and `npm run update:plugin`.
  - Updated `doctor` to display installed version, auto-update mode/interval/channel, and last check status (with background checks disabled during `doctor` smoke tests).

### 简体中文摘要（v0.2.1）

- **零启动延迟的后台自动更新（`dist/updater.mjs` + `SessionStart`）**：每 12 小时在 `SessionStart` 输出快照后异步拉起完全分离的后台更新进程，**0 ms 启动阻塞**；支持并发锁防重入，并在下一次新会话展示一次性更新提示。
- **先暂存冒烟校验、再原子替换**：优先走 `git ls-remote --tags`（规避 GitHub API 限流并原生走系统/git 代理），暂存目录先做全运行文件与实时 MCP 4 工具握手校验，通过后再按文件原子替换；损坏版本自动拦截。
- **安全保护与可控配置**：常规复制安装与干净 `git clone` 自动更新，`--link` 软链接与脏仓库仅提示不覆盖；新增 `update [--check]` 与 `config --auto-update auto|notify|off` 子命令（兼容 `install.sh` / `install.ps1`）及环境变量覆盖，`doctor` 同步展示版本号与自动更新状态。

---

## [0.2.0] - 2026-11-19

Production-hardening release driven by real-world Antigravity CLI & Desktop 2.0 transcript telemetry.

### Added

- **Vue/Svelte SFC, CSS/SCSS, Fastify/Express route & test-suite outlining (`read_slices`)**
  - Extracts `<script>`, `<template>` (handling nested `<template #slot>` + semantic/Modal landmarks), and `<style>` block boundaries for `.vue`/`.svelte` files.
  - Extracts `:root`, `[data-theme]`, `@layer`/`@media`/`@keyframes`/`@container`/`@supports`, section comments, and top-level rule groups for `.css`/`.scss`/`.less` files.
  - Detects `app/router/server/fastify.(get|post|put|patch|delete|all|route)` handlers inside large setup functions and `describe`/`it`/`test` blocks in test suites.
  - Raised `outlines` batch cap from `20` to `40` files with depth-0-first multi-file fairness so a single large class never crowds out other files in the batch.
- **`apply_edits` partial-commit mode (`bestEffort`), fuzzy recovery & line-drift hints**
  - Added `bestEffort: true` so valid files in a multi-file batch commit atomically per file even when another file fails validation, preventing redundant full-batch regeneration.
  - Added closest-region snippet hints (`findClosestRegionSnippet`), bounded wide-range failure snippets (`<= 26` lines), and whole-file exact-match detection when `startLine`/`endLine` has drifted.
- **`batch_search` glob truncation directory summary**
  - Deterministic sorted glob results with an `omitted dirs:` per-directory breakdown when matches exceed `maxResults`.
- **Inlined MCP tool schemas & multimodal/long-context TTFT hygiene in `rules/AGENTS.md`**
  - Inlined compact tool schemas directly in `AGENTS.md` to eliminate the lazy-load schema-read turn (`mcp/agy-fast_fast/*.json`).
  - Added empirical routing & TTFT hygiene rules: outline via `read_slices({ outlines })` then read known ranges via parallel built-in `read_file(StartLine, EndLine)` (~7 ms, 46 KB/call inline, 0 remote check); keep screenshots/images in dedicated subagents returning text-only findings to avoid the 3–7× multimodal TTFT cliff (>180k context); pack `>=2` independent non-interactive shell commands into `run_checks` (`compact` for build/test, `full` for diagnostic scripts).
- **Enhanced `benchmark` CLI & health diagnostics**
  - Added `--since <ISO>`, `--until <ISO>`, and `--split-usage` flags plus tracking for lazy-loaded `call_mcp_tool` invocations and async idle waits.
  - Added health & multimodal metrics: `mcpSpillCalls` (`output.txt` spills), `agyTruncatedCalls`, `agyErrorCalls`, `multiMcpTurns`, `multiRunCommandTurns`, `mediaLoadedCount`, and `multimodalHighCtxTurns` (>=180k context with media loaded).
- **Multi-module `SessionStart` snapshots & update guide**
  - Auto-detects multi-module subproject manifests (`pom.xml`, `web/package.json`, `desktop/package.json`, monorepo subpackages) alongside root manifests.
  - Added dedicated update instructions in [README.md](README.md) and [README.zh-CN.md](README.zh-CN.md).

### Changed

- **Hard `<= 8,800 B` UTF-8 inline cap across all 4 MCP tools**
  - Enforced strict UTF-8 byte-budgeted water-filling (`<= 8,800 B`) unconditionally in `read_slices`, `batch_search`, `run_checks`, and `apply_edits` (even when callers explicitly pass a larger `maxChars`/`maxVerifyChars`), eliminating Antigravity's ~10 KB MCP `output.txt` spill-to-disk extra turns.
  - Appends a concise 1-line hint when `read_slices` slices are truncated to steer bulk range reads back to parallel built-in `read_file`.
- **Smarter `verify` / `run_checks` failure filtering**
  - Strips Pino/Bunyan info/debug JSON request logs (`level: 10/20/30`), Maven `[Help 1]` boilerplate footers, and Node `ExperimentalWarning` noise before budgeting failure output.
  - Expands context windows around Spring Boot `Description:` / `Action:`, Java `Caused by:`, compilation errors, and Vitest failure summaries so root causes are preserved.
- **Budgeted `SessionStart` snapshots**
  - Allocates fixed per-section budgets (`Project` → `Git` → `Layout`) so dirty repos with 100+ modified files never truncate scripts or directory layout.
  - Collapses noisy directories (`tmp/`, `output/`, `artifacts/`, `SSL/`, `logs/`) and prioritizes source/test directories (`src/`, `tests/`, `scripts/`) while filtering build/report artifacts (`dist-*`, `playwright-report/`) in 2nd-level trees.

### Fixed

- **TS/JS outliner (`findBraceBlockEnd`)**: Fixed no-semicolon (`semi: false`) single-line `type` aliases swallowing the following `interface` block, fixed inline object types inside parameter parentheses prematurely closing function end lines, and raised multiline signature lookahead from 15 to 40 lines.
- **Windows PowerShell 5.1 installer (`install.ps1`)**: Avoided single-string splatting and unexpected terminal exit when executed via `irm ... | iex`.

### 简体中文摘要（v0.2.0）

- **全工具硬封顶 `<= 8.8 KB` UTF-8 内联输出**：彻底杜绝显式大 `maxChars` 触发 Antigravity MCP 10 KB 落盘 `output.txt` 导致的额外轮次损耗，并在 `read_slices` 切片截断时提示改用并行内置 `read_file`。
- **大纲提取器全面升级**：新增 `.vue`/`.svelte`（`<script>`/`<template>`/`<style>`）、`.css`/`.scss`（`:root`/`[data-theme]`/`@media`/`@keyframes`/分区注释）、Fastify/Express 路由与 `describe`/`it` 测试提取；修复无分号 TS `type` 吞并、参数对象类型提前截断与长多行函数签名 Bug；`outlines` 上限提至 40 文件并按顶层结构公平分配。
- **`apply_edits` 容错与 `verify` 过滤增强**：支持 `bestEffort` 部分落盘、行号漂移精确命中提示、有界宽窗口提示；`verify` 失败过滤剔除 Pino info JSON 与 Maven 尾注，保留 Spring Boot `Description:` 与 Java `Caused by:` 根因。
- **路由规则与 TTFT 卫生规范**：内联 MCP Schema 免去懒加载读 Schema 轮次；明确 `read_slices` 探大纲 + 并行 `read_file` 读正文；扩展 `run_checks` 至多条诊断命令（`outputMode: "full"`）；明确多模态截图隔离给子 Agent、长会话分阶段 `/compact` 以避免 40–97s TTFT 悬崖。
- **快照、搜索与基准完善**：多模块子项目快照与二级目录源码置顶；`glob` 截断按目录汇总；`benchmark` 支持 `--since`/`--until`/`--split-usage` 及落盘/截断/报错/并发泄漏/多模态高危轮次指标；修复 Windows PowerShell 5.1 `install.ps1` 兼容性。

---

## [0.1.0] - 2026-11-19

### Added

- Initial release of `agy-fast`: zero-dependency single-file ESM local Stdio MCP server (`batch_search`, `apply_edits`, `read_slices`, `run_checks`), `SessionStart` workspace snapshot hook, `AGENTS.md` routing rules, cross-platform installers (`install.sh`, `install.ps1`, `scripts/install.mjs`), transcript benchmark CLI, and sanitized latency analysis reports (EN / ZH-CN).

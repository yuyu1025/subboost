# Antigravity Task Latency Analysis and Optimization Report (Sanitized)

> **Sanitization Notice**: This report summarizes quantitative measurements from anonymized real-world development sessions. All personal paths, usernames, private repository names, source code snippets, and raw log excerpts have been removed. Only aggregate statistics, latency distributions, and reproducible methodology are included.

## 1. Objective and Dataset

In real engineering tasks, a multi-turn coding session often takes several minutes even when raw model generation speed exceeds 250 tokens per second (TPS). To identify where wall-clock time is actually spent—and design optimizations that strictly follow Antigravity's usage policy—we analyzed anonymized execution transcripts and millisecond-resolution runtime event logs.

### 1.1 Sample Scope

| Data Source | Sample Size | Measured Signals |
| :--- | :--- | :--- |
| Session transcripts (`transcript.jsonl`) | **55 real sessions**, **8,446 LLM turns**, **17,302 tool calls**, **103 complete multi-turn tasks** | Active task duration, turn counts, tool batch sizes, effective throughput, and prompt cache hit rates |
| Untruncated transcripts (`transcript_full.jsonl`) | **38 complete sessions** (with a 25-session deep subset) | Time breakdown by operation type, tool output volume in bytes, duplicate reads, tool failure rates, and shell command categories |
| Millisecond runtime event logs | **100 main-model HTTP requests**, **129 remote safety evaluations**, **397 local safety checks**, **73 consecutive file-edit intervals** | Network RTT, Time to First Token (TTFT), per-tool remote check latency, and local disk edit latency |
| Local runtime cold-start benchmarks | **10 runs** each across 5 runtimes (macOS Apple Silicon) | Cold-start latency for `rg`, `sh`, `zsh`, `python3`, and `node` |

- **Total active time**: 239,461 seconds (66.52 hours), excluding user input pauses.
- **Single-agent active time**: **198,902 seconds (55.25 hours)** after excluding human-confirmation and multi-agent wait steps (`ask_question`, `swarm_wait`, `schedule`, `manage_subagents`).
- **Task baseline (103 multi-turn tasks)**:
  - Median: **19 LLM turns** / **40 tool calls** / **8.9 minutes**
  - Mean: **39.4 LLM turns** / **79.2 tool calls** / **17.6 minutes**
  - P90: **124 LLM turns** / **230 tool calls** / **53.2 minutes**

---

## 2. End-to-End Latency Breakdown

### 2.1 Single-Agent Active Time Components (198,902 s)

| Component | Estimated Time (s) | Share | Measurement Basis |
| :--- | ---: | ---: | :--- |
| Main-model Time to First Token (fixed per-turn TTFT) | 49,883 – 64,593 | **25.1% – 32.5%** | 8,218 turns × measured P50 `6.07s` / mean `7.86s` |
| Model reasoning and token decoding | 84,509 – 99,219 | **42.5% – 49.9%** | 10,874,534 total output tokens |
| Multi-tool stream buffer wait | 19,475 | **9.8%** | Delay between first and last tool creation within the same turn |
| Tool stage: remote safety evaluation (serial) | ~12,001 | **6.0%** (**39.6%** of tool stage) | ~7,454 triggered calls × mean `1.61s` |
| Tool stage: local disk, build, test, and external execution | ~18,324 | **9.2%** (**60.4%** of tool stage) | Actual execution work |
| **Total (single-agent active time)** | **198,902** | **100.0%** | **54.7 tok/s single-agent active (45.4 tok/s across 239,461 s total active time)** |

### 2.2 Time by Operation Category (38 Complete Sessions)

| Category | Turns | Tool Calls | LLM Time (s) | Stream Wait (s) | Tool Exec (s) | Total (s) | Share (excl. orchestration) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| File edits and writes (`code_edit`) | 740 | 2,744 | 16,071 | 10,253 | 6,221 | 32,545 | **30.2%** |
| Read-only file inspection (`read_only`) | 1,816 | 3,848 | 24,103 | 1,011 | 1,395 | 26,509 | **24.6%** |
| Build, test, and ops commands (`shell_build_ops`) | 736 | 1,135 | 9,041 | 906 | 5,352 | 15,299 | **14.2%** |
| Shell-based search and read-only checks (`search_explore`) | 644 | 1,154 | 11,900 | 748 | 1,672 | 14,320 | **13.3%** |
| Final text responses (`final_text`) | 288 | 0 | 12,045 | 0 | 77 | 12,122 | **11.2%** |
| Planning and user questions (`planning_ux`) | 38 | 38 | 2,701 | 597 | 111 | 3,409 | **3.2%** |
| Browser actions (`browser`) | 135 | 135 | 1,473 | 46 | 566 | 2,085 | **1.9%** |
| Other (`other`) | 109 | 202 | 1,337 | 90 | 168 | 1,595 | **1.5%** |

Three categories—**file editing (30.2%), file reading (24.6%), and shell search (13.3%)**—account for **68.1%** of single-agent active time.

---

## 3. Six Root Causes Identified

### Finding 1: Fixed ~6–8 s Per-Turn TTFT Floor Dilutes Short Turns

Grouping all 8,446 LLM turns by `output_tokens` shows strong length sensitivity:

| Output Token Bucket | Turns (Share) | Mean Output (tok) | Median Turn Time (s) | Mean Turn Time (s) | Effective TPS |
| :--- | ---: | ---: | ---: | ---: | ---: |
| `0 - 100` | 788 (9.3%) | 76 | 8.0 | 16.8 | **4.5** |
| `100 - 300` | 2,747 (32.5%) | 189 | 8.0 | 13.0 | **14.5** |
| `300 - 700` | 2,214 (26.2%) | 452 | 9.0 | 12.2 | **37.0** |
| `700 - 1500` | 1,078 (12.8%) | 1,017 | 13.0 | 18.0 | **56.6** |
| `1500 - 4000` | 940 (11.1%) | 2,469 | 17.0 | 25.2 | **97.9** |
| `4000+` | 679 (8.0%) | 8,185 | 38.0 | 52.7 | **155.2** |

From millisecond event logs:
- Lightweight auxiliary requests to the same API domain receive HTTP headers in **0.90 s (P50)**, confirming base network RTT is under 1 s.
- Main-model TTFT from tool completion to HTTP response headers is **6.07 s (P50)** and **7.86 s (mean)** (P90 **14.67 s**), whereas subsequent streaming until the first tool starts takes only **1.61 s (P50)**.
- **68.1%** of all turns emit fewer than 700 output tokens. On a median turn, roughly **79%** of LLM-stage time is spent waiting for the first byte.

**Implication**: Reducing total round-trip turns produces much larger wall-clock gains than faster token decoding alone.

### Finding 2: Serial Tool Execution Plus Per-Call Remote Safety Evaluation

Before running a tool, Antigravity performs a local rule check (10–80 microseconds). Calls not covered by the local allowlist block synchronously for a remote lightweight safety evaluation:

- Out of 231 logged tool invocations, **53.2% (123)** triggered remote evaluation: **100%** of `edit_file` calls and **92.9%** of `run_command` calls. Built-in `read_file` matches the local allowlist with zero remote check latency (consecutive reads take **6.69 ms P50**).
- Each remote evaluation blocks for **1.57 s (P50)** / **1.61 s (mean)** / **1.97 s (P90)** and uploads **26–47 KB** of formatted trajectory context. In contrast, the actual local disk modification of `edit_file` takes **43.47 ms (P50)**.
- Overlap analysis across 137 evaluation timestamps confirms **max concurrency = 1 (0 overlaps)**: multiple tool calls emitted in the same turn are evaluated and executed strictly sequentially.

Measured tool-stage execution time (P50) scales linearly with batch size:

| Calls in One Turn | `read_file` (s) | `edit_file` (s) | `write_file` (s) |
| :---: | :---: | :---: | :---: |
| 2 | 0.0 | **4.0** | **4.0** |
| 3 | 0.0 | **6.0** | **7.0** |
| 4 | 0.0 | **7.0** | **8.5** |
| 5 | 0.0 | **9.0** | **10.0** |
| 6+ | 0.0 | **14.0** (mean 18.2) | **9.0** |

### Finding 3: Full-Turn Stream Buffering Before First Tool Execution

When a model emits multiple tool calls in a single turn, execution does not begin until all tool call arguments finish streaming.

- Across 55 sessions, this wait totals **19,475 seconds (9.8% of single-agent active time)**.
- Within `code_edit`, stream buffering accounts for **31.5%** of category time. For turns with 6+ `edit_file` calls, median stream wait is **17.0 s**, followed by **14.0 s** of serial execution.

### Finding 4: Fine-Grained Tool Interfaces Multiply Turns and Calls

1. **Consecutive single-tool chains**: **51.7% – 53.9%** of tool turns invoke only 1 tool. Across 38 complete sessions, back-to-back single-tool turns for `read_file` (368 extra turns) and `run_command` (271 extra turns) added **639 mergeable turns**.
2. **Single-block `edit_file` fragmentation**: Out of 2,463 `edit_file` calls, **1,293 (52.5%)** were extra split edits targeting the same file in the same turn. In the 25-session subset, **42.1%** of edited files required 3 or more separate calls. The failure rate of `edit_file` was only **1.0%**, confirming the overhead comes from splitting rather than retry failures.
3. **Read-only search routed through `run_command`**: Out of 1,629 `run_command` calls, **42.2% (688)** were read-only search/inspect commands (`rg`, `grep`, `find`, `ls`, `sed`) and **4.1% (67)** were read-only `git` commands (`status`, `diff`, `log`, `show`)—**46.3%** combined. Local `rg` cold start is **2.1 ms**, yet each shell invocation took **2.0 s P50 (2.6 s mean)**.
4. **Cold-start exploration**: The first 3 turns of each session averaged **49.2 s**, mostly listing directories, checking `git status`, and reading project scripts.

### Finding 5: Full-File Reads Inflate Context and Increase TTFT

Total tool output appended to conversation history across 38 complete sessions (**55.67 MB** total):

| Tool | Returned Bytes | Share | Calls | Mean per Call | Calls >= 10 KB |
| :--- | ---: | ---: | ---: | ---: | ---: |
| `read_file` | **45.60 MB** | **81.9%** | 4,838 | 9,425 B | **1,568 (31.41 MB)** |
| `run_command` | 6.01 MB | 10.8% | 1,629 | 3,691 B | 237 (2.45 MB) |
| `webview_browser` | 1.72 MB | 3.1% | 135 | 12,755 B | 72 (1.29 MB) |
| All other tools | 2.34 MB | 4.2% | — | — | — |

- In the 25-session subset, **1,383 duplicate reads** of previously read files occurred (including **438** sequential chunked re-reads triggered by 800-line / 45 KB truncation).
- **69.4%** of turns operated above 150k context tokens (**37.5%** above 300k). Looking only at short turns (<300 output tokens), median latency rises from **7.0 s (mean 7.2 s)** at 0–30k context to **9.0 s (mean 13.2–14.1 s)** above 150k.

### Finding 6: Long Tool Gaps Trigger Prompt Cache Misses

Across 5,024 adjacent turn transitions with valid elapsed-time deltas (from 5,067 transitions with prior context >25k tokens, excluding explicit context compaction), sharp prompt cache hit drops (>50% drop, 252 events) correlate strongly with inter-turn elapsed time:

| Inter-Turn Gap | Cache Misses / Transitions | Miss Rate |
| :--- | ---: | ---: |
| `< 60 s` | 62 / 4,468 | **1.4%** |
| `60 - 180 s` | 60 / 377 | **15.9%** |
| `180 - 300 s` | 15 / 43 | **34.9%** |
| `300 - 600 s` | 24 / 39 | **61.5%** |
| `>= 600 s` | 91 / 97 | **93.8%** |

On short turns (<500 output tokens), a cache miss adds **+3.0 s** to median latency (10.0 s vs. 7.0 s). Long serial tool phases push inter-turn gaps past 60 s, compounding into higher next-turn prefill latency.

---

## 4. Policy Boundaries and `agy-fast` Architecture

### 4.1 Policy Compliance

`agy-fast` strictly respects Antigravity's official usage policies and plugin specification:
- Does **not** bypass, disable, or intercept any built-in safety monitor.
- Does **not** patch client binaries or application packages.
- Uses only standard documented extension interfaces: `plugin.json`, `mcp_config.json` (local Stdio MCP server), `hooks.json` (`SessionStart` only), and `rules/AGENTS.md`.

### 4.2 Mapping Problems to Solutions

| Finding | `agy-fast` Solution | Implementation Summary |
| :--- | :--- | :--- |
| Finding 4: 46.3% of shell calls are read-only searches and git checks | **`batch_search` (MCP tool 1)** | Runs up to 20 mixed `text`, `regex`, `glob`, and read-only `git` queries concurrently in one call. Uses `rg` (2.1 ms cold start) with automatic pure-Node.js fallback, strict read-only git allowlist/flag validation, and total output budgets. |
| Findings 2, 3, 4: 52.5% of `edit_file` calls are same-file splits; edit and verify take separate turns | **`apply_edits` (MCP tool 2)** | Applies multiple non-contiguous edits across multiple files atomically (validates every file and edit in memory before touching disk; preserves CRLF, file permissions, and symlinks; supports line-range narrowing and optional inline `verify` command). |
| Finding 5: `read_file` accounts for 81.9% of returned context bytes | **`read_slices` (MCP tool 3)** | Extracts multi-language symbol outlines (with line spans) and batch-reads exact line ranges across multiple files in one call under a strict character budget. Keeps built-in `read_file` for 1–4 small files (<300 lines) where the local allowlist is already ~7 ms. |
| Findings 2, 4, 6: Sequential check commands and verbose pass logs | **`run_checks` (MCP tool 4)** | Executes multiple build/typecheck/lint/test commands concurrently with bounded concurrency, timeouts, ANSI stripping, 1-line pass summaries, and filtered error extraction on failure. |
| Finding 4: 49.2 s average cold-start exploration in turns 1–3 | **`SessionStart` snapshot hook** | Runs once at session start (~35–50 ms) to inject a <=1.5 KB repository snapshot (git branch, uncommitted changes, last 3 commits, 2-level layout, detected project scripts). Positioned at session start so prompt caching reuses it on every turn. Zero per-tool hooks (`PreToolUse`/`PostToolUse`). |
| Findings 1, 4: Excess turns and lazy-loaded MCP schema-read overhead | **4 combined tools + inline schemas in `rules/AGENTS.md`** | Limits MCP registration to 4 compact tools (`agy-fast_fast`) and inlines their concise parameter signatures in `rules/AGENTS.md` (~2.2 KB) so the agent invokes `call_mcp_tool` directly without spending a turn reading `<tool>.json` files. |

### 4.3 Runtime and Distribution Design

Built with **TypeScript (strict mode)** and bundled via **`esbuild`** into standalone, zero-dependency ESM modules targeting **Node.js >= 20**:
- **Zero `node_modules` at install time**: Pre-built `dist/*.mjs` bundles work immediately after clone or one-command install across macOS, Linux, and Windows.
- **Persistent local Stdio server**: Started once per session with sub-millisecond JSON-RPC IPC.
- **Readable and auditable**: Unminified bundles and full TypeScript source in one repository.

---

## 5. Expected Impact and Reproducible Benchmarking

Relative to the 55-session single-agent baseline (mean 39.4 turns / 79.2 tool calls / 17.6 min):

| Metric | Baseline | Target Direction with `agy-fast` |
| :--- | :--- | :--- |
| First-3-turn cold-start exploration | 49.2 s mean | **-40% to -65%** via `SessionStart` snapshot |
| Edit-stage tool calls | 3.71 calls/turn (52.5% same-file splits) | **-60% to -75%** via `apply_edits` + inline `verify` |
| Read-only search shell calls | 46.3% of `run_command` | **-65% to -80%** via `batch_search` |
| Total LLM turns per task | 39.4 mean (19 median) | **-35% to -50%** via batching + routing rules |
| Inter-turn gaps > 60 s | 11.1% (556 / 5,024 transitions) | Reduced by eliminating long serial tool waits |

### Reproduce on Your Own Transcripts

`agy-fast` ships an offline benchmark CLI (`dist/benchmark.mjs`) that reads local Antigravity `transcript.jsonl` / `transcript_full.jsonl` files without sending any data externally:

```bash
# Measure your baseline or post-install transcripts
node dist/benchmark.mjs analyze /path/to/transcripts
node dist/benchmark.mjs analyze --local
node dist/benchmark.mjs analyze --local --recent 10

# Compare before vs. after transcripts on the same benchmark tasks
node dist/benchmark.mjs compare --before ./before/transcript.jsonl --after ./after/transcript.jsonl
```

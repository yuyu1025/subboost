#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PLUGIN_NAME = "agy-fast";
const EXPECTED_MCP_TOOLS = [
  "batch_search",
  "apply_edits",
  "read_slices",
  "quick_outline",
  "run_checks",
];
const MAX_LOCAL_RULE_BYTES = 256 * 1024;

const RUNTIME_FILES = [
  "plugin.json",
  "mcp_config.json",
  "hooks.json",
  "rules/AGENTS.md",
  "assets/logo.svg",
  "dist/mcp-server.mjs",
  "dist/session-start.mjs",
  "dist/benchmark.mjs",
  "dist/updater.mjs",
  "scripts/install.mjs",
  "LICENSE",
];

const OPTIONAL_DOC_FILES = [
  "assets/logo-light.svg",
  "assets/logo-dark.svg",
  "assets/architecture-light.svg",
  "assets/architecture-dark.svg",
  "assets/architecture-zh-light.svg",
  "assets/architecture-zh-dark.svg",
  "README.md",
  "README.zh-CN.md",
  "CHANGELOG.md",
  "docs/ANALYSIS_REPORT.md",
  "docs/ANALYSIS_REPORT.zh-CN.md",
];

function getHomeDir() {
  if (process.platform === "win32") {
    const driveHome =
      process.env.HOMEDRIVE && process.env.HOMEPATH
        ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
        : "";
    return process.env.USERPROFILE || driveHome || process.env.HOME || os.homedir();
  }
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function compareSemverSimple(a, b) {
  const pa = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(a || "").trim());
  const pb = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(b || "").trim());
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const na = Number.parseInt(pa[i], 10);
    const nb = Number.parseInt(pb[i], 10);
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return 0;
}

function getGlobalPluginDir() {
  return path.join(getHomeDir(), ".gemini", "config", "plugins", PLUGIN_NAME);
}

function getUpdaterCacheDir() {
  const custom = process.env.AGY_FAST_CACHE_DIR?.trim();
  return custom
    ? path.resolve(custom)
    : path.join(getHomeDir(), ".gemini", "cache", PLUGIN_NAME);
}

async function readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function writeUpdaterConfigFile(patch) {
  const cacheDir = getUpdaterCacheDir();
  const cfgPath = path.join(cacheDir, "config.json");
  await fs.mkdir(cacheDir, { recursive: true });
  const existing = (await readJsonSafe(cfgPath)) || {};
  const merged = { ...existing, ...patch };
  const tmpPath = `${cfgPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  try {
    await fs.rename(tmpPath, cfgPath);
  } catch {
    try {
      await fs.copyFile(tmpPath, cfgPath);
    } finally {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
    }
  }
  return { cfgPath, config: merged };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let command = "install";
  let targetDir = "";
  let projectDir = "";
  let useLink = false;
  let skipEnable = false;
  let skipAcp = false;
  let quiet = false;
  let showHelp = false;
  let checkOnly = false;
  let promptUpdate = false;
  let skipVersion = "";
  let force = false;
  let autoUpdate = "";
  let intervalHours = null;
  let channel = "";
  let repoUrl = "";
  let editsFormat = "";
  let toolLoading = "";

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      showHelp = true;
    } else if (a === "--link") {
      useLink = true;
    } else if (a === "--no-enable") {
      skipEnable = true;
    } else if (a === "--no-acp") {
      skipAcp = true;
    } else if (a === "--quiet" || a === "-q") {
      quiet = true;
    } else if (a === "--check") {
      checkOnly = true;
    } else if (a === "--prompt" || a === "--interactive" || a === "-i") {
      promptUpdate = true;
    } else if (a === "--skip-version") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(
          "Missing version after --skip-version (expected e.g. 0.3.0 or 'none' to clear)",
        );
      }
      skipVersion = args[++i].trim();
    } else if (a === "--force") {
      force = true;
    } else if (a === "--auto-update") {
      const next = args[i + 1];
      if (!next || !["auto", "notify", "off"].includes(next.toLowerCase())) {
        throw new Error("Invalid value after --auto-update (expected: auto | notify | off)");
      }
      autoUpdate = args[++i].toLowerCase();
    } else if (a === "--interval") {
      const next = args[i + 1];
      const parsed = Number.parseFloat(next || "");
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 720) {
        throw new Error("Invalid value after --interval (expected hours between 1 and 720)");
      }
      intervalHours = parsed;
      i++;
    } else if (a === "--channel") {
      const next = args[i + 1];
      if (!next || !["release", "main"].includes(next.toLowerCase())) {
        throw new Error("Invalid value after --channel (expected: release | main)");
      }
      channel = args[++i].toLowerCase();
    } else if (a === "--repo") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing repository URL after --repo");
      }
      repoUrl = args[++i];
    } else if (a === "--edits-format") {
      const next = args[i + 1];
      if (!next || !["auto", "array", "string"].includes(next.toLowerCase())) {
        throw new Error(
          "Invalid value after --edits-format (expected: auto | array | string)",
        );
      }
      editsFormat = args[++i].toLowerCase();
    } else if (a === "--tool-loading") {
      const next = args[i + 1];
      if (!next || !["eager", "lazy"].includes(next.toLowerCase())) {
        throw new Error(
          "Invalid value after --tool-loading (expected: eager | lazy)",
        );
      }
      toolLoading = args[++i].toLowerCase();
    } else if (a === "--target") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing directory path after --target");
      }
      targetDir = path.resolve(args[++i]);
    } else if (a === "--project") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        projectDir = path.resolve(args[++i]);
      } else {
        projectDir = process.cwd();
      }
    } else if (!a.startsWith("-")) {
      positional.push(a);
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }

  if (positional.length > 1) {
    throw new Error(
      `Unexpected extra argument: '${positional[1]}'. Run with --help for usage.`,
    );
  }
  if (positional.length === 1) {
    command = positional[0];
  }

  const isCustomTarget = Boolean(targetDir);
  if (!targetDir) {
    targetDir = projectDir
      ? path.join(projectDir, ".agents", "plugins", PLUGIN_NAME)
      : getGlobalPluginDir();
  }

  return {
    command,
    targetDir,
    isProject: Boolean(projectDir),
    isCustomTarget,
    useLink,
    skipEnable,
    skipAcp,
    quiet,
    showHelp,
    checkOnly,
    promptUpdate,
    skipVersion,
    force,
    autoUpdate,
    intervalHours,
    channel,
    repoUrl,
    editsFormat,
    toolLoading,
  };
}

function printHelp() {
  console.log(`agy-fast installer

Usage:
  node scripts/install.mjs [command] [options]

Commands:
  install      Install agy-fast plugin (default)
  update       Check for and apply plugin updates from GitHub releases
  config       View or persist auto-update preferences
  uninstall    Remove installed agy-fast plugin
  status       Check installation and run live health checks
  doctor       Alias for status

Options:
  --project [dir]               Install/update <dir>/.agents/plugins/agy-fast
  --target <dir>                Use a custom plugin directory
  --link                        Create a symlink to this repository (dev mode)
  --no-enable                   Skip running 'agy plugin enable agy-fast'
  --no-acp                      Skip syncing isolated T3 Code ACP / GEMINI_HOME profiles
  --check                       (update) Check for newer versions without applying
  --prompt, --interactive, -i   (update) Check GitHub and ask before updating ([y]es/[n]o/[s]kip)
  --skip-version <ver|none>     (update) Skip notifications/auto-updates for a version ('none' clears)
  --force                       (update) Re-apply even if already on the same version
  --auto-update auto|notify|off Configure background auto-update mode
  --interval <hours>            Configure background check interval in hours (default 4)
  --channel release|main        Configure update channel (default release)
  --repo <url>                  Override git repository URL for updates
  --edits-format auto|array|string
                                Configure apply_edits.edits schema preference (default auto)
  --tool-loading eager|lazy     Configure MCP tool loading mode in mcp_config.json (default eager)
  -h, --help                    Show this help
`);
}

function checkNodeVersion() {
  const major = Number.parseInt(process.versions.node.split(".")[0] || "0", 10);
  if (major < 20) {
    throw new Error(
      `Node.js >= 20 is required (current version: v${process.versions.node})`,
    );
  }
  return process.versions.node;
}

function spawnCliSync(bin, args, opts = {}) {
  const baseOpts = { windowsHide: true, ...opts };
  const direct = spawnSync(bin, args, baseOpts);
  if (process.platform !== "win32" || direct.error?.code !== "ENOENT") {
    return direct;
  }
  const whereRes = spawnSync("where.exe", [bin], {
    encoding: "utf8",
    timeout: 2000,
    windowsHide: true,
  });
  if (whereRes.error || whereRes.status !== 0) {
    return direct;
  }
  const candidates = (whereRes.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const resolved = candidates.find((p) => /\.(exe|cmd|bat)$/i.test(p));
  if (!resolved) {
    return direct;
  }
  if (/\.exe$/i.test(resolved)) {
    return spawnSync(resolved, args, baseOpts);
  }
  const quoteWin = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const cmdLine = [quoteWin(resolved), ...args.map(quoteWin)].join(" ");
  return spawnSync("cmd.exe", ["/d", "/s", "/c", `"${cmdLine}"`], {
    ...baseOpts,
    windowsVerbatimArguments: true,
  });
}

function hasCommand(bin, args = ["--version"]) {
  const res = spawnCliSync(bin, args, {
    stdio: "ignore",
    timeout: 3000,
  });
  return !res.error && res.status === 0;
}

async function pathExists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function lstatSafe(p) {
  try {
    return await fs.lstat(p);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      return null;
    }
    throw err;
  }
}

function toComparePath(p) {
  const normalized = path.resolve(p);
  return process.platform === "win32" || process.platform === "darwin"
    ? normalized.toLowerCase()
    : normalized;
}

async function canonicalizeExistingPath(p) {
  const resolved = path.resolve(p);
  const tail = [];
  let cur = resolved;
  while (true) {
    try {
      const real = await fs.realpath(cur);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") {
        return resolved;
      }
      const parent = path.dirname(cur);
      if (parent === cur) {
        return resolved;
      }
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

async function canonicalizeEntryComparePath(p) {
  const resolved = path.resolve(p);
  const stat = await lstatSafe(resolved);
  if (stat && !stat.isSymbolicLink()) {
    return toComparePath(await canonicalizeExistingPath(resolved));
  }
  const parent = path.dirname(resolved);
  if (parent === resolved) {
    return toComparePath(resolved);
  }
  const realParent = await canonicalizeExistingPath(parent);
  return toComparePath(path.join(realParent, path.basename(resolved)));
}

function isStrictAncestorPath(ancestorPath, descendantPath) {
  const rel = path.relative(ancestorPath, descendantPath);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

async function assertRemovableTarget(targetPath, stat) {
  if (!stat || stat.isSymbolicLink()) {
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Refusing to delete ${targetPath}: target exists and is not an ${PLUGIN_NAME} directory or symlink.`,
    );
  }
  const entries = await fs.readdir(targetPath);
  if (entries.length === 0) {
    return;
  }
  const manifest = await readJsonSafe(path.join(targetPath, "plugin.json"));
  if (manifest?.name !== PLUGIN_NAME) {
    throw new Error(
      `Refusing to delete non-empty directory ${targetPath}: missing plugin.json with name "${PLUGIN_NAME}".`,
    );
  }
}

async function removeTargetPath(targetPath, stat) {
  if (!stat) {
    return;
  }
  if (stat.isSymbolicLink()) {
    await fs.unlink(targetPath);
    return;
  }
  await fs.rm(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

async function verifyMcpServerLive(mcpScriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpScriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("MCP server smoke test timed out after 5s"));
    }, 5000);
    timer.unref();

    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length < 2) {
        reject(
          new Error(
            `MCP server returned incomplete response (exit ${code}): ${stderr || stdout}`,
          ),
        );
        return;
      }
      try {
        const initResp = JSON.parse(lines[0]);
        const listResp = JSON.parse(lines[1]);
        const tools = listResp?.result?.tools;
        if (!initResp?.result?.serverInfo || !Array.isArray(tools)) {
          reject(new Error("Invalid MCP JSON-RPC responses"));
          return;
        }
        const applyEditsTool = tools.find((t) => t.name === "apply_edits");
        const applyEditsSchemaType =
          applyEditsTool?.inputSchema?.properties?.edits?.type || "unknown";
        resolve({
          protocolVersion: initResp.result.protocolVersion,
          tools: tools.map((t) => t.name),
          applyEditsSchemaType,
        });
      } catch (err) {
        reject(err);
      }
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "agy-fast-doctor", version: "1.0" },
        },
      }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n",
    );
    child.stdin.end();
  });
}

async function verifySessionStartLive(hookScriptPath, sampleWorkspace) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookScriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, AGY_FAST_AUTO_UPDATE: "off" },
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("SessionStart hook smoke test timed out after 5s"));
    }, 5000);
    timer.unref();

    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`SessionStart hook exited with code ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        const msg = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
        resolve({
          durationMs: Date.now() - start,
          bytes: Buffer.byteLength(msg, "utf8"),
        });
      } catch (err) {
        reject(err);
      }
    });

    child.stdin.end(
      JSON.stringify({
        cwd: sampleWorkspace,
        workspacePaths: [sampleWorkspace],
        hookEventName: "SessionStart",
      }),
    );
  });
}

async function assertSourceFilesPresent(srcRoot) {
  for (const rel of RUNTIME_FILES) {
    const src = path.join(srcRoot, rel);
    if (!(await pathExists(src))) {
      throw new Error(
        `Missing required file: ${rel}. Run 'npm run build' first if installing from source.`,
      );
    }
  }
}

async function copyRuntimeFiles(srcRoot, dstRoot) {
  await assertSourceFilesPresent(srcRoot);
  await fs.mkdir(dstRoot, { recursive: true });
  const toCopy = [...RUNTIME_FILES];
  for (const opt of OPTIONAL_DOC_FILES) {
    if (await pathExists(path.join(srcRoot, opt))) {
      toCopy.push(opt);
    }
  }
  for (const rel of toCopy) {
    const src = path.join(srcRoot, rel);
    const dst = path.join(dstRoot, rel);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
  }
}

function parseToolLoadingValue(raw) {
  if (typeof raw !== "string") return "";
  const v = raw.trim().toLowerCase();
  return v === "eager" || v === "lazy" ? v : "";
}

async function resolveEffectiveToolLoading(explicitOverride = "") {
  const explicit = parseToolLoadingValue(explicitOverride);
  if (explicit) return explicit;
  const fromEnv = parseToolLoadingValue(process.env.AGY_FAST_TOOL_LOADING || "");
  if (fromEnv) return fromEnv;
  const cfgPath = path.join(getUpdaterCacheDir(), "config.json");
  const cfg = (await readJsonSafe(cfgPath)) || {};
  return parseToolLoadingValue(cfg.toolLoading) || "eager";
}

async function applyToolLoadingToCopiedPluginDir(pluginDir, mode) {
  const dirStat = await lstatSafe(pluginDir);
  if (!dirStat) return { applied: false, reason: "missing" };
  if (dirStat.isSymbolicLink()) return { applied: false, reason: "symlink" };
  if (await pathExists(path.join(pluginDir, ".git"))) {
    return { applied: false, reason: "git-clone" };
  }
  const mcpPath = path.join(pluginDir, "mcp_config.json");
  const cfg = await readJsonSafe(mcpPath);
  if (!cfg?.mcpServers?.fast || typeof cfg.mcpServers.fast !== "object") {
    return { applied: false, reason: "invalid-mcp-config" };
  }
  if (mode === "lazy") {
    delete cfg.mcpServers.fast.tools;
  } else {
    const toolsMap = {};
    for (const tool of EXPECTED_MCP_TOOLS) {
      toolsMap[tool] = { eager: true };
    }
    cfg.mcpServers.fast.tools = toolsMap;
  }
  const tmpPath = `${mcpPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  try {
    await fs.rename(tmpPath, mcpPath);
  } catch {
    try {
      await fs.copyFile(tmpPath, mcpPath);
    } finally {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
    }
  }
  return { applied: true, reason: null };
}

async function snapshotLocalRuleFiles(pluginDir) {
  const preserved = [];
  const skipped = [];
  const dirStat = await lstatSafe(pluginDir);
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    return { preserved, skipped };
  }
  const rulesDir = path.join(pluginDir, "rules");
  const rulesStat = await lstatSafe(rulesDir);
  if (!rulesStat || rulesStat.isSymbolicLink() || !rulesStat.isDirectory()) {
    return { preserved, skipped };
  }
  let entries;
  try {
    entries = await fs.readdir(rulesDir, { withFileTypes: true });
  } catch {
    return { preserved, skipped };
  }
  for (const entry of entries) {
    const name = entry.name;
    if (
      !name ||
      name.startsWith(".") ||
      !name.toLowerCase().endsWith(".local.md") ||
      name.length <= ".local.md".length ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes("\0") ||
      path.basename(name) !== name
    ) {
      continue;
    }
    const fullPath = path.join(rulesDir, name);
    const st = await lstatSafe(fullPath);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      skipped.push({ name, reason: "symlink" });
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_LOCAL_RULE_BYTES) {
      skipped.push({ name, reason: `exceeds ${Math.round(MAX_LOCAL_RULE_BYTES / 1024)}KB limit` });
      continue;
    }
    try {
      const content = await fs.readFile(fullPath);
      if (content.length > MAX_LOCAL_RULE_BYTES) {
        skipped.push({ name, reason: `exceeds ${Math.round(MAX_LOCAL_RULE_BYTES / 1024)}KB limit` });
        continue;
      }
      preserved.push({ name, content, mode: (st.mode & 0o777) | 0o600 });
    } catch {
      skipped.push({ name, reason: "unreadable" });
    }
  }
  preserved.sort((a, b) => a.name.localeCompare(b.name));
  skipped.sort((a, b) => a.name.localeCompare(b.name));
  return { preserved, skipped };
}

async function restoreLocalRuleFiles(pluginDir, preserved) {
  const restored = [];
  const keptExisting = [];
  if (!preserved || preserved.length === 0) {
    return { restored, keptExisting };
  }
  const rulesDir = path.join(pluginDir, "rules");
  await fs.mkdir(rulesDir, { recursive: true });
  for (const file of preserved) {
    const dst = path.join(rulesDir, file.name);
    if (await lstatSafe(dst)) {
      keptExisting.push(file.name);
      continue;
    }
    await fs.writeFile(dst, file.content, { mode: file.mode || 0o644 });
    restored.push(file.name);
  }
  return { restored, keptExisting };
}

async function hasLocalRuleFiles(pluginDir) {
  const rulesDir = path.join(pluginDir, "rules");
  try {
    const entries = await fs.readdir(rulesDir);
    return entries.some((n) => n.toLowerCase().endsWith(".local.md"));
  } catch {
    return false;
  }
}

async function isDirSafe(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function discoverIsolatedPluginDirs(primaryGlobalDir) {
  const home = getHomeDir();
  const primaryCompare = await canonicalizeEntryComparePath(primaryGlobalDir);
  const defaultGeminiCompare = toComparePath(
    await canonicalizeExistingPath(path.join(home, ".gemini")),
  );
  const seen = new Set([primaryCompare]);
  const results = [];

  const addCandidate = async (geminiRoot, label) => {
    const resolvedRoot = path.resolve(geminiRoot);
    const rootCompare = toComparePath(await canonicalizeExistingPath(resolvedRoot));
    if (rootCompare === defaultGeminiCompare) return;
    const pluginDir = path.join(resolvedRoot, "config", "plugins", PLUGIN_NAME);
    const key = await canonicalizeEntryComparePath(pluginDir);
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ geminiRoot: resolvedRoot, pluginDir, label });
  };

  // 1. T3 Code isolated Antigravity ACP provider profiles:
  //    ~/.t3/userdata/providers/antigravity/<hash>/
  const t3ProvidersRoot = path.join(home, ".t3", "userdata", "providers", "antigravity");
  try {
    const entries = await fs.readdir(t3ProvidersRoot, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const profileRoot = path.join(t3ProvidersRoot, entry.name);
      const hasConfig = await isDirSafe(path.join(profileRoot, "config"));
      const hasAcp = await isDirSafe(path.join(profileRoot, "antigravity-acp"));
      if (hasConfig || hasAcp) {
        await addCandidate(profileRoot, `T3 Code ACP (${entry.name.slice(0, 8)})`);
      }
    }
  } catch {
    // ~/.t3 not present
  }

  // 2. Explicit GEMINI_HOME env var when pointing to an isolated Antigravity / ACP home
  const envGeminiHome = process.env.GEMINI_HOME?.trim();
  if (envGeminiHome) {
    const resolvedEnv = path.resolve(envGeminiHome);
    if (await isDirSafe(resolvedEnv)) {
      const hasConfig = await isDirSafe(path.join(resolvedEnv, "config"));
      const hasAcp = await isDirSafe(path.join(resolvedEnv, "antigravity-acp"));
      if (hasConfig || hasAcp) {
        await addCandidate(resolvedEnv, "GEMINI_HOME");
      }
    }
  }

  return results;
}

async function inspectIsolatedPluginDir(isolated) {
  const stat = await lstatSafe(isolated.pluginDir);
  if (!stat) {
    return { ...isolated, status: "missing", mode: null, linkTarget: null, version: null };
  }
  const configJson = await readJsonSafe(path.join(isolated.geminiRoot, "config", "config.json"));
  const disabledInConfig = configJson?.plugins?.[PLUGIN_NAME]?.enabled === false;
  const manifest = await readJsonSafe(path.join(isolated.pluginDir, "plugin.json"));
  const mcpExists = await pathExists(path.join(isolated.pluginDir, "dist", "mcp-server.mjs"));
  const valid = manifest?.name === PLUGIN_NAME && mcpExists;
  const version = typeof manifest?.version === "string" ? manifest.version : null;

  if (stat.isSymbolicLink()) {
    let linkTarget = null;
    try {
      linkTarget = await fs.readlink(isolated.pluginDir);
    } catch {
      // ignore
    }
    if (!valid) {
      return { ...isolated, status: "broken", mode: "symlink", linkTarget, version: null };
    }
    return {
      ...isolated,
      status: disabledInConfig ? "disabled" : "ok",
      mode: "symlink",
      linkTarget,
      version,
    };
  }

  if (!valid) {
    return { ...isolated, status: "broken", mode: "copied", linkTarget: null, version: null };
  }
  return {
    ...isolated,
    status: disabledInConfig ? "disabled" : "ok",
    mode: "copied",
    linkTarget: null,
    version,
  };
}

async function syncIsolatedPluginDir(resolvedSrc, primaryGlobalDir, isolated, opts) {
  const isoStat = await lstatSafe(isolated.pluginDir);
  const srcCompare = toComparePath(await canonicalizeExistingPath(resolvedSrc));
  const primaryStat = await lstatSafe(primaryGlobalDir);
  const primaryRealPath =
    primaryStat && !primaryStat.isSymbolicLink()
      ? await canonicalizeExistingPath(primaryGlobalDir)
      : primaryGlobalDir;
  const primaryCompare =
    primaryStat && !primaryStat.isSymbolicLink()
      ? toComparePath(primaryRealPath)
      : await canonicalizeEntryComparePath(primaryGlobalDir);
  const isoEntryCompare = await canonicalizeEntryComparePath(isolated.pluginDir);
  if (isoEntryCompare === primaryCompare) {
    return { synced: true, mode: "same" };
  }
  if (isoStat && !isoStat.isSymbolicLink()) {
    const isoCompare = toComparePath(await fs.realpath(isolated.pluginDir));
    if (isoCompare === srcCompare || isoCompare === primaryCompare) {
      return { synced: true, mode: "same" };
    }
    if (
      isStrictAncestorPath(isoCompare, srcCompare) ||
      isStrictAncestorPath(isoCompare, primaryCompare)
    ) {
      throw new Error(
        `Refusing to sync into ${isolated.pluginDir}: target is an ancestor directory of ${resolvedSrc}.`,
      );
    }
  }

  await assertRemovableTarget(isolated.pluginDir, isoStat);
  const { preserved: preservedIsoLocalRules, skipped: skippedIsoLocalRules } =
    await snapshotLocalRuleFiles(isolated.pluginDir);
  await fs.mkdir(path.dirname(isolated.pluginDir), { recursive: true });
  await removeTargetPath(isolated.pluginDir, isoStat);

  // Link directly to resolvedSrc in --link dev mode (avoids chained NTFS junctions on Windows),
  // otherwise link to primaryRealPath so auto-updates to ~/.gemini/config/plugins/agy-fast
  // propagate immediately to every isolated ACP profile.
  const linkSource = opts.useLink ? resolvedSrc : primaryRealPath;
  const linkType = process.platform === "win32" ? "junction" : "dir";
  let mode = "symlink";
  let migratedToPrimary = { restored: [], keptExisting: [] };
  try {
    await fs.symlink(linkSource, isolated.pluginDir, linkType);
  } catch (err) {
    const code = err?.code;
    if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV") {
      await copyRuntimeFiles(resolvedSrc, isolated.pluginDir);
      if (opts.effectiveToolLoading) {
        await applyToolLoadingToCopiedPluginDir(isolated.pluginDir, opts.effectiveToolLoading);
      }
      await restoreLocalRuleFiles(isolated.pluginDir, preservedIsoLocalRules);
      mode = "copied";
    } else {
      throw err;
    }
  }
  if (mode === "symlink" && !opts.useLink && preservedIsoLocalRules.length > 0) {
    migratedToPrimary = await restoreLocalRuleFiles(
      primaryRealPath,
      preservedIsoLocalRules,
    );
  }

  if (!opts.quiet) {
    if (mode === "symlink") {
      console.log(`Synced ${isolated.label}: ${isolated.pluginDir} -> ${linkSource}`);
      if (migratedToPrimary.restored.length > 0) {
        console.log(
          `Migrated isolated local rule file(s) to primary plugin dir: ${migratedToPrimary.restored.map((n) => `rules/${n}`).join(", ")}`,
        );
      }
      if (migratedToPrimary.keptExisting.length > 0) {
        console.log(
          `Kept existing primary local rule file(s) on symlink sync: ${migratedToPrimary.keptExisting.map((n) => `rules/${n}`).join(", ")}`,
        );
      }
      if (opts.useLink && preservedIsoLocalRules.length > 0) {
        console.log(
          `Note: --link replaced ${isolated.pluginDir}; local rule file(s) were not copied into dev checkout: ${preservedIsoLocalRules.map((f) => `rules/${f.name}`).join(", ")}`,
        );
      }
    } else {
      console.log(`Synced ${isolated.label} (copied): ${isolated.pluginDir}`);
    }
    if (skippedIsoLocalRules.length > 0) {
      console.log(
        `Skipped unsafe/oversized local rule file(s) in ${isolated.label}: ${skippedIsoLocalRules.map((s) => `rules/${s.name} (${s.reason})`).join(", ")}`,
      );
    }
    const configJson = await readJsonSafe(path.join(isolated.geminiRoot, "config", "config.json"));
    if (configJson?.plugins?.[PLUGIN_NAME]?.enabled === false) {
      console.log(
        `Note: '${PLUGIN_NAME}' is explicitly disabled in ${path.join(isolated.geminiRoot, "config", "config.json")}.`,
      );
    }
  }
  return { synced: true, mode };
}

async function runDoctor(targetDir, quiet = false, doctorOpts = {}) {
  const nodeVer = checkNodeVersion();
  const hasRg = hasCommand("rg", ["--version"]);
  const hasAgy = hasCommand("agy", ["--version"]);
  const exists = await pathExists(targetDir);

  const report = {
    nodeVersion: nodeVer,
    ripgrep: hasRg,
    agyCli: hasAgy,
    targetDir,
    installed: exists,
    mcpTools: [],
    hookLatencyMs: null,
    hookBytes: null,
    agyValidated: null,
  };

  if (!exists) {
    if (!quiet) {
      console.log(`agy-fast is not installed at: ${targetDir}`);
    }
    return { ok: false, report };
  }

  const mcpPath = path.join(targetDir, "dist", "mcp-server.mjs");
  const hookPath = path.join(targetDir, "dist", "session-start.mjs");
  const mcpCheck = await verifyMcpServerLive(mcpPath);
  const hookCheck = await verifySessionStartLive(hookPath, targetDir);

  report.mcpTools = mcpCheck.tools;
  report.hookLatencyMs = hookCheck.durationMs;
  report.hookBytes = hookCheck.bytes;

  if (hasAgy) {
    const valRes = spawnCliSync("agy", ["plugin", "validate", "--strict", targetDir], {
      encoding: "utf8",
      timeout: 10_000,
    });
    report.agyValidated = !valRes.error && valRes.status === 0;
    report.agyValidateOutput = [valRes.error?.message, valRes.stdout, valRes.stderr]
      .filter((s) => typeof s === "string" && s.trim())
      .join("\n")
      .trim();
  }

  const manifest = await readJsonSafe(path.join(targetDir, "plugin.json"));
  const installedVersion =
    manifest && typeof manifest.version === "string" ? manifest.version : "unknown";
  const cacheDir = getUpdaterCacheDir();
  const updaterCfg = (await readJsonSafe(path.join(cacheDir, "config.json"))) || {};
  const updaterState = (await readJsonSafe(path.join(cacheDir, "update-state.json"))) || {};
  const effectiveAutoMode =
    process.env.AGY_FAST_AUTO_UPDATE?.trim().toLowerCase() ||
    updaterCfg.autoUpdate ||
    "auto";
  const effectiveInterval =
    process.env.AGY_FAST_UPDATE_INTERVAL_HOURS?.trim() ||
    updaterCfg.checkIntervalHours ||
    4;
  const effectiveChannel =
    process.env.AGY_FAST_UPDATE_CHANNEL?.trim().toLowerCase() ||
    updaterCfg.channel ||
    "release";
  const rawEnvEditsFormat = process.env.AGY_FAST_EDITS_FORMAT?.trim().toLowerCase() || "";
  const validEnvEditsFormat = ["auto", "array", "string"].includes(rawEnvEditsFormat)
    ? rawEnvEditsFormat
    : "";
  const validCfgEditsFormat =
    typeof updaterCfg.editsFormat === "string" &&
    ["auto", "array", "string"].includes(updaterCfg.editsFormat.trim().toLowerCase())
      ? updaterCfg.editsFormat.trim().toLowerCase()
      : "";
  const effectiveEditsFormat = validEnvEditsFormat || validCfgEditsFormat || "auto";
  const effectiveToolLoading =
    parseToolLoadingValue(process.env.AGY_FAST_TOOL_LOADING || "") ||
    parseToolLoadingValue(updaterCfg.toolLoading) ||
    "eager";
  const installedMcpCfg = await readJsonSafe(path.join(targetDir, "mcp_config.json"));
  const installedToolsMap =
    installedMcpCfg?.mcpServers?.fast?.tools &&
    typeof installedMcpCfg.mcpServers.fast.tools === "object"
      ? installedMcpCfg.mcpServers.fast.tools
      : {};
  const eagerToolCount = EXPECTED_MCP_TOOLS.filter(
    (t) => installedToolsMap?.[t]?.eager === true,
  ).length;
  const rawHostOverride = process.env.AGY_FAST_HOST?.trim() || "";
  const validHostOverride =
    /^(?:cli|desktop|app|antigravity|ide|unknown)(?:[@\-/\s]v?\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)?$/i.test(
      rawHostOverride,
    )
      ? rawHostOverride
      : "";
  const hostEnvLabel =
    validHostOverride || process.env.ANTIGRAVITY_LS_VERSION?.trim() || "auto";

  const isolatedProfiles = doctorOpts.checkIsolated
    ? await Promise.all(
        (await discoverIsolatedPluginDirs(targetDir)).map((iso) =>
          inspectIsolatedPluginDir(iso),
        ),
      )
    : [];
  report.isolatedProfiles = isolatedProfiles;

  const missingTools = EXPECTED_MCP_TOOLS.filter((t) => !mcpCheck.tools.includes(t));
  const hasAllExpectedTools = missingTools.length === 0;
  const hasLocalRules =
    report.agyValidated === false ? await hasLocalRuleFiles(targetDir) : false;

  if (!quiet) {
    console.log("agy-fast health check:");
    console.log(`  - Plugin path : ${targetDir}`);
    console.log(`  - Version     : v${installedVersion}`);
    console.log(`  - Node.js     : v${nodeVer} (OK)`);
    console.log(
      `  - ripgrep (rg): ${hasRg ? "available (fast search active)" : "not found (automatic Node.js fallback active)"}`,
    );
    console.log(
      `  - MCP server  : ${
        hasAllExpectedTools
          ? `OK (${mcpCheck.tools.length} tools: ${mcpCheck.tools.join(", ")})`
          : `FAILED (missing: ${missingTools.join(", ")}; found: ${mcpCheck.tools.join(", ") || "none"})`
      }`,
    );
    console.log(
      `  - Tool loading: ${effectiveToolLoading} (${eagerToolCount}/${EXPECTED_MCP_TOOLS.length} tools eager in mcp_config.json)`,
    );
    console.log(
      `  - Host compat : editsFormat=${effectiveEditsFormat} (active edits schema: ${mcpCheck.applyEditsSchemaType}; host=${hostEnvLabel})`,
    );
    console.log(
      `  - SessionStart: ${hookCheck.bytes > 0 ? "OK" : "EMPTY (FAILED)"} (${hookCheck.durationMs}ms, ${hookCheck.bytes} bytes)`,
    );
    const availCmp = updaterState.availableVersion
      ? compareSemverSimple(updaterState.availableVersion, installedVersion)
      : null;
    const hasFreshSemverUpdate =
      Boolean(updaterState.availableVersion) && (availCmp === null || availCmp > 0);
    const skipCmp = updaterState.skippedVersion
      ? compareSemverSimple(updaterState.skippedVersion, installedVersion)
      : null;
    const hasActiveSkip =
      Boolean(updaterState.skippedVersion) && (skipCmp === null || skipCmp > 0);
    const hasMainUpdate =
      !updaterState.availableVersion &&
      Boolean(updaterState.availableCommit) &&
      updaterState.availableCommit !== updaterState.lastAppliedCommit;

    const checkParts = [];
    if (
      hasFreshSemverUpdate &&
      (!hasActiveSkip || updaterState.availableVersion !== updaterState.skippedVersion)
    ) {
      checkParts.push(`update available: v${updaterState.availableVersion}`);
    } else if (hasMainUpdate) {
      checkParts.push(
        `update available: ${updaterState.availableRef || "main"} (${String(updaterState.availableCommit).slice(0, 7)})`,
      );
    } else if (hasActiveSkip) {
      checkParts.push(`skipped: v${updaterState.skippedVersion}`);
    }
    if (updaterState.lastCheckAt) {
      checkParts.push(`last check: ${updaterState.lastCheckAt}`);
    } else if (checkParts.length === 0) {
      checkParts.push("not checked yet");
    }
    if (updaterState.lastError) {
      const compactErr = String(updaterState.lastError).replace(/\s+/g, " ").trim().slice(0, 120);
      checkParts.push(`last error: ${compactErr}`);
    }
    console.log(
      `  - Auto-update : ${effectiveAutoMode} (interval: ${effectiveInterval}h, channel: ${effectiveChannel}; ${checkParts.join("; ")})`,
    );
    if (
      (hasFreshSemverUpdate || hasMainUpdate) &&
      (!hasActiveSkip || updaterState.availableVersion !== updaterState.skippedVersion) &&
      updaterState.availableReleaseUrl
    ) {
      console.log(`      Release: ${updaterState.availableReleaseUrl}`);
    }
    if (hasAgy) {
      console.log(
        `  - agy validate: ${report.agyValidated ? "PASSED (--strict)" : "FAILED"}`,
      );
      if (!report.agyValidated && report.agyValidateOutput) {
        for (const line of report.agyValidateOutput.split(/\r?\n/).slice(0, 12)) {
          if (line.trim()) console.log(`      ${line.trim()}`);
        }
      }
      if (!report.agyValidated && hasLocalRules) {
        console.log(
          "      Hint: custom rules/*.local.md files require YAML frontmatter (`---\\ntrigger: always_on\\n---`) for Antigravity to load and validate them.",
        );
      }
    }
    for (const iso of isolatedProfiles) {
      const desc =
        iso.status === "ok"
          ? iso.mode === "symlink"
            ? `OK (linked -> ${iso.linkTarget})`
            : `OK (installed v${iso.version || "unknown"})`
          : iso.status === "disabled"
            ? "DISABLED in profile config.json"
            : iso.status === "broken"
              ? `BROKEN (${iso.pluginDir})`
              : `MISSING (${iso.pluginDir} — run 'install' to sync)`;
      console.log(`  - ${iso.label}: ${desc}`);
    }
  }

  const hasBrokenIsolated = isolatedProfiles.some((iso) => iso.status === "broken");
  const ok =
    hasAllExpectedTools &&
    hookCheck.bytes > 0 &&
    !hasBrokenIsolated &&
    (report.agyValidated === null || report.agyValidated === true);
  return { ok, report };
}

async function runInstall(opts) {
  checkNodeVersion();

  const resolvedSrc = await fs.realpath(REPO_ROOT);
  const resolvedDst = path.resolve(opts.targetDir);
  const dstStat = await lstatSafe(resolvedDst);

  let sameDirectory = false;
  if (dstStat && !dstStat.isSymbolicLink()) {
    const srcCompare = toComparePath(resolvedSrc);
    const dstCompare = toComparePath(await fs.realpath(resolvedDst));
    sameDirectory = srcCompare === dstCompare;
    if (isStrictAncestorPath(dstCompare, srcCompare)) {
      throw new Error(
        `Refusing to install into ${resolvedDst}: target is an ancestor directory of ${resolvedSrc}.`,
      );
    }
  }

  await assertSourceFilesPresent(resolvedSrc);
  const effectiveToolLoading = await resolveEffectiveToolLoading(opts.toolLoading);
  const installOpts = { ...opts, effectiveToolLoading };

  if (sameDirectory) {
    if (!opts.quiet) {
      console.log(`Repository is already at target plugin directory: ${resolvedDst}`);
    }
  } else if (opts.useLink) {
    await assertRemovableTarget(resolvedDst, dstStat);
    const { preserved: replacedLocalRules } = await snapshotLocalRuleFiles(resolvedDst);
    await fs.mkdir(path.dirname(resolvedDst), { recursive: true });
    await removeTargetPath(resolvedDst, dstStat);
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(resolvedSrc, resolvedDst, linkType);
    if (!opts.quiet) {
      console.log(`Linked ${resolvedDst} -> ${resolvedSrc}`);
      if (replacedLocalRules.length > 0) {
        console.log(
          `Note: --link replaced ${resolvedDst}; local rule file(s) were not copied into dev checkout: ${replacedLocalRules.map((f) => `rules/${f.name}`).join(", ")}`,
        );
      }
    }
  } else {
    // Preserve clean target directory and any user-authored rules/*.local.md when re-installing / upgrading
    await assertRemovableTarget(resolvedDst, dstStat);
    const { preserved: preservedLocalRules, skipped: skippedLocalRules } =
      await snapshotLocalRuleFiles(resolvedDst);
    await removeTargetPath(resolvedDst, dstStat);
    await copyRuntimeFiles(resolvedSrc, resolvedDst);
    await applyToolLoadingToCopiedPluginDir(resolvedDst, effectiveToolLoading);
    const { restored } = await restoreLocalRuleFiles(resolvedDst, preservedLocalRules);
    if (!opts.quiet) {
      console.log(`Installed agy-fast to ${resolvedDst}`);
      if (effectiveToolLoading === "lazy") {
        console.log("Applied MCP tool loading mode: lazy (all 5 tools via call_mcp_tool).");
      }
      if (restored.length > 0) {
        console.log(
          `Preserved local rule file(s): ${restored.map((n) => `rules/${n}`).join(", ")}`,
        );
      }
      if (skippedLocalRules.length > 0) {
        console.log(
          `Skipped unsafe/oversized local rule file(s): ${skippedLocalRules.map((s) => `rules/${s.name} (${s.reason})`).join(", ")}`,
        );
      }
    }
  }

  const hasAgy = hasCommand("agy", ["--version"]);
  const isGlobalTarget = !opts.isProject && !opts.isCustomTarget;
  const syncIsolated = isGlobalTarget && !opts.skipAcp;
  const isolatedTargets = syncIsolated ? await discoverIsolatedPluginDirs(resolvedDst) : [];
  for (const isolated of isolatedTargets) {
    await syncIsolatedPluginDir(resolvedSrc, resolvedDst, isolated, installOpts);
  }

  if (hasAgy && !opts.skipEnable && isGlobalTarget) {
    const enableRes = spawnCliSync("agy", ["plugin", "enable", PLUGIN_NAME], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (!opts.quiet) {
      if (!enableRes.error && enableRes.status === 0) {
        console.log(`Enabled plugin '${PLUGIN_NAME}' via agy CLI.`);
      } else {
        console.log(
          `Note: could not auto-enable via 'agy plugin enable ${PLUGIN_NAME}'. Enable it in Antigravity Customizations UI.`,
        );
      }
    }
  }

  if (
    opts.autoUpdate ||
    opts.intervalHours !== null ||
    opts.channel ||
    opts.repoUrl ||
    opts.editsFormat ||
    opts.toolLoading
  ) {
    const patch = {};
    if (opts.autoUpdate) patch.autoUpdate = opts.autoUpdate;
    if (opts.intervalHours !== null) patch.checkIntervalHours = opts.intervalHours;
    if (opts.channel) patch.channel = opts.channel;
    if (opts.repoUrl) patch.repoUrl = opts.repoUrl;
    if (opts.editsFormat) patch.editsFormat = opts.editsFormat;
    if (opts.toolLoading) patch.toolLoading = opts.toolLoading;
    await writeUpdaterConfigFile(patch);
  }

  const { ok } = await runDoctor(resolvedDst, opts.quiet, { checkIsolated: syncIsolated });
  if (!ok) {
    throw new Error("Post-install health check failed.");
  }

  if (!opts.quiet) {
    console.log("");
    console.log("Installation complete. Next steps:");
    console.log("  - Antigravity CLI (agy)    : Start a new session to activate agy-fast.");
    console.log("  - Antigravity Desktop / IDE: Open Customizations -> Installed and ensure 'agy-fast' is enabled.");
    if (isolatedTargets.length > 0) {
      console.log(
        `  - T3 Code / ACP (${isolatedTargets.length})        : Start a new thread (or reload provider) to activate agy-fast.`,
      );
    }
  }
}

async function runConfig(opts) {
  const patch = {};
  if (opts.autoUpdate) patch.autoUpdate = opts.autoUpdate;
  if (opts.intervalHours !== null) patch.checkIntervalHours = opts.intervalHours;
  if (opts.channel) patch.channel = opts.channel;
  if (opts.repoUrl) patch.repoUrl = opts.repoUrl;
  if (opts.editsFormat) patch.editsFormat = opts.editsFormat;
  if (opts.toolLoading) patch.toolLoading = opts.toolLoading;

  let cfgPath = path.join(getUpdaterCacheDir(), "config.json");
  let cfg;
  if (Object.keys(patch).length > 0) {
    const res = await writeUpdaterConfigFile(patch);
    cfgPath = res.cfgPath;
    cfg = res.config;
  } else {
    cfg = (await readJsonSafe(cfgPath)) || {};
  }

  let appliedToolLoadingNote = "";
  if (opts.toolLoading) {
    const resolvedDst = path.resolve(opts.targetDir);
    const applyRes = await applyToolLoadingToCopiedPluginDir(resolvedDst, opts.toolLoading);
    if (applyRes.applied) {
      const isGlobalTarget = !opts.isProject && !opts.isCustomTarget;
      if (isGlobalTarget && !opts.skipAcp) {
        const isolatedTargets = await discoverIsolatedPluginDirs(resolvedDst);
        for (const iso of isolatedTargets) {
          await applyToolLoadingToCopiedPluginDir(iso.pluginDir, opts.toolLoading);
        }
      }
      appliedToolLoadingNote = `Applied '${opts.toolLoading}' mode to ${path.join(resolvedDst, "mcp_config.json")} (start a new session to take effect).`;
    } else if (applyRes.reason === "symlink" || applyRes.reason === "git-clone") {
      appliedToolLoadingNote = `Saved toolLoading='${opts.toolLoading}' in config.json (skipped rewriting ${resolvedDst}/mcp_config.json because it is a ${applyRes.reason}; edit manually or reinstall as a copied install).`;
    }
  }

  if (!opts.quiet) {
    console.log(`agy-fast updater config (${cfgPath}):`);
    console.log(`  - autoUpdate        : ${cfg.autoUpdate || "auto"}`);
    console.log(`  - checkIntervalHours: ${cfg.checkIntervalHours || 4}`);
    console.log(`  - channel           : ${cfg.channel || "release"}`);
    console.log(`  - repoUrl           : ${cfg.repoUrl || "https://github.com/INK-Q/agy-fast.git"}`);
    console.log(`  - editsFormat       : ${cfg.editsFormat || "auto"}`);
    console.log(`  - toolLoading       : ${cfg.toolLoading || "eager"}`);
    if (appliedToolLoadingNote) {
      console.log(`  ${appliedToolLoadingNote}`);
    }
  }
}

function invokeUpdaterJson(updaterPath, args) {
  const res = spawnSync(process.execPath, [updaterPath, ...args, "--json"], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  let parsed = null;
  try {
    parsed = JSON.parse((res.stdout || "").trim());
  } catch {
    // Non-JSON error output handled below
  }
  if (!parsed) {
    const detail = (res.stderr || res.stdout || res.error?.message || "updater failed").trim();
    throw new Error(detail);
  }
  return parsed;
}

async function promptUpdateDecision(question) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const raw = await rl.question(question);
    const ans = raw.trim().toLowerCase();
    if (ans === "y" || ans === "yes") return "yes";
    if (ans === "s" || ans === "skip") return "skip";
    return "no";
  } catch {
    return "no";
  } finally {
    rl.close();
  }
}

async function runUpdate(opts) {
  checkNodeVersion();
  const resolvedDst = path.resolve(opts.targetDir);
  if (!(await pathExists(resolvedDst))) {
    throw new Error(
      `agy-fast is not installed at ${resolvedDst}. Run 'install' first.`,
    );
  }

  if (opts.autoUpdate || opts.intervalHours !== null || opts.editsFormat || opts.toolLoading) {
    const patch = {};
    if (opts.autoUpdate) patch.autoUpdate = opts.autoUpdate;
    if (opts.intervalHours !== null) patch.checkIntervalHours = opts.intervalHours;
    if (opts.editsFormat) patch.editsFormat = opts.editsFormat;
    if (opts.toolLoading) patch.toolLoading = opts.toolLoading;
    await writeUpdaterConfigFile(patch);
  }

  // Prefer the updater paired with this install.mjs so new CLI flags (e.g. --skip-version)
  // are never sent to an older installed dist/updater.mjs that might ignore unknown flags.
  const repoUpdater = path.join(REPO_ROOT, "dist", "updater.mjs");
  const installedUpdater = path.join(resolvedDst, "dist", "updater.mjs");
  const updaterPath = (await pathExists(repoUpdater))
    ? repoUpdater
    : installedUpdater;
  if (!(await pathExists(updaterPath))) {
    throw new Error("Missing dist/updater.mjs. Run 'npm run build' or reinstall agy-fast.");
  }

  const runSkipCommand = (rawVer) => {
    const lower = rawVer.toLowerCase();
    const isClear = lower === "none" || lower === "clear";
    const expectedStatus = isClear ? "cleared-skip" : "skipped-version";
    const skipArgs = isClear
      ? ["--plugin-dir", resolvedDst, "--clear-skip"]
      : ["--plugin-dir", resolvedDst, "--skip-version", rawVer];
    const skipParsed = invokeUpdaterJson(updaterPath, skipArgs);
    if (skipParsed.status === "error") {
      throw new Error(skipParsed.error || skipParsed.message || "Failed to update skip preference.");
    }
    if (skipParsed.status !== expectedStatus) {
      throw new Error(
        `Updater at ${updaterPath} does not support --skip-version (returned status: '${skipParsed.status}').`,
      );
    }
    if (!opts.quiet) {
      console.log(skipParsed.message);
    }
  };

  if (opts.skipVersion) {
    runSkipCommand(opts.skipVersion);
    return;
  }

  const baseArgs = ["--plugin-dir", resolvedDst];
  if (opts.channel) baseArgs.push("--channel", opts.channel);
  if (opts.repoUrl) baseArgs.push("--repo", opts.repoUrl);

  const installerScriptPath = path.join(resolvedDst, "scripts", "install.mjs");
  let parsed = null;

  if (opts.promptUpdate && !opts.checkOnly) {
    const checkArgs = [...baseArgs, "--check"];
    if (opts.force) checkArgs.push("--force");
    const checkParsed = invokeUpdaterJson(updaterPath, checkArgs);
    if (checkParsed.status === "error") {
      if (!opts.quiet) console.log(checkParsed.message);
      throw new Error(checkParsed.error || checkParsed.message);
    }
    if (checkParsed.status !== "available") {
      // Reuse checkParsed without returning early so --tool-loading and isolated ACP sync still run on up-to-date
      parsed = checkParsed;
    } else {
      if (!opts.quiet) {
        console.log(checkParsed.message);
        if (checkParsed.releaseUrl) {
          console.log(`Release notes: ${checkParsed.releaseUrl}`);
        }
        if (checkParsed.publishedAt) {
          console.log(`Published at : ${checkParsed.publishedAt}`);
        }
      }

      const targetLabel = checkParsed.latestVersion
        ? `v${checkParsed.currentVersion} -> v${checkParsed.latestVersion}`
        : `branch '${checkParsed.latestRef || "main"}'`;
      const isManagedUpdate =
        checkParsed.installKind === "copied" || checkParsed.installKind === "git-clone";
      const question = isManagedUpdate
        ? `Update agy-fast ${targetLabel} now? [y]es / [n]o / [s]kip this version (default: n): `
        : `This install (${checkParsed.installKind}) requires manual git pull/build. Skip notifications for ${targetLabel}? [s]kip / [n]o (default: n): `;

      const decision = await promptUpdateDecision(question);
      if (decision === "skip") {
        if (checkParsed.latestVersion) {
          runSkipCommand(checkParsed.latestVersion);
        } else if (!opts.quiet) {
          console.log("Skipped for now (no semver version tag to persist).");
        }
        return;
      }
      if (decision !== "yes" || !isManagedUpdate) {
        if (!opts.quiet) {
          console.log(
            isManagedUpdate
              ? `Update declined. Run \`node "${installerScriptPath}" update\` whenever you are ready.`
              : "No changes made.",
          );
        }
        return;
      }
    }
  }

  if (!parsed) {
    const updaterArgs = [...baseArgs];
    if (opts.checkOnly) updaterArgs.push("--check");
    if (opts.force) updaterArgs.push("--force");
    parsed = invokeUpdaterJson(updaterPath, updaterArgs);
  }
  if (opts.toolLoading && !opts.checkOnly) {
    await applyToolLoadingToCopiedPluginDir(resolvedDst, opts.toolLoading);
  }

  if (!opts.quiet) {
    console.log(parsed.message);
    if (opts.checkOnly && parsed.status === "available") {
      if (parsed.releaseUrl) {
        console.log(`Release notes: ${parsed.releaseUrl}`);
      }
      console.log(`  - Update now : node "${installerScriptPath}" update`);
      if (parsed.latestVersion) {
        console.log(
          `  - Skip v${parsed.latestVersion}: node "${installerScriptPath}" update --skip-version ${parsed.latestVersion}`,
        );
      }
      console.log(
        `  - Notify-only: node "${installerScriptPath}" config --auto-update notify`,
      );
    }
  }

  if (parsed.status === "error") {
    throw new Error(parsed.error || parsed.message);
  }

  const isGlobalTarget = !opts.isProject && !opts.isCustomTarget;
  const syncIsolated = isGlobalTarget && !opts.skipAcp;
  if (
    syncIsolated &&
    !opts.checkOnly &&
    (parsed.status === "updated" || parsed.status === "up-to-date" || opts.force)
  ) {
    const isolatedTargets = await discoverIsolatedPluginDirs(resolvedDst);
    if (isolatedTargets.length > 0) {
      let linkTarget;
      try {
        linkTarget = await fs.realpath(resolvedDst);
      } catch (err) {
        if (err?.code === "ENOENT") {
          throw new Error(
            `Primary plugin path ${resolvedDst} is a broken symlink. Run 'install' to repair it.`,
          );
        }
        throw err;
      }
      const linkTargetCompare = toComparePath(linkTarget);
      for (const isolated of isolatedTargets) {
        const info = await inspectIsolatedPluginDir(isolated);
        const resolvedLinkTarget =
          (info.status === "ok" || info.status === "disabled") && info.mode === "symlink"
            ? await canonicalizeExistingPath(isolated.pluginDir)
            : null;
        const alreadyLinkedToGlobal =
          resolvedLinkTarget !== null &&
          toComparePath(resolvedLinkTarget) === linkTargetCompare;
        if (!alreadyLinkedToGlobal) {
          await syncIsolatedPluginDir(linkTarget, linkTarget, isolated, {
            ...opts,
            useLink: false,
          });
        }
      }
    }
  }

  if (parsed.status === "updated") {
    const { ok } = await runDoctor(resolvedDst, opts.quiet, { checkIsolated: syncIsolated });
    if (!ok) {
      throw new Error("Post-update health check failed.");
    }
    if (!opts.quiet) {
      console.log("");
      console.log("Update complete. Start a new session (or reload Desktop/IDE window) to load the updated MCP server.");
    }
  }
}

async function runUninstall(opts) {
  const resolvedDst = path.resolve(opts.targetDir);
  const dstStat = await lstatSafe(resolvedDst);
  const isGlobalTarget = !opts.isProject && !opts.isCustomTarget;
  const syncIsolated = isGlobalTarget && !opts.skipAcp;
  const isolatedTargets = syncIsolated ? await discoverIsolatedPluginDirs(resolvedDst) : [];
  const existingIsolated = [];
  for (const isolated of isolatedTargets) {
    const isoStat = await lstatSafe(isolated.pluginDir);
    if (isoStat) {
      existingIsolated.push({ isolated, stat: isoStat });
    }
  }

  if (!dstStat && existingIsolated.length === 0) {
    if (!opts.quiet) {
      console.log(`Nothing to remove (${resolvedDst} does not exist).`);
    }
    return;
  }

  const resolvedSrc = await fs.realpath(REPO_ROOT);
  const srcCompare = toComparePath(resolvedSrc);
  const hasSrcDir = await pathExists(path.join(resolvedSrc, "src"));

  const guardTarget = async (targetPath, stat) => {
    if (!stat.isSymbolicLink()) {
      const targetCompare = toComparePath(await fs.realpath(targetPath));
      if (srcCompare === targetCompare && hasSrcDir) {
        throw new Error(
          `Refusing to delete the active source repository at ${targetPath}. Remove it manually if desired.`,
        );
      }
      if (isStrictAncestorPath(targetCompare, srcCompare)) {
        throw new Error(
          `Refusing to delete ${targetPath}: target is an ancestor directory of ${resolvedSrc}.`,
        );
      }
    }
    await assertRemovableTarget(targetPath, stat);
  };

  if (dstStat) {
    await guardTarget(resolvedDst, dstStat);
  }
  for (const { isolated, stat } of existingIsolated) {
    await guardTarget(isolated.pluginDir, stat);
  }

  if (dstStat && hasCommand("agy", ["--version"]) && !opts.skipEnable && isGlobalTarget) {
    spawnCliSync("agy", ["plugin", "disable", PLUGIN_NAME], {
      stdio: "ignore",
      timeout: 10_000,
    });
  }

  for (const { isolated, stat } of existingIsolated) {
    await removeTargetPath(isolated.pluginDir, stat);
    if (!opts.quiet) {
      console.log(`Removed agy-fast from ${isolated.pluginDir} (${isolated.label})`);
    }
  }

  if (dstStat) {
    await removeTargetPath(resolvedDst, dstStat);
    if (!opts.quiet) {
      console.log(`Removed agy-fast from ${resolvedDst}`);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.showHelp) {
    printHelp();
    return;
  }

  switch (opts.command) {
    case "install":
      await runInstall(opts);
      break;
    case "update":
      await runUpdate(opts);
      break;
    case "config":
      await runConfig(opts);
      break;
    case "uninstall":
      await runUninstall(opts);
      break;
    case "status":
    case "doctor": {
      const checkIsolated = !opts.isProject && !opts.isCustomTarget && !opts.skipAcp;
      const { ok } = await runDoctor(opts.targetDir, opts.quiet, { checkIsolated });
      if (!ok) process.exitCode = 1;
      break;
    }
    default:
      throw new Error(`Unknown command: ${opts.command}. Run with --help for usage.`);
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

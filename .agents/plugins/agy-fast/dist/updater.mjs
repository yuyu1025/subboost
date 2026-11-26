#!/usr/bin/env node
// agy-fast Background & CLI Auto-Updater (zero-dependency ESM)


// src/updater.ts
import path3 from "node:path";
import { fileURLToPath } from "node:url";

// src/utils/updater-core.ts
import { spawn as spawn2 } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path2 from "node:path";

// src/utils/exec-utils.ts
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
var DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
var WINDOWS_CODEPAGE_LABELS = {
  866: "ibm866",
  874: "windows-874",
  936: "gb18030",
  54936: "gb18030",
  950: "big5",
  932: "shift_jis",
  949: "euc-kr",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  65001: "utf-8"
};
var strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
var cachedWindowsFallbackEncoding;
var fallbackDecoderCache = /* @__PURE__ */ new Map();
function parseWindowsCodePage(output) {
  const match = /\b(\d{3,5})\b/.exec(output);
  if (!match) return null;
  const cp = Number.parseInt(match[1], 10);
  const mapped = WINDOWS_CODEPAGE_LABELS[cp];
  return mapped && mapped !== "utf-8" ? mapped : null;
}
function stripTrailingIncompleteUtf8(buf) {
  if (buf.length === 0) return buf;
  let i = buf.length - 1;
  const minIdx = Math.max(0, buf.length - 4);
  while (i >= minIdx && (buf[i] & 192) === 128) {
    i--;
  }
  if (i < minIdx) return buf;
  const lead = buf[i];
  if ((lead & 128) === 0) return buf;
  let expectedLen = 0;
  if ((lead & 224) === 192) expectedLen = 2;
  else if ((lead & 240) === 224) expectedLen = 3;
  else if ((lead & 248) === 240) expectedLen = 4;
  else return buf;
  return buf.length - i < expectedLen ? buf.subarray(0, i) : buf;
}
function getWindowsSystem32Binary(name) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "";
  if (systemRoot) {
    return {
      bin: path.join(systemRoot, "System32", name),
      cwd: systemRoot
    };
  }
  return { bin: name, cwd: process.cwd() };
}
function getWindowsFallbackEncoding() {
  if (cachedWindowsFallbackEncoding !== void 0) {
    return cachedWindowsFallbackEncoding;
  }
  try {
    const { bin: chcpBin, cwd } = getWindowsSystem32Binary("chcp.com");
    const res = spawnSync(chcpBin, [], {
      cwd,
      encoding: "latin1",
      timeout: 1500,
      windowsHide: true
    });
    if (!res.error && res.status === 0) {
      const mapped = parseWindowsCodePage(res.stdout || "");
      if (mapped) {
        cachedWindowsFallbackEncoding = mapped;
        return cachedWindowsFallbackEncoding;
      }
    }
  } catch {
  }
  cachedWindowsFallbackEncoding = null;
  return null;
}
function decodeProcessOutput(buf, truncated = false, fallbackEncoding) {
  if (buf.length === 0) return "";
  const candidate = truncated ? stripTrailingIncompleteUtf8(buf) : buf;
  try {
    return strictUtf8Decoder.decode(candidate);
  } catch {
    const label = fallbackEncoding ?? (process.platform === "win32" ? getWindowsFallbackEncoding() : null);
    if (!label || label === "utf-8") {
      return buf.toString("utf8");
    }
    let decoder;
    try {
      const cached = fallbackDecoderCache.get(label);
      if (cached) {
        decoder = cached;
      } else {
        decoder = new TextDecoder(label);
        fallbackDecoderCache.set(label, decoder);
      }
    } catch {
      return buf.toString("utf8");
    }
    if (buf.indexOf(10) === -1) {
      return decoder.decode(buf);
    }
    const parts = [];
    let offset = 0;
    while (offset < buf.length) {
      const nl = buf.indexOf(10, offset);
      const end = nl === -1 ? buf.length : nl + 1;
      const line = buf.subarray(offset, end);
      const lineCandidate = truncated && end === buf.length ? stripTrailingIncompleteUtf8(line) : line;
      try {
        parts.push(strictUtf8Decoder.decode(lineCandidate));
      } catch {
        parts.push(decoder.decode(line));
      }
      offset = end;
    }
    return parts.join("");
  }
}
function killChildTree(pid, detached) {
  if (!pid) return null;
  if (process.platform === "win32") {
    const fallbackKill = () => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
      }
    };
    try {
      const { bin: taskkillBin, cwd } = getWindowsSystem32Binary("taskkill.exe");
      const killer = spawn(taskkillBin, ["/PID", String(pid), "/T", "/F"], {
        cwd,
        stdio: "ignore",
        windowsHide: true
      });
      killer.on("error", fallbackKill);
      killer.unref();
    } catch {
      fallbackKill();
    }
    return null;
  }
  try {
    if (detached) {
      process.kill(-pid, "SIGTERM");
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
  }
  const sigkillTimer = setTimeout(() => {
    try {
      if (detached) {
        process.kill(-pid, "SIGKILL");
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch {
    }
  }, 400);
  sigkillTimer.unref();
  return sigkillTimer;
}
function execBinaryAsync(bin, args, options) {
  return spawnAndCollect(bin, args, false, options);
}
function hasDefinedEnvKey(env, key, platform) {
  if (env[key] !== void 0) return true;
  if (platform !== "win32") return false;
  const upper = key.toUpperCase();
  for (const existing of Object.keys(env)) {
    if (existing.toUpperCase() === upper && env[existing] !== void 0) {
      return true;
    }
  }
  return false;
}
function withNonInteractiveGitEnv(baseEnv = process.env, platform = process.platform) {
  const result = { ...baseEnv };
  if (!hasDefinedEnvKey(baseEnv, "GIT_TERMINAL_PROMPT", platform)) {
    result.GIT_TERMINAL_PROMPT = "0";
  }
  if (!hasDefinedEnvKey(baseEnv, "GCM_INTERACTIVE", platform)) {
    result.GCM_INTERACTIVE = "never";
  }
  return result;
}
function spawnAndCollect(commandOrBin, args, shell, options) {
  const startMs = Date.now();
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const detached = process.platform !== "win32";
  return new Promise((resolve) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    const stdoutChunks = [];
    const stderrChunks = [];
    let child;
    try {
      child = spawn(commandOrBin, args, {
        cwd: options.cwd,
        shell,
        detached,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env ?? process.env
      });
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startMs,
        stdout: "",
        stderr: "",
        truncated: false,
        error: err instanceof Error ? err.message : String(err)
      });
      return;
    }
    let settleFallbackTimer = null;
    let sigkillTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      sigkillTimer = killChildTree(child.pid, detached);
      settleFallbackTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null, "SIGKILL");
      }, 1500);
      settleFallbackTimer.unref();
    }, Math.max(100, options.timeoutMs));
    timer.unref();
    const finish = (exitCode, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (settleFallbackTimer) clearTimeout(settleFallbackTimer);
      resolve({
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startMs,
        stdout: decodeProcessOutput(Buffer.concat(stdoutChunks), stdoutTruncated),
        stderr: decodeProcessOutput(Buffer.concat(stderrChunks), stderrTruncated),
        truncated: stdoutTruncated || stderrTruncated,
        error
      });
    };
    child.stdout?.on("data", (chunk) => {
      if (stdoutBytes >= maxOutputBytes) {
        stdoutTruncated = true;
        return;
      }
      const remaining = maxOutputBytes - stdoutBytes;
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        stdoutTruncated = true;
      } else {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr?.on("data", (chunk) => {
      if (stderrBytes >= maxOutputBytes) {
        stderrTruncated = true;
        return;
      }
      const remaining = maxOutputBytes - stderrBytes;
      if (chunk.length > remaining) {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += remaining;
        stderrTruncated = true;
      } else {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });
    child.on("error", (err) => {
      finish(null, null, err.message);
    });
    child.on("close", (code, signal) => {
      finish(code, signal);
    });
  });
}

// src/utils/updater-core.ts
var DEFAULT_REPO_URL = "https://github.com/INK-Q/agy-fast.git";
var DEFAULT_CHECK_INTERVAL_HOURS = 4;
var LOCK_STALE_MS = 10 * 60 * 1e3;
var UPDATER_RUNTIME_FILES = [
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
  "LICENSE"
];
var UPDATER_OPTIONAL_FILES = [
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
  "docs/ANALYSIS_REPORT.zh-CN.md"
];
var EAGER_MCP_TOOLS = [
  "batch_search",
  "apply_edits",
  "read_slices",
  "quick_outline",
  "run_checks"
];
function getHomeDir(env = process.env, platform = process.platform) {
  if (platform === "win32") {
    const userProfile = env.USERPROFILE?.trim();
    if (userProfile) return userProfile;
    const driveHome = env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}`.trim() : "";
    if (driveHome) return driveHome;
    const home = env.HOME?.trim();
    if (home) return home;
    return os.homedir();
  }
  return env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
}
function getUpdaterPaths(env = process.env) {
  const custom = env.AGY_FAST_CACHE_DIR?.trim();
  const cacheDir = custom ? path2.resolve(custom) : path2.join(getHomeDir(env), ".gemini", "cache", "agy-fast");
  return {
    cacheDir,
    stateFile: path2.join(cacheDir, "update-state.json"),
    configFile: path2.join(cacheDir, "config.json"),
    lockFile: path2.join(cacheDir, "update.lock")
  };
}
function parseSemver(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!m) return null;
  return [
    Number.parseInt(m[1], 10),
    Number.parseInt(m[2], 10),
    Number.parseInt(m[3], 10)
  ];
}
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return a.localeCompare(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}
function pickLatestSemverTag(lsRemoteOutput) {
  let best = null;
  for (const rawLine of lsRemoteOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const sha = parts[0];
    const ref = parts[1];
    if (!ref.startsWith("refs/tags/") || ref.endsWith("^{}")) continue;
    const tag = ref.slice("refs/tags/".length);
    const parsed = parseSemver(tag);
    if (!parsed) continue;
    const version = `${parsed[0]}.${parsed[1]}.${parsed[2]}`;
    if (!best || compareSemver(version, best.version) > 0) {
      best = { tag, version, commitSha: sha };
    }
  }
  return best;
}
function parseAutoUpdateMode(raw) {
  if (!raw) return null;
  const norm = raw.trim().toLowerCase();
  if (norm === "auto" || norm === "on" || norm === "1" || norm === "true") {
    return "auto";
  }
  if (norm === "notify" || norm === "check") {
    return "notify";
  }
  if (norm === "off" || norm === "0" || norm === "false" || norm === "disabled") {
    return "off";
  }
  return null;
}
function parseUpdateChannel(raw) {
  if (!raw) return null;
  const norm = raw.trim().toLowerCase();
  if (norm === "release" || norm === "stable") return "release";
  if (norm === "main" || norm === "nightly" || norm === "edge") return "main";
  return null;
}
async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
  }
  return null;
}
var tmpWriteSeq = 0;
async function writeJsonAtomically(filePath, data) {
  await fs.mkdir(path2.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${++tmpWriteSeq}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}
`, "utf8");
  try {
    await fs.rename(tmpPath, filePath);
  } catch {
    try {
      await fs.copyFile(tmpPath, filePath);
    } finally {
      await fs.rm(tmpPath, { force: true }).catch(() => {
      });
    }
  }
}
async function readUpdaterConfig(env = process.env) {
  const paths = getUpdaterPaths(env);
  return await readJsonFile(paths.configFile) ?? {};
}
async function readUpdateState(env = process.env) {
  const paths = getUpdaterPaths(env);
  return await readJsonFile(paths.stateFile) ?? {};
}
async function writeUpdateState(patch, env = process.env) {
  const paths = getUpdaterPaths(env);
  const existing = await readJsonFile(paths.stateFile) ?? {};
  const merged = { ...existing, ...patch };
  await writeJsonAtomically(paths.stateFile, merged);
  return merged;
}
async function skipUpdateVersion(rawVersion, env = process.env) {
  const parsed = parseSemver(rawVersion);
  if (!parsed) {
    throw new Error(
      `Invalid version '${rawVersion}'. Expected semver like 0.3.1 or v0.3.1.`
    );
  }
  const version = `${parsed[0]}.${parsed[1]}.${parsed[2]}`;
  const state = await writeUpdateState(
    {
      skippedVersion: version,
      notifiedAvailableVersion: version
    },
    env
  );
  return { version, state };
}
async function clearSkippedVersion(env = process.env) {
  return writeUpdateState(
    {
      skippedVersion: void 0,
      notifiedAvailableVersion: void 0
    },
    env
  );
}
function parseToolLoadingMode(raw) {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "eager" || v === "lazy") return v;
  return null;
}
async function applyToolLoadingToMcpConfig(pluginDir, mode) {
  const mcpPath = path2.join(pluginDir, "mcp_config.json");
  const cfg = await readJsonFile(mcpPath);
  if (!cfg) return false;
  const servers = cfg.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return false;
  }
  const fast = servers.fast;
  if (!fast || typeof fast !== "object" || Array.isArray(fast)) {
    return false;
  }
  const fastObj = fast;
  if (mode === "lazy") {
    delete fastObj.tools;
  } else {
    const toolsMap = {};
    for (const tool of EAGER_MCP_TOOLS) {
      toolsMap[tool] = { eager: true };
    }
    fastObj.tools = toolsMap;
  }
  await writeJsonAtomically(mcpPath, cfg);
  return true;
}
async function resolveUpdaterSettings(env = process.env) {
  const cfg = await readUpdaterConfig(env);
  const envMode = parseAutoUpdateMode(env.AGY_FAST_AUTO_UPDATE);
  const cfgMode = parseAutoUpdateMode(cfg.autoUpdate);
  const mode = envMode ?? cfgMode ?? "auto";
  const envHours = Number.parseFloat(env.AGY_FAST_UPDATE_INTERVAL_HOURS ?? "");
  const rawHours = Number.isFinite(envHours) && envHours >= 0.01 ? envHours : typeof cfg.checkIntervalHours === "number" && cfg.checkIntervalHours >= 0.01 ? cfg.checkIntervalHours : DEFAULT_CHECK_INTERVAL_HOURS;
  const checkIntervalHours = Math.max(0.01, Math.min(24 * 30, rawHours));
  const envChan = parseUpdateChannel(env.AGY_FAST_UPDATE_CHANNEL);
  const cfgChan = parseUpdateChannel(cfg.channel);
  const channel = envChan ?? cfgChan ?? "release";
  const envToolLoading = parseToolLoadingMode(env.AGY_FAST_TOOL_LOADING);
  const cfgToolLoading = parseToolLoadingMode(cfg.toolLoading);
  const toolLoading = envToolLoading ?? cfgToolLoading ?? "eager";
  const repoUrl = env.AGY_FAST_REPO?.trim() || cfg.repoUrl?.trim() || DEFAULT_REPO_URL;
  return {
    mode,
    checkIntervalHours,
    checkIntervalMs: Math.round(checkIntervalHours * 3600 * 1e3),
    channel,
    repoUrl,
    toolLoading
  };
}
async function readInstalledVersion(pluginDir) {
  const manifest = await readJsonFile(
    path2.join(pluginDir, "plugin.json")
  );
  if (manifest && typeof manifest.version === "string" && manifest.version.trim()) {
    return manifest.version.trim();
  }
  return "0.0.0";
}
async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
async function detectInstallKind(pluginDir) {
  const resolved = path2.resolve(pluginDir);
  try {
    const lst = await fs.lstat(resolved);
    if (lst.isSymbolicLink()) return "symlink";
  } catch {
    return "copied";
  }
  const hasGit = await pathExists(path2.join(resolved, ".git"));
  if (hasGit) {
    const statusRes = await execBinaryAsync("git", ["status", "--porcelain"], {
      cwd: resolved,
      timeoutMs: 4e3,
      env: withNonInteractiveGitEnv()
    });
    if (statusRes.error || statusRes.exitCode !== 0 || statusRes.stdout.trim() !== "") {
      return "git-dirty";
    }
    const norm = resolved.split(path2.sep).join("/").toLowerCase();
    const isPluginInstallDir = norm.endsWith("/plugins/agy-fast") || norm.includes("/plugins/agy-fast/");
    if (!isPluginInstallDir) {
      return "dev-source";
    }
    return "git-clone";
  }
  if (await pathExists(path2.join(resolved, "src"))) {
    return "dev-source";
  }
  return "copied";
}
function extractGithubSlug(repoUrl) {
  const m = /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
    repoUrl.trim()
  );
  if (!m?.[1] || m[1].includes("..")) return null;
  return m[1];
}
function buildGithubReleaseUrl(repoUrl, ref, commitSha) {
  const slug = extractGithubSlug(repoUrl);
  if (!slug) return void 0;
  const trimmedRef = ref?.trim();
  if (trimmedRef && parseSemver(trimmedRef)) {
    return `https://github.com/${slug}/releases/tag/${encodeURIComponent(trimmedRef)}`;
  }
  if (commitSha?.trim()) {
    return `https://github.com/${slug}/commit/${encodeURIComponent(commitSha.trim())}`;
  }
  if (trimmedRef) {
    return `https://github.com/${slug}/tree/${encodeURIComponent(trimmedRef)}`;
  }
  return `https://github.com/${slug}/releases`;
}
function sanitizeGithubHtmlUrl(raw, fallback) {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^https:\/\/github\.com\//i.test(trimmed)) {
      return trimmed;
    }
  }
  return fallback;
}
function validateRepoUrl(rawUrl) {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith("-") || /[\0\r\n]/.test(trimmed)) {
    throw new Error(`Invalid update repository URL: ${rawUrl}`);
  }
  return trimmed;
}
async function fetchLatestRemoteVersion(opts) {
  const safeRepoUrl = validateRepoUrl(opts.repoUrl);
  const timeoutMs = opts.timeoutMs ?? 8e3;
  const gitEnv = withNonInteractiveGitEnv(opts.env);
  const doFetch = opts.fetchFn ?? (typeof fetch === "function" ? fetch : void 0);
  const slug = extractGithubSlug(safeRepoUrl);
  const ghHeaders = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agy-fast-updater"
  };
  let gitUnavailableOrFailed = false;
  if (opts.channel === "release") {
    let confirmedUntagged = false;
    const tagsRes = await execBinaryAsync(
      "git",
      ["ls-remote", "--tags", "--refs", "--", safeRepoUrl],
      { cwd: os.tmpdir(), timeoutMs, env: gitEnv }
    );
    if (!tagsRes.error && !tagsRes.timedOut && tagsRes.exitCode === 0) {
      const latest = pickLatestSemverTag(tagsRes.stdout);
      if (latest) {
        return {
          ref: latest.tag,
          version: latest.version,
          commitSha: latest.commitSha,
          releaseUrl: buildGithubReleaseUrl(safeRepoUrl, latest.tag, latest.commitSha),
          source: "git-tags"
        };
      }
      confirmedUntagged = true;
    } else {
      gitUnavailableOrFailed = true;
      if (!slug || !doFetch) {
        throw new Error(
          tagsRes.stderr.trim() || tagsRes.error || (tagsRes.timedOut ? `Timed out checking releases from: ${safeRepoUrl}` : `Unable to reach update source: ${safeRepoUrl}`)
        );
      }
      const relRes = await doFetch(
        `https://api.github.com/repos/${slug}/releases/latest`,
        {
          headers: ghHeaders,
          signal: AbortSignal.timeout(timeoutMs)
        }
      );
      let checkTagsApi = false;
      if (relRes.ok) {
        const json = await relRes.json();
        if (typeof json.tag_name === "string") {
          const parsed = parseSemver(json.tag_name);
          if (parsed) {
            const tag = json.tag_name.trim();
            return {
              ref: tag,
              version: `${parsed[0]}.${parsed[1]}.${parsed[2]}`,
              releaseUrl: sanitizeGithubHtmlUrl(
                json.html_url,
                buildGithubReleaseUrl(safeRepoUrl, tag)
              ),
              publishedAt: typeof json.published_at === "string" ? json.published_at : void 0,
              source: "github-api"
            };
          }
        }
        checkTagsApi = true;
      } else if (relRes.status === 404) {
        checkTagsApi = true;
      } else {
        throw new Error(
          `GitHub releases API returned HTTP ${relRes.status} for ${slug}`
        );
      }
      if (checkTagsApi) {
        const tagsApiRes = await doFetch(
          `https://api.github.com/repos/${slug}/tags?per_page=30`,
          {
            headers: ghHeaders,
            signal: AbortSignal.timeout(timeoutMs)
          }
        );
        if (!tagsApiRes.ok) {
          throw new Error(
            `GitHub tags API returned HTTP ${tagsApiRes.status} for ${slug}`
          );
        }
        const rawTags = await tagsApiRes.json();
        if (!Array.isArray(rawTags)) {
          throw new Error(`Invalid GitHub tags API response for ${slug}`);
        }
        let best = null;
        for (const item of rawTags) {
          if (!item || typeof item !== "object") continue;
          const rec = item;
          if (typeof rec.name !== "string") continue;
          const parsed = parseSemver(rec.name);
          if (!parsed) continue;
          const version = `${parsed[0]}.${parsed[1]}.${parsed[2]}`;
          if (!best || compareSemver(version, best.version) > 0) {
            best = {
              tag: rec.name.trim(),
              version,
              commitSha: typeof rec.commit?.sha === "string" ? rec.commit.sha : void 0
            };
          }
        }
        if (best) {
          return {
            ref: best.tag,
            version: best.version,
            commitSha: best.commitSha,
            releaseUrl: buildGithubReleaseUrl(safeRepoUrl, best.tag, best.commitSha),
            source: "github-api"
          };
        }
        confirmedUntagged = true;
      }
    }
    if (!confirmedUntagged) {
      throw new Error(`Unable to determine release version from: ${safeRepoUrl}`);
    }
  }
  let headErr = "";
  if (!gitUnavailableOrFailed) {
    const headRes = await execBinaryAsync(
      "git",
      ["ls-remote", "--", safeRepoUrl, "refs/heads/main", "HEAD"],
      { cwd: os.tmpdir(), timeoutMs, env: gitEnv }
    );
    if (!headRes.error && !headRes.timedOut && headRes.exitCode === 0) {
      const entries = headRes.stdout.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length >= 2 && Boolean(parts[0]));
      const mainEntry = entries.find((parts) => parts[1] === "refs/heads/main");
      const chosen = mainEntry ?? entries[0];
      if (chosen?.[0]) {
        const ref = mainEntry ? "main" : "HEAD";
        return {
          ref,
          version: null,
          commitSha: chosen[0],
          releaseUrl: buildGithubReleaseUrl(safeRepoUrl, ref, chosen[0]),
          source: "git-main"
        };
      }
    }
    headErr = headRes.stderr.trim() || headRes.error || (headRes.timedOut ? `Timed out checking main branch from: ${safeRepoUrl}` : "");
  }
  if (slug && doFetch) {
    const commitRes = await doFetch(
      `https://api.github.com/repos/${slug}/commits/main`,
      {
        headers: ghHeaders,
        signal: AbortSignal.timeout(timeoutMs)
      }
    );
    if (!commitRes.ok) {
      throw new Error(
        `GitHub commits API returned HTTP ${commitRes.status} for ${slug}`
      );
    }
    const json = await commitRes.json();
    if (typeof json.sha === "string" && json.sha.trim()) {
      const sha = json.sha.trim();
      const publishedAt = typeof json.commit?.committer?.date === "string" ? json.commit.committer.date : typeof json.commit?.author?.date === "string" ? json.commit.author.date : void 0;
      return {
        ref: "main",
        version: null,
        commitSha: sha,
        releaseUrl: sanitizeGithubHtmlUrl(
          json.html_url,
          buildGithubReleaseUrl(safeRepoUrl, "main", sha)
        ),
        publishedAt,
        source: "github-api"
      };
    }
  }
  throw new Error(headErr || `Unable to reach update source: ${safeRepoUrl}`);
}
async function verifyStagedPlugin(stagingDir) {
  for (const rel of UPDATER_RUNTIME_FILES) {
    if (!await pathExists(path2.join(stagingDir, rel))) {
      return { ok: false, version: "0.0.0", reason: `Missing required file: ${rel}` };
    }
  }
  const manifest = await readJsonFile(
    path2.join(stagingDir, "plugin.json")
  );
  if (!manifest || manifest.name !== "agy-fast" || typeof manifest.version !== "string" || !parseSemver(manifest.version)) {
    return { ok: false, version: "0.0.0", reason: "Invalid staged plugin.json manifest" };
  }
  const mcpPath = path2.join(stagingDir, "dist", "mcp-server.mjs");
  const smokeOk = await new Promise((resolve) => {
    const child = spawn2(process.execPath, [mcpPath], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, 6e3);
    timer.unref();
    child.stdin.on("error", () => {
    });
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(false);
        return;
      }
      try {
        const lines = stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
        const listResp = lines.find((m) => m.id === 2);
        const tools = listResp?.result?.tools?.map((t) => t.name) ?? [];
        resolve(tools.length >= 4);
      } catch {
        resolve(false);
      }
    });
    const initMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "updater", version: "1" } }
    });
    const listMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    });
    child.stdin.write(`${initMsg}
${listMsg}
`);
    child.stdin.end();
  });
  if (!smokeOk) {
    return {
      ok: false,
      version: manifest.version,
      reason: "Staged MCP server smoke check failed"
    };
  }
  return { ok: true, version: manifest.version };
}
async function syncRuntimeFilesAtomically(srcRoot, dstRoot) {
  await fs.mkdir(dstRoot, { recursive: true });
  const runtimeWithoutManifest = UPDATER_RUNTIME_FILES.filter((rel) => rel !== "plugin.json");
  const toCopy = [...runtimeWithoutManifest];
  for (const opt of UPDATER_OPTIONAL_FILES) {
    if (await pathExists(path2.join(srcRoot, opt))) {
      toCopy.push(opt);
    }
  }
  toCopy.push("plugin.json");
  let seq = 0;
  for (const rel of toCopy) {
    const src = path2.join(srcRoot, rel);
    const dst = path2.join(dstRoot, rel);
    await fs.mkdir(path2.dirname(dst), { recursive: true });
    const tmp = `${dst}.agy-tmp.${process.pid}.${seq++}`;
    try {
      await fs.copyFile(src, tmp);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {
      });
      throw err;
    }
    try {
      await fs.rename(tmp, dst);
    } catch {
      try {
        await fs.copyFile(tmp, dst);
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => {
        });
      }
    }
  }
}
function isProcessDead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err?.code === "ESRCH";
  }
}
async function acquireUpdateLock(lockPath) {
  await fs.mkdir(path2.dirname(lockPath), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${++tmpWriteSeq}-${Math.random().toString(36).slice(2, 10)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, token, createdAt: (/* @__PURE__ */ new Date()).toISOString() }),
          "utf8"
        );
      } finally {
        await handle.close();
      }
      return token;
    } catch (err) {
      const code = err?.code;
      if (code !== "EEXIST") return null;
      try {
        const st = await fs.stat(lockPath);
        let stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
        if (!stale) {
          const info = await readJsonFile(lockPath);
          if (typeof info?.pid === "number" && info.pid !== process.pid && isProcessDead(info.pid)) {
            stale = true;
          }
        }
        if (stale) {
          const claimedPath = `${lockPath}.stale.${process.pid}.${++tmpWriteSeq}`;
          try {
            await fs.rename(lockPath, claimedPath);
            await fs.rm(claimedPath, { force: true }).catch(() => {
            });
          } catch {
          }
          continue;
        }
      } catch {
        continue;
      }
      return null;
    }
  }
  return null;
}
async function releaseUpdateLock(lockPath, token) {
  try {
    const info = await readJsonFile(lockPath);
    if (info?.token === token) {
      await fs.rm(lockPath, { force: true });
    }
  } catch {
  }
}
async function runPluginUpdate(opts) {
  const env = opts.env ?? process.env;
  const pluginDir = path2.resolve(opts.pluginDir);
  const paths = getUpdaterPaths(env);
  const settings = await resolveUpdaterSettings(env);
  const repoUrl = opts.repoUrl?.trim() || settings.repoUrl;
  const channel = opts.channel ?? settings.channel;
  const timeoutMs = opts.timeoutMs ?? 12e3;
  const currentVersion = await readInstalledVersion(pluginDir);
  const installKind = await detectInstallKind(pluginDir);
  if (opts.background && settings.mode === "off") {
    return {
      status: "skipped-disabled",
      currentVersion,
      latestVersion: null,
      installKind,
      message: "Auto-update is disabled."
    };
  }
  const lockToken = await acquireUpdateLock(paths.lockFile);
  if (!lockToken) {
    return {
      status: "skipped-locked",
      currentVersion,
      latestVersion: null,
      installKind,
      message: "Another update check is already in progress."
    };
  }
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  let stagingDir = "";
  try {
    const remote = await fetchLatestRemoteVersion({
      repoUrl,
      channel,
      timeoutMs,
      env,
      fetchFn: opts.fetchFn
    });
    const prevState = await readUpdateState(env);
    const hasNewerSemver = remote.version !== null && compareSemver(remote.version, currentVersion) > 0;
    const hasNewerMainCommit = remote.version === null && Boolean(remote.commitSha) && remote.commitSha !== prevState.lastAppliedCommit;
    if (!opts.force && !hasNewerSemver && !hasNewerMainCommit) {
      const clearStaleSkip = Boolean(prevState.skippedVersion) && compareSemver(prevState.skippedVersion, currentVersion) <= 0;
      await writeUpdateState(
        {
          lastCheckAt: nowIso,
          latestVersion: remote.version ?? currentVersion,
          latestRef: remote.ref,
          availableVersion: void 0,
          availableRef: void 0,
          availableCommit: void 0,
          availableReleaseUrl: void 0,
          availableInstallKind: void 0,
          availableReason: void 0,
          ...clearStaleSkip ? { skippedVersion: void 0 } : {},
          lastError: void 0
        },
        env
      );
      return {
        status: "up-to-date",
        currentVersion,
        latestVersion: remote.version ?? currentVersion,
        latestRef: remote.ref,
        commitSha: remote.commitSha,
        releaseUrl: remote.releaseUrl,
        publishedAt: remote.publishedAt,
        installKind,
        message: `agy-fast v${currentVersion} is already up to date.`
      };
    }
    const isSkippedInBackground = Boolean(
      opts.background && !opts.force && remote.version && prevState.skippedVersion === remote.version
    );
    const effectiveNotifyOnly = opts.checkOnly || isSkippedInBackground || opts.background && settings.mode === "notify" || installKind === "symlink" || installKind === "git-dirty" || installKind === "dev-source";
    if (effectiveNotifyOnly) {
      const reason = installKind === "symlink" ? "linked dev install" : installKind === "git-dirty" ? "uncommitted local changes" : installKind === "dev-source" ? "local source repo" : isSkippedInBackground ? "skipped by user" : settings.mode === "notify" ? "notify mode" : void 0;
      const shouldClearSkip = Boolean(prevState.skippedVersion) && (remote.version !== null && compareSemver(remote.version, prevState.skippedVersion) > 0 || compareSemver(prevState.skippedVersion, currentVersion) <= 0);
      await writeUpdateState(
        {
          lastCheckAt: nowIso,
          latestVersion: remote.version ?? void 0,
          latestRef: remote.ref,
          availableVersion: remote.version ?? void 0,
          availableRef: remote.ref,
          availableCommit: remote.commitSha,
          availableReleaseUrl: remote.releaseUrl,
          availableInstallKind: installKind,
          availableReason: reason,
          ...shouldClearSkip ? { skippedVersion: void 0 } : {},
          lastError: void 0
        },
        env
      );
      return {
        status: "available",
        currentVersion,
        latestVersion: remote.version,
        latestRef: remote.ref,
        commitSha: remote.commitSha,
        releaseUrl: remote.releaseUrl,
        publishedAt: remote.publishedAt,
        installKind,
        message: remote.version ? `Update available: v${currentVersion} -> v${remote.version}${reason ? ` (${reason})` : ""}.` : `Update available on branch '${remote.ref}'${reason ? ` (${reason})` : ""}.`
      };
    }
    stagingDir = path2.join(
      paths.cacheDir,
      `staging-${process.pid}-${Date.now()}`
    );
    await fs.mkdir(paths.cacheDir, { recursive: true });
    const gitEnv = withNonInteractiveGitEnv(env);
    const safeRepoUrl = validateRepoUrl(repoUrl);
    const cloneArgs = remote.ref === "HEAD" ? ["clone", "--depth", "1", "--", safeRepoUrl, stagingDir] : ["clone", "--depth", "1", "--branch", remote.ref, "--", safeRepoUrl, stagingDir];
    const cloneRes = await execBinaryAsync("git", cloneArgs, {
      cwd: paths.cacheDir,
      timeoutMs: Math.max(timeoutMs, 3e4),
      env: gitEnv
    });
    if (cloneRes.error || cloneRes.timedOut || cloneRes.exitCode !== 0) {
      throw new Error(
        cloneRes.stderr.trim() || cloneRes.error || `git clone failed for ${remote.ref}`
      );
    }
    const stagedCheck = await verifyStagedPlugin(stagingDir);
    if (!stagedCheck.ok) {
      throw new Error(stagedCheck.reason || "Staged plugin validation failed");
    }
    if (!opts.force && remote.version === null && (compareSemver(stagedCheck.version, currentVersion) < 0 || compareSemver(stagedCheck.version, currentVersion) === 0 && !prevState.lastAppliedCommit)) {
      await writeUpdateState(
        {
          lastCheckAt: nowIso,
          latestVersion: stagedCheck.version,
          latestRef: remote.ref,
          availableVersion: void 0,
          availableRef: void 0,
          availableCommit: void 0,
          availableReleaseUrl: void 0,
          availableInstallKind: void 0,
          availableReason: void 0,
          lastAppliedCommit: remote.commitSha,
          lastError: void 0
        },
        env
      );
      return {
        status: "up-to-date",
        currentVersion,
        latestVersion: stagedCheck.version,
        latestRef: remote.ref,
        commitSha: remote.commitSha,
        releaseUrl: remote.releaseUrl,
        publishedAt: remote.publishedAt,
        installKind,
        message: `agy-fast v${currentVersion} is already up to date.`
      };
    }
    if (installKind === "git-clone") {
      const fetchRes = await execBinaryAsync(
        "git",
        ["fetch", "--depth", "1", stagingDir, "HEAD"],
        { cwd: pluginDir, timeoutMs: Math.max(timeoutMs, 2e4), env: gitEnv }
      );
      if (fetchRes.error || fetchRes.timedOut || fetchRes.exitCode !== 0) {
        throw new Error(
          fetchRes.stderr.trim() || fetchRes.error || (fetchRes.timedOut ? "git fetch timed out in plugin clone" : "git fetch failed in plugin clone")
        );
      }
      const checkoutRes = await execBinaryAsync(
        "git",
        ["checkout", "-q", "FETCH_HEAD"],
        { cwd: pluginDir, timeoutMs: 1e4, env: gitEnv }
      );
      if (checkoutRes.error || checkoutRes.timedOut || checkoutRes.exitCode !== 0) {
        throw new Error(
          checkoutRes.stderr.trim() || checkoutRes.error || (checkoutRes.timedOut ? "git checkout timed out in plugin clone" : "git checkout failed in plugin clone")
        );
      }
    } else {
      await applyToolLoadingToMcpConfig(stagingDir, settings.toolLoading);
      await syncRuntimeFilesAtomically(stagingDir, pluginDir);
    }
    await writeUpdateState(
      {
        lastCheckAt: nowIso,
        latestVersion: stagedCheck.version,
        latestRef: remote.ref,
        availableVersion: void 0,
        availableRef: void 0,
        availableCommit: void 0,
        availableReleaseUrl: void 0,
        availableInstallKind: void 0,
        availableReason: void 0,
        skippedVersion: void 0,
        lastAppliedVersion: stagedCheck.version,
        lastAppliedFrom: currentVersion,
        lastAppliedAt: nowIso,
        lastAppliedCommit: remote.commitSha,
        notifiedAppliedVersion: opts.background ? void 0 : stagedCheck.version,
        lastError: void 0
      },
      env
    );
    return {
      status: "updated",
      currentVersion,
      latestVersion: stagedCheck.version,
      latestRef: remote.ref,
      commitSha: remote.commitSha,
      releaseUrl: remote.releaseUrl,
      publishedAt: remote.publishedAt,
      installKind,
      message: `Updated agy-fast v${currentVersion} -> v${stagedCheck.version} (${installKind}).`
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await writeUpdateState(
      {
        lastCheckAt: nowIso,
        lastError: errMsg.slice(0, 300)
      },
      env
    ).catch(() => {
    });
    return {
      status: "error",
      currentVersion,
      latestVersion: null,
      installKind,
      message: `Update check failed: ${errMsg}`,
      error: errMsg
    };
  } finally {
    if (stagingDir) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {
      });
    }
    await releaseUpdateLock(paths.lockFile, lockToken);
  }
}

// src/updater.ts
function requireFlagValue(args, idx, flag) {
  const next = args[idx + 1];
  if (!next || next.startsWith("-")) {
    throw new Error(`Missing value after ${flag}`);
  }
  return next;
}
function parseCliArgs(argv) {
  const args = argv.slice(2);
  const defaultPluginDir = path3.resolve(
    path3.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  let pluginDir = defaultPluginDir;
  let background = false;
  let checkOnly = false;
  let force = false;
  let json = false;
  let skipVersion;
  let clearSkip = false;
  let channel;
  let repoUrl;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--background") {
      background = true;
    } else if (a === "--check") {
      checkOnly = true;
    } else if (a === "--force") {
      force = true;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--clear-skip") {
      clearSkip = true;
    } else if (a === "--skip-version") {
      skipVersion = requireFlagValue(args, i, "--skip-version");
      i++;
    } else if (a === "--plugin-dir") {
      pluginDir = path3.resolve(requireFlagValue(args, i, "--plugin-dir"));
      i++;
    } else if (a === "--channel") {
      const val = requireFlagValue(args, i, "--channel");
      const parsed = parseUpdateChannel(val);
      if (!parsed) throw new Error(`Invalid --channel value (expected 'release' or 'main')`);
      channel = parsed;
      i++;
    } else if (a === "--repo") {
      repoUrl = requireFlagValue(args, i, "--repo");
      i++;
    } else {
      throw new Error(`Unknown updater option: ${a}`);
    }
  }
  return {
    pluginDir,
    background,
    checkOnly,
    force,
    json,
    skipVersion,
    clearSkip,
    channel,
    repoUrl
  };
}
async function main() {
  const opts = parseCliArgs(process.argv);
  if (opts.clearSkip) {
    await clearSkippedVersion();
    const res = {
      status: "cleared-skip",
      message: "Cleared skipped agy-fast version preference."
    };
    process.stdout.write(
      opts.json ? `${JSON.stringify(res, null, 2)}
` : `${res.message}
`
    );
    return;
  }
  if (opts.skipVersion) {
    const { version } = await skipUpdateVersion(opts.skipVersion);
    const res = {
      status: "skipped-version",
      skippedVersion: version,
      message: `Skipped agy-fast v${version}. You will be notified again when a newer release is published.`
    };
    process.stdout.write(
      opts.json ? `${JSON.stringify(res, null, 2)}
` : `${res.message}
`
    );
    return;
  }
  const result = await runPluginUpdate({
    pluginDir: opts.pluginDir,
    background: opts.background,
    checkOnly: opts.checkOnly,
    force: opts.force,
    channel: opts.channel,
    repoUrl: opts.repoUrl
  });
  if (opts.background) {
    return;
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
  } else {
    process.stdout.write(`${result.message}
`);
  }
  if (result.status === "error") {
    process.exitCode = 1;
  }
}
main().catch((err) => {
  if (!process.argv.includes("--background")) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (process.argv.includes("--json")) {
      process.stdout.write(
        `${JSON.stringify({ status: "error", message: errMsg, error: errMsg }, null, 2)}
`
      );
    } else {
      process.stderr.write(`Error: ${errMsg}
`);
    }
    process.exitCode = 1;
  }
});

// agy-fast SessionStart Hook (bundled zero-dependency ESM)


// src/session-start.ts
import { promises as fs3 } from "node:fs";
import path5 from "node:path";
import { fileURLToPath } from "node:url";

// src/utils/output-filter.ts
var DEFAULT_INLINE_MAX_BYTES = 8800;
function sliceUtf8Bytes(text, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.trunc(maxBytes);
  if (limit <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  let bytes = 0;
  let endIndex = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    const unitLen = cp > 65535 ? 2 : 1;
    const chBytes = cp <= 127 ? 1 : cp <= 2047 ? 2 : cp <= 65535 ? 3 : 4;
    if (bytes + chBytes > limit) break;
    bytes += chBytes;
    i += unitLen;
    endIndex = i;
  }
  return text.slice(0, endIndex);
}
function truncateWithByteNotice(text, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.trunc(maxBytes);
  if (limit <= 0) return "";
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= limit) return text;
  if (limit < 56) {
    if (limit <= 3) return sliceUtf8Bytes(text, limit);
    return `${sliceUtf8Bytes(text, limit - 3)}...`;
  }
  const maxNoticeBytes = Buffer.byteLength(
    `
... [truncated: showed ${totalBytes} of ${totalBytes} bytes]`,
    "utf8"
  );
  const cutoffBytes = Math.max(0, limit - maxNoticeBytes);
  if (cutoffBytes < 8) {
    return `${sliceUtf8Bytes(text, limit - 3)}...`;
  }
  let slice = sliceUtf8Bytes(text, cutoffBytes);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > 0 && Buffer.byteLength(slice.slice(0, lastNewline), "utf8") > cutoffBytes * 0.6) {
    slice = slice.slice(0, lastNewline);
  }
  const shownBytes = Buffer.byteLength(slice, "utf8");
  const result = `${slice}
... [truncated: showed ${shownBytes} of ${totalBytes} bytes]`;
  return Buffer.byteLength(result, "utf8") <= limit ? result : sliceUtf8Bytes(result, limit);
}
function sliceSafeChars(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  let end = limit;
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 55296 && lastCode <= 56319) {
    end -= 1;
  }
  return text.slice(0, end);
}

// src/utils/host-compat.ts
import { promises as fsp } from "node:fs";
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
var MCP_CALL_BUDGET_SEC = 170;
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

// src/utils/host-compat.ts
var HOST_COMPAT_RULES = [
  {
    id: "agy-cli-1.5-call-mcp-tool-empty-edits",
    surface: "cli",
    minVersion: "1.5.0",
    // Antigravity CLI >= 1.5.8 supports `"eager": true` in mcp_config.json,
    // which registers typed native mcp_agy-fast_fast_* tools and bypasses
    // lazy call_mcp_tool altogether (keeping token-saving native array edits).
    // Pre-eager CLI 1.5.0-1.5.7 keeps the JSON-string workaround automatically;
    // any lazy/custom setup can still opt in via AGY_FAST_EDITS_FORMAT=string.
    maxVersionExclusive: "1.5.8",
    editsFormat: "string",
    reason: "Pre-eager Antigravity CLI 1.5.0-1.5.7 loads tools lazily via call_mcp_tool where long native edits arrays can drop to []; JSON array string avoids payload loss"
  }
];
function parseHostSemverParts(raw) {
  const m = /(?:^|[^0-9.])v?(\d+)\.(\d+)\.(\d+)(?:\.\d+)?(?:-([0-9A-Za-z.-]+))?(?:$|[^0-9.])/.exec(
    raw.trim()
  );
  if (!m) return null;
  const major = Number.parseInt(m[1], 10);
  const minor = Number.parseInt(m[2], 10);
  const patch = Number.parseInt(m[3], 10);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch) || major > 999999 || minor > 999999 || patch > 999999) {
    return null;
  }
  return { major, minor, patch, prerelease: m[4] ?? null };
}
function formatHostSemverParts(parts) {
  const base = `${parts.major}.${parts.minor}.${parts.patch}`;
  return parts.prerelease ? `${base}-${parts.prerelease}` : base;
}
function comparePrerelease(a, b) {
  const aParts = a.split(".");
  const bParts = b.split(".");
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ai = aParts[i];
    const bi = bParts[i];
    if (ai === void 0) return -1;
    if (bi === void 0) return 1;
    if (ai === bi) continue;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const diff = Number.parseInt(ai, 10) - Number.parseInt(bi, 10);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}
function compareHostSemver(a, b) {
  const pa = parseHostSemverParts(a);
  const pb = parseHostSemverParts(b);
  if (!pa || !pb) return a.localeCompare(b);
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}
function parseEditsFormatMode(raw) {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "auto" || v === "array" || v === "string") return v;
  return null;
}
function parseHostOverride(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const m = /^(cli|desktop|app|antigravity|ide|unknown)(?:[@\-/\s](.+))?$/.exec(trimmed);
  if (!m) return null;
  const surface = m[1] === "app" || m[1] === "antigravity" ? "desktop" : m[1];
  if (m[2] !== void 0) {
    const parts = parseHostSemverParts(m[2]);
    if (!parts) return null;
    return { surface, version: formatHostSemverParts(parts) };
  }
  return { surface, version: null };
}
var EXPLICIT_THIRD_PARTY_CLIENT_RE = /^(?:claude(?:[-_\s]|$)|cursor(?:[-_\s]|$)|windsurf(?:[-_\s]|$)|vscode(?:[-_\s]|$)|visual[\s_-]+studio[\s_-]+code|codex(?:[-_\s]|$)|zed(?:[-_\s]|$)|cline(?:[-_\s]|$)|roo[-_\s]?code|continue(?:[-_\s]|$)|opencode(?:[-_\s]|$)|aider(?:[-_\s]|$)|goose(?:[-_\s]|$)|jetbrains(?:[-_\s]|$)|neovim(?:[-_\s]|$)|nvim(?:[-_\s]|$)|emacs(?:[-_\s]|$)|mcp[-_\s]?inspector(?:[-_\s]|$))/i;
function isExplicitThirdPartyClient(rawName) {
  if (typeof rawName !== "string") return false;
  return EXPLICIT_THIRD_PARTY_CLIENT_RE.test(rawName.trim());
}
function parseSurfaceFromClientName(rawName) {
  if (typeof rawName !== "string") return null;
  const s = rawName.trim().toLowerCase();
  if (!s || s.startsWith("agy-fast")) return null;
  if (/^(?:google[-_\s]?)?antigravity[-_\s]?cli$/.test(s) || /^agy(?:[-_\s]?cli)?$/.test(s)) {
    return "cli";
  }
  if (/^(?:google[-_\s]?)?antigravity[-_\s]?ide$/.test(s)) {
    return "ide";
  }
  if (/^(?:google[-_\s]?)?antigravity(?:[-_\s]?(?:2\.0|app|desktop))?$/.test(s)) {
    return "desktop";
  }
  return null;
}
function parseLsVersion(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parts = parseHostSemverParts(trimmed);
  const version = parts ? formatHostSemverParts(parts) : null;
  if (/^(?:antigravity[-_\s]?)?cli(?:[-_/@\s]|$)/i.test(trimmed)) {
    return { surface: "cli", version };
  }
  if (/^(?:antigravity[-_\s]?)?ide(?:[-_/@\s]|$)/i.test(trimmed)) {
    return { surface: "ide", version };
  }
  if (/^(?:antigravity[-_\s]?)?(?:desktop|app)(?:[-_/@\s]|$)/i.test(trimmed)) {
    return { surface: "desktop", version };
  }
  if (/^antigravity(?:[-_/@\s]|$)/i.test(trimmed)) {
    return { surface: "desktop", version };
  }
  if (version) {
    return { surface: null, version };
  }
  return null;
}
function parseSurfaceFromPath(rawPath, allowTrailingAppDir = false) {
  if (typeof rawPath !== "string" || !rawPath.trim()) return null;
  const segs = rawPath.trim().replace(/\\/g, "/").split("/").filter(Boolean).map((s) => s.toLowerCase());
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i] !== ".gemini") continue;
    const next = segs[i + 1];
    if (next === "antigravity-cli") return "cli";
    if (next === "antigravity-ide") return "ide";
    if (next === "antigravity") return "desktop";
  }
  if (allowTrailingAppDir && segs.length > 0) {
    const tail = segs[segs.length - 1];
    if (tail === "antigravity-cli") return "cli";
    if (tail === "antigravity-ide") return "ide";
    if (tail === "antigravity") return "desktop";
  }
  return null;
}
function detectHostIdentity(signals = {}) {
  const env = signals.env ?? process.env;
  const rawClientName = typeof signals.clientInfo?.name === "string" && signals.clientInfo.name.trim() ? signals.clientInfo.name.trim() : void 0;
  const rawClientVersion = typeof signals.clientInfo?.version === "string" && signals.clientInfo.version.trim() ? signals.clientInfo.version.trim() : void 0;
  const modelName = typeof signals.modelName === "string" && signals.modelName.trim() ? signals.modelName.trim() : void 0;
  const override = parseHostOverride(env.AGY_FAST_HOST);
  if (override) {
    return {
      surface: override.surface,
      version: override.version,
      source: "override",
      rawClientName,
      rawClientVersion,
      modelName
    };
  }
  if (isExplicitThirdPartyClient(rawClientName)) {
    return {
      surface: "unknown",
      version: null,
      source: "mcp:client-info",
      rawClientName,
      rawClientVersion,
      modelName
    };
  }
  const clientSurface = parseSurfaceFromClientName(rawClientName);
  const clientVerParts = clientSurface && rawClientVersion ? parseHostSemverParts(rawClientVersion) : null;
  const clientVersion = clientVerParts ? formatHostSemverParts(clientVerParts) : null;
  const hookSurface = parseSurfaceFromPath(signals.transcriptPath) ?? parseSurfaceFromPath(signals.artifactDirectoryPath);
  const lsInfo = parseLsVersion(env.ANTIGRAVITY_LS_VERSION);
  const appDataSurface = parseSurfaceFromPath(env.ANTIGRAVITY_APP_DATA_DIR, true);
  let surface = "unknown";
  let source = "unknown";
  if (clientSurface) {
    surface = clientSurface;
    source = "mcp:client-info";
  } else if (hookSurface) {
    surface = hookSurface;
    source = "hook:path";
  } else if (lsInfo?.surface) {
    surface = lsInfo.surface;
    source = "env:ls-version";
  } else if (appDataSurface) {
    surface = appDataSurface;
    source = "env:app-data-dir";
  }
  let version = null;
  if (clientSurface === surface && clientVersion) {
    version = clientVersion;
  } else if (surface !== "unknown" && lsInfo?.version && (lsInfo.surface === null || lsInfo.surface === surface)) {
    version = lsInfo.version;
  }
  return {
    surface,
    version,
    source,
    rawClientName,
    rawClientVersion,
    modelName
  };
}
function ruleMatchesIdentity(rule, identity) {
  if (rule.surface !== identity.surface) return false;
  if (rule.minVersion !== void 0 || rule.maxVersionExclusive !== void 0) {
    if (!identity.version) return false;
    if (rule.minVersion !== void 0 && compareHostSemver(identity.version, rule.minVersion) < 0) {
      return false;
    }
    if (rule.maxVersionExclusive !== void 0 && compareHostSemver(identity.version, rule.maxVersionExclusive) >= 0) {
      return false;
    }
  }
  return true;
}
function resolveHostCompat(signals = {}, rules = HOST_COMPAT_RULES) {
  const env = signals.env ?? process.env;
  const identity = detectHostIdentity(signals);
  let ruleEditsFormat;
  let callBudgetSec = MCP_CALL_BUDGET_SEC;
  let inlineMaxBytes = DEFAULT_INLINE_MAX_BYTES;
  const matchedRuleIds = [];
  const reasons = [];
  for (const rule of rules) {
    if (!ruleMatchesIdentity(rule, identity)) continue;
    matchedRuleIds.push(rule.id);
    if (rule.editsFormat !== void 0) ruleEditsFormat = rule.editsFormat;
    if (rule.callBudgetSec !== void 0) callBudgetSec = rule.callBudgetSec;
    if (rule.inlineMaxBytes !== void 0) inlineMaxBytes = rule.inlineMaxBytes;
    if (rule.reason) reasons.push(rule.reason);
  }
  const envMode = parseEditsFormatMode(env.AGY_FAST_EDITS_FORMAT);
  const cfgMode = parseEditsFormatMode(signals.configEditsFormat);
  let editsFormat = "array";
  let editsFormatSource = "token-saving-default";
  let reason = reasons[0] ?? "Defaulting to native array edits for lower output token usage (~2.6-3.3x cheaper than double-escaped JSON strings)";
  if (envMode === "array" || envMode === "string") {
    editsFormat = envMode;
    editsFormatSource = "env-override";
    reason = `Forced by AGY_FAST_EDITS_FORMAT=${envMode}`;
  } else if (envMode !== "auto" && (cfgMode === "array" || cfgMode === "string")) {
    editsFormat = cfgMode;
    editsFormatSource = "config-override";
    reason = `Configured in agy-fast config.json (editsFormat=${cfgMode})`;
  } else if (ruleEditsFormat !== void 0) {
    editsFormat = ruleEditsFormat;
    editsFormatSource = "compat-rule";
  }
  return {
    identity,
    editsFormat,
    editsFormatSource,
    callBudgetSec,
    inlineMaxBytes,
    matchedRuleIds,
    reason
  };
}
function formatHostLabel(identity) {
  return identity.version ? `${identity.surface}@${identity.version}` : identity.surface;
}
function formatSessionStartCompatNotice(compat) {
  if (compat.editsFormat !== "string") return null;
  const hostLabel = formatHostLabel(compat.identity);
  return `[agy-fast compat] host=${hostLabel} | apply_edits.edits (lazy call_mcp_tool mode): pass as JSON array string (not native array) to avoid call_mcp_tool [] drops.`;
}
function getConfigPath(env = process.env) {
  const custom = env.AGY_FAST_CACHE_DIR?.trim();
  const home = process.platform === "win32" ? env.USERPROFILE || env.HOME || os.homedir() : env.HOME || env.USERPROFILE || os.homedir();
  const cacheDir = custom ? path2.resolve(custom) : path2.join(home, ".gemini", "cache", "agy-fast");
  return path2.join(cacheDir, "config.json");
}
async function readSavedEditsFormat(env = process.env) {
  try {
    const raw = await fsp.readFile(getConfigPath(env), "utf8");
    const parsed = JSON.parse(raw);
    return parseEditsFormatMode(parsed?.editsFormat) ?? void 0;
  } catch {
    return void 0;
  }
}

// src/utils/snapshot.ts
import { promises as fs } from "node:fs";
import os2 from "node:os";
import path3 from "node:path";
import { performance } from "node:perf_hooks";

// src/utils/fs-utils.ts
var DEFAULT_IGNORE_DIRS = /* @__PURE__ */ new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  ".idea",
  "vendor"
]);

// src/utils/snapshot.ts
var DEFAULT_SCAN_TIMEOUT_MS = 250;
var HARDENED_GIT_BASE_ARGS = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "diff.external=",
  "-c",
  "gpg.program=false",
  "-c",
  "gpg.openpgp.program=false",
  "-c",
  "gpg.ssh.program=false",
  "-c",
  "gpg.x509.program=false",
  "--no-pager"
];
async function findGitEntry(workspaceDir) {
  let cur = path3.resolve(workspaceDir);
  while (true) {
    const candidate = path3.join(cur, ".git");
    try {
      await fs.lstat(candidate);
      return candidate;
    } catch {
    }
    const parent = path3.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
async function readBranchFromGitEntry(gitEntry) {
  if (!gitEntry) return null;
  try {
    const st = await fs.stat(gitEntry);
    let gitDir = gitEntry;
    if (st.isFile()) {
      const ptr = await fs.readFile(gitEntry, "utf8");
      const m = /^gitdir:\s*(.+)$/im.exec(ptr.trim());
      if (!m?.[1]) return null;
      gitDir = path3.resolve(path3.dirname(gitEntry), m[1].trim());
    }
    const headRaw = (await fs.readFile(path3.join(gitDir, "HEAD"), "utf8")).trim();
    const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(headRaw);
    return refMatch?.[1]?.trim() || "HEAD";
  } catch {
    return null;
  }
}
function parsePorcelainBranchHeader(headerLine) {
  const body = headerLine.slice(3).trim();
  const unbornMatch = /^(?:No commits yet|Initial commit) on (.+)$/.exec(body);
  if (unbornMatch?.[1]) {
    const branchOnly2 = unbornMatch[1].split("...")[0]?.trim() || "HEAD";
    return { branch: branchOnly2, isUnborn: true };
  }
  if (/^HEAD\s*\(no branch\)$/i.test(body)) {
    return { branch: "HEAD", isUnborn: false };
  }
  const branchOnly = body.split("...")[0]?.trim() || "HEAD";
  return { branch: branchOnly, isUnborn: false };
}
async function getGitSummary(workspaceDir, timeoutMs, gitExec = execBinaryAsync) {
  const hasExplicitGitEnv = Boolean(process.env.GIT_DIR || process.env.GIT_WORK_TREE);
  const gitEntry = hasExplicitGitEnv ? null : await findGitEntry(workspaceDir);
  if (!hasExplicitGitEnv && !gitEntry) {
    return null;
  }
  const gitEnv = withNonInteractiveGitEnv();
  const [statusRes, logRes] = await Promise.all([
    gitExec(
      "git",
      [...HARDENED_GIT_BASE_ARGS, "status", "--porcelain=v1", "--branch"],
      {
        cwd: workspaceDir,
        timeoutMs,
        maxOutputBytes: 32768,
        env: gitEnv
      }
    ),
    gitExec("git", [...HARDENED_GIT_BASE_ARGS, "log", "-n", "3", "--format=%h %s"], {
      cwd: workspaceDir,
      timeoutMs,
      maxOutputBytes: 8192,
      env: gitEnv
    })
  ]);
  const statusOk = !statusRes.error && !statusRes.timedOut && statusRes.exitCode === 0;
  const logOk = !logRes.error && !logRes.timedOut && logRes.exitCode === 0;
  const fallbackBranch = !statusOk && gitEntry ? await readBranchFromGitEntry(gitEntry) : null;
  if (!statusOk && !logOk && !(statusRes.timedOut && fallbackBranch)) {
    return null;
  }
  let branch = "HEAD";
  let isUnborn = false;
  let statusLines = [];
  if (statusOk) {
    const rawLines = statusRes.stdout.split(/\r?\n/);
    if (statusRes.truncated && rawLines.length > 1) {
      rawLines.pop();
    }
    const headerIdx = rawLines.findIndex((l) => l.startsWith("## "));
    if (headerIdx !== -1) {
      const parsed = parsePorcelainBranchHeader(rawLines[headerIdx]);
      branch = parsed.branch;
      isUnborn = parsed.isUnborn;
      rawLines.splice(headerIdx, 1);
    } else {
      branch = await readBranchFromGitEntry(gitEntry) ?? "HEAD";
    }
    statusLines = rawLines.filter((l) => {
      const trimmed = l.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith("?? ")) {
        const rawPath = trimmed.slice(3).replace(/^"/, "");
        const topSeg = rawPath.split("/")[0]?.replace(/\/$/, "");
        if (topSeg && DEFAULT_IGNORE_DIRS.has(topSeg)) return false;
      }
      return true;
    });
  } else {
    branch = fallbackBranch ?? "HEAD";
  }
  const logLines = logOk ? logRes.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  const parts = [
    isUnborn ? `Git: branch \`${branch}\` (unborn, no commits yet)` : `Git: branch \`${branch}\``
  ];
  if (!statusOk) {
    parts.push(
      statusRes.timedOut ? "Working tree: unknown (git status timed out)" : "Working tree: unknown (git status failed)"
    );
  } else if (statusLines.length === 0) {
    parts.push("Working tree: clean");
  } else {
    const countLabel = statusRes.truncated ? `${statusLines.length}+` : `${statusLines.length}`;
    const prefix = `Modified (${countLabel}): `;
    const maxModifiedChars = 260;
    const maxItems = 8;
    const shown = [];
    let currentLen = prefix.length;
    for (let i = 0; i < Math.min(statusLines.length, maxItems); i++) {
      const raw = statusLines[i].trim();
      const item = raw.length > 100 ? `${sliceSafeChars(raw, 97)}...` : raw;
      const sepLen = shown.length > 0 ? 2 : 0;
      const remainingAfter = statusLines.length - (i + 1);
      const moreReserve = remainingAfter > 0 || statusRes.truncated ? ` (+${remainingAfter} more)`.length : 0;
      if (shown.length > 0 && currentLen + sepLen + item.length + moreReserve > maxModifiedChars) {
        break;
      }
      shown.push(item);
      currentLen += sepLen + item.length;
    }
    const more = shown.length < statusLines.length ? ` (+${statusLines.length - shown.length}${statusRes.truncated ? "+" : ""} more)` : statusRes.truncated ? " (+more)" : "";
    parts.push(`${prefix}${shown.join(", ")}${more}`);
  }
  if (logLines.length > 0) {
    parts.push(
      `Recent commits:
${logLines.map((l) => `  - ${sliceSafeChars(l, 72)}`).join("\n")}`
    );
  }
  return parts.join("\n");
}
var SNAPSHOT_COLLAPSE_DIRS = /* @__PURE__ */ new Set([
  "tmp",
  "temp",
  "output",
  "outputs",
  "artifacts",
  "ssl",
  "SSL",
  "playwright-report",
  "test-results",
  "coverage",
  "logs"
]);
var SNAPSHOT_PRIORITY_SUBDIRS = /* @__PURE__ */ new Set([
  "src",
  "app",
  "lib",
  "packages",
  "server",
  "web",
  "client",
  "api",
  "tests",
  "test",
  "scripts"
]);
var SNAPSHOT_ALWAYS_SKIP_DIRS = /* @__PURE__ */ new Set([
  "appdata",
  "application data",
  "application support",
  "local settings",
  "program files",
  "program files (x86)",
  "programdata",
  "$recycle.bin",
  "system volume information",
  "onedrive",
  "icloud drive",
  "mobile documents",
  "creative cloud files",
  "msocache",
  "perflogs",
  "system32",
  "syswow64",
  "winsxs"
]);
var SNAPSHOT_HOME_ROOT_SKIP_DIRS = /* @__PURE__ */ new Set([
  "desktop",
  "documents",
  "downloads",
  "pictures",
  "photos",
  "movies",
  "videos",
  "music",
  "library",
  "applications",
  "public",
  "favorites",
  "contacts",
  "links",
  "saved games",
  "searches",
  "3d objects",
  "my documents",
  "my music",
  "my pictures",
  "my videos",
  "nethood",
  "printhood",
  "recent",
  "sendto",
  "start menu",
  "templates",
  "cookies",
  "documents and settings",
  "all users",
  "default user",
  "recovery",
  "windows",
  "users",
  "intel",
  "dropbox",
  "google drive",
  "parallels",
  "virtualbox vms",
  "trash",
  "proc",
  "sys",
  "dev",
  "mnt",
  "media",
  "run",
  "volumes",
  "private",
  "system"
]);
var DEFAULT_IGNORE_DIRS_LOWER = new Set(
  [...DEFAULT_IGNORE_DIRS].map((d) => d.toLowerCase())
);
var SNAPSHOT_COLLAPSE_DIRS_LOWER = new Set(
  [...SNAPSHOT_COLLAPSE_DIRS].map((d) => d.toLowerCase())
);
var SNAPSHOT_SKIP_FILES = /* @__PURE__ */ new Set([
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
  "ntuser.dat",
  "ntuser.ini"
]);
function isSystemUserParentPath(p) {
  const lowerPosix = p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return lowerPosix === "/users" || lowerPosix === "/home" || /^[a-z]:\/users$/i.test(lowerPosix) || /^[a-z]:\/documents and settings$/i.test(lowerPosix);
}
function normalizePathForCompare(p) {
  const resolved = path3.resolve(p);
  const root = path3.parse(resolved).root;
  const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/, "") : resolved;
  return process.platform === "win32" || process.platform === "darwin" ? trimmed.toLowerCase() : trimmed;
}
async function boundedRealpath(p, deadlineMs) {
  if (deadlineMs === void 0) {
    return fs.realpath(p).catch(() => p);
  }
  const res = await raceWithDeadline(fs.realpath(p), deadlineMs);
  return res.ok ? res.value : p;
}
async function isHomeOrSystemRoot(workspaceDir, deadlineMs) {
  const resolved = path3.resolve(workspaceDir);
  if (path3.parse(resolved).root === resolved) return true;
  if (isSystemUserParentPath(resolved)) return true;
  const homeCandidates = /* @__PURE__ */ new Set();
  for (const cand of [os2.homedir(), process.env.HOME, process.env.USERPROFILE]) {
    if (cand && cand.trim()) {
      homeCandidates.add(path3.resolve(cand.trim()));
    }
  }
  const resolvedKey = normalizePathForCompare(resolved);
  for (const cand of homeCandidates) {
    if (normalizePathForCompare(cand) === resolvedKey) return true;
  }
  const candList = [...homeCandidates];
  const [realWorkspace, ...realCands] = await Promise.all([
    boundedRealpath(resolved, deadlineMs),
    ...candList.map((cand) => boundedRealpath(cand, deadlineMs))
  ]);
  if (path3.parse(realWorkspace).root === realWorkspace) return true;
  if (isSystemUserParentPath(realWorkspace)) return true;
  const wsKeys = /* @__PURE__ */ new Set([resolvedKey, normalizePathForCompare(realWorkspace)]);
  for (const realCand of realCands) {
    if (wsKeys.has(normalizePathForCompare(realCand))) return true;
  }
  return false;
}
function isAlwaysSkippedDirName(name) {
  const lower = name.toLowerCase();
  return SNAPSHOT_ALWAYS_SKIP_DIRS.has(lower) || lower.startsWith("onedrive - ") || lower.startsWith("$recycle");
}
function isSkippedMetadataFile(name) {
  const lower = name.toLowerCase();
  return SNAPSHOT_SKIP_FILES.has(lower) || lower.startsWith("ntuser.dat");
}
function shouldSkipSnapshotEntry(name, isDir, isSymlink, isHomeRoot) {
  const lower = name.toLowerCase();
  if (isSkippedMetadataFile(name)) {
    return true;
  }
  if (isDir || isSymlink) {
    if (isAlwaysSkippedDirName(name)) return true;
    if (isHomeRoot && SNAPSHOT_HOME_ROOT_SKIP_DIRS.has(lower)) return true;
  }
  if (isDir) {
    if (name.startsWith(".")) return true;
    if (DEFAULT_IGNORE_DIRS_LOWER.has(lower)) return true;
  }
  return false;
}
var TIMEOUT_SENTINEL = Symbol("snapshot-timeout");
async function raceWithDeadline(promise, deadlineMs) {
  const remaining = deadlineMs - performance.now();
  if (remaining <= 0) {
    void promise.catch(() => {
    });
    return { ok: false, timedOut: true };
  }
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), remaining);
  });
  try {
    const res = await Promise.race([promise, timeoutPromise]);
    if (res === TIMEOUT_SENTINEL) {
      void promise.catch(() => {
      });
      return { ok: false, timedOut: true };
    }
    return { ok: true, value: res };
  } catch {
    return { ok: false, timedOut: false };
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
}
function isIgnoredSnapshotSubdir(name) {
  const lower = name.toLowerCase();
  if (name.startsWith(".") || DEFAULT_IGNORE_DIRS_LOWER.has(lower)) return true;
  if (isAlwaysSkippedDirName(name)) return true;
  if (lower === "playwright-report" || lower === "test-results" || lower.startsWith("dist-") || lower.startsWith("build-")) {
    return true;
  }
  return false;
}
var MANIFEST_SKIP_SUBDIRS_LOWER = new Set(
  [
    "docs",
    "doc",
    "assets",
    "scripts",
    "test",
    "tests",
    "fixtures",
    "examples",
    ...SNAPSHOT_COLLAPSE_DIRS
  ].map((d) => d.toLowerCase())
);
function shortEntryName(name, maxLen = 28) {
  return name.length > maxLen ? `${sliceSafeChars(name, maxLen - 3)}...` : name;
}
async function getTwoLevelTree(workspaceDir, topRes, isHomeRoot, deadlineMs) {
  if (!topRes.ok) {
    return topRes.timedOut ? "Layout (2 levels):\n  ... (scan timed out)" : null;
  }
  const topEntries = topRes.value;
  const filteredTop = topEntries.filter(
    (e) => !shouldSkipSnapshotEntry(
      e.name,
      e.isDirectory(),
      e.isSymbolicLink(),
      isHomeRoot
    )
  ).sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    const aCollapse = a.isDirectory() && SNAPSHOT_COLLAPSE_DIRS_LOWER.has(a.name.toLowerCase());
    const bCollapse = b.isDirectory() && SNAPSHOT_COLLAPSE_DIRS_LOWER.has(b.name.toLowerCase());
    if (aCollapse !== bCollapse) return aCollapse ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  if (filteredTop.length === 0) return null;
  const lines = [];
  const maxTop = 20;
  const shownTop = filteredTop.slice(0, maxTop);
  if (isHomeRoot) {
    for (const entry of shownTop) {
      lines.push(
        entry.isDirectory() ? `  ${entry.name}/` : `  ${shortEntryName(entry.name)}`
      );
    }
    if (filteredTop.length > maxTop) {
      lines.push(`  ... (+${filteredTop.length - maxTop} more top-level entries)`);
    }
    return `Layout (1 level):
${lines.join("\n")}`;
  }
  const subResults = new Array(shownTop.length);
  let nextIdx = 0;
  const workerCount = Math.min(4, shownTop.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = nextIdx++;
        if (idx >= shownTop.length) break;
        const entry = shownTop[idx];
        if (!entry.isDirectory()) {
          subResults[idx] = {
            name: shortEntryName(entry.name),
            isDir: false,
            collapsedCount: null,
            children: [],
            more: 0,
            timedOut: false
          };
          continue;
        }
        if (performance.now() >= deadlineMs) {
          subResults[idx] = {
            name: `${entry.name}/`,
            isDir: true,
            collapsedCount: null,
            children: [],
            more: 0,
            timedOut: true
          };
          continue;
        }
        const subRes = await raceWithDeadline(
          fs.readdir(path3.join(workspaceDir, entry.name), {
            withFileTypes: true
          }),
          deadlineMs
        );
        if (!subRes.ok) {
          subResults[idx] = {
            name: `${entry.name}/`,
            isDir: true,
            collapsedCount: null,
            children: [],
            more: 0,
            timedOut: subRes.timedOut
          };
          continue;
        }
        const valid = subRes.value.filter(
          (s) => !isSkippedMetadataFile(s.name) && !(s.isDirectory() && isIgnoredSnapshotSubdir(s.name)) && !(s.isSymbolicLink() && isAlwaysSkippedDirName(s.name))
        ).sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          if (a.isDirectory() && b.isDirectory()) {
            const aPrio = SNAPSHOT_PRIORITY_SUBDIRS.has(a.name);
            const bPrio = SNAPSHOT_PRIORITY_SUBDIRS.has(b.name);
            if (aPrio !== bPrio) return aPrio ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });
        if (SNAPSHOT_COLLAPSE_DIRS_LOWER.has(entry.name.toLowerCase())) {
          subResults[idx] = {
            name: `${entry.name}/`,
            isDir: true,
            collapsedCount: valid.length,
            children: [],
            more: 0,
            timedOut: false
          };
          continue;
        }
        const maxSub = 6;
        const children = valid.slice(0, maxSub).map((s) => {
          const base = shortEntryName(s.name);
          return s.isDirectory() ? `${base}/` : base;
        });
        subResults[idx] = {
          name: `${entry.name}/`,
          isDir: true,
          collapsedCount: null,
          children,
          more: Math.max(0, valid.length - maxSub),
          timedOut: false
        };
      }
    })
  );
  let timedOutDirs = 0;
  for (const item of subResults) {
    if (item.timedOut) timedOutDirs++;
    if (!item.isDir) {
      lines.push(`  ${item.name}`);
    } else if (item.collapsedCount !== null) {
      lines.push(`  ${item.name} (${item.collapsedCount} entries)`);
    } else if (item.children.length === 0) {
      lines.push(`  ${item.name}`);
    } else {
      const more = item.more > 0 ? `, +${item.more}` : "";
      lines.push(`  ${item.name} (${item.children.join(", ")}${more})`);
    }
  }
  if (filteredTop.length > maxTop) {
    lines.push(`  ... (+${filteredTop.length - maxTop} more top-level entries)`);
  }
  if (timedOutDirs > 0) {
    lines.push(
      `  ... (${timedOutDirs} dir${timedOutDirs === 1 ? "" : "s"} skipped; scan timed out)`
    );
  }
  return `Layout (2 levels):
${lines.join("\n")}`;
}
async function detectManifestsInDir(dirPath, prefix, knownFiles) {
  const hints = [];
  const hasFile = (name) => !knownFiles || knownFiles.has(name);
  await Promise.all([
    // package.json
    (async () => {
      if (!hasFile("package.json")) return;
      try {
        const raw = await fs.readFile(path3.join(dirPath, "package.json"), "utf8");
        const pkg = JSON.parse(raw);
        const pkgName = typeof pkg.name === "string" ? pkg.name.trim() : "";
        const scriptNames = pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts) ? Object.keys(pkg.scripts).slice(0, 12) : [];
        const label = pkgName ? `${prefix}package.json (${pkgName})` : `${prefix}package.json`;
        hints.push(
          scriptNames.length > 0 ? `${label} scripts: ${scriptNames.join(", ")}` : label
        );
      } catch {
      }
    })(),
    // Makefile (root only to avoid noisy nested Makefiles)
    (async () => {
      if (prefix) return;
      for (const name of ["Makefile", "makefile"]) {
        if (!hasFile(name)) continue;
        try {
          const raw = await fs.readFile(path3.join(dirPath, name), "utf8");
          const targets = [];
          for (const line of raw.split(/\r?\n/)) {
            const m = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line);
            if (m && m[1] && !m[1].startsWith(".")) {
              if (!targets.includes(m[1])) targets.push(m[1]);
              if (targets.length >= 10) break;
            }
          }
          hints.push(
            targets.length > 0 ? `${name} targets: ${targets.join(", ")}` : name
          );
          break;
        } catch {
        }
      }
    })(),
    // pom.xml (Maven)
    (async () => {
      if (!hasFile("pom.xml")) return;
      try {
        const raw = await fs.readFile(path3.join(dirPath, "pom.xml"), "utf8");
        const stripped = raw.replace(/<parent>[\s\S]*?<\/parent>/i, "");
        const m = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/i.exec(stripped);
        hints.push(
          m?.[1] ? `${prefix}pom.xml (${m[1]}, maven)` : `${prefix}pom.xml (maven)`
        );
      } catch {
      }
    })(),
    // build.gradle / build.gradle.kts
    (async () => {
      for (const name of ["build.gradle.kts", "build.gradle"]) {
        if (!hasFile(name)) continue;
        try {
          await fs.access(path3.join(dirPath, name));
          hints.push(`${prefix}${name} (gradle)`);
          break;
        } catch {
        }
      }
    })(),
    // pyproject.toml
    (async () => {
      if (!hasFile("pyproject.toml")) return;
      try {
        const raw = await fs.readFile(path3.join(dirPath, "pyproject.toml"), "utf8");
        const tools = [];
        if (/\[tool\.pytest/.test(raw)) tools.push("pytest");
        if (/\[tool\.ruff/.test(raw)) tools.push("ruff");
        if (/\[tool\.mypy/.test(raw)) tools.push("mypy");
        if (/\[tool\.poetry/.test(raw)) tools.push("poetry");
        if (/\[tool\.uv/.test(raw)) tools.push("uv");
        hints.push(
          tools.length > 0 ? `${prefix}pyproject.toml (${tools.join(", ")})` : `${prefix}pyproject.toml`
        );
      } catch {
      }
    })(),
    // Cargo.toml
    (async () => {
      if (!hasFile("Cargo.toml")) return;
      try {
        const raw = await fs.readFile(path3.join(dirPath, "Cargo.toml"), "utf8");
        const isWorkspace = /\[workspace\]/.test(raw);
        hints.push(
          isWorkspace ? `${prefix}Cargo.toml (workspace)` : `${prefix}Cargo.toml`
        );
      } catch {
      }
    })(),
    // go.mod
    (async () => {
      if (!hasFile("go.mod")) return;
      try {
        const raw = await fs.readFile(path3.join(dirPath, "go.mod"), "utf8");
        const m = /^module\s+(\S+)/m.exec(raw);
        hints.push(m?.[1] ? `${prefix}go.mod (${m[1]})` : `${prefix}go.mod`);
      } catch {
      }
    })()
  ]);
  return hints;
}
async function getProjectManifestSummary(workspaceDir, topRes, isHomeRoot, deadlineMs) {
  const rootKnownFiles = topRes.ok ? new Set(topRes.value.filter((e) => !e.isDirectory()).map((e) => e.name)) : void 0;
  const rootRes = await raceWithDeadline(
    detectManifestsInDir(workspaceDir, "", rootKnownFiles),
    deadlineMs
  );
  const rootHints = rootRes.ok ? [...rootRes.value].sort() : [];
  const subHints = [];
  if (!isHomeRoot && performance.now() < deadlineMs && topRes.ok) {
    const subdirs = topRes.value.filter(
      (e) => e.isDirectory() && !shouldSkipSnapshotEntry(e.name, true, false, isHomeRoot) && !MANIFEST_SKIP_SUBDIRS_LOWER.has(e.name.toLowerCase())
    ).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 8);
    let nextIdx = 0;
    const workerCount = Math.min(4, subdirs.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const idx = nextIdx++;
          if (idx >= subdirs.length || performance.now() >= deadlineMs) break;
          const d = subdirs[idx];
          const res = await raceWithDeadline(
            detectManifestsInDir(path3.join(workspaceDir, d.name), `${d.name}/`),
            deadlineMs
          );
          if (res.ok) {
            subHints.push(...res.value);
          }
        }
      })
    );
  }
  subHints.sort();
  const allHints = [...rootHints, ...subHints];
  if (allHints.length === 0) return null;
  return `Project:
${allHints.slice(0, 6).map((h) => `  - ${h}`).join("\n")}`;
}
function fitSectionToChars(section, budget, marker) {
  if (!Number.isFinite(budget) || budget <= 0) return "";
  const limit = Math.trunc(budget);
  if (limit <= 0) return "";
  if (section.length <= limit) return section;
  if (limit <= marker.length + 1) {
    return sliceSafeChars(section, limit);
  }
  const cutoff = limit - marker.length - 1;
  let trimmed = sliceSafeChars(section, cutoff);
  const lastNl = trimmed.lastIndexOf("\n");
  if (lastNl > 0) {
    trimmed = trimmed.slice(0, lastNl);
  }
  return `${trimmed}
${marker}`;
}
function fitSectionToBytes(section, budgetBytes, marker) {
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) return "";
  const limit = Math.trunc(budgetBytes);
  if (limit <= 0) return "";
  if (Buffer.byteLength(section, "utf8") <= limit) return section;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (limit <= markerBytes + 1) {
    return sliceUtf8Bytes(section, limit);
  }
  const cutoffBytes = limit - markerBytes - 1;
  let trimmed = sliceUtf8Bytes(section, cutoffBytes);
  const lastNl = trimmed.lastIndexOf("\n");
  if (lastNl > 0) {
    trimmed = trimmed.slice(0, lastNl);
  }
  const result = `${trimmed}
${marker}`;
  return Buffer.byteLength(result, "utf8") <= limit ? result : sliceUtf8Bytes(result, limit);
}
async function buildWorkspaceSnapshot(workspaceDir, options = {}) {
  const maxChars = typeof options.maxChars === "number" && Number.isFinite(options.maxChars) ? Math.max(0, Math.trunc(options.maxChars)) : 1500;
  const maxBytes = typeof options.maxBytes === "number" && Number.isFinite(options.maxBytes) ? Math.max(0, Math.trunc(options.maxBytes)) : maxChars;
  const gitTimeoutMs = options.gitTimeoutMs ?? 800;
  const scanTimeoutMs = typeof options.scanTimeoutMs === "number" && Number.isFinite(options.scanTimeoutMs) ? Math.max(1, Math.trunc(options.scanTimeoutMs)) : DEFAULT_SCAN_TIMEOUT_MS;
  const scanDeadline = performance.now() + scanTimeoutMs;
  const statRes = await raceWithDeadline(fs.stat(workspaceDir), scanDeadline);
  if (!statRes.ok || !statRes.value.isDirectory()) return null;
  const gitPromise = getGitSummary(workspaceDir, gitTimeoutMs, options.gitExec);
  const [isHomeRoot, topRes] = await Promise.all([
    isHomeOrSystemRoot(workspaceDir, scanDeadline),
    raceWithDeadline(
      fs.readdir(workspaceDir, { withFileTypes: true }),
      scanDeadline
    )
  ]);
  const [gitSummary, treeSummary, projectSummary] = await Promise.all([
    gitPromise,
    getTwoLevelTree(workspaceDir, topRes, isHomeRoot, scanDeadline),
    getProjectManifestSummary(workspaceDir, topRes, isHomeRoot, scanDeadline)
  ]);
  const header = `[agy-fast startup snapshot] Workspace: ${workspaceDir}`;
  const sections = [header, gitSummary, projectSummary, treeSummary].filter(
    (s) => Boolean(s)
  );
  if (sections.length <= 1) return null;
  const full = sections.join("\n");
  if (full.length <= maxChars && Buffer.byteLength(full, "utf8") <= maxBytes) {
    return full;
  }
  const suffix = "... [snapshot capped]";
  const headerBytes = Buffer.byteLength(header, "utf8");
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (maxChars <= header.length + suffix.length + 4 || maxBytes <= headerBytes + suffixBytes + 4) {
    const charCapped = fitSectionToChars(full, maxChars, suffix);
    return Buffer.byteLength(charCapped, "utf8") <= maxBytes ? charCapped : truncateWithByteNotice(charCapped, maxBytes);
  }
  const remainingAfterHeader = maxBytes - headerBytes;
  const nonEmptyCount = (gitSummary ? 1 : 0) + (projectSummary ? 1 : 0) + (treeSummary ? 1 : 0);
  const availableForBodies = remainingAfterHeader - nonEmptyCount;
  let projectPart = "";
  let gitPart = "";
  let treePart = "";
  let budgetLeft = availableForBodies;
  if (projectSummary) {
    const otherPresent = Boolean(gitSummary || treeSummary);
    const projectBytes = Buffer.byteLength(projectSummary, "utf8");
    const projectCap = otherPresent ? Math.min(projectBytes, Math.max(80, Math.floor(availableForBodies * 0.25))) : budgetLeft;
    projectPart = fitSectionToBytes(
      projectSummary,
      Math.min(budgetLeft, projectCap),
      "  ... [project capped]"
    );
    budgetLeft -= Buffer.byteLength(projectPart, "utf8");
  }
  if (gitSummary && budgetLeft > 0) {
    const gitBytes = Buffer.byteLength(gitSummary, "utf8");
    const gitCap = treeSummary ? Math.min(gitBytes, Math.max(100, Math.floor(budgetLeft * 0.48))) : budgetLeft;
    gitPart = fitSectionToBytes(
      gitSummary,
      Math.min(budgetLeft, gitCap),
      "  ... [git capped]"
    );
    budgetLeft -= Buffer.byteLength(gitPart, "utf8");
  }
  if (treeSummary && budgetLeft > 0) {
    treePart = fitSectionToBytes(treeSummary, budgetLeft, suffix);
    budgetLeft -= Buffer.byteLength(treePart, "utf8");
  }
  let assembled = [header, gitPart, projectPart, treePart].filter(Boolean).join("\n");
  if (assembled.length > maxChars) {
    assembled = fitSectionToChars(assembled, maxChars, suffix);
  }
  if (Buffer.byteLength(assembled, "utf8") > maxBytes) {
    assembled = fitSectionToBytes(assembled, maxBytes, suffix);
  }
  return assembled;
}

// src/utils/updater-core.ts
import { spawn as spawn2 } from "node:child_process";
import { promises as fs2 } from "node:fs";
import os3 from "node:os";
import path4 from "node:path";
var DEFAULT_REPO_URL = "https://github.com/INK-Q/agy-fast.git";
var DEFAULT_CHECK_INTERVAL_HOURS = 4;
var LOCK_STALE_MS = 10 * 60 * 1e3;
function getHomeDir(env = process.env, platform = process.platform) {
  if (platform === "win32") {
    const userProfile = env.USERPROFILE?.trim();
    if (userProfile) return userProfile;
    const driveHome = env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}`.trim() : "";
    if (driveHome) return driveHome;
    const home = env.HOME?.trim();
    if (home) return home;
    return os3.homedir();
  }
  return env.HOME?.trim() || env.USERPROFILE?.trim() || os3.homedir();
}
function getUpdaterPaths(env = process.env) {
  const custom = env.AGY_FAST_CACHE_DIR?.trim();
  const cacheDir = custom ? path4.resolve(custom) : path4.join(getHomeDir(env), ".gemini", "cache", "agy-fast");
  return {
    cacheDir,
    stateFile: path4.join(cacheDir, "update-state.json"),
    configFile: path4.join(cacheDir, "config.json"),
    lockFile: path4.join(cacheDir, "update.lock")
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
    const raw = await fs2.readFile(filePath, "utf8");
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
  await fs2.mkdir(path4.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${++tmpWriteSeq}`;
  await fs2.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}
`, "utf8");
  try {
    await fs2.rename(tmpPath, filePath);
  } catch {
    try {
      await fs2.copyFile(tmpPath, filePath);
    } finally {
      await fs2.rm(tmpPath, { force: true }).catch(() => {
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
function parseToolLoadingMode(raw) {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "eager" || v === "lazy") return v;
  return null;
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
    path4.join(pluginDir, "plugin.json")
  );
  if (manifest && typeof manifest.version === "string" && manifest.version.trim()) {
    return manifest.version.trim();
  }
  return "0.0.0";
}
function shouldTriggerBackgroundCheck(state, nowMs, intervalMs) {
  const lastCompleted = state.lastCheckAt ? Date.parse(state.lastCheckAt) : NaN;
  const lastAttempt = state.lastCheckAttemptAt ? Date.parse(state.lastCheckAttemptAt) : NaN;
  if (Number.isFinite(lastCompleted) && nowMs - lastCompleted < intervalMs) {
    return false;
  }
  if (Number.isFinite(lastAttempt) && nowMs - lastAttempt < Math.min(intervalMs, 5 * 60 * 1e3)) {
    return false;
  }
  return true;
}
async function consumeSnapshotUpdateNotice(pluginDir, currentVersion, env = process.env) {
  const state = await readUpdateState(env);
  if (state.lastAppliedVersion && state.lastAppliedVersion === currentVersion && state.lastAppliedFrom && state.lastAppliedFrom !== currentVersion && state.notifiedAppliedVersion !== currentVersion) {
    await writeUpdateState({ notifiedAppliedVersion: currentVersion }, env).catch(
      () => {
      }
    );
    return `[agy-fast] Auto-updated v${state.lastAppliedFrom} -> v${currentVersion} (rules/hooks active now; reload Desktop/IDE window if MCP was already running).`;
  }
  const installerPath = path4.join(pluginDir, "scripts", "install.mjs");
  const isManualInstall = state.availableInstallKind === "symlink" || state.availableInstallKind === "dev-source" || state.availableInstallKind === "git-dirty";
  if (state.availableVersion && compareSemver(state.availableVersion, currentVersion) > 0) {
    if (state.skippedVersion === state.availableVersion || state.notifiedAvailableVersion === state.availableVersion) {
      return null;
    }
    await writeUpdateState(
      { notifiedAvailableVersion: state.availableVersion },
      env
    ).catch(() => {
    });
    const ver = state.availableVersion;
    const reason = state.availableReason ? ` (${state.availableReason})` : "";
    const urlSuffix = state.availableReleaseUrl ? ` | ${state.availableReleaseUrl}` : "";
    if (isManualInstall) {
      return `[agy-fast] Update available: v${currentVersion} -> v${ver}${reason}. Pull & build in repo, or skip: node "${installerPath}" update --skip-version ${ver}${urlSuffix}`;
    }
    return `[agy-fast] Update available: v${currentVersion} -> v${ver}${reason}. Run: node "${installerPath}" update --prompt (or --skip-version ${ver})${urlSuffix}`;
  }
  if (!state.availableVersion && state.availableCommit && state.availableCommit !== state.lastAppliedCommit && state.notifiedAvailableCommit !== state.availableCommit) {
    await writeUpdateState(
      { notifiedAvailableCommit: state.availableCommit },
      env
    ).catch(() => {
    });
    const refLabel = state.availableRef || "main";
    const shortSha = state.availableCommit.slice(0, 7);
    const reason = state.availableReason ? ` (${state.availableReason})` : "";
    const urlSuffix = state.availableReleaseUrl ? ` | ${state.availableReleaseUrl}` : "";
    if (isManualInstall) {
      return `[agy-fast] Update available on ${refLabel} (${shortSha})${reason}. Pull & build in repo.${urlSuffix}`;
    }
    return `[agy-fast] Update available on ${refLabel} (${shortSha})${reason}. Run: node "${installerPath}" update --prompt${urlSuffix}`;
  }
  return null;
}
function spawnBackgroundUpdateCheck(pluginDir, env = process.env) {
  const updaterPath = path4.join(pluginDir, "dist", "updater.mjs");
  try {
    const child = spawn2(
      process.execPath,
      [updaterPath, "--background", "--plugin-dir", pluginDir],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env
      }
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// src/session-start.ts
function firstNonEmptyPath(list) {
  if (!Array.isArray(list)) return "";
  for (const item of list) {
    if (typeof item === "string" && item.trim()) {
      return item.trim();
    }
  }
  return "";
}
var MAX_STDIN_BYTES = 256 * 1024;
var MAX_SNAPSHOT_BYTES = 1500;
async function readStdin(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const endsWithCloseBrace = (buf) => {
      for (let i = buf.length - 1; i >= 0; i--) {
        const b = buf[i];
        if (b === 32 || b === 9 || b === 10 || b === 13) continue;
        return b === 125;
      }
      return false;
    };
    const hasCompleteJsonObject = () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text.startsWith("{") || !text.endsWith("}")) return false;
      try {
        const parsed = JSON.parse(text);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
      } catch {
        return false;
      }
    };
    const onData = (chunk) => {
      if (settled) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const remaining = MAX_STDIN_BYTES - totalBytes;
      if (remaining <= 0) {
        finish();
        return;
      }
      if (buf.length > remaining) {
        chunks.push(buf.subarray(0, remaining));
        totalBytes += remaining;
        finish();
      } else {
        chunks.push(buf);
        totalBytes += buf.length;
        if (endsWithCloseBrace(buf) && hasCompleteJsonObject()) {
          finish();
        }
      }
    };
    const onEnd = () => finish();
    const onError = () => finish();
    const ignoreLateError = () => {
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("close", onEnd);
      process.stdin.off("error", onError);
      process.stdin.on("error", ignoreLateError);
      process.stdin.pause();
      if (typeof process.stdin.unref === "function") {
        process.stdin.unref();
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("close", onEnd);
    process.stdin.on("error", onError);
  });
}
function writeAndExit(payload) {
  let exited = false;
  const done = () => {
    if (exited) return;
    exited = true;
    process.exit(0);
  };
  const failsafe = setTimeout(done, 150);
  failsafe.unref();
  process.stdout.on("error", done);
  try {
    process.stdout.write(payload, done);
  } catch {
    done();
  }
}
async function main() {
  try {
    const raw = (await readStdin()).trim();
    if (!raw) {
      writeAndExit("{}\n");
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      writeAndExit("{}\n");
      return;
    }
    const workspaceDir = typeof payload.cwd === "string" && payload.cwd.trim() || firstNonEmptyPath(payload.workspacePaths) || firstNonEmptyPath(payload.workspace_paths) || firstNonEmptyPath(payload.workspaceRoots) || firstNonEmptyPath(payload.workspace_roots);
    if (!workspaceDir) {
      writeAndExit("{}\n");
      return;
    }
    const snapshot = await buildWorkspaceSnapshot(workspaceDir, {
      maxChars: MAX_SNAPSHOT_BYTES,
      maxBytes: MAX_SNAPSHOT_BYTES,
      gitTimeoutMs: 800
    });
    if (!snapshot) {
      writeAndExit("{}\n");
      return;
    }
    let updateNotice = null;
    try {
      const pluginDir = path5.resolve(
        path5.dirname(fileURLToPath(import.meta.url)),
        ".."
      );
      const settings = await resolveUpdaterSettings();
      if (settings.mode !== "off") {
        const [currentVersion, state] = await Promise.all([
          readInstalledVersion(pluginDir),
          readUpdateState()
        ]);
        updateNotice = await consumeSnapshotUpdateNotice(
          pluginDir,
          currentVersion
        );
        if (shouldTriggerBackgroundCheck(state, Date.now(), settings.checkIntervalMs)) {
          const updaterPath = path5.join(pluginDir, "dist", "updater.mjs");
          const hasUpdater = await fs3.access(updaterPath).then(() => true).catch(() => false);
          if (hasUpdater) {
            await writeUpdateState({
              lastCheckAttemptAt: (/* @__PURE__ */ new Date()).toISOString()
            }).catch(() => {
            });
            spawnBackgroundUpdateCheck(pluginDir);
          }
        }
      }
    } catch {
    }
    let compatNotice = null;
    try {
      const configEditsFormat = await readSavedEditsFormat(process.env);
      const hostCompat = resolveHostCompat({
        transcriptPath: typeof payload.transcriptPath === "string" ? payload.transcriptPath : typeof payload.transcript_path === "string" ? payload.transcript_path : void 0,
        artifactDirectoryPath: typeof payload.artifactDirectoryPath === "string" ? payload.artifactDirectoryPath : typeof payload.artifact_directory_path === "string" ? payload.artifact_directory_path : void 0,
        modelName: typeof payload.modelName === "string" ? payload.modelName : typeof payload.model_name === "string" ? payload.model_name : void 0,
        env: process.env,
        configEditsFormat
      });
      compatNotice = formatSessionStartCompatNotice(hostCompat);
    } catch {
    }
    const trailingNotices = [compatNotice, updateNotice].filter(
      (n) => Boolean(n)
    );
    let messageText = snapshot;
    if (trailingNotices.length > 0) {
      const suffix = trailingNotices.join("\n");
      const combined = `${snapshot}
${suffix}`;
      if (Buffer.byteLength(combined, "utf8") <= MAX_SNAPSHOT_BYTES) {
        messageText = combined;
      } else {
        const noticeBytes = Buffer.byteLength(suffix, "utf8") + 1;
        const snapshotBudget = MAX_SNAPSHOT_BYTES - noticeBytes;
        messageText = snapshotBudget >= 64 ? `${truncateWithByteNotice(snapshot, snapshotBudget)}
${suffix}` : truncateWithByteNotice(combined, MAX_SNAPSHOT_BYTES);
      }
    }
    const response = {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: messageText
          }
        }
      ]
    };
    writeAndExit(`${JSON.stringify(response)}
`);
  } catch {
    writeAndExit("{}\n");
  }
}
void main();

// agy-fast MCP Stdio Server (bundled zero-dependency ESM)


// src/mcp-server.ts
import fs6 from "node:fs";
import os4 from "node:os";
import path7 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/protocol/mcp.ts
import { fileURLToPath } from "node:url";
var SUPPORTED_PROTOCOL_VERSIONS = /* @__PURE__ */ new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
]);
var DEFAULT_PROTOCOL_VERSION = "2025-03-26";
var ROOTS_REQUEST_TIMEOUT_MS = 1e3;
var MAX_KNOWN_ROOTS_IDS = 64;
var MAX_FRAME_BYTES = 64 * 1024 * 1024;
var McpStdioServer = class {
  tools = /* @__PURE__ */ new Map();
  serverName;
  serverVersion;
  inFlight = 0;
  stdinEnded = false;
  onDrainExit;
  onWorkspaceRoots;
  shouldRequestRoots;
  onInitialize;
  sendToClient;
  clientSupportsRoots = false;
  rootsDirty = false;
  rootsRequestCount = 0;
  lastAppliedRootsSeq = 0;
  pendingRoots = /* @__PURE__ */ new Map();
  knownRootsIds = /* @__PURE__ */ new Map();
  rootsWaiters = /* @__PURE__ */ new Set();
  activeOutgoingQueue = null;
  initWriteInFlight = 0;
  postInitOutgoingQueue = [];
  rootsTimeoutMs;
  maxFrameBytes;
  constructor(options) {
    this.serverName = options.name;
    this.serverVersion = options.version;
    this.onWorkspaceRoots = options.onWorkspaceRoots;
    this.shouldRequestRoots = options.shouldRequestRoots;
    this.onInitialize = options.onInitialize;
    this.rootsTimeoutMs = typeof options.rootsTimeoutMs === "number" && Number.isFinite(options.rootsTimeoutMs) && options.rootsTimeoutMs > 0 ? Math.trunc(options.rootsTimeoutMs) : ROOTS_REQUEST_TIMEOUT_MS;
    this.maxFrameBytes = typeof options.maxFrameBytes === "number" && Number.isFinite(options.maxFrameBytes) && options.maxFrameBytes > 0 ? Math.trunc(options.maxFrameBytes) : MAX_FRAME_BYTES;
  }
  flushRootsWaiters() {
    for (const waiter of this.rootsWaiters) {
      let stillWaiting = false;
      for (const pending of this.pendingRoots.values()) {
        if (pending.seq <= waiter.minSeq) {
          stillWaiting = true;
          break;
        }
      }
      if (!stillWaiting) {
        this.rootsWaiters.delete(waiter);
        waiter.resolve();
      }
    }
  }
  settleAllPendingRoots() {
    for (const pending of this.pendingRoots.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingRoots.clear();
    for (const waiter of this.rootsWaiters) {
      waiter.resolve();
    }
    this.rootsWaiters.clear();
  }
  waitForRoots() {
    if (this.pendingRoots.size === 0 || this.stdinEnded) {
      return Promise.resolve();
    }
    if (this.activeOutgoingQueue && this.activeOutgoingQueue.length > 0) {
      const tasks = this.activeOutgoingQueue.splice(0, this.activeOutgoingQueue.length);
      if (this.initWriteInFlight > 0) {
        this.postInitOutgoingQueue.push(...tasks);
      } else {
        for (const task of tasks) {
          try {
            task();
          } catch {
          }
        }
      }
    }
    const minSeq = this.rootsRequestCount;
    return new Promise((resolve) => {
      this.rootsWaiters.add({ minSeq, resolve });
    });
  }
  pruneKnownRootsIds() {
    if (this.knownRootsIds.size <= MAX_KNOWN_ROOTS_IDS) return;
    for (const key of this.knownRootsIds.keys()) {
      if (this.knownRootsIds.size <= MAX_KNOWN_ROOTS_IDS) break;
      if (!this.pendingRoots.has(key)) {
        this.knownRootsIds.delete(key);
      }
    }
  }
  // Tool calls wait for the pending answer (bounded by rootsTimeoutMs and stdin EOF),
  // so the first call already sees the workspace roots without ever deadlocking.
  requestRoots(useContentLength) {
    if (this.stdinEnded || !this.clientSupportsRoots || !this.onWorkspaceRoots || !this.sendToClient) {
      return;
    }
    this.rootsRequestCount += 1;
    const seq = this.rootsRequestCount;
    const id = `agy-fast-roots-${seq}`;
    const timer = setTimeout(() => {
      if (this.pendingRoots.delete(id)) {
        this.pruneKnownRootsIds();
        this.flushRootsWaiters();
      }
    }, this.rootsTimeoutMs);
    timer.unref();
    this.pendingRoots.set(id, { seq, timer });
    this.knownRootsIds.set(id, seq);
    this.pruneKnownRootsIds();
    const send = this.sendToClient;
    const sendTask = () => {
      if (this.stdinEnded) return;
      send({ jsonrpc: "2.0", id, method: "roots/list" }, useContentLength);
    };
    if (this.activeOutgoingQueue) {
      this.activeOutgoingQueue.push(sendTask);
    } else {
      sendTask();
    }
  }
  receiveRoots(result) {
    if (!result || typeof result !== "object") return;
    const rawRoots = result.roots;
    if (!Array.isArray(rawRoots)) return;
    const paths = [];
    for (const root of rawRoots) {
      if (!root || typeof root !== "object") continue;
      const uri = root.uri;
      if (typeof uri !== "string" || !/^file:/i.test(uri)) continue;
      try {
        paths.push(fileURLToPath(uri));
      } catch {
      }
    }
    if (paths.length > 0) {
      try {
        this.onWorkspaceRoots?.(paths);
      } catch {
      }
    }
  }
  registerTool(definition, handler) {
    const name = typeof definition === "function" ? definition().name : definition.name;
    this.tools.set(name, { definition, handler });
  }
  async handleMessage(raw, useContentLength = false) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" }
      };
    }
    const msg = raw;
    const hasId = Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== void 0;
    const id = hasId ? msg.id ?? null : null;
    const method = typeof msg.method === "string" ? msg.method : "";
    if (!method && typeof id === "string" && this.knownRootsIds.has(id)) {
      const seq = this.knownRootsIds.get(id);
      this.knownRootsIds.delete(id);
      const pending = this.pendingRoots.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRoots.delete(id);
      }
      const errField = msg.error;
      const hasError = errField !== void 0 && errField !== null;
      try {
        if (!hasError && seq >= this.lastAppliedRootsSeq) {
          this.lastAppliedRootsSeq = seq;
          for (const [oldId, oldPending] of this.pendingRoots.entries()) {
            if (oldPending.seq < seq) {
              clearTimeout(oldPending.timer);
              this.pendingRoots.delete(oldId);
            }
          }
          this.receiveRoots(msg.result);
        }
      } finally {
        this.pruneKnownRootsIds();
        this.flushRootsWaiters();
      }
      return null;
    }
    if (!method) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid Request: missing method" }
      };
    }
    if (!hasId) {
      if (method === "notifications/initialized" || method === "notifications/roots/list_changed") {
        if (this.clientSupportsRoots) {
          this.rootsDirty = true;
        }
      }
      return null;
    }
    if (method === "initialize") {
      const requested = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion.trim() : "";
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
      const capabilities = msg.params?.capabilities;
      this.clientSupportsRoots = capabilities?.roots !== null && typeof capabilities?.roots === "object" && !Array.isArray(capabilities?.roots);
      this.rootsDirty = this.clientSupportsRoots;
      const rawClientInfo = msg.params?.clientInfo;
      let clientInfo;
      if (rawClientInfo !== null && typeof rawClientInfo === "object" && !Array.isArray(rawClientInfo)) {
        const ci = rawClientInfo;
        clientInfo = {
          name: typeof ci.name === "string" ? ci.name : void 0,
          version: typeof ci.version === "string" ? ci.version : void 0
        };
      }
      try {
        this.onInitialize?.({ clientInfo, protocolVersion });
      } catch {
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: this.serverName,
            version: this.serverVersion
          }
        }
      };
    }
    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (method === "tools/list") {
      const definitions = [...this.tools.values()].map(
        (t) => typeof t.definition === "function" ? t.definition() : t.definition
      );
      return { jsonrpc: "2.0", id, result: { tools: definitions } };
    }
    if (method === "resources/list") {
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    }
    if (method === "resources/templates/list") {
      return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
    }
    if (method === "prompts/list") {
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    }
    if (method === "tools/call") {
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      const tool = this.tools.get(name);
      if (!tool) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${name}` }
        };
      }
      const rawArgs = msg.params?.arguments;
      let args;
      if (rawArgs === void 0 || rawArgs === null) {
        args = {};
      } else if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
        args = rawArgs;
      } else if (typeof rawArgs === "string" && rawArgs.trim().startsWith("{")) {
        try {
          const parsedArgs = JSON.parse(rawArgs);
          if (parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)) {
            args = parsedArgs;
          } else {
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32602,
                message: `Invalid params: 'arguments' for '${name}' must be a JSON object`
              }
            };
          }
        } catch {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: `Invalid params: malformed JSON string in 'arguments' for '${name}'`
            }
          };
        }
      } else {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: `Invalid params: 'arguments' for '${name}' must be an object (received ${Array.isArray(rawArgs) ? "array" : typeof rawArgs})`
          }
        };
      }
      try {
        const needRoots = this.clientSupportsRoots && Boolean(this.onWorkspaceRoots) && (this.shouldRequestRoots ? this.shouldRequestRoots(name, args) : true);
        if (needRoots) {
          if (this.rootsDirty && !this.stdinEnded) {
            this.rootsDirty = false;
            this.requestRoots(useContentLength);
          }
          await this.waitForRoots();
        }
        const res = await tool.handler(args);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: res.text }],
            isError: Boolean(res.isError)
          }
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Tool error: ${message}` }],
            isError: true
          }
        };
      }
    }
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    };
  }
  listen(input = process.stdin, output = process.stdout, onExit) {
    this.onDrainExit = onExit;
    const maxFrameBytes = this.maxFrameBytes;
    let buffer = Buffer.alloc(0);
    let discardingOversizedLine = false;
    const writeResponse = (payload, useContentLength) => {
      const serialized = JSON.stringify(payload);
      if (useContentLength) {
        const len = Buffer.byteLength(serialized, "utf8");
        output.write(`Content-Length: ${len}\r
\r
${serialized}`);
      } else {
        output.write(`${serialized}
`);
      }
    };
    this.sendToClient = (request, useContentLength) => writeResponse(request, useContentLength);
    let drainExitCalled = false;
    const triggerDrainExit = () => {
      if (drainExitCalled) return;
      drainExitCalled = true;
      this.onDrainExit?.();
    };
    const dispatchRawJson = (jsonText, useContentLength) => {
      let parsed;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        writeResponse(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" }
          },
          useContentLength
        );
        return;
      }
      this.inFlight += 1;
      const finish = () => {
        this.inFlight -= 1;
        if (this.stdinEnded && this.inFlight === 0) {
          triggerDrainExit();
        }
      };
      const outgoingForCall = [];
      const flushOutgoingForCall = () => {
        for (const task of outgoingForCall) {
          task();
        }
      };
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          writeResponse(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32600, message: "Invalid Request: empty batch" }
            },
            useContentLength
          );
          finish();
          return;
        }
        const prevQueue2 = this.activeOutgoingQueue;
        this.activeOutgoingQueue = outgoingForCall;
        let promises;
        try {
          promises = parsed.map((item) => this.handleMessage(item, useContentLength));
        } finally {
          this.activeOutgoingQueue = prevQueue2;
        }
        const isInitOnlyBatch = parsed.some(
          (item) => item !== null && typeof item === "object" && item.method === "initialize"
        ) && !parsed.some(
          (item) => item !== null && typeof item === "object" && item.method === "tools/call"
        );
        if (isInitOnlyBatch) {
          this.initWriteInFlight += 1;
        }
        const releaseInitFlush = () => {
          if (!isInitOnlyBatch) return;
          this.initWriteInFlight = Math.max(0, this.initWriteInFlight - 1);
          if (this.initWriteInFlight === 0 && this.postInitOutgoingQueue.length > 0) {
            const queued = this.postInitOutgoingQueue.splice(0, this.postInitOutgoingQueue.length);
            for (const task of queued) {
              try {
                task();
              } catch {
              }
            }
          }
        };
        void Promise.all(promises).then((responses) => {
          const nonNull = responses.filter(
            (r) => r !== null
          );
          if (nonNull.length > 0) {
            writeResponse(nonNull, useContentLength);
          }
          flushOutgoingForCall();
          releaseInitFlush();
        }).catch(() => {
          releaseInitFlush();
        }).finally(finish);
        return;
      }
      const isSingleInit = parsed !== null && typeof parsed === "object" && parsed.method === "initialize";
      if (isSingleInit) {
        this.initWriteInFlight += 1;
      }
      const releaseSingleInitFlush = () => {
        if (!isSingleInit) return;
        this.initWriteInFlight = Math.max(0, this.initWriteInFlight - 1);
        if (this.initWriteInFlight === 0 && this.postInitOutgoingQueue.length > 0) {
          const queued = this.postInitOutgoingQueue.splice(0, this.postInitOutgoingQueue.length);
          for (const task of queued) {
            try {
              task();
            } catch {
            }
          }
        }
      };
      const prevQueue = this.activeOutgoingQueue;
      this.activeOutgoingQueue = outgoingForCall;
      let promise;
      try {
        promise = this.handleMessage(parsed, useContentLength);
      } finally {
        this.activeOutgoingQueue = prevQueue;
      }
      void promise.then((response) => {
        if (response !== null) {
          writeResponse(response, useContentLength);
        }
        flushOutgoingForCall();
        releaseSingleInitFlush();
      }).catch(() => {
        releaseSingleInitFlush();
      }).finally(finish);
    };
    const drainBuffer = () => {
      while (buffer.length > 0) {
        if (discardingOversizedLine) {
          const nlIdx = buffer.indexOf(10);
          if (nlIdx === -1) {
            buffer = Buffer.alloc(0);
            break;
          }
          discardingOversizedLine = false;
          buffer = nlIdx + 1 >= buffer.length ? Buffer.alloc(0) : Buffer.from(buffer.subarray(nlIdx + 1));
          continue;
        }
        let offset = 0;
        while (offset < buffer.length && (buffer[offset] === 10 || buffer[offset] === 13)) {
          offset++;
        }
        if (offset > 0) {
          buffer = buffer.subarray(offset);
          if (buffer.length === 0) break;
        }
        const headerProbe = buffer.subarray(0, 16).toString("latin1").toLowerCase();
        if (headerProbe.startsWith("content-length:") || headerProbe.startsWith("content-type:")) {
          const headerScan = buffer.subarray(0, Math.min(buffer.length, 16384)).toString("latin1");
          const sepMatch = /\r?\n\r?\n/.exec(headerScan);
          if (!sepMatch) {
            if (buffer.length >= 16384) {
              writeResponse(
                {
                  jsonrpc: "2.0",
                  id: null,
                  error: { code: -32600, message: "Invalid Request: header too large" }
                },
                true
              );
              buffer = Buffer.alloc(0);
            }
            break;
          }
          const sepIdx = sepMatch.index;
          const sepLen = sepMatch[0].length;
          const headerText = headerScan.slice(0, sepIdx);
          const clMatches = [...headerText.matchAll(/^content-length:[ \t]*(\d+)[ \t]*\r?$/gim)];
          if (clMatches.length !== 1) {
            writeResponse(
              {
                jsonrpc: "2.0",
                id: null,
                error: { code: -32600, message: "Invalid Request: invalid Content-Length header" }
              },
              true
            );
            buffer = buffer.subarray(sepIdx + sepLen);
            continue;
          }
          const contentLength = Number(clMatches[0][1]);
          if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maxFrameBytes) {
            writeResponse(
              {
                jsonrpc: "2.0",
                id: null,
                error: { code: -32600, message: "Invalid Request: Content-Length out of bounds" }
              },
              true
            );
            buffer = Buffer.alloc(0);
            break;
          }
          const bodyStart = sepIdx + sepLen;
          if (buffer.length < bodyStart + contentLength) {
            break;
          }
          const bodyText = buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
          buffer = buffer.subarray(bodyStart + contentLength);
          dispatchRawJson(bodyText, true);
          continue;
        }
        const newlineIdx = buffer.indexOf(10);
        if (newlineIdx === -1) {
          const pendingLen = buffer.length > 0 && buffer[buffer.length - 1] === 13 ? buffer.length - 1 : buffer.length;
          if (pendingLen > maxFrameBytes) {
            writeResponse(
              {
                jsonrpc: "2.0",
                id: null,
                error: {
                  code: -32600,
                  message: "Invalid Request: NDJSON message exceeds maximum allowed size"
                }
              },
              false
            );
            discardingOversizedLine = true;
            buffer = Buffer.alloc(0);
          }
          break;
        }
        const lineLen = newlineIdx > 0 && buffer[newlineIdx - 1] === 13 ? newlineIdx - 1 : newlineIdx;
        if (lineLen > maxFrameBytes) {
          writeResponse(
            {
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32600,
                message: "Invalid Request: NDJSON message exceeds maximum allowed size"
              }
            },
            false
          );
          buffer = newlineIdx + 1 >= buffer.length ? Buffer.alloc(0) : Buffer.from(buffer.subarray(newlineIdx + 1));
          continue;
        }
        const lineBuf = buffer.subarray(0, newlineIdx);
        buffer = buffer.subarray(newlineIdx + 1);
        const line = lineBuf.toString("utf8").trim();
        if (line.length > 0) {
          dispatchRawJson(line, false);
        }
      }
    };
    input.on("data", (chunk) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      buffer = buffer.length === 0 ? buf : Buffer.concat([buffer, buf]);
      drainBuffer();
    });
    const handleInputClosed = (flushTrailing) => {
      if (this.stdinEnded) return;
      const wasDiscarding = discardingOversizedLine;
      discardingOversizedLine = false;
      const remaining = flushTrailing && !wasDiscarding ? buffer.toString("utf8").trim() : "";
      buffer = Buffer.alloc(0);
      this.stdinEnded = true;
      if (flushTrailing && remaining.length > 0) {
        const lowerRem = remaining.toLowerCase();
        if (!lowerRem.startsWith("content-length:") && !lowerRem.startsWith("content-type:")) {
          dispatchRawJson(remaining, false);
        }
      }
      this.settleAllPendingRoots();
      if (this.inFlight === 0) {
        triggerDrainExit();
      }
    };
    input.on("end", () => handleInputClosed(true));
    input.on("close", () => handleInputClosed(false));
    input.on("error", () => handleInputClosed(false));
  }
};

// src/utils/exec-utils.ts
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
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
var WINDOWS_PS_DOUBLE_QUOTABLE_VAR_RE = /(?<![\\`])(?:\$env:[A-Za-z_][A-Za-z0-9_]*|\$(?:LASTEXITCODE|PSVersionTable|PSScriptRoot|PROFILE)\b)/i;
var WINDOWS_PS_UNQUOTED_SYNTAX_RE = /(?<![\\`])\$(?:HOME|PWD|null|true|false|_)\b|\$\([^)]|@\(|(?:^|[;\r\n])\s*\$[A-Za-z_][A-Za-z0-9_]*\s*=/im;
var WINDOWS_PS_CMDLET_RE = /(?:^|[;|&({\r\n]\s*)(?:Get|Set|New|Remove|Test|Select|Where|ForEach|Sort|Group|Measure|Compare|ConvertTo|ConvertFrom|Export|Import|Invoke|Start|Stop|Restart|Wait|Read|Write|Out|Format|Resolve|Join|Split|Copy|Move|Rename|Clear|Add|Push|Pop|Enable|Disable)-[A-Z][A-Za-z0-9]*\b(?!-)/;
var EXPLICIT_POWERSHELL_INVOCATION_RE = /^\s*(?:["']?)(?:pwsh|powershell)(?:\.exe)?(?:["']?)(?:\s|$)/i;
var PS_NON_INVOCATION_TAIL_RE = /^(?:[|;&+}=),*?]|(?:[1-6*])?>|-(?:c|i)?(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|replace|split|join|in|notin|contains|notcontains|is|isnot|as|and|or|xor|shl|shr|band|bor|bxor)\b|-f\b|$)/i;
var PS_UTF8_PREFIX = "try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}; $OutputEncoding = [System.Text.UTF8Encoding]::new($false);";
var WINDOWS_PS_WRAPPER_BIN_RE = /^(?:"(?:pwsh|powershell)(?:\.exe)?"|'(?:pwsh|powershell)(?:\.exe)?'|(?:pwsh|powershell)(?:\.exe)?)(?=\s)/i;
var WINDOWS_PS_BENIGN_FLAGS = /* @__PURE__ */ new Set([
  "-noprofile",
  "-nop",
  "-noninteractive",
  "-noni",
  "-nologo",
  "-nol"
]);
var WINDOWS_UNWRAP_SAFE_BINS = /* @__PURE__ */ new Set([
  "git",
  "rg",
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "python",
  "python3",
  "py",
  "pip",
  "pip3",
  "pytest",
  "uv",
  "ruff",
  "mypy",
  "flake8",
  "black",
  "go",
  "cargo",
  "rustc",
  "rustup",
  "java",
  "javac",
  "mvn",
  "gradle",
  "tsc",
  "tsx",
  "eslint",
  "prettier",
  "vitest",
  "jest",
  "biome",
  "dotnet",
  "cmake",
  "make",
  "ninja",
  "gcc",
  "g++",
  "clang",
  "gh",
  "docker",
  "kubectl",
  "terraform",
  "agy"
]);
var WINDOWS_UNWRAP_FORBIDDEN_META_RE = /[|;&><`$(){}@%!^*\r\n'#,?\[\]~\x00-\x08\x0b\x0c\x0e-\x1f\u0085\u00a0\u2013-\u2015\u2018-\u201f\u2028\u2029\u3000]/;
function hasSafeBalancedDoubleQuotes(text) {
  if (/\\+"/.test(text)) return false;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') count++;
  }
  return count % 2 === 0;
}
function unwrapTrivialWindowsPowerShellCommand(command) {
  const trimmed = command.trim();
  const binMatch = WINDOWS_PS_WRAPPER_BIN_RE.exec(trimmed);
  if (!binMatch) return command;
  let rest = trimmed.slice(binMatch[0].length);
  let sawCommandFlag = false;
  while (true) {
    rest = rest.trimStart();
    if (!rest) return command;
    const tokMatch = /^(\S+)/.exec(rest);
    if (!tokMatch) return command;
    const tok = tokMatch[1];
    const lower = tok.toLowerCase();
    rest = rest.slice(tok.length);
    if (lower === "-command" || lower === "-c") {
      if (!/^\s/.test(rest)) return command;
      sawCommandFlag = true;
      break;
    }
    if (!WINDOWS_PS_BENIGN_FLAGS.has(lower)) {
      return command;
    }
  }
  if (!sawCommandFlag) return command;
  const payload = rest.trim();
  if (!payload) return command;
  let inner;
  if (payload[0] === '"' || payload[0] === "'") {
    const quote = payload[0];
    if (payload.length < 2 || payload.indexOf(quote, 1) !== payload.length - 1) {
      return command;
    }
    const rawInner = payload.slice(1, -1);
    if (quote === '"' && rawInner.endsWith("\\")) {
      return command;
    }
    inner = rawInner.trim();
    if (quote === "'" && inner.includes('"') && !hasSafeBalancedDoubleQuotes(inner)) {
      return command;
    }
  } else {
    if (/^[-&./\\]/.test(payload)) return command;
    if (payload.includes('"') && !hasSafeBalancedDoubleQuotes(payload)) {
      return command;
    }
    inner = payload;
  }
  if (!inner || WINDOWS_UNWRAP_FORBIDDEN_META_RE.test(inner)) {
    return command;
  }
  const firstTok = /^(\S+)/.exec(inner)?.[1];
  if (!firstTok || !/^[A-Za-z0-9_+.-]+$/.test(firstTok)) {
    return command;
  }
  const baseBin = firstTok.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "");
  if (!WINDOWS_UNWRAP_SAFE_BINS.has(baseBin)) {
    return command;
  }
  if (needsPowerShellOnWindows(inner)) {
    return command;
  }
  return inner;
}
function stripQuotedSpans(command, stripDoubleQuotes) {
  let out = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (ch === "'") {
        if (next === "'") {
          i++;
        } else {
          quote = null;
          out += " ";
        }
      }
      continue;
    }
    if (quote === '"') {
      if ((ch === "\\" || ch === "`") && (next === ch || next === '"')) {
        i++;
        if (!stripDoubleQuotes) out += ch + next;
        continue;
      }
      if (ch === '"') {
        if (next === '"') {
          i++;
          if (!stripDoubleQuotes) out += '""';
        } else {
          quote = null;
          out += stripDoubleQuotes ? " " : '"';
        }
        continue;
      }
      if (!stripDoubleQuotes) out += ch;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      out += " ";
      continue;
    }
    if (ch === '"') {
      quote = '"';
      out += stripDoubleQuotes ? " " : '"';
      continue;
    }
    out += ch;
  }
  return out;
}
function needsPowerShellOnWindows(command) {
  if (!command || EXPLICIT_POWERSHELL_INVOCATION_RE.test(command)) {
    return false;
  }
  const withoutSingle = stripQuotedSpans(command, false);
  if (WINDOWS_PS_DOUBLE_QUOTABLE_VAR_RE.test(withoutSingle)) {
    return true;
  }
  const unquoted = stripQuotedSpans(command, true);
  return WINDOWS_PS_UNQUOTED_SYNTAX_RE.test(unquoted) || WINDOWS_PS_CMDLET_RE.test(unquoted);
}
function formatPowerShellCommand(command) {
  const trimmed = command.trim();
  if (!trimmed || trimmed[0] !== '"' && trimmed[0] !== "'") {
    return command;
  }
  const quote = trimmed[0];
  let idx = 1;
  while (idx < trimmed.length) {
    if (quote === '"' && trimmed[idx] === "`" && idx + 1 < trimmed.length) {
      idx += 2;
      continue;
    }
    if (trimmed[idx] === quote) {
      if (trimmed[idx + 1] === quote) {
        idx += 2;
        continue;
      }
      const afterQuote = trimmed.slice(idx + 1);
      const rest = afterQuote.replace(/^[ \t]+/, "");
      if (rest.length === afterQuote.length || !rest || /^[\r\n]/.test(rest)) {
        return command;
      }
      if (!PS_NON_INVOCATION_TAIL_RE.test(rest)) {
        return `& ${trimmed}`;
      }
      return command;
    }
    idx++;
  }
  return command;
}
function buildPowerShellUtf8Command(command) {
  return `${PS_UTF8_PREFIX} ${formatPowerShellCommand(command)}`;
}
var cachedWindowsPowerShell;
var cachedWindowsPowerShellExecPath = null;
var pendingWindowsPowerShellProbe = null;
async function defaultProbeWindowsShell(bin) {
  const { bin: whereBin, cwd } = getWindowsSystem32Binary("where.exe");
  const exeQuery = bin.toLowerCase().endsWith(".exe") ? bin : `${bin}.exe`;
  const whereRes = await execBinaryAsync(whereBin, [exeQuery], {
    cwd,
    timeoutMs: 2e3,
    maxOutputBytes: 4096
  });
  if (!whereRes.error && !whereRes.timedOut) {
    if (whereRes.exitCode !== 0) return false;
    const resolved = whereRes.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => /\.exe$/i.test(line));
    if (!resolved) return false;
    cachedWindowsPowerShellExecPath = resolved;
    return true;
  }
  const res = await execBinaryAsync(
    exeQuery,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    {
      cwd,
      timeoutMs: 3e3,
      maxOutputBytes: 4096
    }
  );
  if (!res.error && !res.timedOut && res.exitCode === 0) {
    cachedWindowsPowerShellExecPath = exeQuery;
    return true;
  }
  return false;
}
async function resolveWindowsPowerShell(probe = defaultProbeWindowsShell) {
  if (cachedWindowsPowerShell !== void 0) {
    return cachedWindowsPowerShell;
  }
  if (pendingWindowsPowerShellProbe) {
    return pendingWindowsPowerShellProbe;
  }
  pendingWindowsPowerShellProbe = (async () => {
    try {
      cachedWindowsPowerShellExecPath = null;
      if (await probe("pwsh")) {
        cachedWindowsPowerShell = "pwsh";
        return cachedWindowsPowerShell;
      }
      cachedWindowsPowerShellExecPath = null;
      if (await probe("powershell.exe")) {
        cachedWindowsPowerShell = "powershell.exe";
        return cachedWindowsPowerShell;
      }
      cachedWindowsPowerShellExecPath = null;
      cachedWindowsPowerShell = null;
      return null;
    } finally {
      pendingWindowsPowerShellProbe = null;
    }
  })();
  return pendingWindowsPowerShellProbe;
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
async function runShellCommandAsync(command, options) {
  const effectiveOptions = {
    ...options,
    env: withNonInteractiveGitEnv(options.env)
  };
  if (process.platform === "win32") {
    const effectiveCommand = unwrapTrivialWindowsPowerShellCommand(command);
    if (needsPowerShellOnWindows(effectiveCommand)) {
      const psBin = await resolveWindowsPowerShell();
      if (psBin) {
        const utf8Command = buildPowerShellUtf8Command(effectiveCommand);
        return spawnAndCollect(
          cachedWindowsPowerShellExecPath ?? psBin,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", utf8Command],
          false,
          effectiveOptions
        );
      }
    }
    return spawnAndCollect(effectiveCommand, [], true, effectiveOptions);
  }
  return spawnAndCollect(command, [], true, effectiveOptions);
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
var cachedRgAvailable = null;
var pendingRgProbe = null;
async function isRipgrepAvailable() {
  if (cachedRgAvailable !== null) return cachedRgAvailable;
  if (pendingRgProbe) return pendingRgProbe;
  let probe = null;
  probe = (async () => {
    try {
      const res = await execBinaryAsync("rg", ["--version"], {
        cwd: os.tmpdir(),
        timeoutMs: 2e3,
        maxOutputBytes: 4096
      });
      const available = !res.error && !res.timedOut && res.exitCode === 0;
      if (!res.timedOut && pendingRgProbe === probe) {
        cachedRgAvailable = available;
      }
      return available;
    } finally {
      if (pendingRgProbe === probe) {
        pendingRgProbe = null;
      }
    }
  })();
  pendingRgProbe = probe;
  return probe;
}

// src/utils/host-compat.ts
import fs from "node:fs";
import os2 from "node:os";
import path2 from "node:path";

// src/utils/output-filter.ts
var ANSI_REGEX = (
  // eslint-disable-next-line no-control-regex
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g
);
function stripAnsi(text) {
  return text.replace(ANSI_REGEX, "");
}
var LINE_ERASE_CSI_RE = /\x1B\[(?:2K|0?K)/;
var LEADING_CLEAR_TO_EOL_RE = /^(?:\x1B\[0?K)+/;
function normalizeTerminalOutput(raw) {
  const rawLines = raw.replace(/\r\n/g, "\n").split("\n");
  const normalizedLines = [];
  for (const rawLine of rawLines) {
    if (rawLine.length === 0) {
      normalizedLines.push("");
      continue;
    }
    const hadLineErase = LINE_ERASE_CSI_RE.test(rawLine);
    let working = rawLine;
    const lastFullErase = working.lastIndexOf("\x1B[2K");
    if (lastFullErase !== -1) {
      working = working.slice(lastFullErase + 4);
    }
    if (!working.includes("\r") && !hadLineErase) {
      normalizedLines.push(stripAnsi(working));
      continue;
    }
    let currentFrame = "";
    const crFrames = working.split("\r");
    for (let idx = 0; idx < crFrames.length; idx++) {
      let seg = crFrames[idx];
      if (idx > 0 && LEADING_CLEAR_TO_EOL_RE.test(seg)) {
        seg = seg.replace(LEADING_CLEAR_TO_EOL_RE, "");
        currentFrame = stripAnsi(seg);
        continue;
      }
      const cleanSeg = stripAnsi(seg);
      if (cleanSeg.length > 0) {
        currentFrame = cleanSeg;
      }
    }
    if (hadLineErase && currentFrame.length === 0) {
      continue;
    }
    normalizedLines.push(currentFrame);
  }
  return normalizedLines.join("\n").trimEnd();
}
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
function sliceUtf8BytesTail(text, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.trunc(maxBytes);
  if (limit <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  let bytes = 0;
  let startIndex = text.length;
  for (let i = text.length; i > 0; ) {
    let unitLen = 1;
    let cp;
    const code = text.charCodeAt(i - 1);
    if (i >= 2 && code >= 56320 && code <= 57343 && text.charCodeAt(i - 2) >= 55296 && text.charCodeAt(i - 2) <= 56319) {
      unitLen = 2;
      cp = text.codePointAt(i - 2);
    } else {
      cp = code;
    }
    const chBytes = cp <= 127 ? 1 : cp <= 2047 ? 2 : cp <= 65535 ? 3 : 4;
    if (bytes + chBytes > limit) break;
    bytes += chBytes;
    i -= unitLen;
    startIndex = i;
  }
  return text.slice(startIndex);
}
function truncateHeadTailWithByteNotice(text, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.trunc(maxBytes);
  if (limit <= 0) return "";
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= limit) return text;
  if (limit < 120) {
    return truncateWithByteNotice(text, limit);
  }
  const maxMarkerBytes = Buffer.byteLength(
    `
... [truncated: folded ${totalBytes} middle bytes; total ${totalBytes} bytes] ...
`,
    "utf8"
  );
  const contentBytes = limit - maxMarkerBytes;
  if (contentBytes < 40) {
    return truncateWithByteNotice(text, limit);
  }
  const headBudget = Math.max(16, Math.floor(contentBytes * 0.38));
  const tailBudget = Math.max(24, contentBytes - headBudget);
  let head = sliceUtf8Bytes(text, headBudget);
  const lastNewline = head.lastIndexOf("\n");
  if (lastNewline > 0 && Buffer.byteLength(head.slice(0, lastNewline), "utf8") > headBudget * 0.5) {
    head = head.slice(0, lastNewline);
  }
  let tail = sliceUtf8BytesTail(text, tailBudget);
  const firstNewline = tail.indexOf("\n");
  if (firstNewline !== -1 && Buffer.byteLength(tail.slice(firstNewline + 1), "utf8") > tailBudget * 0.5) {
    tail = tail.slice(firstNewline + 1);
  }
  const headBytes = Buffer.byteLength(head, "utf8");
  const tailBytes = Buffer.byteLength(tail, "utf8");
  const omittedBytes = Math.max(1, totalBytes - headBytes - tailBytes);
  const marker = `
... [truncated: folded ${omittedBytes} middle bytes; total ${totalBytes} bytes] ...
`;
  const result = `${head}${marker}${tail}`;
  return Buffer.byteLength(result, "utf8") <= limit ? result : truncateWithByteNotice(result, limit);
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
function sliceSafeCharsTail(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  let start = text.length - limit;
  if (start < text.length) {
    const firstCode = text.charCodeAt(start);
    if (firstCode >= 56320 && firstCode <= 57343) {
      start += 1;
    }
  }
  return text.slice(start);
}
function truncateHeadTailWithNotice(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  if (limit < 120) {
    return truncateWithNotice(text, limit);
  }
  const maxMarkerLen = `
... [truncated: folded ${text.length} middle chars; total ${text.length} chars] ...
`.length;
  const contentBudget = limit - maxMarkerLen;
  if (contentBudget < 40) {
    return truncateWithNotice(text, limit);
  }
  const headBudget = Math.max(16, Math.floor(contentBudget * 0.38));
  const tailBudget = Math.max(24, contentBudget - headBudget);
  let head = sliceSafeChars(text, headBudget);
  const lastNewline = head.lastIndexOf("\n");
  if (lastNewline > headBudget * 0.5) {
    head = head.slice(0, lastNewline);
  }
  let tail = sliceSafeCharsTail(text, tailBudget);
  const firstNewline = tail.indexOf("\n");
  if (firstNewline !== -1 && tail.length - (firstNewline + 1) > tailBudget * 0.5) {
    tail = tail.slice(firstNewline + 1);
  }
  const omittedChars = Math.max(1, text.length - head.length - tail.length);
  const marker = `
... [truncated: folded ${omittedChars} middle chars; total ${text.length} chars] ...
`;
  const result = `${head}${marker}${tail}`;
  return result.length <= limit ? result : truncateWithNotice(result, limit);
}
function truncateWithNotice(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  if (limit < 48) {
    if (limit <= 3) return sliceSafeChars(text, limit);
    return `${sliceSafeChars(text, limit - 3)}...`;
  }
  const maxNoticeLen = `
... [truncated: showed ${text.length} of ${text.length} chars]`.length;
  const cutoff = Math.max(0, limit - maxNoticeLen);
  if (cutoff < 8) {
    return `${sliceSafeChars(text, limit - 3)}...`;
  }
  let slice = sliceSafeChars(text, cutoff);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > cutoff * 0.6) {
    slice = slice.slice(0, lastNewline);
  }
  const result = `${slice}
... [truncated: showed ${slice.length} of ${text.length} chars]`;
  return result.length <= limit ? result : sliceSafeChars(result, limit);
}
function computeWaterFillBudgets(sizes, totalBudget) {
  if (sizes.length === 0) return [];
  const budgets = new Array(sizes.length).fill(0);
  if (!Number.isFinite(totalBudget) || totalBudget <= 0) return budgets;
  let remainingBudget = Math.trunc(totalBudget);
  if (remainingBudget <= 0) return budgets;
  const order = sizes.map((raw, idx) => ({
    idx,
    size: Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0
  })).sort((a, b) => a.size - b.size || a.idx - b.idx);
  for (let i = 0; i < order.length; i++) {
    const remainingCount = order.length - i;
    const share = Math.floor(remainingBudget / remainingCount);
    const item = order[i];
    if (item.size <= share) {
      budgets[item.idx] = item.size;
      remainingBudget -= item.size;
    } else {
      for (let j = i; j < order.length; j++) {
        const rem = order.length - j;
        const alloc = Math.floor(remainingBudget / rem);
        budgets[order[j].idx] = alloc;
        remainingBudget -= alloc;
      }
      break;
    }
  }
  return budgets;
}
function fitSectionsToBudget(sections, maxChars, separator = "\n\n", truncateMode = "head") {
  if (sections.length === 0 || !Number.isFinite(maxChars) || maxChars <= 0) return "";
  const truncateChar = truncateMode === "head-tail" ? truncateHeadTailWithNotice : truncateWithNotice;
  const joined = sections.join(separator);
  if (joined.length <= maxChars) return joined;
  const sepTotal = separator.length * (sections.length - 1);
  if (sepTotal >= maxChars) {
    return truncateChar(joined, maxChars);
  }
  const budgets = computeWaterFillBudgets(
    sections.map((s) => s.length),
    maxChars - sepTotal
  );
  const fitted = sections.map((sec, idx) => truncateChar(sec, budgets[idx] ?? 0)).join(separator);
  return fitted.length <= maxChars ? fitted : truncateChar(fitted, maxChars);
}
function fitSectionsToByteBudget(sections, maxChars, maxBytes, separator = "\n\n", truncateMode = "head") {
  const truncateBytes = truncateMode === "head-tail" ? truncateHeadTailWithByteNotice : truncateWithByteNotice;
  const charFitted = fitSectionsToBudget(sections, maxChars, separator, truncateMode);
  if (maxBytes === void 0) {
    return charFitted;
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  if (Buffer.byteLength(charFitted, "utf8") <= maxBytes) {
    return charFitted;
  }
  const sepBytes = Buffer.byteLength(separator, "utf8") * (sections.length - 1);
  if (sepBytes >= maxBytes) {
    return truncateBytes(charFitted, maxBytes);
  }
  const byteBudgets = computeWaterFillBudgets(
    sections.map((s) => Buffer.byteLength(s, "utf8")),
    maxBytes - sepBytes
  );
  const byteFittedSections = sections.map(
    (sec, idx) => truncateBytes(sec, byteBudgets[idx] ?? 0)
  );
  let fitted = byteFittedSections.join(separator);
  if (fitted.length > maxChars) {
    fitted = fitSectionsToBudget(
      byteFittedSections,
      maxChars,
      separator,
      truncateMode
    );
  }
  return Buffer.byteLength(fitted, "utf8") <= maxBytes ? fitted : truncateBytes(fitted, maxBytes);
}
var ZERO_INDEXED_ENTITY_RE = /\b(?:worker|task|step|job|shard|rank|stage|attempt|node|process|test|check|thread|agent|container|pod|case|suite|phase|index|slot|cpu|gpu|core|port|channel|client|server|host|peer)(?:\s+#?|-)\s*$/i;
var BENIGN_ZERO_COUNT_LEADING_RE = /\b(?:0|no)\s+(?:errors?|warnings?|fail(?:ed|ures?|ing)?)(?:\(s\))?(?=$|[\s,;.)\]|])/gi;
var BENIGN_ZERO_COUNT_TRAILING_RE = /\b(?:errors|error\(s\)|warnings|warning\(s\)|failures|failure\(s\)|failed|failing)\s*(?:(?::|=)\s*0(?=$|\s*(?:$|[,;)\]|]|\.(?!\d)|(?:\b(?:skipped|warnings?|errors?|failures?|total|ignored|pending)\b)))|\(\s*0\s*\))/gi;
function stripBenignZeroCounts(line) {
  const afterLeading = line.replace(
    BENIGN_ZERO_COUNT_LEADING_RE,
    (match, offset, full) => {
      const prefix = full.slice(Math.max(0, offset - 24), offset);
      return ZERO_INDEXED_ENTITY_RE.test(prefix) ? match : " ";
    }
  );
  return afterLeading.replace(BENIGN_ZERO_COUNT_TRAILING_RE, " ");
}
var ERROR_LINE_PATTERN = /(?:\berr!|\b(?:errors?|fail(?:ed|ing|ure|ures)?|exception|traceback|panic|fatal|assertion|syntaxerror|typeerror|referenceerror|zoderror|validationerror|ts\d{4}|e\d{4}|cannot find|not found|unexpected|undefined)\b|caused by:|application failed to start|compilation error|<<<\s*(?:failure|error)|找不到符号|符号:|位置:)/i;
var ROOT_CAUSE_HEADER_PATTERN = /(?:^\s*(?:description|action):|caused by:|application failed to start|⎯\s*failed tests|compilation error)/i;
var FOLD_DANGER_TOKEN_PATTERN = /(?:\berr!|\b(?:errors?|fail(?:ed|ing|ure|ures)?|warns?|warnings?|exceptions?|tracebacks?|panics?|fatals?|assertions?|syntaxerror|typeerror|referenceerror|zoderror|validationerror|ts\d{4}|e\d{4}|cannot find|not found|unexpected|undefined|compilation error|killed|sigkill|sigsegv|sigabrt|oom|out of memory|timed out|timeout|refused|denied|permission|unhandled|mismatched|mismatch)\b|\bexit\s+(?:status|code)\s+[1-9]\d*\b|caused by:|application failed to start|<<<\s*(?:failure|error)|[✖✘✗×]\s+|找不到符号|符号:|位置:|错误|失败|异常|警告)/i;
function isErrorLine(line) {
  return ERROR_LINE_PATTERN.test(stripBenignZeroCounts(line));
}
function hasFoldDangerToken(line) {
  return FOLD_DANGER_TOKEN_PATTERN.test(stripBenignZeroCounts(line));
}
var JSON_INFO_LOG_PATTERNS = [
  /^\s*\{"level":(?:10|20|30)\b/,
  /^\s*\{[^}]*"level"\s*:\s*"(?:trace|debug|info)"/i
];
var ALWAYS_NOISE_LINE_PATTERNS = [
  /^\[ERROR\]\s*(?:To see the full stack trace|Re-run Maven using the -X|For more information about the errors|\[Help \d+\]|->\s*\[Help \d+\])/i,
  /^\(node:\d+\)\s*ExperimentalWarning:/,
  /^\(Use `node --trace-warnings/
];
function isFailureNoiseLine(line) {
  if (ALWAYS_NOISE_LINE_PATTERNS.some((re) => re.test(line))) return true;
  if (JSON_INFO_LOG_PATTERNS.some((re) => re.test(line))) {
    return !/"statusCode"\s*:\s*5\d\d|\b(?:error|exception|failed|fatal)\b/i.test(
      stripBenignZeroCounts(line)
    );
  }
  return false;
}
var SUMMARY_LINE_PATTERN = /\b(passed|tests?|specs?|suites?|ok|warnings?|errors?|built in|compiled|done in|finished)\b/i;
var MONOREPO_PREFIX_PATTERN = /^(?:@[\w.-]+\/)?[\w./-]+(?::[A-Za-z][\w.-]*|\s+[A-Za-z][\w.-]*):\s+/;
var GREEN_BUILD_OR_PASS_PATTERNS = [
  // Vite / Rollup / esbuild / Webpack / bundler banners & asset size lines
  /^(?:vite|rollup|esbuild|webpack|rspack|parcel|tsup|rolldown)\s+v?\d[\w.-]*\b/i,
  /^transforming(?:\.\.\.|\s*\(\d+\).*|\s+\d+\s+modules?)?$/i,
  /^(?:[✓✔]\s*)?\d+\s+modules?\s+transformed\.?$/i,
  /^(?:rendering chunks|computing (?:gzip|brotli) size|building (?:for |SSR )?production|bundling|minifying|emitting assets)(?:\.{0,3})$/i,
  /^(?:\.\.?\/)?(?:dist|build|out|\.next|\.output|public|assets|lib)\/\S+\s+\d+(?:\.\d+)?\s*(?:B|kB|KB|MB|GB|KiB|MiB|bytes)\b/i,
  /^\S+\.(?:m?js|cjs|css|html|svg|png|woff2?|json|map|wasm)\s+\d+(?:\.\d+)?\s*(?:B|kB|KB|MB|GB|KiB|MiB)(?:\s+[│|]\s*(?:gzip|brotli|map):|\s*$)/i,
  /^(?:[✓✔⚡]\s*)?built\b.*(?:\bin\s{1,4}\d+(?:\.\d+)?\s{0,4}(?:ms|s|m)\b|\(\s{0,4}\d+(?:\.\d+)?\s{0,4}(?:B|KB|kB|MB|GB|KiB|MiB)\s{0,4}\))/i,
  /^(?:[✓✔⚡]\s*)?(?:done in\s+\d+(?:\.\d+)?\s*(?:ms|s|m)\.?|build (?:succeeded|completed|finished)\b|compiled successfully\b|bundle created\b)/i,
  /^(?:asset|chunk|orphan modules|runtime modules|cacheable modules)\s+\S.*\b(?:bytes|KiB|MiB|kB|KB|MB|modules?)\b/i,
  // npm / pnpm / yarn / turbo script & workspace banners
  /^>\s+(?:@[\w.-]+\/)?[\w.-]+@[\w.+-]+(?:\s|$)/,
  /^>\s+(?:vite|tsc|esbuild|rollup|webpack|rspack|tsup|unbuild|next|nuxt|astro|svelte-kit|vitest|jest|mocha|pnpm|npm|yarn|turbo|nx|node|tsx)\b/,
  /^(?:@[\w.-]+\/)?[\w./-]+\s+[A-Za-z][\w.-]*\$\s+\S/,
  /^Scope:\s+\d+\s+of\s+\d+\s+workspace projects\b/i,
  /^Tasks:\s+\d+\s+successful\b/i,
  /^Cached:\s+\d+\s+cached\b/i,
  /^cache hit,\s+replaying logs\b/i,
  /^Time:\s+\d+(?:\.\d+)?\s*(?:ms|s|m)\b/i,
  /^(?:yarn run v\d|•\s+Packages in scope:|•\s+Running\s+\S+\s+in\s+\d+\s+packages)/i,
  // Test pass lines (Vitest / Jest / Mocha / Node / Go / Cargo / TAP)
  /^[✓✔]\s+\S/,
  /^PASS\s+\S/,
  /^(?:---\s+PASS:\s*|===\s+(?:RUN|PAUSE|CONT)\s+)\S/,
  /^ok\t\S/,
  /^ok\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\))/i,
  /^ok\s+\d+\s+-\s+\S/,
  /^test\s+\S+\s+\.\.\.\s+ok\b/,
  /^running\s+\d+\s+tests?$/i,
  /^(?:Test Files|Tests|Suites|Snapshots|Start at|Duration|test result:\s{0,4}ok\.)\s.*(?:\bpassed\b|\btotal\b|\b\d+(?:\.\d+)?(?:ms|s)\b|\bok\.)/i,
  // Rust / Go / Gradle / Maven progress (strictly scoped [INFO] whitelist)
  /^(?:Compiling|Checking|Downloading|Downloaded|Updating|Fresh|Locking|Packaging|Documenting|Finished)\s+\S/,
  /^go:\s+downloading\s+\S/,
  /^>\s+Task\s+:[\w:.-]+\s+(?:UP-TO-DATE|FROM-CACHE|NO-SOURCE|SKIPPED)\s*$/,
  /^\[INFO\]\s*(?:---\s+\S|Building\s+\S|Compiling\s+\S|Changes detected|Nothing to compile|Copying\s+\d+|Using\s+'[^']+'\s+encoding|Downloading\b|Downloaded\b|Installing\s+\S|Packaging\s+\S|Tests run:\s*\d+,\s*Failures:\s*0,\s*Errors:\s*0\b|Results:|Running\s+\S|Reactor Summary|BUILD SUCCESS|Total time:|Finished at:|-+\s*$|$)/i
];
var UNAMBIGUOUS_TEST_PASS_PATTERNS = [
  /^[✓✔]\s+(?!built\b|done\b|\d+\s+modules?\s+transformed\b)\S/,
  /^---\s+PASS:\s+\S/,
  /^ok\s+\d+\s+-\s+\S/,
  /^ok\t\S/,
  /^test\s+\S+\s+\.\.\.\s+ok\s*$/,
  /^PASS\s+\S+\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|cs|php|vue|svelte)\b/
];
function isUnambiguousTestPassLine(trimmed) {
  if (!trimmed || /[✖✘✗×]/.test(trimmed)) return false;
  return UNAMBIGUOUS_TEST_PASS_PATTERNS.some((re) => re.test(trimmed));
}
var MIN_FOLD_RUN_LINES = 4;
var PROTECTED_TAIL_LINES = 15;
function isGreenBuildOrPassLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (isUnambiguousTestPassLine(trimmed)) return true;
  const prefixMatch = MONOREPO_PREFIX_PATTERN.exec(trimmed);
  const inner = prefixMatch ? trimmed.slice(prefixMatch[0].length).trim() : "";
  if (inner && isUnambiguousTestPassLine(inner)) return true;
  if (hasFoldDangerToken(trimmed)) return false;
  if (GREEN_BUILD_OR_PASS_PATTERNS.some((re) => re.test(trimmed))) {
    return true;
  }
  if (prefixMatch) {
    if (!inner) return false;
    if (inner === "Done") return true;
    return GREEN_BUILD_OR_PASS_PATTERNS.some((re) => re.test(inner));
  }
  return false;
}
function formatLastCollapsedPreview(line) {
  const trimmed = line.trim();
  if (trimmed.length <= 120) return trimmed;
  return `${sliceSafeChars(trimmed, 117)}...`;
}
function foldGreenBuildPhaseLines(lines) {
  const foldableEnd = Math.max(0, lines.length - PROTECTED_TAIL_LINES);
  if (foldableEnd < MIN_FOLD_RUN_LINES) {
    return { lines, collapsedLines: 0 };
  }
  const out = [];
  let collapsedLines = 0;
  let i = 0;
  while (i < foldableEnd) {
    if (!isGreenBuildOrPassLine(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const start = i;
    let lastGreen = i;
    let greenCount = 1;
    i++;
    while (i < foldableEnd) {
      const cur = lines[i];
      if (isGreenBuildOrPassLine(cur)) {
        lastGreen = i;
        greenCount++;
        i++;
      } else if (cur.trim() === "") {
        i++;
      } else {
        break;
      }
    }
    if (greenCount >= MIN_FOLD_RUN_LINES) {
      const runLen = lastGreen - start + 1;
      const placeholder = `... (collapsed ${runLen} build/pass lines; last: ${formatLastCollapsedPreview(lines[lastGreen])})`;
      let originalRunChars = runLen - 1;
      for (let j = start; j <= lastGreen; j++) {
        originalRunChars += lines[j].length;
      }
      if (placeholder.length < originalRunChars) {
        out.push(placeholder);
        collapsedLines += runLen;
      } else {
        for (let j = start; j <= lastGreen; j++) {
          out.push(lines[j]);
        }
      }
      i = lastGreen + 1;
    } else {
      for (let j = start; j <= lastGreen; j++) {
        out.push(lines[j]);
      }
      i = lastGreen + 1;
    }
  }
  for (let j = foldableEnd; j < lines.length; j++) {
    out.push(lines[j]);
  }
  return { lines: out, collapsedLines };
}
function formatOmittedLinesMarker(omitted, markTruncated) {
  return markTruncated ? `... [truncated: ${omitted} lines omitted] ...` : `... (${omitted} lines omitted) ...`;
}
function renderSelectedIndices(lines, indices, leadingOmission, markTruncated = false) {
  if (indices.length === 0) return "";
  const out = [];
  if (leadingOmission && indices[0] > 0) {
    out.push(formatOmittedLinesMarker(indices[0], markTruncated));
  }
  let prev = -1;
  for (const idx of indices) {
    if (prev !== -1 && idx > prev + 1) {
      out.push(formatOmittedLinesMarker(idx - prev - 1, markTruncated));
    }
    out.push(lines[idx]);
    prev = idx;
  }
  return out.join("\n");
}
function packTailIndices(lines, candidates, budget, leadingOmission, markTruncated = false) {
  if (candidates.length === 0 || budget <= 0) {
    return { indices: [], text: "" };
  }
  const chosenRev = [];
  let usedChars = 0;
  for (let k = candidates.length - 1; k >= 0; k--) {
    const idx = candidates[k];
    const lineLen = lines[idx].length;
    let add = lineLen;
    if (chosenRev.length > 0) {
      const nextIdx = chosenRev[chosenRev.length - 1];
      if (nextIdx > idx + 1) {
        const gapMarkerLen = formatOmittedLinesMarker(
          nextIdx - idx - 1,
          markTruncated
        ).length;
        add = lineLen + 1 + gapMarkerLen + 1;
      } else {
        add = lineLen + 1;
      }
    }
    const headerLen = leadingOmission && idx > 0 ? formatOmittedLinesMarker(idx, markTruncated).length + 1 : 0;
    if (usedChars + add + headerLen <= budget) {
      chosenRev.push(idx);
      usedChars += add;
    } else {
      break;
    }
  }
  const indices = chosenRev.reverse();
  return {
    indices,
    text: renderSelectedIndices(lines, indices, leadingOmission, markTruncated)
  };
}
function compactSingleOversizedErrorLine(line, lineIdx, limit) {
  const rawPrefix = lineIdx > 0 ? `${formatOmittedLinesMarker(lineIdx, true)}
` : "";
  const prefix = limit - rawPrefix.length >= 40 ? rawPrefix : "";
  const avail = limit - prefix.length;
  if (line.length <= avail) {
    return `${prefix}${line}`;
  }
  const maxFoldedMarker = ` ... [truncated: folded ${line.length} chars] ... `;
  if (avail >= maxFoldedMarker.length + 24) {
    const contentAvail2 = avail - maxFoldedMarker.length;
    const headChars2 = Math.max(8, Math.floor(contentAvail2 * 0.28));
    const tailChars2 = Math.max(16, contentAvail2 - headChars2);
    const head = sliceSafeChars(line, headChars2);
    const tail = sliceSafeCharsTail(line, tailChars2);
    const omitted = Math.max(1, line.length - head.length - tail.length);
    const marker = ` ... [truncated: folded ${omitted} chars] ... `;
    return `${prefix}${head}${marker}${tail}`;
  }
  const joiner = " ... ";
  if (avail <= joiner.length + 2) {
    return `${prefix}${sliceSafeCharsTail(line, avail)}`;
  }
  const contentAvail = avail - joiner.length;
  const headChars = Math.max(1, Math.floor(contentAvail * 0.28));
  const tailChars = Math.max(1, contentAvail - headChars);
  return `${prefix}${sliceSafeChars(line, headChars)}${joiner}${sliceSafeCharsTail(line, tailChars)}`;
}
function compactLongFailureLines(lines, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  const fullText = lines.join("\n");
  if (fullText.length <= limit) return fullText;
  if (limit < 80) {
    if (limit <= 3) return sliceSafeCharsTail(fullText, limit);
    return `...${sliceSafeCharsTail(fullText, limit - 3)}`;
  }
  let firstErrorLineIdx = -1;
  const keepIndices = /* @__PURE__ */ new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const monoMatch = MONOREPO_PREFIX_PATTERN.exec(trimmed);
    const monoInner = monoMatch ? trimmed.slice(monoMatch[0].length).trim() : "";
    if (isUnambiguousTestPassLine(trimmed) || monoInner.length > 0 && isUnambiguousTestPassLine(monoInner)) {
      continue;
    }
    if (ROOT_CAUSE_HEADER_PATTERN.test(line)) {
      if (firstErrorLineIdx === -1) firstErrorLineIdx = i;
      const from = Math.max(0, i - 1);
      const to = Math.min(lines.length - 1, i + 8);
      for (let j = from; j <= to; j++) keepIndices.add(j);
    } else if (isErrorLine(line)) {
      if (firstErrorLineIdx === -1) firstErrorLineIdx = i;
      const from = Math.max(0, i - 1);
      const to = Math.min(lines.length - 1, i + 3);
      for (let j = from; j <= to; j++) keepIndices.add(j);
    }
  }
  const tailStart = Math.max(0, lines.length - PROTECTED_TAIL_LINES);
  for (let i = tailStart; i < lines.length; i++) {
    keepIndices.add(i);
  }
  if (firstErrorLineIdx === -1) {
    const allIndices = Array.from({ length: lines.length }, (_, idx) => idx);
    const tailPacked2 = packTailIndices(lines, allIndices, limit, true, true);
    if (tailPacked2.text) return tailPacked2.text;
    return compactSingleOversizedErrorLine(
      lines[lines.length - 1],
      lines.length - 1,
      limit
    );
  }
  const candidateIndices = [...keepIndices].sort((a, b) => a - b);
  const fullCandidatesText = renderSelectedIndices(
    lines,
    candidateIndices,
    true,
    true
  );
  if (fullCandidatesText.length <= limit) {
    return fullCandidatesText;
  }
  const tailOnly = packTailIndices(lines, candidateIndices, limit, true, true);
  if (tailOnly.indices.length > 0 && tailOnly.indices[0] <= firstErrorLineIdx) {
    return tailOnly.text;
  }
  if (firstErrorLineIdx === candidateIndices[candidateIndices.length - 1]) {
    return compactSingleOversizedErrorLine(
      lines[firstErrorLineIdx],
      firstErrorLineIdx,
      limit
    );
  }
  const maxSepLen = `
${formatOmittedLinesMarker(lines.length, true)}
`.length;
  const usableForSplit = Math.max(0, limit - maxSepLen);
  const headBudget = Math.floor(usableForSplit * 0.28);
  const firstPosInCandidates = candidateIndices.indexOf(firstErrorLineIdx);
  const headIndices = [];
  if (headBudget >= 24 && firstPosInCandidates !== -1) {
    const prevIdx = firstErrorLineIdx - 1;
    const leadIfPrev = prevIdx > 0 ? formatOmittedLinesMarker(prevIdx, true).length + 1 : 0;
    const prevLine = prevIdx >= 0 ? lines[prevIdx] : "";
    const firstLine = lines[firstErrorLineIdx];
    if (prevIdx >= 0 && prevLine.length <= Math.floor(headBudget * 0.35) && leadIfPrev + prevLine.length + 1 + firstLine.length <= headBudget) {
      headIndices.push(prevIdx);
    }
    for (let pos = firstPosInCandidates; pos < candidateIndices.length; pos++) {
      const idx = candidateIndices[pos];
      if (headIndices.length > 0 && idx > headIndices[headIndices.length - 1] + 1) {
        break;
      }
      const trial = [...headIndices, idx];
      const rendered = renderSelectedIndices(lines, trial, true, true);
      if (rendered.length <= headBudget) {
        headIndices.push(idx);
      } else {
        break;
      }
    }
  }
  if (headIndices.length === 0) {
    const remainingCandidates2 = candidateIndices.filter((idx) => idx > firstErrorLineIdx);
    const minHeadReserve = Math.max(40, headBudget);
    const maxTailBudget = Math.max(0, limit - minHeadReserve - maxSepLen);
    const tailPacked2 = packTailIndices(
      lines,
      remainingCandidates2,
      maxTailBudget,
      false,
      true
    );
    if (tailPacked2.indices.length > 0) {
      const omitted = tailPacked2.indices[0] - firstErrorLineIdx - 1;
      const sep = omitted > 0 ? `
${formatOmittedLinesMarker(omitted, true)}
` : "\n";
      const availForFirst = limit - tailPacked2.text.length - sep.length;
      if (availForFirst >= 24) {
        const firstRendered = compactSingleOversizedErrorLine(
          lines[firstErrorLineIdx],
          firstErrorLineIdx,
          availForFirst
        );
        const combinedResult = `${firstRendered}${sep}${tailPacked2.text}`;
        return combinedResult.length <= limit ? combinedResult : sliceSafeChars(combinedResult, limit);
      }
    }
    if (remainingCandidates2.length > 0) {
      const lastIdx = remainingCandidates2[remainingCandidates2.length - 1];
      const omitted = lastIdx - firstErrorLineIdx - 1;
      const sep = omitted > 0 ? `
${formatOmittedLinesMarker(omitted, true)}
` : "\n... [truncated: folded middle] ...\n";
      const avail = limit - sep.length;
      if (avail >= 24) {
        const headShare = Math.max(10, Math.floor(avail * 0.28));
        const tailShare = Math.max(14, avail - headShare);
        const headPart = `${sliceSafeChars(lines[firstErrorLineIdx], Math.max(1, headShare - 3))}...`;
        const tailPart = `...${sliceSafeCharsTail(lines[lastIdx], Math.max(1, tailShare - 3))}`;
        const combinedResult = `${headPart}${sep}${tailPart}`;
        return combinedResult.length <= limit ? combinedResult : sliceSafeChars(combinedResult, limit);
      }
    }
    if (tailOnly.text) return tailOnly.text;
    return compactSingleOversizedErrorLine(
      lines[firstErrorLineIdx],
      firstErrorLineIdx,
      limit
    );
  }
  const headText = renderSelectedIndices(lines, headIndices, true, true);
  const headLastIdx = headIndices[headIndices.length - 1];
  const remainingCandidates = candidateIndices.filter((idx) => idx > headLastIdx);
  const tailBudget = Math.max(0, limit - headText.length - maxSepLen);
  const tailPacked = packTailIndices(
    lines,
    remainingCandidates,
    tailBudget,
    false,
    true
  );
  if (tailPacked.indices.length > 0) {
    const omitted = tailPacked.indices[0] - headLastIdx - 1;
    const sep = omitted > 0 ? `
${formatOmittedLinesMarker(omitted, true)}
` : "\n";
    const combinedResult = `${headText}${sep}${tailPacked.text}`;
    return combinedResult.length <= limit ? combinedResult : sliceSafeChars(combinedResult, limit);
  }
  if (remainingCandidates.length > 0 && tailBudget > 6) {
    const lastIdx = remainingCandidates[remainingCandidates.length - 1];
    const omitted = lastIdx - headLastIdx - 1;
    const sep = omitted > 0 ? `
${formatOmittedLinesMarker(omitted, true)}
` : "\n";
    const availTail = limit - headText.length - sep.length;
    if (availTail > 3) {
      const tailSlice = `...${sliceSafeCharsTail(lines[lastIdx], availTail - 3)}`;
      const combinedResult = `${headText}${sep}${tailSlice}`;
      return combinedResult.length <= limit ? combinedResult : sliceSafeChars(combinedResult, limit);
    }
  }
  return headText.length <= limit ? headText : sliceSafeChars(headText, limit);
}
function describeFatalExitCode(exitCode) {
  switch (exitCode) {
    case 137:
      return "exit 137 / SIGKILL - possible OOM";
    case 139:
      return "exit 139 / SIGSEGV - segmentation fault";
    case 134:
      return "exit 134 / SIGABRT - process aborted";
    case 3221225477:
    case -1073741819:
      return "exit 0xC0000005 / STATUS_ACCESS_VIOLATION";
    case 3221225725:
    case -1073741571:
      return "exit 0xC00000FD / STATUS_STACK_OVERFLOW";
    case 3221226505:
    case -1073740791:
      return "exit 0xC0000409 / STATUS_STACK_BUFFER_OVERRUN";
    default:
      return null;
  }
}
function formatExitFailureLabel(exitCode, signal) {
  if (signal) {
    switch (signal) {
      case "SIGKILL":
        return "SIGKILL - possible OOM";
      case "SIGSEGV":
        return "SIGSEGV - segmentation fault";
      case "SIGABRT":
        return "SIGABRT - process aborted";
      case "SIGTERM":
        return "SIGTERM";
      default:
        return String(signal);
    }
  }
  const fatalExit = describeFatalExitCode(exitCode);
  if (fatalExit) return fatalExit;
  return `exit ${exitCode ?? "err"}`;
}
function prepareCompactCommandOutput(params) {
  const out = normalizeTerminalOutput(params.stdout);
  const err = normalizeTerminalOutput(params.stderr);
  const combined = [out, err].filter(Boolean).join("\n");
  const rawChars = combined.length;
  const rawLines = combined ? combined.split("\n").length : 0;
  if (params.error) {
    return {
      kind: "error",
      bodyText: `spawn error: ${params.error}`,
      collapsedLines: 0,
      rawLines,
      rawChars
    };
  }
  if (params.timedOut) {
    const tail = getTailLines(combined, 20);
    return {
      kind: "timeout",
      bodyText: tail ? `TIMED OUT
${tail}` : "TIMED OUT (no output)",
      collapsedLines: 0,
      rawLines,
      rawChars
    };
  }
  if (params.exitCode === 0) {
    if (!combined) {
      return {
        kind: "pass-empty",
        bodyText: "OK",
        collapsedLines: 0,
        rawLines: 0,
        rawChars: 0
      };
    }
    const lines = combined.split("\n").map((l) => l.trim()).filter(Boolean);
    const summaryLines = lines.filter((l) => SUMMARY_LINE_PATTERN.test(l));
    const picked = summaryLines.length > 0 ? summaryLines.slice(-2) : lines.length <= 2 ? lines : [lines[lines.length - 1]];
    return {
      kind: "pass-summary",
      bodyText: picked.join(" | "),
      collapsedLines: 0,
      rawLines,
      rawChars
    };
  }
  if (!combined) {
    const fatalExitLabel = params.signal ? null : describeFatalExitCode(params.exitCode);
    const bodyText = params.signal ? `Terminated by ${formatExitFailureLabel(params.exitCode, params.signal)}` : fatalExitLabel ? `Terminated (${fatalExitLabel})` : `Exited with code ${params.exitCode ?? "unknown"}`;
    return {
      kind: "fail-empty",
      bodyText,
      collapsedLines: 0,
      rawLines: 0,
      rawChars: 0
    };
  }
  const splitLines = combined.split("\n");
  const filteredLines = splitLines.filter((line) => !isFailureNoiseLine(line));
  const cleanedLines = filteredLines.length > 0 ? filteredLines : splitLines;
  const { lines: foldedLines, collapsedLines } = foldGreenBuildPhaseLines(cleanedLines);
  return {
    kind: "fail-lines",
    bodyText: foldedLines.join("\n"),
    foldedLines,
    collapsedLines,
    rawLines,
    rawChars
  };
}
function renderPreparedCompactCommandOutput(prepared, maxChars) {
  if (prepared.kind === "error" || prepared.kind === "fail-empty") {
    const text2 = truncateWithNotice(prepared.bodyText, maxChars);
    return {
      text: text2,
      collapsedLines: 0,
      truncated: text2 !== prepared.bodyText,
      rawLines: prepared.rawLines,
      rawChars: prepared.rawChars
    };
  }
  if (prepared.kind === "timeout") {
    const text2 = truncateHeadTailWithNotice(prepared.bodyText, maxChars);
    return {
      text: text2,
      collapsedLines: 0,
      truncated: text2 !== prepared.bodyText || prepared.rawLines > 20,
      rawLines: prepared.rawLines,
      rawChars: prepared.rawChars
    };
  }
  if (prepared.kind === "pass-empty") {
    const text2 = truncateWithNotice(prepared.bodyText, maxChars);
    return {
      text: text2,
      collapsedLines: 0,
      truncated: text2 !== prepared.bodyText,
      rawLines: 0,
      rawChars: 0
    };
  }
  if (prepared.kind === "pass-summary") {
    const cap = Math.min(maxChars, 320);
    const text2 = truncateWithNotice(prepared.bodyText, cap);
    return {
      text: text2,
      collapsedLines: 0,
      truncated: text2 !== prepared.bodyText,
      rawLines: prepared.rawLines,
      rawChars: prepared.rawChars
    };
  }
  if (prepared.bodyText.length <= maxChars) {
    return {
      text: prepared.bodyText,
      collapsedLines: prepared.collapsedLines,
      truncated: false,
      rawLines: prepared.rawLines,
      rawChars: prepared.rawChars
    };
  }
  const text = compactLongFailureLines(prepared.foldedLines ?? [], maxChars);
  return {
    text,
    collapsedLines: prepared.collapsedLines,
    truncated: true,
    rawLines: prepared.rawLines,
    rawChars: prepared.rawChars
  };
}
function formatCompactCommandOutputWithMeta(params) {
  return renderPreparedCompactCommandOutput(
    prepareCompactCommandOutput(params),
    params.maxChars
  );
}
function formatCompactCommandOutput(params) {
  return formatCompactCommandOutputWithMeta(params).text;
}
function getTailLines(text, count) {
  if (!text) return "";
  const lines = text.split("\n");
  return lines.slice(-count).join("\n");
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
function getConfigPath(env = process.env) {
  const custom = env.AGY_FAST_CACHE_DIR?.trim();
  const home = process.platform === "win32" ? env.USERPROFILE || env.HOME || os2.homedir() : env.HOME || env.USERPROFILE || os2.homedir();
  const cacheDir = custom ? path2.resolve(custom) : path2.join(home, ".gemini", "cache", "agy-fast");
  return path2.join(cacheDir, "config.json");
}
function readSavedEditsFormatSync(env = process.env) {
  try {
    const raw = fs.readFileSync(getConfigPath(env), "utf8");
    const parsed = JSON.parse(raw);
    return parseEditsFormatMode(parsed?.editsFormat) ?? void 0;
  } catch {
    return void 0;
  }
}

// src/tools/apply-edits.ts
import { promises as fs3 } from "node:fs";
import path4 from "node:path";

// src/utils/arg-validation.ts
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function describeValueType(value) {
  if (value === null) return "null";
  if (value === void 0) return "undefined";
  if (Array.isArray(value)) return `array (len=${value.length})`;
  if (typeof value === "boolean") return `boolean (${String(value)})`;
  if (typeof value === "number") return `number (${String(value)})`;
  if (typeof value === "string") return `string (len=${value.length})`;
  return typeof value;
}
function parseMaybeJsonArray(value) {
  if (value === void 0) {
    return { ok: false, kind: "missing", detail: "undefined" };
  }
  if (Array.isArray(value)) {
    return { ok: true, value };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return { ok: false, kind: "wrong_type", detail: "empty string" };
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return { ok: true, value: parsed };
      }
      if (parsed === null || typeof parsed === "boolean") {
        return {
          ok: false,
          kind: "corrupted_literal",
          detail: describeValueType(parsed),
          value: parsed
        };
      }
      return {
        ok: false,
        kind: "invalid_json",
        detail: `decoded to ${describeValueType(parsed)} instead of a JSON array`
      };
    } catch (err) {
      return {
        ok: false,
        kind: "invalid_json",
        detail: err instanceof Error ? err.message : String(err)
      };
    }
  }
  return {
    ok: false,
    kind: "wrong_type",
    detail: describeValueType(value)
  };
}
function formatCorruptedArrayError(options) {
  const details = options.items.slice(0, 8).map(
    (item) => `- ${item.label}: received ${describeValueType(item.value)} instead of ${item.expected ?? "an object"}`
  );
  if (options.items.length > 8) {
    details.push(`- ... (+${options.items.length - 8} more corrupted entries)`);
  }
  return [
    `${options.header}: nested argument serialization corruption detected in call_mcp_tool.`,
    ...details,
    "",
    `Hint: untyped call_mcp_tool Arguments can occasionally collapse nested objects/arrays into booleans, null, or an empty array. Do NOT retry the same ${options.toolName} payload \u2014 ${options.fallbackAdvice}`
  ].join("\n");
}

// src/utils/fs-utils.ts
import { promises as fs2 } from "node:fs";
import os3 from "node:os";
import path3 from "node:path";
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
function expandHome(inputPath) {
  if (inputPath === "~") return os3.homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path3.join(os3.homedir(), inputPath.slice(2));
  }
  return inputPath;
}
function resolvePath(inputPath, baseDir) {
  const expanded = expandHome(inputPath.trim());
  const root = baseDir ? path3.resolve(expandHome(baseDir)) : process.cwd();
  return path3.resolve(root, expanded);
}
function toPosixPath(p) {
  return p.split(path3.sep).join("/");
}
function isLikelyBinary(buf) {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
function hasUtf8Bom(buf) {
  return buf.length >= 3 && buf[0] === 239 && buf[1] === 187 && buf[2] === 191;
}
function detectUtf16Bom(buf) {
  if (buf.length < 2) return null;
  if (buf[0] === 255 && buf[1] === 254) {
    if (buf.length >= 4 && buf[2] === 0 && buf[3] === 0) {
      return null;
    }
    return "UTF-16 LE";
  }
  if (buf[0] === 254 && buf[1] === 255) {
    return "UTF-16 BE";
  }
  return null;
}
async function readTextFile(filePath, maxBytes = 10 * 1024 * 1024) {
  const stat = await fs2.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(
      `File exceeds maximum size (${stat.size} bytes > ${maxBytes} bytes): ${filePath}`
    );
  }
  const buf = await fs2.readFile(filePath);
  const utf16Bom = detectUtf16Bom(buf);
  if (utf16Bom) {
    throw new Error(
      `UTF-16 encoded file is not supported (convert to UTF-8 first): ${filePath} [${utf16Bom}]`
    );
  }
  if (isLikelyBinary(buf)) {
    throw new Error(`Binary file cannot be read as text: ${filePath}`);
  }
  const hasBom = hasUtf8Bom(buf);
  const rawContent = (hasBom ? buf.subarray(3) : buf).toString("utf8");
  let crlfCount = 0;
  let lfOnlyCount = 0;
  for (let i = 0; i < rawContent.length; i++) {
    if (rawContent[i] === "\n") {
      if (i > 0 && rawContent[i - 1] === "\r") crlfCount++;
      else lfOnlyCount++;
    }
  }
  const eol = crlfCount > lfOnlyCount ? "\r\n" : "\n";
  const mixedEol = crlfCount > 0 && lfOnlyCount > 0;
  return {
    content: rawContent,
    rawContent,
    eol,
    mixedEol,
    hasBom,
    size: stat.size,
    mode: stat.mode & 4095,
    rawBuffer: buf
  };
}
function globToRegExp(pattern) {
  const normalized = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\*{3,}/g, "**").replace(/(?:\*\*\/)+/g, "**/");
  const re = `^${compileGlobBody(normalized)}$`;
  try {
    return new RegExp(re);
  } catch (err) {
    throw new Error(
      `Invalid glob pattern '${pattern}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
function compileGlobBody(normalized) {
  let re = "";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else if (ch === "[") {
      const close = findClosingBracket(normalized, i);
      if (close === -1) {
        re += "\\[";
        i += 1;
      } else {
        let inner = normalized.slice(i + 1, close);
        const negated = inner.startsWith("!") || inner.startsWith("^");
        if (negated) inner = inner.slice(1);
        inner = inner.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
        re += negated ? `(?!/)[${"^"}${inner}]` : `[${inner}]`;
        i = close + 1;
      }
    } else if (ch === "{") {
      const close = findMatchingBrace(normalized, i);
      if (close === -1) {
        re += "\\{";
        i += 1;
      } else {
        const parts = splitBraceAlternatives(normalized.slice(i + 1, close));
        const sub = parts.map((part) => compileGlobBody(part.replace(/\*{3,}/g, "**").replace(/(?:\*\*\/)+/g, "**/"))).join("|");
        re += `(?:${sub})`;
        i = close + 1;
      }
    } else if (".+^$()|\\".includes(ch)) {
      re += "\\" + ch;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  return re;
}
function findClosingBracket(str, openIdx) {
  let i = openIdx + 1;
  if (i < str.length && (str[i] === "!" || str[i] === "^")) i++;
  if (i < str.length && str[i] === "]") i++;
  for (; i < str.length; i++) {
    if (str[i] === "]") return i;
  }
  return -1;
}
function findMatchingBrace(str, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === "[") {
      const close = findClosingBracket(str, i);
      if (close !== -1) {
        i = close;
        continue;
      }
    }
    if (str[i] === "{") depth++;
    else if (str[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function splitBraceAlternatives(inner) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "[") {
      const close = findClosingBracket(inner, i);
      if (close !== -1) {
        i = close;
        continue;
      }
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}
async function walkFiles(rootDir, options = {}) {
  const maxFiles = Math.max(0, Math.trunc(options.maxFiles ?? 5e3));
  const maxDepth = options.maxDepth ?? 32;
  const includeHidden = options.includeHidden ?? false;
  const ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const fileFilter = options.fileFilter;
  const files = [];
  let truncated = false;
  const MAX_CONCURRENT_READDIRS = 16;
  let activeReaddirs = 0;
  const waitQueue = [];
  const drainWaiters = () => {
    while (waitQueue.length > 0) {
      waitQueue.shift()();
    }
  };
  const markTruncated = () => {
    if (truncated) return;
    truncated = true;
    drainWaiters();
  };
  const readDirBounded = async (dir) => {
    if (truncated) return null;
    while (activeReaddirs >= MAX_CONCURRENT_READDIRS) {
      await new Promise((resolve) => waitQueue.push(resolve));
      if (truncated) return null;
    }
    if (truncated) return null;
    activeReaddirs++;
    try {
      return await fs2.readdir(dir, { withFileTypes: true });
    } finally {
      activeReaddirs--;
      if (truncated) {
        drainWaiters();
      } else {
        const next = waitQueue.shift();
        if (next) next();
      }
    }
  };
  const scanDir = async (dir, relDir) => {
    if (truncated) return { localFiles: [], subdirs: [] };
    let entries;
    try {
      entries = await readDirBounded(dir);
    } catch {
      return { localFiles: [], subdirs: [] };
    }
    if (!entries || truncated) return { localFiles: [], subdirs: [] };
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const localFiles = [];
    const subdirs = [];
    for (const entry of entries) {
      const name = entry.name;
      if (!includeHidden && name.startsWith(".")) {
        if (!(entry.isDirectory() && name === ".agents")) {
          continue;
        }
      }
      const relPosix = relDir ? `${relDir}/${name}` : name;
      if (entry.isDirectory()) {
        if (ignoreDirs.has(name)) continue;
        subdirs.push({ abs: path3.join(dir, name), rel: relPosix });
      } else if (entry.isFile()) {
        if (fileFilter && !fileFilter(relPosix)) continue;
        localFiles.push(relPosix);
      }
    }
    return { localFiles, subdirs };
  };
  async function visit(dir, relDir, depth, prefetched) {
    if (truncated || depth > maxDepth) return;
    const { localFiles, subdirs } = await (prefetched ?? scanDir(dir, relDir));
    for (const relPosix of localFiles) {
      if (files.length >= maxFiles) {
        markTruncated();
        return;
      }
      files.push(relPosix);
    }
    if (depth >= maxDepth || subdirs.length === 0) return;
    const batchSize = 8;
    for (let i = 0; i < subdirs.length && !truncated; i += batchSize) {
      const slice = subdirs.slice(i, i + batchSize);
      const prefetches = slice.map((sub) => scanDir(sub.abs, sub.rel));
      try {
        for (let j = 0; j < slice.length && !truncated; j++) {
          await visit(slice[j].abs, slice[j].rel, depth + 1, prefetches[j]);
        }
      } finally {
        if (truncated) {
          await Promise.allSettled(prefetches);
        }
      }
    }
  }
  await visit(rootDir, "", 0);
  return { files, truncated };
}

// src/tools/apply-edits.ts
function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}
function offsetToLine(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.max(1, hi + 1);
}
function formatMatchLineRange(lineStarts, offset, length, prefix = "L") {
  const startLine = offsetToLine(lineStarts, offset);
  const endOffset = length > 0 ? offset + length - 1 : offset;
  const endLine = offsetToLine(lineStarts, endOffset);
  return startLine === endLine ? `${prefix}${startLine}` : `${prefix}${startLine}-${prefix}${endLine}`;
}
function getLineWindowOffsets(text, lineStarts, startLine, endLine) {
  if (startLine !== void 0 && (typeof startLine !== "number" || !Number.isFinite(startLine) || startLine < 1)) {
    throw new Error(`Invalid startLine: ${String(startLine)} (must be integer >= 1)`);
  }
  if (endLine !== void 0 && (typeof endLine !== "number" || !Number.isFinite(endLine) || endLine < 1)) {
    throw new Error(`Invalid endLine: ${String(endLine)} (must be integer >= 1)`);
  }
  const totalLines = lineStarts.length;
  const sLine = startLine !== void 0 ? Math.trunc(startLine) : 1;
  const eLine = endLine !== void 0 ? Math.min(totalLines, Math.trunc(endLine)) : totalLines;
  if (sLine > totalLines) {
    return { windowStart: text.length, windowEnd: text.length };
  }
  if (eLine < sLine) {
    throw new Error(`Invalid line range: startLine (${sLine}) > endLine (${eLine})`);
  }
  const windowStart = lineStarts[sLine - 1];
  const windowEnd = eLine < totalLines ? lineStarts[eLine] : text.length;
  return { windowStart, windowEnd };
}
var MAX_NEARBY_LINES = 26;
function formatNearbyLines(text, startLine, endLine) {
  const lines = text.split("\n");
  if (startLine === void 0 && endLine === void 0) return "";
  const from = Math.max(1, (startLine ?? endLine ?? 1) - 2);
  const rawTo = Math.min(lines.length, (endLine ?? startLine ?? 1) + 2);
  const truncated = rawTo - from + 1 > MAX_NEARBY_LINES;
  const to = truncated ? from + MAX_NEARBY_LINES - 1 : rawTo;
  const snippet = [];
  for (let ln = from; ln <= to; ln++) {
    const lineText = lines[ln - 1] ?? "";
    snippet.push(
      `    ${ln}: ${lineText.length > 160 ? `${sliceSafeChars(lineText, 157)}...` : lineText}`
    );
  }
  const extra = truncated ? `
    ... (${rawTo - to} more lines in range omitted)` : "";
  return `
  Nearby lines (${from}-${to}):
${snippet.join("\n")}${extra}`;
}
function extractLineTokens(trimmedLine) {
  const tokens = trimmedLine.match(/[A-Za-z0-9_$]{3,}|[\u4e00-\u9fff]{2,}/g);
  if (tokens && tokens.length > 0) return tokens;
  return trimmedLine.split(/\s+/).map((s) => s.trim()).filter((s) => s.length >= 2);
}
function findClosestRegionSnippet(normalizedContent, normTarget, rangeStartLine, rangeEndLine) {
  const fileLines = normalizedContent.split("\n");
  if (fileLines.length === 0) return "";
  const targetLines = normTarget.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (targetLines.length === 0) return "";
  let firstAnchorIdx = 0;
  for (let idx = 0; idx < targetLines.length; idx++) {
    if (targetLines[idx].length >= 6) {
      firstAnchorIdx = idx;
      break;
    }
  }
  let longestAnchorIdx = 0;
  for (let idx = 1; idx < targetLines.length; idx++) {
    if (targetLines[idx].length > targetLines[longestAnchorIdx].length) {
      longestAnchorIdx = idx;
    }
  }
  const lastAnchorIdx = targetLines.length - 1;
  const anchorIndices = /* @__PURE__ */ new Set([firstAnchorIdx, longestAnchorIdx]);
  if (targetLines[lastAnchorIdx].length >= 8) {
    anchorIndices.add(lastAnchorIdx);
  }
  const anchors = [...anchorIndices].map((idx) => ({
    text: targetLines[idx],
    idx,
    tokens: new Set(extractLineTokens(targetLines[idx]))
  }));
  const targetTokenSets = targetLines.map((tl) => new Set(extractLineTokens(tl)));
  const trimmedFileLines = fileLines.map((l) => l.trim());
  const scanStart = Math.max(0, (rangeStartLine ?? 1) - 1);
  const scanEnd = Math.min(
    trimmedFileLines.length - 1,
    (rangeEndLine ?? trimmedFileLines.length) - 1
  );
  if (scanStart > scanEnd) return "";
  const evaluatedStarts = /* @__PURE__ */ new Set();
  let bestStart = -1;
  let bestScore = 0;
  const scoreIndices = [];
  const windowLen = Math.min(targetLines.length, 10);
  for (let k = 0; k < windowLen; k++) {
    scoreIndices.push(k);
  }
  for (const idx of anchorIndices) {
    if (idx >= windowLen) {
      scoreIndices.push(idx);
    }
  }
  const scoreCandidateStart = (candStart) => {
    let total = 0;
    for (const k of scoreIndices) {
      const fIdx = candStart + k;
      if (fIdx > scanEnd || fIdx >= trimmedFileLines.length) continue;
      const fLine = trimmedFileLines[fIdx];
      const tLine = targetLines[k];
      if (!fLine || !tLine) continue;
      const tTokens = targetTokenSets[k];
      const isHighEntropy = tLine.length >= 12 && tTokens.size >= 2;
      if (fLine === tLine) {
        total += isHighEntropy ? 8 + Math.min(6, tLine.length / 14) : 4;
      } else if (tLine.length >= 8 && (fLine.includes(tLine) || tLine.includes(fLine))) {
        total += isHighEntropy ? 6 : 3.5;
      } else if (tTokens.size > 0) {
        const lineTokens = extractLineTokens(fLine);
        let hits = 0;
        for (const tok of lineTokens) {
          if (tTokens.has(tok)) hits += 1;
        }
        if (hits >= 2 || hits >= 1 && tTokens.size <= 2 && hits === tTokens.size) {
          total += (isHighEntropy ? 4.5 : 3) * (hits / tTokens.size);
        }
      }
    }
    return total;
  };
  for (let i = scanStart; i <= scanEnd; i++) {
    const line = trimmedFileLines[i];
    if (!line) continue;
    for (const anchor of anchors) {
      let matchedAnchor = false;
      if (line === anchor.text || anchor.text.length >= 8 && (line.includes(anchor.text) || anchor.text.includes(line))) {
        matchedAnchor = true;
      } else if (anchor.tokens.size > 0) {
        const lineTokens = extractLineTokens(line);
        let hits = 0;
        for (const tok of lineTokens) {
          if (anchor.tokens.has(tok)) hits += 1;
        }
        if (hits >= 2 || hits >= 1 && anchor.tokens.size <= 2 && hits === anchor.tokens.size) {
          matchedAnchor = true;
        }
      }
      if (!matchedAnchor) continue;
      const candStart = Math.max(scanStart, Math.min(scanEnd, i - anchor.idx));
      if (evaluatedStarts.has(candStart)) continue;
      evaluatedStarts.add(candStart);
      const score = scoreCandidateStart(candStart);
      if (score > bestScore) {
        bestScore = score;
        bestStart = candStart;
      }
    }
  }
  if (bestStart < 0 || bestScore < 2.5) return "";
  const span = Math.min(Math.max(targetLines.length, 4), 8);
  const from = Math.max(1, bestStart + 1 - 2);
  const to = Math.min(fileLines.length, Math.min(from + 13, bestStart + 1 + span + 2));
  const snippet = [];
  for (let ln = from; ln <= to; ln++) {
    const lineText = fileLines[ln - 1] ?? "";
    snippet.push(
      `    ${ln}: ${lineText.length > 160 ? `${sliceSafeChars(lineText, 157)}...` : lineText}`
    );
  }
  return `
  Closest match near line ${bestStart + 1} (lines ${from}-${to}):
${snippet.join("\n")}`;
}
function planHunksForContent(normalizedContent, hunks, displayPath) {
  const lineStarts = computeLineStarts(normalizedContent);
  const spans = [];
  const errors = [];
  for (let idx = 0; idx < hunks.length; idx++) {
    const hunk = hunks[idx];
    if (!isPlainObject(hunk)) {
      errors.push(`${displayPath} hunk #${idx + 1}: must be an object with 'target' and 'replacement'`);
      continue;
    }
    if (typeof hunk.target !== "string" || hunk.target.length === 0) {
      errors.push(`${displayPath} hunk #${idx + 1}: 'target' must be a non-empty string`);
      continue;
    }
    if (typeof hunk.replacement !== "string") {
      errors.push(`${displayPath} hunk #${idx + 1}: 'replacement' must be a string`);
      continue;
    }
    const normTarget = hunk.target.replace(/\r\n/g, "\n");
    const normReplacement = hunk.replacement.replace(/\r\n/g, "\n");
    let windowStart = 0;
    let windowEnd = normalizedContent.length;
    try {
      const win = getLineWindowOffsets(
        normalizedContent,
        lineStarts,
        hunk.startLine,
        hunk.endLine
      );
      windowStart = win.windowStart;
      windowEnd = win.windowEnd;
    } catch (err) {
      errors.push(
        `${displayPath} hunk #${idx + 1}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    const foundOffsets = [];
    let pos = windowStart;
    while (pos <= windowEnd - normTarget.length) {
      const found = normalizedContent.indexOf(normTarget, pos);
      if (found === -1 || found + normTarget.length > windowEnd) break;
      foundOffsets.push(found);
      pos = found + Math.max(1, normTarget.length);
    }
    if (foundOffsets.length === 0) {
      const hasRange = hunk.startLine !== void 0 || hunk.endLine !== void 0;
      const rangeNote = hasRange ? ` within lines ${hunk.startLine ?? 1}-${hunk.endLine ?? lineStarts.length}` : "";
      let hint = "";
      if (hasRange) {
        const globalOffsets = [];
        let gPos = 0;
        while (gPos <= normalizedContent.length - normTarget.length && globalOffsets.length < 5) {
          const found = normalizedContent.indexOf(normTarget, gPos);
          if (found === -1) break;
          globalOffsets.push(found);
          gPos = found + Math.max(1, normTarget.length);
        }
        if (globalOffsets.length > 0) {
          const hitLines = globalOffsets.map((o) => formatMatchLineRange(lineStarts, o, normTarget.length)).join(", ");
          hint = ` Exact match found outside range at ${hitLines} \u2014 adjust startLine/endLine or omit them.`;
        } else {
          const effStart = hunk.startLine ?? 1;
          const effEnd = hunk.endLine ?? lineStarts.length;
          if (effEnd - effStart + 1 > MAX_NEARBY_LINES - 4) {
            hint = findClosestRegionSnippet(normalizedContent, normTarget, effStart, effEnd) || findClosestRegionSnippet(normalizedContent, normTarget) || formatNearbyLines(normalizedContent, effStart, effEnd);
          } else {
            hint = formatNearbyLines(normalizedContent, hunk.startLine, hunk.endLine);
          }
        }
      } else {
        hint = findClosestRegionSnippet(normalizedContent, normTarget);
      }
      errors.push(
        `${displayPath} hunk #${idx + 1}: target text not found${rangeNote}.${hint}`
      );
      continue;
    }
    if (foundOffsets.length > 1 && !hunk.replaceAll) {
      const lines = foundOffsets.slice(0, 10).map((o) => formatMatchLineRange(lineStarts, o, normTarget.length, "")).join(", ");
      errors.push(
        `${displayPath} hunk #${idx + 1}: target matched ${foundOffsets.length} times (lines: ${lines}). Provide startLine/endLine, more surrounding context, or set replaceAll: true.`
      );
      continue;
    }
    for (const start of foundOffsets) {
      spans.push({
        start,
        end: start + normTarget.length,
        replacement: normReplacement,
        hunkIndex: idx
      });
    }
  }
  if (errors.length > 0) {
    return { newNormalized: normalizedContent, appliedMatches: 0, spans: [], errors };
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1];
    const curr = spans[i];
    if (curr.start < prev.end) {
      const line = offsetToLine(lineStarts, curr.start);
      errors.push(
        `${displayPath}: hunk #${prev.hunkIndex + 1} and hunk #${curr.hunkIndex + 1} overlap near line ${line}.`
      );
    }
  }
  if (errors.length > 0) {
    return { newNormalized: normalizedContent, appliedMatches: 0, spans: [], errors };
  }
  const pieces = [];
  let cursor = 0;
  for (const span of spans) {
    pieces.push(normalizedContent.slice(cursor, span.start));
    pieces.push(span.replacement);
    cursor = span.end;
  }
  pieces.push(normalizedContent.slice(cursor));
  return {
    newNormalized: pieces.join(""),
    appliedMatches: spans.length,
    spans,
    errors: []
  };
}
function buildNormToRawOffsetMap(rawContent, normLength) {
  const map = new Int32Array(normLength + 1);
  let normIdx = 0;
  for (let rawIdx = 0; rawIdx < rawContent.length; rawIdx++) {
    if (rawContent[rawIdx] === "\r" && rawContent[rawIdx + 1] === "\n") {
      map[normIdx++] = rawIdx;
      rawIdx++;
    } else {
      map[normIdx++] = rawIdx;
    }
  }
  map[normIdx] = rawContent.length;
  return map;
}
function detectLocalSpanEol(rawContent, rawStart, rawEnd, fallbackEol) {
  let crlfCount = 0;
  let lfOnlyCount = 0;
  for (let i = rawStart; i < rawEnd; i++) {
    if (rawContent[i] === "\n") {
      if (i > rawStart && rawContent[i - 1] === "\r") crlfCount++;
      else lfOnlyCount++;
    }
  }
  if (crlfCount > lfOnlyCount) return "\r\n";
  if (lfOnlyCount > crlfCount) return "\n";
  for (let i = rawEnd; i < rawContent.length; i++) {
    if (rawContent[i] === "\n") {
      return i > 0 && rawContent[i - 1] === "\r" ? "\r\n" : "\n";
    }
  }
  for (let i = rawStart - 1; i >= 0; i--) {
    if (rawContent[i] === "\n") {
      return i > 0 && rawContent[i - 1] === "\r" ? "\r\n" : "\n";
    }
  }
  return fallbackEol;
}
function applySpansPreservingMixedEol(rawContent, normLength, spans, fallbackEol) {
  const normToRaw = buildNormToRawOffsetMap(rawContent, normLength);
  const pieces = [];
  let rawCursor = 0;
  for (const span of spans) {
    const rawStart = normToRaw[span.start];
    const rawEnd = normToRaw[span.end];
    pieces.push(rawContent.slice(rawCursor, rawStart));
    const localEol = detectLocalSpanEol(rawContent, rawStart, rawEnd, fallbackEol);
    pieces.push(
      localEol === "\r\n" ? span.replacement.replace(/\n/g, "\r\n") : span.replacement
    );
    rawCursor = rawEnd;
  }
  pieces.push(rawContent.slice(rawCursor));
  return pieces.join("");
}
function countLines(text) {
  if (!text) return 0;
  const end = text.endsWith("\n") ? text.length - 1 : text.length;
  if (end === 0) return 1;
  let count = 1;
  for (let i = 0; i < end; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
}
var OVERWRITE_HEADER_PEEK_BYTES = 8192;
async function readFileHeaderBytes(filePath, maxBytes = OVERWRITE_HEADER_PEEK_BYTES) {
  const fh = await fs3.open(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
function classifyNonTextOverwriteBuffer(buf, relPath) {
  const utf16Bom = detectUtf16Bom(buf);
  if (utf16Bom) {
    return `${relPath}: UTF-16 encoded file is not supported (convert to UTF-8 first) [${utf16Bom}]`;
  }
  if (isLikelyBinary(buf)) {
    return `${relPath}: Cannot overwrite binary file with text content`;
  }
  return null;
}
async function readOverwriteOriginal(writeTargetPath, size, relPath) {
  if (size > OVERWRITE_HEADER_PEEK_BYTES) {
    const header = await readFileHeaderBytes(writeTargetPath, OVERWRITE_HEADER_PEEK_BYTES);
    const nonTextErr2 = classifyNonTextOverwriteBuffer(header, relPath);
    if (nonTextErr2) {
      return { ok: false, error: nonTextErr2 };
    }
  }
  const buffer = await fs3.readFile(writeTargetPath);
  const nonTextErr = classifyNonTextOverwriteBuffer(buffer, relPath);
  if (nonTextErr) {
    return { ok: false, error: nonTextErr };
  }
  return { ok: true, buffer };
}
function isGitInternalPath(filePath, platform = process.platform) {
  const segments = filePath.split(/[\\/]+/);
  for (const rawSeg of segments) {
    if (!rawSeg) continue;
    let seg = rawSeg.toLowerCase();
    if (platform === "win32") {
      seg = seg.replace(/[. ]+$/, "").replace(/:.*$/, "").replace(/[. ]+$/, "");
    }
    if (seg === ".git") {
      return true;
    }
  }
  return false;
}
async function canonicalizeTargetPath(absPath) {
  try {
    return await fs3.realpath(absPath);
  } catch {
    const trailingSegments = [];
    let current = absPath;
    while (true) {
      const parent = path4.dirname(current);
      if (parent === current) {
        return absPath;
      }
      trailingSegments.push(path4.basename(current));
      current = parent;
      try {
        const realAncestor = await fs3.realpath(current);
        return path4.join(realAncestor, ...trailingSegments.reverse());
      } catch {
      }
    }
  }
}
async function findMissingAncestorDirs(dir) {
  const missing = [];
  let current = path4.resolve(dir);
  while (true) {
    try {
      await fs3.lstat(current);
      break;
    } catch (err) {
      if (err?.code !== "ENOENT") {
        break;
      }
      missing.push(current);
      const parent = path4.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return missing;
}
async function commitPlannedWrites(plans) {
  const written = [];
  const createdDirs = [];
  const createdDirSet = /* @__PURE__ */ new Set();
  try {
    for (const plan of plans) {
      if (plan.isNoOp) continue;
      const target = plan.writeTargetPath;
      const dir = path4.dirname(target);
      const missingDirs = await findMissingAncestorDirs(dir);
      for (let i = missingDirs.length - 1; i >= 0; i--) {
        const d = missingDirs[i];
        if (!createdDirSet.has(d)) {
          createdDirSet.add(d);
          createdDirs.push(d);
        }
      }
      await fs3.mkdir(dir, { recursive: true });
      const tmpPath = path4.join(
        dir,
        `.agy-tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      );
      try {
        await fs3.writeFile(tmpPath, plan.newContent, "utf8");
        if (plan.originalMode !== null && process.platform !== "win32") {
          await fs3.chmod(tmpPath, plan.originalMode);
        }
      } catch (tmpErr) {
        try {
          await fs3.unlink(tmpPath);
        } catch {
        }
        throw tmpErr;
      }
      try {
        await fs3.rename(tmpPath, target);
        written.push(plan);
      } catch (renameErr) {
        try {
          await fs3.unlink(tmpPath);
        } catch {
        }
        written.push(plan);
        if (plan.originalSymlinkTarget) {
          try {
            await fs3.unlink(target);
          } catch {
          }
        }
        await fs3.writeFile(target, plan.newContent, "utf8");
        if (plan.originalMode !== null && process.platform !== "win32") {
          try {
            await fs3.chmod(target, plan.originalMode);
          } catch {
          }
        }
        void renameErr;
      }
    }
  } catch (err) {
    for (let i = written.length - 1; i >= 0; i--) {
      const item = written[i];
      const target = item.writeTargetPath;
      try {
        if (item.originalSymlinkTarget) {
          await fs3.unlink(target).catch(() => {
          });
          await fs3.symlink(item.originalSymlinkTarget, target);
        } else if (item.existed && item.originalBuffer !== null) {
          await fs3.writeFile(target, item.originalBuffer);
          if (item.originalMode !== null && process.platform !== "win32") {
            await fs3.chmod(target, item.originalMode);
          }
        } else if (!item.existed) {
          await fs3.unlink(target);
        }
      } catch {
      }
    }
    for (let i = createdDirs.length - 1; i >= 0; i--) {
      try {
        await fs3.rmdir(createdDirs[i]);
      } catch {
      }
    }
    throw err;
  }
}
function corruptedEditsError(items) {
  return {
    text: formatCorruptedArrayError({
      header: "Validation failed (0 files modified)",
      toolName: "apply_edits",
      items,
      fallbackAdvice: "immediately fall back to parallel built-in edit_file / write_file calls for these file(s)."
    }),
    isError: true
  };
}
function formatErrorBulletsWithinBytes(heading, errors, maxBytes) {
  const full = `${heading}
- ${errors.join("\n- ")}`;
  if (Buffer.byteLength(full, "utf8") <= maxBytes) {
    return full;
  }
  const headingPrefix = `${heading}
`;
  const availBytes = maxBytes - Buffer.byteLength(headingPrefix, "utf8");
  if (availBytes <= 64 || errors.length <= 1) {
    return truncateWithByteNotice(full, maxBytes);
  }
  const fittedBullets = fitSectionsToByteBudget(
    errors.map((e) => `- ${e}`),
    availBytes,
    availBytes,
    "\n"
  );
  const assembled = `${headingPrefix}${fittedBullets}`;
  return Buffer.byteLength(assembled, "utf8") <= maxBytes ? assembled : truncateWithByteNotice(assembled, maxBytes);
}
function formatAppliedCountPhrase(totalCount, noOpCount, dryRun) {
  if (dryRun) {
    return noOpCount > 0 ? `${totalCount} valid (${noOpCount} unchanged)` : `${totalCount} valid`;
  }
  const writtenCount = totalCount - noOpCount;
  return noOpCount > 0 ? `${writtenCount} written, ${noOpCount} unchanged` : `${writtenCount} written`;
}
function formatAppliedSummaryCompact(totalCount, noOpCount, dryRun) {
  if (dryRun) {
    return noOpCount > 0 ? `${totalCount} file(s) valid (${noOpCount} unchanged)` : `${totalCount} file(s) valid`;
  }
  const writtenCount = totalCount - noOpCount;
  return noOpCount > 0 ? `${writtenCount} file(s) written, ${noOpCount} unchanged` : `${writtenCount} file(s) written`;
}
function compactSummaryLinesToBytes(header, summaryLines, noOpCount, maxBytes) {
  const full = `${header}
${summaryLines.join("\n")}`;
  if (Buffer.byteLength(full, "utf8") <= maxBytes) {
    return full;
  }
  const countSummary = formatAppliedSummaryCompact(summaryLines.length, noOpCount, false);
  const totalPhrase = formatAppliedCountPhrase(summaryLines.length, noOpCount, false);
  const minimal = `${header} (${countSummary}; list omitted to preserve verify diagnostics)`;
  const headerPrefix = `${header}
`;
  const kept = [];
  let usedBytes = Buffer.byteLength(headerPrefix, "utf8");
  for (let i = 0; i < summaryLines.length; i++) {
    const line = summaryLines[i];
    const remaining = summaryLines.length - (i + 1);
    const omitNotice = remaining > 0 ? `
... (+${remaining} more applied file(s) omitted; total ${totalPhrase})` : "";
    const lineBytes = (kept.length > 0 ? 1 : 0) + Buffer.byteLength(line, "utf8");
    if (usedBytes + lineBytes + Buffer.byteLength(omitNotice, "utf8") > maxBytes) {
      break;
    }
    kept.push(line);
    usedBytes += lineBytes;
  }
  if (kept.length > 0) {
    const omitted = summaryLines.length - kept.length;
    return omitted > 0 ? `${headerPrefix}${kept.join("\n")}
... (+${omitted} more applied file(s) omitted; total ${totalPhrase})` : `${headerPrefix}${kept.join("\n")}`;
  }
  return Buffer.byteLength(minimal, "utf8") <= maxBytes ? minimal : truncateWithByteNotice(minimal, maxBytes);
}
function formatBestEffortPartialResult(params) {
  const { partialHeader, errors, summaryLines, noOpCount, dryRun, verifySkipped, maxBytes } = params;
  const failedHeading = dryRun ? "Failed (fix only these):" : "Failed (retry ONLY these failed file(s); do NOT re-send applied files):";
  const failedFull = `${failedHeading}
- ${errors.join("\n- ")}`;
  const appliedFull = `Applied:
${summaryLines.join("\n")}`;
  const verifyNote = verifySkipped ? "Verify skipped because failed file(s) remain; fix only the failed file(s) and re-run verify." : "";
  const joinSections = (failedText, appliedText) => {
    const parts = [partialHeader, failedText, appliedText];
    if (verifyNote) parts.push(verifyNote);
    return parts.join("\n\n");
  };
  const fullText = joinSections(failedFull, appliedFull);
  if (Buffer.byteLength(fullText, "utf8") <= maxBytes) {
    return fullText;
  }
  const countSummary = formatAppliedSummaryCompact(summaryLines.length, noOpCount, dryRun);
  const totalPhrase = formatAppliedCountPhrase(summaryLines.length, noOpCount, dryRun);
  const minimalApplied = `Applied: ${countSummary} (list omitted to preserve failure diagnostics).`;
  const fixedBytes = Buffer.byteLength(partialHeader, "utf8") + 4 + // "\n\n" before failed + "\n\n" before applied
  (verifyNote ? 2 + Buffer.byteLength(verifyNote, "utf8") : 0);
  const minAppliedBytes = Math.min(
    Buffer.byteLength(appliedFull, "utf8"),
    Buffer.byteLength(minimalApplied, "utf8")
  );
  const maxFailedBytes = Math.max(256, maxBytes - fixedBytes - minAppliedBytes);
  const failedSection = formatErrorBulletsWithinBytes(
    failedHeading,
    errors,
    maxFailedBytes
  );
  const remainingForApplied = maxBytes - fixedBytes - Buffer.byteLength(failedSection, "utf8");
  let appliedSection = minimalApplied;
  if (remainingForApplied >= Buffer.byteLength(appliedFull, "utf8")) {
    appliedSection = appliedFull;
  } else {
    const appliedPrefix = "Applied:\n";
    const keptLines = [];
    let usedBytes = Buffer.byteLength(appliedPrefix, "utf8");
    for (let i = 0; i < summaryLines.length; i++) {
      const line = summaryLines[i];
      const remainingCount = summaryLines.length - (i + 1);
      const omitNotice = remainingCount > 0 ? `
... (+${remainingCount} more applied file(s) omitted; total ${totalPhrase})` : "";
      const lineBytes = (keptLines.length > 0 ? 1 : 0) + Buffer.byteLength(line, "utf8");
      if (usedBytes + lineBytes + Buffer.byteLength(omitNotice, "utf8") > remainingForApplied) {
        break;
      }
      keptLines.push(line);
      usedBytes += lineBytes;
    }
    if (keptLines.length > 0) {
      const omitted = summaryLines.length - keptLines.length;
      appliedSection = omitted > 0 ? `${appliedPrefix}${keptLines.join("\n")}
... (+${omitted} more applied file(s) omitted; total ${totalPhrase})` : `${appliedPrefix}${keptLines.join("\n")}`;
    }
  }
  const assembled = joinSections(failedSection, appliedSection);
  return Buffer.byteLength(assembled, "utf8") <= maxBytes ? assembled : truncateWithByteNotice(assembled, maxBytes);
}
async function runApplyEdits(input) {
  const parsedEdits = parseMaybeJsonArray(input?.edits);
  if (!parsedEdits.ok) {
    if (parsedEdits.kind === "corrupted_literal" || parsedEdits.kind === "wrong_type" && (typeof input?.edits === "boolean" || input?.edits === null)) {
      return corruptedEditsError([
        {
          label: "edits",
          value: parsedEdits.kind === "corrupted_literal" ? parsedEdits.value : input.edits,
          expected: "an array of edit objects"
        }
      ]);
    }
    if (parsedEdits.kind === "invalid_json") {
      return {
        text: `Error: 'edits' is not a valid JSON array (0 files modified): ${parsedEdits.detail}`,
        isError: true
      };
    }
    return {
      text: "Error: 'edits' must be a non-empty JSON array string (or array) of file edit objects.",
      isError: true
    };
  }
  const rawEdits = parsedEdits.value;
  if (rawEdits.length === 0) {
    return corruptedEditsError([
      { label: "edits", value: rawEdits, expected: "a non-empty array of edit objects" }
    ]);
  }
  if (rawEdits.length > 50) {
    return {
      text: "Error: 'edits' supports at most 50 file entries per call.",
      isError: true
    };
  }
  const corruptedItems = [];
  const normalizedEdits = [];
  for (let i = 0; i < rawEdits.length; i++) {
    const rawEntry = rawEdits[i];
    if (!isPlainObject(rawEntry)) {
      corruptedItems.push({ label: `edits[${i}]`, value: rawEntry, expected: "an edit object" });
      continue;
    }
    let normalizedHunks;
    if (rawEntry.hunks !== void 0) {
      const parsedHunks = parseMaybeJsonArray(rawEntry.hunks);
      if (!parsedHunks.ok) {
        corruptedItems.push({
          label: `edits[${i}].hunks`,
          value: parsedHunks.kind === "corrupted_literal" ? parsedHunks.value : rawEntry.hunks,
          expected: "an array of hunk objects"
        });
        continue;
      }
      let hunkCorrupted = false;
      for (let j = 0; j < parsedHunks.value.length; j++) {
        if (!isPlainObject(parsedHunks.value[j])) {
          corruptedItems.push({
            label: `edits[${i}].hunks[${j}]`,
            value: parsedHunks.value[j],
            expected: "a hunk object"
          });
          hunkCorrupted = true;
        }
      }
      if (hunkCorrupted) continue;
      normalizedHunks = parsedHunks.value;
    }
    normalizedEdits.push({
      path: rawEntry.path,
      hunks: normalizedHunks,
      create: rawEntry.create,
      overwrite: rawEntry.overwrite
    });
  }
  if (corruptedItems.length > 0) {
    return corruptedEditsError(corruptedItems);
  }
  let validatedVerify = null;
  if (input.verify !== void 0) {
    if (typeof input.verify === "string") {
      if (input.verify.trim()) {
        validatedVerify = { command: input.verify };
      }
    } else if (isPlainObject(input.verify)) {
      const cmd = input.verify.command;
      if (typeof cmd !== "string" || !cmd.trim()) {
        return {
          text: "Validation failed (0 files modified):\n- 'verify.command' must be a non-empty string.",
          isError: true
        };
      }
      if (input.verify.cwd !== void 0 && typeof input.verify.cwd !== "string") {
        return {
          text: "Validation failed (0 files modified):\n- 'verify.cwd' must be a string.",
          isError: true
        };
      }
      const rawSpecTimeout = input.verify.timeoutSec;
      const parsedSpecTimeout = typeof rawSpecTimeout === "number" || typeof rawSpecTimeout === "string" && rawSpecTimeout.trim() !== "" ? Number(rawSpecTimeout) : void 0;
      validatedVerify = {
        command: cmd,
        cwd: input.verify.cwd,
        timeoutSec: parsedSpecTimeout !== void 0 && Number.isFinite(parsedSpecTimeout) ? parsedSpecTimeout : void 0
      };
    } else {
      return {
        text: "Validation failed (0 files modified):\n- 'verify' must be a command string or { command, cwd?, timeoutSec? } object.",
        isError: true
      };
    }
  }
  const baseCwd = resolvePath(input.cwd || process.cwd());
  if (!input.dryRun && validatedVerify?.cwd) {
    const resolvedVerifyCwd = resolvePath(validatedVerify.cwd, baseCwd);
    try {
      const st = await fs3.stat(resolvedVerifyCwd);
      if (!st.isDirectory()) {
        return {
          text: `Validation failed (0 files modified):
- 'verify.cwd' is not a directory: ${validatedVerify.cwd}`,
          isError: true
        };
      }
    } catch {
      return {
        text: `Validation failed (0 files modified):
- 'verify.cwd' directory not found: ${validatedVerify.cwd}`,
        isError: true
      };
    }
  }
  const mergedByPath = /* @__PURE__ */ new Map();
  const errors = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const entry = normalizedEdits[i];
    if (typeof entry.path !== "string" || !entry.path.trim()) {
      errors.push(`edits[${i}]: 'path' must be a non-empty string`);
      continue;
    }
    const absPath = resolvePath(entry.path, baseCwd);
    const writeTargetPath = await canonicalizeTargetPath(absPath);
    const relPath = toPosixPath(path4.relative(baseCwd, absPath)) || path4.basename(absPath);
    if (isGitInternalPath(absPath) || isGitInternalPath(writeTargetPath)) {
      errors.push(`${relPath}: refusing to modify Git internal metadata path (.git)`);
      continue;
    }
    const hasCreate = typeof entry.create === "string";
    const hasHunks = Array.isArray(entry.hunks) && entry.hunks.length > 0;
    if (!hasCreate && !hasHunks) {
      errors.push(`${relPath}: must specify either non-empty 'hunks' or 'create'`);
      continue;
    }
    if (hasCreate && hasHunks) {
      errors.push(`${relPath}: cannot specify both 'create' and 'hunks' on the same entry`);
      continue;
    }
    const existing = mergedByPath.get(writeTargetPath);
    if (!existing) {
      mergedByPath.set(writeTargetPath, {
        absPath,
        writeTargetPath,
        relPath,
        create: hasCreate ? entry.create : void 0,
        overwrite: entry.overwrite,
        hunks: hasHunks ? [...entry.hunks] : []
      });
    } else {
      if (hasCreate || existing.create !== void 0) {
        errors.push(`${relPath}: duplicate entries cannot mix 'create' with other edits`);
        continue;
      }
      existing.hunks.push(...entry.hunks);
    }
  }
  if (errors.length > 0) {
    return {
      text: `Validation failed (0 files modified):
- ${errors.join("\n- ")}`,
      isError: true
    };
  }
  const plans = [];
  for (const item of mergedByPath.values()) {
    if (item.create !== void 0) {
      let exists = false;
      let originalBuffer = null;
      let originalMode = null;
      let originalSymlinkTarget = null;
      try {
        const lst = await fs3.lstat(item.writeTargetPath);
        if (lst.isSymbolicLink()) {
          try {
            const st = await fs3.stat(item.writeTargetPath);
            if (st.isDirectory()) {
              errors.push(`${item.relPath}: target path is a directory`);
              continue;
            }
            exists = true;
            if (!item.overwrite) {
              errors.push(
                `${item.relPath}: file already exists (set overwrite: true to replace it)`
              );
              continue;
            }
            originalMode = st.mode & 4095;
            const origRes = await readOverwriteOriginal(
              item.writeTargetPath,
              st.size,
              item.relPath
            );
            if (!origRes.ok) {
              errors.push(origRes.error);
              continue;
            }
            originalBuffer = origRes.buffer;
          } catch (statErr) {
            if (statErr?.code === "ENOENT") {
              exists = true;
              if (!item.overwrite) {
                errors.push(
                  `${item.relPath}: dangling symlink already exists (set overwrite: true to replace it)`
                );
                continue;
              }
              originalSymlinkTarget = await fs3.readlink(item.writeTargetPath);
            } else {
              errors.push(
                `${item.relPath}: ${statErr instanceof Error ? statErr.message : String(statErr)}`
              );
              continue;
            }
          }
        } else {
          const st = await fs3.stat(item.writeTargetPath);
          if (st.isDirectory()) {
            errors.push(`${item.relPath}: target path is a directory`);
            continue;
          }
          exists = true;
          if (!item.overwrite) {
            errors.push(
              `${item.relPath}: file already exists (set overwrite: true to replace it)`
            );
            continue;
          }
          originalMode = st.mode & 4095;
          const origRes = await readOverwriteOriginal(
            item.writeTargetPath,
            st.size,
            item.relPath
          );
          if (!origRes.ok) {
            errors.push(origRes.error);
            continue;
          }
          originalBuffer = origRes.buffer;
        }
      } catch (err) {
        if (err?.code === "ENOENT") {
          exists = false;
          originalBuffer = null;
          originalMode = null;
        } else {
          errors.push(
            `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`
          );
          continue;
        }
      }
      const originalHadBom = originalBuffer ? hasUtf8Bom(originalBuffer) : false;
      const oldLines = originalBuffer ? countLines((originalHadBom ? originalBuffer.subarray(3) : originalBuffer).toString("utf8")) : 0;
      const newContent2 = originalHadBom && !item.create.startsWith("\uFEFF") ? `\uFEFF${item.create}` : item.create;
      const createBody = item.create.startsWith("\uFEFF") ? item.create.slice(1) : item.create;
      const newLines = countLines(createBody);
      plans.push({
        absPath: item.absPath,
        writeTargetPath: item.writeTargetPath,
        relPath: item.relPath,
        existed: exists,
        originalBuffer,
        originalMode,
        originalSymlinkTarget,
        newContent: newContent2,
        hunkCount: 1,
        lineDelta: newLines - oldLines,
        created: !exists,
        isNoOp: false
      });
      continue;
    }
    let fileData;
    try {
      fileData = await readTextFile(item.writeTargetPath);
    } catch (err) {
      errors.push(
        `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    const normalizedOriginal = fileData.rawContent.replace(/\r\n/g, "\n");
    const planned = planHunksForContent(normalizedOriginal, item.hunks, item.relPath);
    if (planned.errors.length > 0) {
      errors.push(...planned.errors);
      continue;
    }
    const normalizedUnchanged = planned.newNormalized === normalizedOriginal;
    let newContent = "";
    let isNoOp = normalizedUnchanged;
    if (!normalizedUnchanged) {
      const finalContent = fileData.mixedEol ? applySpansPreservingMixedEol(
        fileData.rawContent,
        normalizedOriginal.length,
        planned.spans,
        fileData.eol
      ) : fileData.eol === "\r\n" ? planned.newNormalized.replace(/\n/g, "\r\n") : planned.newNormalized;
      newContent = fileData.hasBom && !finalContent.startsWith("\uFEFF") ? `\uFEFF${finalContent}` : finalContent;
      isNoOp = Buffer.byteLength(newContent, "utf8") === fileData.rawBuffer.length && Buffer.from(newContent, "utf8").equals(fileData.rawBuffer);
    }
    const lineDelta = normalizedUnchanged ? 0 : countLines(planned.newNormalized) - countLines(normalizedOriginal);
    plans.push({
      absPath: item.absPath,
      writeTargetPath: item.writeTargetPath,
      relPath: item.relPath,
      existed: true,
      originalBuffer: fileData.rawBuffer,
      originalMode: fileData.mode,
      newContent,
      hunkCount: planned.appliedMatches,
      lineDelta,
      created: false,
      isNoOp
    });
  }
  const bestEffort = Boolean(input.bestEffort);
  if (errors.length > 0 && (!bestEffort || plans.length === 0)) {
    const prefix = bestEffort ? "Edit aborted (0 files modified):" : "Atomic edit aborted (0 files modified):";
    return {
      text: formatErrorBulletsWithinBytes(prefix, errors, DEFAULT_INLINE_MAX_BYTES),
      isError: true
    };
  }
  if (!input.dryRun) {
    try {
      await commitPlannedWrites(plans);
    } catch (err) {
      return {
        text: `Write failed (changes rolled back): ${err instanceof Error ? err.message : String(err)}`,
        isError: true
      };
    }
  }
  const summaryLines = plans.map((p) => {
    if (p.isNoOp) {
      return `- ${p.relPath}: unchanged (no-op: replacement identical to target)`;
    }
    const deltaStr = p.lineDelta >= 0 ? `+${p.lineDelta}` : `${p.lineDelta}`;
    const action = p.created ? "created" : `updated (${p.hunkCount} match${p.hunkCount === 1 ? "" : "es"})`;
    return `- ${p.relPath}: ${action}, lines ${deltaStr}`;
  });
  const noOpCount = plans.filter((p) => p.isNoOp).length;
  const writtenCount = plans.length - noOpCount;
  if (bestEffort && errors.length > 0) {
    const totalFiles = mergedByPath.size;
    const failedFileCount = Math.max(1, totalFiles - plans.length);
    const unchangedSuffix = noOpCount > 0 ? `, ${noOpCount} unchanged` : "";
    const partialHeader = input.dryRun ? `Partial dry-run (${plans.length}/${totalFiles} file(s) valid; ${failedFileCount} file(s) failed):` : `Partial edit applied (${writtenCount}/${totalFiles} file(s) written${unchangedSuffix}; ${failedFileCount} file(s) failed \u2014 do NOT re-send applied files):`;
    return {
      text: formatBestEffortPartialResult({
        partialHeader,
        errors,
        summaryLines,
        noOpCount,
        dryRun: Boolean(input.dryRun),
        verifySkipped: Boolean(!input.dryRun && input.verify),
        maxBytes: DEFAULT_INLINE_MAX_BYTES
      }),
      isError: true
    };
  }
  const header = input.dryRun ? `Dry run validated ${plans.length} file(s) (0 files modified):` : noOpCount > 0 ? `Applied edits to ${writtenCount} file(s) (${noOpCount} unchanged):` : `Applied edits to ${plans.length} file(s):`;
  const appliedFull = `${header}
${summaryLines.join("\n")}`;
  if (!input.dryRun && validatedVerify) {
    const verifySpec = validatedVerify;
    const verifyCwd = verifySpec.cwd ? resolvePath(verifySpec.cwd, baseCwd) : baseCwd;
    const timeoutCandidate = verifySpec.timeoutSec ?? input.verifyTimeoutSec;
    const rawTimeoutSec = typeof timeoutCandidate === "number" || typeof timeoutCandidate === "string" && timeoutCandidate.trim() !== "" ? Number(timeoutCandidate) : 60;
    const timeoutMs = (Number.isFinite(rawTimeoutSec) ? Math.max(1, Math.min(MCP_CALL_BUDGET_SEC, Math.trunc(rawTimeoutSec))) : 60) * 1e3;
    const rawMaxVerifyChars = Number(input.maxVerifyChars ?? 4e3);
    const maxVerifyChars = Number.isFinite(rawMaxVerifyChars) ? Math.max(300, Math.min(7500, Math.trunc(rawMaxVerifyChars))) : 4e3;
    const res = await runShellCommandAsync(verifySpec.command, {
      cwd: verifyCwd,
      timeoutMs
    });
    const status = res.timedOut ? "TIMEOUT" : res.error ? "ERROR" : res.exitCode === 0 ? "PASS" : `FAIL (${formatExitFailureLabel(res.exitCode, res.signal)})`;
    const verifyPrefix = `

Verify [${status} in ${res.durationMs}ms] \`${verifySpec.command}\`:
`;
    const preparedVerify = prepareCompactCommandOutput({
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      signal: res.signal,
      timedOut: res.timedOut,
      error: res.error
    });
    const minApplied = `${header} (${formatAppliedSummaryCompact(summaryLines.length, noOpCount, false)}; list omitted to preserve verify diagnostics)`;
    const reservedForApplied = status === "PASS" ? Math.min(
      Buffer.byteLength(appliedFull, "utf8"),
      DEFAULT_INLINE_MAX_BYTES - 512
    ) : Math.min(
      Buffer.byteLength(appliedFull, "utf8"),
      Buffer.byteLength(minApplied, "utf8")
    );
    const maxVerifyBodyBytes = Math.max(
      256,
      DEFAULT_INLINE_MAX_BYTES - reservedForApplied - Buffer.byteLength(verifyPrefix, "utf8")
    );
    let targetChars = Math.min(maxVerifyChars, maxVerifyBodyBytes);
    let formatted = renderPreparedCompactCommandOutput(
      preparedVerify,
      targetChars
    ).text;
    for (let iter = 0; iter < 4; iter++) {
      const actualBytes = Buffer.byteLength(formatted, "utf8");
      if (actualBytes <= maxVerifyBodyBytes || targetChars <= 64) break;
      targetChars = Math.max(
        64,
        Math.floor(targetChars * (maxVerifyBodyBytes / actualBytes) * 0.94)
      );
      formatted = renderPreparedCompactCommandOutput(
        preparedVerify,
        targetChars
      ).text;
    }
    if (Buffer.byteLength(formatted, "utf8") > maxVerifyBodyBytes) {
      formatted = truncateHeadTailWithByteNotice(formatted, maxVerifyBodyBytes);
    }
    const verifySection = `${verifyPrefix}${formatted}`;
    const remainingAppliedBytes = DEFAULT_INLINE_MAX_BYTES - Buffer.byteLength(verifySection, "utf8");
    const appliedSection = compactSummaryLinesToBytes(
      header,
      summaryLines,
      noOpCount,
      Math.max(64, remainingAppliedBytes)
    );
    const combined = `${appliedSection}${verifySection}`;
    return {
      text: Buffer.byteLength(combined, "utf8") <= DEFAULT_INLINE_MAX_BYTES ? combined : truncateWithByteNotice(combined, DEFAULT_INLINE_MAX_BYTES),
      isError: false
    };
  }
  return {
    text: truncateWithByteNotice(appliedFull, DEFAULT_INLINE_MAX_BYTES),
    isError: false
  };
}

// src/tools/batch-search.ts
import { promises as fs4 } from "node:fs";
import path5 from "node:path";

// src/utils/fuzzy-match.ts
function findContiguousIndex(haystack, needle) {
  const maxStart = haystack.length - needle.length;
  for (let start = 0; start <= maxStart; start++) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}
function isAscii(text) {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) return false;
  }
  return true;
}
function subsequenceCost(needle, haystack) {
  if (!needle) return 2147483647;
  if (isAscii(needle) && isAscii(haystack)) {
    const query2 = needle.toLowerCase();
    const lowered2 = haystack.toLowerCase();
    const contiguousAt2 = lowered2.indexOf(query2);
    if (contiguousAt2 >= 0) {
      return contiguousAt2 === 0 ? -100 : -60 + Math.min(25, contiguousAt2);
    }
    let cursor2 = 0;
    let first2 = -1;
    let last2 = -1;
    const hLen = lowered2.length;
    for (let i = 0; i < query2.length; i++) {
      const targetCode = query2.charCodeAt(i);
      while (cursor2 < hLen && lowered2.charCodeAt(cursor2) !== targetCode) cursor2++;
      if (cursor2 === hLen) return void 0;
      if (first2 < 0) first2 = cursor2;
      last2 = cursor2++;
    }
    return Math.max(0, last2 - first2 + 1 - query2.length) - (first2 === 0 ? 20 : 0);
  }
  const lowered = [...haystack.toLowerCase()];
  const query = [...needle.toLowerCase()];
  const contiguousAt = findContiguousIndex(lowered, query);
  if (contiguousAt >= 0) {
    return contiguousAt === 0 ? -100 : -60 + Math.min(25, contiguousAt);
  }
  let cursor = 0;
  let first = -1;
  let last = -1;
  for (const ch of query) {
    while (cursor < lowered.length && lowered[cursor] !== ch) cursor++;
    if (cursor === lowered.length) return void 0;
    if (first < 0) first = cursor;
    last = cursor++;
  }
  return Math.max(0, last - first + 1 - query.length) - (first === 0 ? 20 : 0);
}
function scoreSubsequence(query, target) {
  const cost = subsequenceCost(query, target);
  return cost === void 0 ? -1 : Math.max(1, 1e3 - cost);
}
function fuzzyScorePath(query, candidatePosix) {
  const trimmed = query.trim().replace(/\\/g, "/");
  if (!trimmed) return -1;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const slashIdx = candidatePosix.lastIndexOf("/");
  const basename = slashIdx === -1 ? candidatePosix : candidatePosix.slice(slashIdx + 1);
  let totalScore = 0;
  for (const token of tokens) {
    const fullScore = scoreSubsequence(token, candidatePosix);
    if (fullScore < 0) return -1;
    const baseScore = !token.includes("/") ? scoreSubsequence(token, basename) : -1;
    totalScore += baseScore >= 0 ? Math.max(fullScore, baseScore + 45) : fullScore;
    if (basename.toLowerCase() === token.toLowerCase()) totalScore += 60;
  }
  return totalScore;
}
function rankFuzzyPaths(query, candidates, maxResults) {
  const scored = [];
  for (const candidate of candidates) {
    const score = fuzzyScorePath(query, candidate);
    if (score >= 0) scored.push({ path: candidate, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    matches: scored.slice(0, maxResults),
    totalMatched: scored.length
  };
}

// src/tools/batch-search.ts
var READONLY_GIT_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "ls-files",
  "blame",
  "shortlog",
  "describe",
  "tag",
  "remote"
]);
var FORBIDDEN_GIT_GLOBAL_FLAGS = /* @__PURE__ */ new Set([
  "-c",
  "--config",
  "--config-env",
  "--exec-path",
  "--ext-diff",
  "--textconv",
  "--output",
  "--exec",
  "--upload-pack",
  "--git-dir",
  "--work-tree"
]);
var ALLOWED_BRANCH_BOOL_FLAGS = /* @__PURE__ */ new Set([
  "--all",
  "--remotes",
  "--verbose",
  "--list",
  "--show-current",
  "--no-abbrev",
  "--no-color",
  "--ignore-case",
  "--omit-empty",
  "--no-column",
  "--quiet"
]);
var ALLOWED_BRANCH_EQ_ONLY_OPTIONAL_FLAGS = /* @__PURE__ */ new Set([
  "--abbrev",
  "--color",
  "--column"
]);
var ALLOWED_BRANCH_COMMIT_OPTIONAL_FLAGS = /* @__PURE__ */ new Set([
  "--merged",
  "--no-merged"
]);
var ALLOWED_BRANCH_COMMIT_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--contains",
  "--no-contains",
  "--points-at"
]);
var ALLOWED_BRANCH_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--contains",
  "--no-contains",
  "--points-at",
  "--sort",
  "--format"
]);
var ALLOWED_BRANCH_SHORT_CHARS = /* @__PURE__ */ new Set(["a", "r", "v", "l", "q", "i"]);
var ALLOWED_TAG_BOOL_FLAGS = /* @__PURE__ */ new Set([
  "--list",
  "--no-color",
  "--ignore-case",
  "--omit-empty",
  "--no-column"
]);
var ALLOWED_TAG_EQ_ONLY_OPTIONAL_FLAGS = /* @__PURE__ */ new Set([
  "--color",
  "--column"
]);
var ALLOWED_TAG_COMMIT_OPTIONAL_FLAGS = /* @__PURE__ */ new Set([
  "--merged",
  "--no-merged"
]);
var ALLOWED_TAG_COMMIT_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--contains",
  "--no-contains",
  "--points-at"
]);
var ALLOWED_TAG_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--contains",
  "--no-contains",
  "--points-at",
  "--sort",
  "--format"
]);
var ALLOWED_TAG_SHORT_CHARS = /* @__PURE__ */ new Set(["l", "i"]);
var ALLOWED_REMOTE_SUBCOMMANDS = /* @__PURE__ */ new Set(["show", "get-url"]);
function tokenizeArgs(input) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escape = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote) {
    throw new Error("Unterminated quote in git query");
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}
function validateReadonlyGitArgs(pattern) {
  const rawTokens = tokenizeArgs(pattern.trim());
  const tokens = rawTokens[0] === "git" ? rawTokens.slice(1) : rawTokens;
  if (tokens.length === 0) {
    throw new Error("Empty git query. Example: 'status --short' or 'log -n 5 --oneline'");
  }
  const subcmd = tokens[0];
  if (subcmd.startsWith("-")) {
    throw new Error(
      `Git query must start with a read-only subcommand (got '${subcmd}')`
    );
  }
  if (!READONLY_GIT_SUBCOMMANDS.has(subcmd)) {
    throw new Error(
      `Git subcommand '${subcmd}' is not allowed in batch_search (read-only only: ${[...READONLY_GIT_SUBCOMMANDS].join(", ")})`
    );
  }
  const rest = tokens.slice(1);
  for (const arg of rest) {
    if (arg === "&&" || arg === "||" || arg === ";" || arg === "|") {
      throw new Error(
        `Shell operator '${arg}' is not supported in git queries; split chained commands into separate batch_search queries`
      );
    }
    const flagName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (FORBIDDEN_GIT_GLOBAL_FLAGS.has(flagName) || arg.startsWith("--output=") || flagName === "--ext" || flagName.startsWith("--ext-") || flagName.startsWith("--textc") || arg.startsWith("-c") && arg.length > 2) {
      throw new Error(`Flag '${arg}' is not allowed in read-only git query`);
    }
  }
  if (subcmd === "status") {
    for (const arg of rest) {
      if (arg === "--") break;
      if (arg.startsWith("--")) {
        const flagName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
        if (flagName.startsWith("--v")) {
          throw new Error(
            `Flag '${arg}' is not allowed in read-only git status query (verbose status executes diff textconv; use 'diff' instead)`
          );
        }
      } else if (arg.startsWith("-") && arg.length > 1) {
        for (const ch of arg.slice(1)) {
          if (ch === "u" || ch === "M") break;
          if (ch === "v") {
            throw new Error(
              `Flag '${arg}' is not allowed in read-only git status query (verbose status executes diff textconv; use 'diff' instead)`
            );
          }
        }
      }
    }
  } else if (subcmd === "branch") {
    let hasListFlag = false;
    let expectValue = false;
    let expectNonFlagCommit = false;
    for (const arg of rest) {
      if (expectValue) {
        expectValue = false;
        continue;
      }
      if (expectNonFlagCommit) {
        expectNonFlagCommit = false;
        if (arg.startsWith("-")) {
          throw new Error(
            `Expected commit ref after commit filter flag (got '${arg}')`
          );
        }
        continue;
      }
      if (arg === "--") {
        if (!hasListFlag) {
          throw new Error(
            "Positional branch arguments are only allowed with --list in read-only mode"
          );
        }
        break;
      }
      if (arg.startsWith("--")) {
        const eqIdx = arg.indexOf("=");
        const flagName = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
        if (eqIdx !== -1) {
          if (!ALLOWED_BRANCH_VALUE_FLAGS.has(flagName) && !ALLOWED_BRANCH_EQ_ONLY_OPTIONAL_FLAGS.has(flagName) && !ALLOWED_BRANCH_COMMIT_OPTIONAL_FLAGS.has(flagName)) {
            throw new Error(`Flag '${arg}' is not allowed in read-only git branch query`);
          }
        } else if (ALLOWED_BRANCH_COMMIT_VALUE_FLAGS.has(flagName)) {
          expectNonFlagCommit = true;
          hasListFlag = true;
        } else if (ALLOWED_BRANCH_COMMIT_OPTIONAL_FLAGS.has(flagName)) {
          expectNonFlagCommit = true;
          hasListFlag = true;
        } else if (ALLOWED_BRANCH_VALUE_FLAGS.has(flagName)) {
          expectValue = true;
        } else if (!ALLOWED_BRANCH_BOOL_FLAGS.has(flagName) && !ALLOWED_BRANCH_EQ_ONLY_OPTIONAL_FLAGS.has(flagName)) {
          throw new Error(`Flag '${arg}' is not allowed in read-only git branch query`);
        }
        if (flagName === "--list" || ALLOWED_BRANCH_COMMIT_OPTIONAL_FLAGS.has(flagName) || ALLOWED_BRANCH_COMMIT_VALUE_FLAGS.has(flagName)) {
          hasListFlag = true;
        }
      } else if (arg.startsWith("-") && arg.length > 1) {
        for (const ch of arg.slice(1)) {
          if (!ALLOWED_BRANCH_SHORT_CHARS.has(ch)) {
            throw new Error(`Flag '${arg}' is not allowed in read-only git branch query`);
          }
          if (ch === "l") hasListFlag = true;
        }
      } else if (!hasListFlag) {
        throw new Error(
          `Positional branch argument '${arg}' is only allowed with --list in read-only mode`
        );
      }
    }
  } else if (subcmd === "tag") {
    let allowsPositionals = false;
    let expectValue = false;
    let expectNonFlagCommit = false;
    for (const arg of rest) {
      if (expectValue) {
        expectValue = false;
        continue;
      }
      if (expectNonFlagCommit) {
        expectNonFlagCommit = false;
        if (arg.startsWith("-")) {
          throw new Error(
            `Expected commit ref after commit filter flag (got '${arg}')`
          );
        }
        continue;
      }
      if (arg === "--") {
        if (!allowsPositionals) {
          throw new Error(
            "Positional tag arguments are only allowed with --list in read-only mode"
          );
        }
        break;
      }
      if (arg.startsWith("--")) {
        const eqIdx = arg.indexOf("=");
        const flagName = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
        if (eqIdx !== -1) {
          if (!ALLOWED_TAG_VALUE_FLAGS.has(flagName) && !ALLOWED_TAG_EQ_ONLY_OPTIONAL_FLAGS.has(flagName) && !ALLOWED_TAG_COMMIT_OPTIONAL_FLAGS.has(flagName)) {
            throw new Error(`Flag '${arg}' is not allowed in read-only git tag query`);
          }
        } else if (ALLOWED_TAG_COMMIT_VALUE_FLAGS.has(flagName)) {
          expectNonFlagCommit = true;
          allowsPositionals = true;
        } else if (ALLOWED_TAG_COMMIT_OPTIONAL_FLAGS.has(flagName)) {
          expectNonFlagCommit = true;
          allowsPositionals = true;
        } else if (ALLOWED_TAG_VALUE_FLAGS.has(flagName)) {
          expectValue = true;
        } else if (!ALLOWED_TAG_BOOL_FLAGS.has(flagName) && !ALLOWED_TAG_EQ_ONLY_OPTIONAL_FLAGS.has(flagName)) {
          throw new Error(`Flag '${arg}' is not allowed in read-only git tag query`);
        }
        if (flagName === "--list" || ALLOWED_TAG_COMMIT_OPTIONAL_FLAGS.has(flagName) || ALLOWED_TAG_COMMIT_VALUE_FLAGS.has(flagName)) {
          allowsPositionals = true;
        }
      } else if (arg.startsWith("-") && arg.length > 1) {
        if (/^-n\d*$/.test(arg)) {
          allowsPositionals = true;
        } else {
          for (const ch of arg.slice(1)) {
            if (!ALLOWED_TAG_SHORT_CHARS.has(ch)) {
              throw new Error(`Flag '${arg}' is not allowed in read-only git tag query`);
            }
            if (ch === "l") allowsPositionals = true;
          }
        }
      } else if (!allowsPositionals) {
        throw new Error(
          `Positional tag argument '${arg}' is only allowed with --list in read-only mode`
        );
      }
    }
  } else if (subcmd === "remote") {
    let remoteSubcmd = null;
    for (const arg of rest) {
      if (!remoteSubcmd) {
        if (arg === "-v" || arg === "--verbose") continue;
        if (arg.startsWith("-")) {
          throw new Error(`Flag '${arg}' is not allowed in read-only git remote query`);
        }
        if (!ALLOWED_REMOTE_SUBCOMMANDS.has(arg)) {
          throw new Error(`Mutating git remote subcommand '${arg}' is not allowed`);
        }
        remoteSubcmd = arg;
      } else if (arg.startsWith("-")) {
        const okFlag = remoteSubcmd === "show" && arg === "-n" || remoteSubcmd === "get-url" && (arg === "--push" || arg === "--all");
        if (!okFlag) {
          throw new Error(
            `Flag '${arg}' is not allowed for read-only git remote ${remoteSubcmd}`
          );
        }
      } else if (arg.includes("://") || arg.includes(":") || arg.includes("/") || arg.includes("\\")) {
        throw new Error(
          `Remote target '${arg}' must be a configured remote name, not a URL or path`
        );
      }
    }
  }
  return ["--no-pager", subcmd, ...rest];
}
var FILE_TYPE_GLOBS = {
  ts: ["*.ts", "*.tsx", "*.mts", "*.cts"],
  typescript: ["*.ts", "*.tsx", "*.mts", "*.cts"],
  js: ["*.js", "*.jsx", "*.mjs", "*.cjs"],
  javascript: ["*.js", "*.jsx", "*.mjs", "*.cjs"],
  py: ["*.py", "*.pyi"],
  python: ["*.py", "*.pyi"],
  go: ["*.go"],
  gd: ["*.gd"],
  gdscript: ["*.gd"],
  rust: ["*.rs"],
  rs: ["*.rs"],
  java: ["*.java"],
  kt: ["*.kt", "*.kts"],
  kotlin: ["*.kt", "*.kts"],
  c: ["*.c", "*.h"],
  cpp: ["*.cc", "*.cpp", "*.cxx", "*.hpp", "*.hh", "*.hxx", "*.h"],
  cs: ["*.cs"],
  csharp: ["*.cs"],
  swift: ["*.swift"],
  rb: ["*.rb"],
  ruby: ["*.rb"],
  php: ["*.php"],
  css: ["*.css", "*.scss", "*.sass", "*.less"],
  html: ["*.html", "*.htm"],
  vue: ["*.vue"],
  svelte: ["*.svelte"],
  md: ["*.md", "*.mdx", "*.markdown"],
  markdown: ["*.md", "*.mdx", "*.markdown"],
  json: ["*.json", "*.jsonc"],
  yaml: ["*.yml", "*.yaml"],
  yml: ["*.yml", "*.yaml"],
  toml: ["*.toml"],
  xml: ["*.xml"],
  sql: ["*.sql"],
  sh: ["*.sh", "*.bash", "*.zsh"],
  shell: ["*.sh", "*.bash", "*.zsh"]
};
function resolveFileTypeGlobs(fileType) {
  if (fileType === void 0) return null;
  if (typeof fileType !== "string") throw new Error("fileType must be a string");
  const key = fileType.trim().toLowerCase().replace(/^\./, "");
  if (!key) return null;
  const mapped = FILE_TYPE_GLOBS[key];
  if (Object.hasOwn(FILE_TYPE_GLOBS, key)) return mapped;
  if (/^[a-z0-9]+$/i.test(key)) return [`*.${key}`];
  throw new Error(`Unsupported fileType '${fileType}'`);
}
function fileTypeMatcher(fileType) {
  const matchers = (resolveFileTypeGlobs(fileType) ?? []).map(globToRegExp);
  return (file) => matchers.length === 0 || matchers.some((matcher) => matcher.test(path5.basename(file)));
}
async function runTextOrRegexWithRg(query, searchRoot, baseCwd) {
  const maxResults = clampInt(query.maxResults, 1, 200, 40);
  const contextLines = clampInt(query.contextLines, 0, 5, 0);
  const summary = query.outputMode === "count" || query.outputMode === "files_with_matches";
  const typeGlobs = resolveFileTypeGlobs(query.fileType);
  const matchesType = fileTypeMatcher(query.fileType);
  const fileStat = await fs4.stat(searchRoot);
  const isFileTarget = fileStat.isFile();
  if (isFileTarget) {
    if (typeGlobs && !matchesType(searchRoot)) {
      return { files: [], totalMatches: 0, truncated: false };
    }
    if (fileStat.size > 2 * 1024 * 1024) {
      return { files: [], totalMatches: 0, truncated: false };
    }
    if (query.glob) {
      const negated = query.glob.startsWith("!");
      const rawGlob = negated ? query.glob.slice(1) : query.glob;
      const globRe = globToRegExp(rawGlob);
      const relPosix = relativeFile(baseCwd, searchRoot);
      const matched = globRe.test(relPosix) || globRe.test(path5.basename(searchRoot));
      if (negated ? matched : !matched) {
        return { files: [], totalMatches: 0, truncated: false };
      }
    }
    const fh = await fs4.open(searchRoot, "r");
    try {
      const head = Buffer.alloc(Math.min(fileStat.size, 8192));
      const { bytesRead } = await fh.read(head, 0, head.length, 0);
      if (isLikelyBinary(head.subarray(0, bytesRead))) {
        return { files: [], totalMatches: 0, truncated: false };
      }
    } finally {
      await fh.close();
    }
  }
  const perFileCap = isFileTarget ? maxResults : Math.min(maxResults, 50);
  const args = ["--no-config", "--no-messages", "--max-filesize", "2M", "--crlf"];
  if (query.multiline) args.push("--multiline", "--multiline-dotall");
  if (typeGlobs) {
    for (const glob of typeGlobs) args.push("--type-add", `agyfilter:${glob}`);
    args.push("--type", "agyfilter");
  }
  if (query.type === "text") {
    args.push("--fixed-strings");
  }
  if (query.caseSensitive === false) {
    args.push("--ignore-case");
  }
  if (query.glob) {
    args.push(`--glob=${query.glob}`);
  }
  const relNative = path5.relative(baseCwd, searchRoot);
  const relRoot = toPosixPath(relNative);
  const isInsideBaseCwd = relRoot === "" || relRoot !== ".." && !relRoot.startsWith("../") && !path5.isAbsolute(relRoot);
  const rgSearchTarget = isInsideBaseCwd ? !relNative ? "." : relNative === "-" ? `.${path5.sep}-` : relNative : searchRoot;
  const rootSegments = isInsideBaseCwd ? relRoot ? relRoot.split("/") : [] : toPosixPath(searchRoot).split("/").filter(Boolean);
  const positiveGlob = query.glob && !query.glob.startsWith("!") ? query.glob : null;
  for (const dir of [
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    "coverage",
    "__pycache__",
    ".venv",
    ".next"
  ]) {
    if (!rootSegments.includes(dir) && !(positiveGlob && globTargetsDir(positiveGlob, dir))) {
      args.push(`--glob=!**/${dir}/**`);
    }
  }
  const runRg = async (runArgs, opts) => {
    const res = await execBinaryAsync("rg", runArgs, {
      cwd: baseCwd,
      timeoutMs: 15e3,
      maxOutputBytes: 2 * 1024 * 1024
    });
    if (res.error) {
      throw new Error(`rg spawn error: ${res.error}`);
    }
    if (res.exitCode === 2 && !(opts?.allowPartialError && !res.stderr.trim())) {
      throw new Error(res.stderr.trim() || `rg failed for pattern: ${query.pattern}`);
    }
    return res;
  };
  const cutShort = (res) => res.truncated || res.timedOut || res.exitCode === null;
  if (summary) {
    const res = await runRg([
      ...args,
      ...query.outputMode === "count" ? [query.multiline ? "--count-matches" : "--count", "--with-filename", "--null"] : ["--files-with-matches", "--null"],
      "--",
      query.pattern,
      rgSearchTarget
    ]);
    const files2 = [];
    const out = res.stdout;
    let pos = 0;
    while (pos < out.length) {
      const nul = out.indexOf("\0", pos);
      if (nul === -1) break;
      const rawFile = out.slice(pos, nul);
      let count = 0;
      if (query.outputMode === "count") {
        const nl = out.indexOf("\n", nul + 1);
        if (nl === -1) break;
        const rawCount = out.slice(nul + 1, nl).trim();
        count = Number(rawCount);
        pos = nl + 1;
      } else {
        pos = nul + 1;
      }
      if (!rawFile || !matchesType(rawFile)) continue;
      files2.push({ file: relativeFile(baseCwd, rawFile), lines: [], count: Number.isFinite(count) ? count : 0 });
    }
    files2.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
    return {
      files: files2.slice(0, maxResults),
      totalMatches: 0,
      truncated: files2.length > maxResults || cutShort(res)
    };
  }
  const maxCountArgs = query.multiline ? [] : ["--max-count", String(perFileCap + 1)];
  let chosen;
  let truncated = false;
  if (isFileTarget) {
    chosen = [
      {
        rawFile: searchRoot,
        relFile: relativeFile(baseCwd, searchRoot),
        count: Number.POSITIVE_INFINITY
      }
    ];
  } else {
    const counts = await runRg([
      ...args,
      ...maxCountArgs,
      "--count",
      "--with-filename",
      "--null",
      "--",
      query.pattern,
      rgSearchTarget
    ]);
    const counted = [];
    for (const record of counts.stdout.split("\n").slice(0, -1)) {
      const sep = record.lastIndexOf("\0");
      const count = Number(record.slice(sep + 1));
      if (sep <= 0 || !Number.isInteger(count) || count <= 0) continue;
      const rawFile = record.slice(0, sep);
      if (!matchesType(rawFile)) continue;
      counted.push({ rawFile, relFile: relativeFile(baseCwd, rawFile), count });
    }
    counted.sort((a, b) => a.relFile < b.relFile ? -1 : a.relFile > b.relFile ? 1 : 0);
    chosen = [];
    let coveredMatches = 0;
    for (const item of counted) {
      if (coveredMatches >= maxResults) break;
      chosen.push(item);
      coveredMatches += query.multiline ? item.count : Math.min(item.count, perFileCap);
    }
    truncated = cutShort(counts) || chosen.length < counted.length;
    if (chosen.length === 0) {
      return { files: [], totalMatches: 0, truncated };
    }
  }
  const toRgArgPath = (rawFile) => {
    const rel = path5.relative(baseCwd, path5.resolve(baseCwd, rawFile));
    const chosenPath = rel && rel !== ".." && !rel.startsWith(`..${path5.sep}`) && !path5.isAbsolute(rel) ? rel : rawFile;
    return chosenPath === "-" ? `.${path5.sep}-` : chosenPath;
  };
  const rgChunks = [];
  let currentChunk = [];
  let currentChunkChars = 0;
  const maxArgChars = 2e4;
  for (const item of chosen) {
    const argPath = toRgArgPath(item.rawFile);
    const est = argPath.length + 3;
    if (currentChunk.length > 0 && currentChunkChars + est > maxArgChars) {
      rgChunks.push(currentChunk);
      currentChunk = [];
      currentChunkChars = 0;
    }
    currentChunk.push(argPath);
    currentChunkChars += est;
  }
  if (currentChunk.length > 0) rgChunks.push(currentChunk);
  const byFile = /* @__PURE__ */ new Map();
  for (const chunk of rgChunks) {
    const res = await runRg(
      [
        ...args,
        ...maxCountArgs,
        "--json",
        ...contextLines > 0 ? ["-C", String(contextLines)] : [],
        "--",
        query.pattern,
        ...chunk
      ],
      { allowPartialError: !isFileTarget }
    );
    if (cutShort(res)) truncated = true;
    for (const rawLine of res.stdout.split("\n")) {
      if (!rawLine.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(rawLine);
      } catch {
        continue;
      }
      if (ev.type !== "match" && ev.type !== "context") continue;
      const rawFile = ev.data?.path?.text ?? (ev.data?.path?.bytes ? Buffer.from(ev.data.path.bytes, "base64").toString("utf8") : void 0);
      const lineNumber = ev.data?.line_number;
      const rawBuf = ev.data?.lines?.bytes ? Buffer.from(ev.data.lines.bytes, "base64") : null;
      const rawText = ev.data?.lines?.text ?? (rawBuf ? rawBuf.toString("utf8") : "");
      if (!rawFile || typeof lineNumber !== "number") continue;
      const relFile = relativeFile(baseCwd, rawFile);
      let lineMap = byFile.get(relFile);
      if (!lineMap) {
        lineMap = /* @__PURE__ */ new Map();
        byFile.set(relFile, lineMap);
      }
      const isMatch = ev.type === "match";
      const submatchRanges = [];
      if (isMatch && Array.isArray(ev.data?.submatches) && ev.data.submatches.length > 0) {
        let utf8Buf = rawBuf;
        const isAsciiOnly = !utf8Buf && Buffer.byteLength(rawText, "utf8") === rawText.length;
        const byteToChar = (byteOffset) => {
          if (byteOffset <= 0) return 0;
          if (isAsciiOnly) return Math.min(byteOffset, rawText.length);
          if (!utf8Buf) utf8Buf = Buffer.from(rawText, "utf8");
          const clamped = Math.min(byteOffset, utf8Buf.length);
          return utf8Buf.subarray(0, clamped).toString("utf8").length;
        };
        for (const sm of ev.data.submatches) {
          if (typeof sm?.start !== "number") continue;
          const start = byteToChar(sm.start);
          const end = typeof sm.end === "number" ? Math.max(start, byteToChar(sm.end)) : start;
          submatchRanges.push({ start, end });
        }
      }
      const lineText = rawText.replace(/\r?\n$/, "");
      const segments = isMatch && query.multiline ? lineText.split(/\r?\n/) : [lineText];
      let segStart = 0;
      for (const [offset, text] of segments.entries()) {
        const segEnd = segStart + text.length;
        const line = lineNumber + offset;
        if (!lineMap.get(line)?.isMatch) {
          let matchStart;
          let matchEnd;
          if (isMatch && submatchRanges.length > 0) {
            const hit = submatchRanges.find(
              (r) => r.start === r.end ? r.start >= segStart && r.start <= segEnd : r.start <= segEnd && r.end > segStart
            );
            if (hit) {
              matchStart = Math.max(0, Math.min(hit.start - segStart, text.length));
              matchEnd = Math.max(matchStart, Math.min(hit.end - segStart, text.length));
            }
          }
          lineMap.set(line, {
            lineNumber: line,
            text,
            isMatch,
            ...matchStart !== void 0 ? { matchStart, matchEnd } : {}
          });
        }
        segStart = segEnd;
        if (rawText[segStart] === "\r" && rawText[segStart + 1] === "\n") {
          segStart += 2;
        } else if (rawText[segStart] === "\n") {
          segStart += 1;
        }
      }
    }
  }
  const files = [];
  let totalMatches = 0;
  for (const { relFile, count } of chosen) {
    if (totalMatches >= maxResults) {
      truncated = true;
      break;
    }
    const fileCap = query.multiline ? maxResults : Math.min(count, perFileCap);
    const budget = Math.min(fileCap, maxResults - totalMatches);
    const sorted = [...byFile.get(relFile)?.values() ?? []].sort(
      (a, b) => a.lineNumber - b.lineNumber
    );
    const lines = [];
    let kept = 0;
    let lastKeptMatchLine = -1;
    for (const line of sorted) {
      if (line.isMatch) {
        if (kept === budget) {
          truncated = true;
          if (lastKeptMatchLine !== -1 && line.lineNumber <= lastKeptMatchLine + contextLines) {
            lines.push({ lineNumber: line.lineNumber, text: line.text, isMatch: false });
          }
          continue;
        }
        kept += 1;
        lastKeptMatchLine = line.lineNumber;
        lines.push(line);
      } else if (kept < budget || line.lineNumber <= lastKeptMatchLine + contextLines) {
        lines.push(line);
      }
    }
    if (kept === 0) continue;
    files.push({ file: relFile, lines });
    totalMatches += kept;
  }
  return { files, totalMatches, truncated };
}
function* multilineMatches(content, regex) {
  let previousEnd = -1;
  for (const match of content.matchAll(regex)) {
    const start = match.index;
    if (start === content.length && (content.length === 0 || content.endsWith("\n"))) break;
    if (match[0] === "") {
      if (start === previousEnd || content[start - 1] === "\r" && content[start] === "\n") continue;
    }
    previousEnd = start + match[0].length;
    yield match;
  }
}
function multilineMatchLines(content, regex, limit) {
  const results = [];
  let line = 0;
  let lineStart = 0;
  let nextBreak = content.indexOf("\n");
  for (const match of multilineMatches(content, regex)) {
    const start = match.index;
    const rawEnd = start + match[0].length;
    const end = start + Math.max(0, match[0].length - 1);
    while (nextBreak !== -1 && nextBreak < start) {
      line++;
      lineStart = nextBreak + 1;
      nextBreak = content.indexOf("\n", lineStart);
    }
    while (true) {
      if (results.at(-1)?.lineIndex !== line) {
        const rawLineEnd = nextBreak === -1 ? content.length : nextBreak;
        const lineEnd = rawLineEnd > lineStart && content[rawLineEnd - 1] === "\r" ? rawLineEnd - 1 : rawLineEnd;
        const lineLen = lineEnd - lineStart;
        const matchStart = Math.max(0, Math.min(start - lineStart, lineLen));
        const matchEnd = Math.max(matchStart, Math.min(rawEnd - lineStart, lineLen));
        results.push({ lineIndex: line, matchStart, matchEnd });
      }
      if (results.length >= limit) return results;
      if (nextBreak === -1 || nextBreak >= end) break;
      line++;
      lineStart = nextBreak + 1;
      nextBreak = content.indexOf("\n", lineStart);
    }
  }
  return results;
}
async function runTextOrRegexWithNode(query, searchRoot, baseCwd) {
  const maxResults = clampInt(query.maxResults, 1, 200, 40);
  const contextLines = clampInt(query.contextLines, 0, 5, 0);
  const flags = (query.caseSensitive === false ? "i" : "") + (query.multiline ? "gmsu" : "");
  let regex;
  if (query.type === "regex") {
    try {
      regex = new RegExp(query.pattern, flags);
    } catch (err) {
      if (flags.includes("u")) {
        try {
          regex = new RegExp(query.pattern, flags.replace("u", ""));
        } catch {
          throw new Error(
            `Invalid regex '${query.pattern}': ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } else {
        throw new Error(
          `Invalid regex '${query.pattern}': ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  } else {
    const escaped = query.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(escaped, flags);
  }
  const summary = query.outputMode === "count" || query.outputMode === "files_with_matches";
  const matchesType = fileTypeMatcher(query.fileType);
  let discoveryTruncated = false;
  const globNegated = Boolean(query.glob && query.glob.startsWith("!"));
  const rawGlob = query.glob ? globNegated ? query.glob.slice(1) : query.glob : null;
  const globRegex = rawGlob ? globToRegExp(rawGlob) : null;
  const globMatchesFile = (relPosix) => {
    if (!matchesType(relPosix)) return false;
    if (!globRegex) return true;
    let matched = globRegex.test(relPosix);
    if (!matched && !rawGlob.includes("/")) {
      const base = relPosix.split("/").pop() ?? relPosix;
      matched = globRegex.test(base);
    }
    return globNegated ? !matched : matched;
  };
  const stat = await fs4.stat(searchRoot);
  const perFileCap = stat.isFile() ? maxResults : Math.min(maxResults, 50);
  let targetFiles;
  if (stat.isFile()) {
    const relPosix = toPosixPath(path5.relative(baseCwd, searchRoot)) || path5.basename(searchRoot);
    targetFiles = globMatchesFile(relPosix) ? [{ abs: searchRoot, rel: relativeFile(baseCwd, searchRoot) }] : [];
  } else {
    const includeHidden = Boolean(
      rawGlob && !globNegated && patternTargetsHidden(rawGlob)
    );
    let ignoreDirs;
    if (rawGlob && !globNegated) {
      const targeted = [...DEFAULT_IGNORE_DIRS].filter(
        (dir) => globTargetsDir(rawGlob, dir)
      );
      if (targeted.length > 0) {
        ignoreDirs = new Set(DEFAULT_IGNORE_DIRS);
        for (const dir of targeted) ignoreDirs.delete(dir);
      }
    }
    const walked = await walkFiles(searchRoot, {
      maxFiles: 8e3,
      includeHidden,
      ignoreDirs,
      fileFilter: globMatchesFile
    });
    discoveryTruncated = walked.truncated;
    const rootRel = toPosixPath(path5.relative(baseCwd, searchRoot));
    const useFastPrefix = Boolean(
      rootRel === "" || !rootRel.startsWith("..") && !path5.isAbsolute(rootRel)
    );
    targetFiles = walked.files.map((rel) => {
      const abs = path5.join(searchRoot, rel);
      const displayRel = useFastPrefix ? rootRel ? `${rootRel}/${rel}` : rel : relativeFile(baseCwd, abs);
      return { abs, rel: displayRel };
    });
    targetFiles.sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  }
  const canBufPrecheck = query.type === "text" && query.caseSensitive !== false && !query.multiline && query.pattern.length > 0 && !query.pattern.includes("\uFFFD");
  const patternBuf = canBufPrecheck ? Buffer.from(query.pattern, "utf8") : null;
  const canTextCaseInsensitivePrecheck = query.type === "text" && query.caseSensitive === false && !query.multiline && query.pattern.length > 0;
  let wholeFileRegex = null;
  const regexHasDollar = query.type === "regex" && query.pattern.includes("$");
  const regexUnsafeForWholeFile = query.type === "regex" && /\(\?<?[=!]|\(\?[a-z]*-[a-z]*m/.test(query.pattern);
  if (query.type === "regex" && !query.multiline && !regexUnsafeForWholeFile) {
    try {
      wholeFileRegex = new RegExp(
        regex.source,
        `${query.caseSensitive === false ? "i" : ""}m`
      );
    } catch {
      wholeFileRegex = null;
    }
  }
  const files = [];
  let totalMatches = 0;
  let truncated = false;
  const buildFileMatches = (relFile, allLines, keptMatches) => {
    const lineMap = /* @__PURE__ */ new Map();
    for (const match of keptMatches) {
      const mIdx = match.lineIndex;
      const from = Math.max(0, mIdx - contextLines);
      const to = Math.min(allLines.length - 1, mIdx + contextLines);
      for (let j = from; j <= to; j++) {
        const ln = j + 1;
        const prev = lineMap.get(ln);
        if (j === mIdx) {
          if (!prev?.isMatch) {
            lineMap.set(ln, {
              lineNumber: ln,
              text: allLines[j],
              isMatch: true,
              ...match.matchStart !== void 0 ? { matchStart: match.matchStart, matchEnd: match.matchEnd } : {}
            });
          }
        } else if (!prev) {
          lineMap.set(ln, {
            lineNumber: ln,
            text: allLines[j],
            isMatch: false
          });
        }
      }
    }
    return {
      file: relFile,
      lines: [...lineMap.values()].sort((a, b) => a.lineNumber - b.lineNumber)
    };
  };
  const batchSize = 16;
  let anyFileTruncated = false;
  for (let i = 0; i < targetFiles.length && !truncated; i += batchSize) {
    const batch = targetFiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async ({ abs: absFile, rel: relFile }) => {
        try {
          const st = await fs4.stat(absFile);
          if (st.size > 2 * 1024 * 1024) return null;
          const buf = await fs4.readFile(absFile);
          if (isLikelyBinary(buf)) return null;
          if (patternBuf && buf.indexOf(patternBuf) === -1) return null;
          const content = buf.toString("utf8");
          if (canTextCaseInsensitivePrecheck && !regex.test(content)) return null;
          if (wholeFileRegex && (!regexHasDollar || buf.indexOf(13) === -1)) {
            if (!wholeFileRegex.test(content)) return null;
          }
          let lines = [];
          let matchedLines = [];
          let count = 0;
          let fileTruncated = false;
          if (query.multiline && summary) {
            for (const _match of multilineMatches(content, regex)) {
              count++;
              if (query.outputMode === "files_with_matches") break;
            }
          } else if (query.multiline) {
            matchedLines = multilineMatchLines(content, regex, maxResults + 1);
            count = matchedLines.length;
            if (count > 0) {
              lines = content.split(/\r?\n/);
              if (lines.length > 0 && lines.at(-1) === "") lines.pop();
            }
          } else {
            lines = content.split(/\r?\n/);
            if (lines.length > 0 && lines.at(-1) === "") lines.pop();
            for (let idx = 0; idx < lines.length; idx++) {
              const line = lines[idx];
              const hit = summary ? regex.test(line) ? { index: 0, length: 0 } : null : (() => {
                const m = regex.exec(line);
                return m ? { index: m.index, length: m[0].length } : null;
              })();
              if (hit) {
                if (!summary && matchedLines.length >= perFileCap) {
                  fileTruncated = true;
                  break;
                }
                matchedLines.push({
                  lineIndex: idx,
                  matchStart: hit.index,
                  matchEnd: hit.index + hit.length
                });
                if (query.outputMode === "files_with_matches") break;
              }
            }
            count = matchedLines.length;
          }
          if (!count) return null;
          return {
            relFile,
            lines: summary ? [] : lines,
            matchedLines,
            count,
            fileTruncated
          };
        } catch {
          return null;
        }
      })
    );
    for (const item of results) {
      if (!item) continue;
      if (summary) {
        if (files.length === maxResults) {
          truncated = true;
          break;
        }
        files.push({ file: item.relFile, lines: [], count: item.count });
        continue;
      }
      if (item.fileTruncated) {
        anyFileTruncated = true;
      }
      if (totalMatches + item.matchedLines.length > maxResults) {
        const remaining = maxResults - totalMatches;
        if (remaining > 0) {
          const kept = item.matchedLines.slice(0, remaining);
          files.push(buildFileMatches(item.relFile, item.lines, kept));
          totalMatches += kept.length;
        }
        truncated = true;
        break;
      }
      files.push(buildFileMatches(item.relFile, item.lines, item.matchedLines));
      totalMatches += item.matchedLines.length;
    }
  }
  return {
    files,
    totalMatches,
    truncated: truncated || anyFileTruncated || discoveryTruncated
  };
}
function buildGlobFallbackPlan(pattern) {
  if (!pattern.includes("{") && pattern.includes("|")) {
    const terms = pattern.split("|").map((part) => part.trim()).filter(Boolean);
    if (terms.length >= 2) {
      const termMatchers = terms.map((term) => {
        const hasGlobMeta = /[*?[\]{}]/.test(term);
        if (hasGlobMeta) {
          try {
            const re = globToRegExp(term);
            const matchBase = !term.includes("/");
            return (relPosix, base) => re.test(relPosix) || matchBase && re.test(base);
          } catch {
          }
        }
        const needle = term.toLowerCase();
        return (relPosix) => relPosix.toLowerCase().includes(needle);
      });
      const allBare = terms.every((t) => !/[*?[\]{}/]/.test(t));
      const label = allBare ? `**/*{${terms.join(",")}}*` : `{${terms.join(",")}}`;
      return {
        match: (relPosix, base) => termMatchers.some((fn) => fn(relPosix, base)),
        matchedNote: `[note: exact glob matched 0 files; auto-expanded regex '|' to "${label}" (glob uses * and {a,b}, not |)]`,
        emptyMessage: "(no files matched; hint: glob uses * and {a,b}, not regex |)"
      };
    }
  }
  if (/^[A-Za-z0-9_-]+$/.test(pattern)) {
    const needle = pattern.toLowerCase();
    return {
      match: (relPosix) => relPosix.toLowerCase().includes(needle),
      matchedNote: `[note: exact glob "${pattern}" matched 0 files; showing case-insensitive path matches for "*${pattern}*"]`,
      emptyMessage: "(no files matched)"
    };
  }
  return null;
}
async function formatGlobWalkResult(walked, searchRoot, baseCwd, maxResults, sortBy, notePrefix) {
  const relPrefix = toPosixPath(path5.relative(baseCwd, searchRoot));
  const sortedFiles = [...walked.files].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (sortBy === "mtime") {
    const mtimes = /* @__PURE__ */ new Map();
    for (let i = 0; i < sortedFiles.length; i += 32) {
      await Promise.all(sortedFiles.slice(i, i + 32).map(async (file) => {
        const stat = await fs4.lstat(path5.join(searchRoot, file)).catch(() => void 0);
        mtimes.set(file, stat?.mtimeMs ?? -Infinity);
      }));
    }
    sortedFiles.sort((a, b) => mtimes.get(b) - mtimes.get(a) || (a < b ? -1 : a > b ? 1 : 0));
  }
  const items = sortedFiles.slice(0, maxResults).map((f) => {
    if (!relPrefix || relPrefix === ".") return f;
    return `${relPrefix}/${f}`;
  });
  const truncated = walked.truncated || sortedFiles.length > maxResults;
  const header = notePrefix ? `${notePrefix}
` : "";
  if (!truncated) {
    return `${header}${items.join("\n")}`;
  }
  const omitted = sortedFiles.slice(maxResults);
  const dirCounts = /* @__PURE__ */ new Map();
  for (const f of omitted) {
    const slash = f.indexOf("/");
    const bucket = slash === -1 ? "(root)" : `${f.slice(0, slash)}/`;
    dirCounts.set(bucket, (dirCounts.get(bucket) ?? 0) + 1);
  }
  const topDirs = [...dirCounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, 6).map(([dir, cnt]) => `${dir} (${cnt})`);
  const totalLabel = walked.truncated ? `${walked.files.length}+` : String(walked.files.length);
  const dirSummary = topDirs.length > 0 ? `; omitted dirs: ${topDirs.join(", ")}` : "";
  const suffix = `
... [truncated at ${maxResults} of ${totalLabel} files${dirSummary}]`;
  return `${header}${items.join("\n")}${suffix}`;
}
async function runGlobQuery(query, searchRoot, baseCwd, isFileTarget) {
  const maxResults = clampInt(query.maxResults, 1, 300, 80);
  const pattern = query.pattern.trim() || "**/*";
  const matcher = globToRegExp(pattern);
  const matchBasename = !pattern.includes("/");
  const includeHidden = patternTargetsHidden(pattern);
  if (isFileTarget) {
    const rel = toPosixPath(path5.relative(baseCwd, searchRoot)) || path5.basename(searchRoot);
    const base = path5.basename(searchRoot);
    const matched = matcher.test(rel) || matchBasename && matcher.test(base);
    if (matched) return rel;
    const fallback2 = buildGlobFallbackPlan(pattern);
    if (fallback2) {
      return fallback2.match(rel, base) ? `${fallback2.matchedNote}
${rel}` : fallback2.emptyMessage;
    }
    return "(no files matched)";
  }
  const scanLimit = Math.max(maxResults + 1, 2e3);
  const walked = await walkFiles(searchRoot, {
    maxFiles: scanLimit,
    includeHidden,
    fileFilter: (relPosix) => {
      if (matcher.test(relPosix)) return true;
      if (matchBasename) {
        const base = relPosix.split("/").pop() ?? relPosix;
        return matcher.test(base);
      }
      return false;
    }
  });
  if (walked.files.length > 0) {
    return formatGlobWalkResult(walked, searchRoot, baseCwd, maxResults, query.sortBy);
  }
  const fallback = buildGlobFallbackPlan(pattern);
  if (fallback) {
    const fallbackWalked = await walkFiles(searchRoot, {
      maxFiles: scanLimit,
      includeHidden,
      fileFilter: (relPosix) => {
        const base = relPosix.split("/").pop() ?? relPosix;
        return fallback.match(relPosix, base);
      }
    });
    if (fallbackWalked.files.length > 0) {
      return formatGlobWalkResult(
        fallbackWalked,
        searchRoot,
        baseCwd,
        maxResults,
        query.sortBy,
        fallback.matchedNote
      );
    }
    return fallback.emptyMessage;
  }
  return "(no files matched)";
}
function relativeFile(baseCwd, file) {
  return toPosixPath(path5.relative(baseCwd, path5.resolve(baseCwd, file))) || path5.basename(file);
}
async function runFuzzyQuery(query, searchRoot, baseCwd, isFileTarget) {
  const pattern = query.pattern.trim();
  if (!pattern) throw new Error("Fuzzy pattern must not be blank");
  const matchesType = fileTypeMatcher(query.fileType);
  const maxResults = clampInt(query.maxResults, 1, 200, 30);
  const walked = isFileTarget ? { files: [searchRoot], truncated: false } : await walkFiles(searchRoot, { maxFiles: 8e3, fileFilter: matchesType });
  const candidates = walked.files.filter(matchesType).map((file) => relativeFile(baseCwd, path5.resolve(searchRoot, file)));
  const { matches, totalMatched } = rankFuzzyPaths(pattern, candidates, maxResults);
  const body = matches.map((match) => match.path).join("\n") || "(no files matched)";
  const footer = walked.truncated || totalMatched > maxResults ? `
... [truncated; showing ${matches.length} files]` : "";
  return body + footer;
}
var SHORTLOG_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--group",
  "--format",
  "--since",
  "--after",
  "--until",
  "--before",
  "--author",
  "--committer",
  "--grep",
  "--max-count",
  "--skip"
]);
var SHORTLOG_REV_SELECTOR_FLAGS = /* @__PURE__ */ new Set([
  "--all",
  "--branches",
  "--tags",
  "--remotes",
  "--glob",
  "--stdin"
]);
function hardenGitExecArgs(validatedArgs) {
  const subcmd = validatedArgs[1];
  const rest = validatedArgs.slice(2);
  let subArgs = rest;
  if (subcmd === "diff" || subcmd === "log" || subcmd === "show") {
    subArgs = ["--no-ext-diff", "--no-textconv", ...rest];
  } else if (subcmd === "blame") {
    subArgs = ["--no-textconv", ...rest];
  } else if (subcmd === "remote") {
    const remoteSubIdx = rest.findIndex((a) => !a.startsWith("-"));
    if (remoteSubIdx !== -1 && rest[remoteSubIdx] === "show" && !rest.includes("-n")) {
      subArgs = [...rest.slice(0, remoteSubIdx + 1), "-n", ...rest.slice(remoteSubIdx + 1)];
    }
  } else if (subcmd === "shortlog") {
    let hasRev = false;
    let expectVal = false;
    let dashDashIdx = -1;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (expectVal) {
        expectVal = false;
        continue;
      }
      if (a === "--") {
        dashDashIdx = i;
        break;
      }
      if (a.startsWith("-")) {
        const flagName = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
        if (SHORTLOG_REV_SELECTOR_FLAGS.has(flagName)) {
          hasRev = true;
        } else if (!a.includes("=") && SHORTLOG_VALUE_FLAGS.has(flagName)) {
          expectVal = true;
        }
        continue;
      }
      hasRev = true;
    }
    if (!hasRev) {
      subArgs = dashDashIdx === -1 ? [...rest, "HEAD"] : [...rest.slice(0, dashDashIdx), "HEAD", ...rest.slice(dashDashIdx)];
    }
    subArgs = ["--no-ext-diff", "--no-textconv", ...subArgs];
  }
  return [
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
    "--no-pager",
    ...subcmd ? [subcmd, ...subArgs] : subArgs
  ];
}
async function runGitQuery(query, searchRoot) {
  const gitArgs = validateReadonlyGitArgs(query.pattern);
  const execArgs = hardenGitExecArgs(gitArgs);
  const res = await execBinaryAsync("git", execArgs, {
    cwd: searchRoot,
    timeoutMs: 1e4,
    maxOutputBytes: 512 * 1024,
    env: withNonInteractiveGitEnv()
  });
  if (res.error) {
    throw new Error(`git execution error: ${res.error}`);
  }
  if (res.timedOut) {
    throw new Error("git query timed out");
  }
  if (res.exitCode !== 0) {
    const msg = (res.stderr || res.stdout).trim();
    throw new Error(msg || `git exited with code ${res.exitCode}`);
  }
  const out = res.stdout.trimEnd();
  return out || "(empty output)";
}
var MAX_SEARCH_LINE_CHARS = 240;
function isHighSurrogate(code) {
  return code >= 55296 && code <= 56319;
}
function isLowSurrogate(code) {
  return code >= 56320 && code <= 57343;
}
function formatLineSnippet(line, maxChars = MAX_SEARCH_LINE_CHARS) {
  const text = line.text;
  if (text.length <= maxChars) return text;
  if (!line.isMatch || line.matchStart === void 0) {
    return `${sliceSafeChars(text, maxChars)}...`;
  }
  const len = text.length;
  const mStart = clampInt(line.matchStart, 0, len);
  const mEnd = line.matchEnd !== void 0 ? clampInt(line.matchEnd, mStart, len) : mStart;
  const prefix = sliceSafeChars(text, maxChars);
  if (mStart < prefix.length && mEnd <= prefix.length) {
    return `${prefix}...`;
  }
  const matchLen = mEnd - mStart;
  const lead = matchLen >= maxChars ? Math.min(Math.floor(maxChars * 0.1), mStart) : Math.min(
    Math.min(80, Math.floor(maxChars * 0.35)),
    Math.floor((maxChars - matchLen) / 2)
  );
  let winStart = Math.max(0, mStart - lead);
  let winEnd = Math.min(len, winStart + maxChars);
  if (winEnd === len) {
    winStart = Math.max(0, winEnd - maxChars);
  }
  if (winStart > 0 && winStart < len && isLowSurrogate(text.charCodeAt(winStart))) {
    if (winStart === mStart && isHighSurrogate(text.charCodeAt(winStart - 1))) {
      winStart -= 1;
    } else {
      winStart += 1;
    }
  }
  if (winEnd < len && winEnd > winStart && isHighSurrogate(text.charCodeAt(winEnd - 1))) {
    winEnd -= 1;
  }
  if (winEnd < winStart) winEnd = winStart;
  const leadEllipsis = winStart > 0 ? "..." : "";
  const trailEllipsis = winEnd < len ? "..." : "";
  return `${leadEllipsis}${text.slice(winStart, winEnd)}${trailEllipsis}`;
}
function formatFileMatches(files, totalMatches, truncated) {
  if (files.length === 0) {
    return "(no matches)";
  }
  const blocks = [];
  for (const fm of files) {
    const lines = fm.lines.map((l) => {
      const sep = l.isMatch ? ":" : "-";
      return `  ${l.lineNumber}${sep} ${formatLineSnippet(l)}`;
    });
    blocks.push(`${fm.file}
${lines.join("\n")}`);
  }
  const footer = truncated ? `
... [truncated at ${totalMatches} matches]` : "";
  return `${blocks.join("\n")}${footer}`;
}
function measureCost(text) {
  return { chars: text.length, bytes: Buffer.byteLength(text, "utf8") };
}
function fileOmissionMarker(omitted) {
  if (omitted <= 0) return "";
  return `
  ... (+${omitted} more ${omitted === 1 ? "match" : "matches"})`;
}
function buildTruncatedNotice(shownMatches, totalMatches, shownFiles, totalFiles, maxResultsTruncated, omittedContextOnly) {
  const totalLabel = maxResultsTruncated ? `${totalMatches}+` : `${totalMatches}`;
  const filesLabel = shownFiles < totalFiles ? `across ${shownFiles} of ${totalFiles} files` : totalFiles === 1 ? "in 1 file" : `across ${totalFiles} files`;
  if (omittedContextOnly) {
    return `
... [truncated: showed all ${shownMatches} ${shownMatches === 1 ? "match" : "matches"} ${filesLabel}; omitted context lines${maxResultsTruncated ? `; capped at ${totalMatches} matches` : ""}]`;
  }
  return `
... [truncated: showed ${shownMatches} of ${totalLabel} matches ${filesLabel}]`;
}
function fitShrunkMatchLine(line, maxChars, maxBytes) {
  const prefix = `  ${line.lineNumber}: `;
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  const availChars = maxChars - prefix.length;
  const availBytes = maxBytes - prefixBytes;
  if (availChars < 24 || availBytes < 24) return null;
  let winBudget = Math.min(
    MAX_SEARCH_LINE_CHARS,
    Math.max(16, Math.min(availChars, availBytes) - 6)
  );
  for (let attempt = 0; attempt < 6; attempt++) {
    const snippet = formatLineSnippet(line, winBudget);
    const full = `${prefix}${snippet}`;
    const fullBytes = Buffer.byteLength(full, "utf8");
    if (full.length <= maxChars && fullBytes <= maxBytes) {
      return full;
    }
    const ratio = Math.min(
      availChars / Math.max(1, snippet.length),
      availBytes / Math.max(1, fullBytes - prefixBytes)
    );
    const nextWin = Math.floor(Math.min(winBudget, snippet.length) * ratio) - 4;
    if (nextWin < 16 || nextWin >= winBudget) break;
    winBudget = nextWin;
  }
  return null;
}
function formatBudgetedContentSection(params) {
  const {
    header,
    files,
    totalMatches,
    maxResultsTruncated,
    contextLines,
    charBudget,
    byteBudget
  } = params;
  const headerCost = measureCost(header);
  if (charBudget <= headerCost.chars + 40 || byteBudget <= headerCost.bytes + 40) {
    return null;
  }
  const states = [];
  let totalContextCount = 0;
  for (const fm of files) {
    const matchEntries = [];
    const contextEntries = [];
    let firstMatchLine;
    for (const l of fm.lines) {
      const sep = l.isMatch ? ":" : "-";
      const formatted = `  ${l.lineNumber}${sep} ${formatLineSnippet(l)}`;
      const entry = {
        lineNumber: l.lineNumber,
        isMatch: l.isMatch,
        formatted,
        cost: {
          chars: 1 + formatted.length,
          bytes: 1 + Buffer.byteLength(formatted, "utf8")
        }
      };
      if (l.isMatch) {
        if (!firstMatchLine) firstMatchLine = l;
        matchEntries.push(entry);
      } else {
        contextEntries.push(entry);
        totalContextCount += 1;
      }
    }
    if (matchEntries.length === 0 || !firstMatchLine) continue;
    states.push({
      file: fm.file,
      headerCost: {
        chars: 1 + fm.file.length,
        bytes: 1 + Buffer.byteLength(fm.file, "utf8")
      },
      matchEntries,
      contextEntries,
      firstMatchLine,
      shownMatches: 0,
      selectedContexts: [],
      selectedLineNums: /* @__PURE__ */ new Set()
    });
  }
  if (states.length === 0) return null;
  const totalFiles = states.length;
  const effectiveTotalMatches = states.reduce((acc, s) => acc + s.matchEntries.length, 0);
  const actualTotalMatches = Math.max(totalMatches, effectiveTotalMatches);
  let usedChars = headerCost.chars;
  let usedBytes = headerCost.bytes;
  let shownMatches = 0;
  let shownContexts = 0;
  let shownFiles = 0;
  let allFilesFirstChars = headerCost.chars;
  let allFilesFirstBytes = headerCost.bytes;
  for (const st of states) {
    const first = st.matchEntries[0];
    const markerCost = measureCost(fileOmissionMarker(st.matchEntries.length - 1));
    allFilesFirstChars += st.headerCost.chars + first.cost.chars + markerCost.chars;
    allFilesFirstBytes += st.headerCost.bytes + first.cost.bytes + markerCost.bytes;
  }
  const allShownInitialNotice = measureCost(
    buildTruncatedNotice(
      totalFiles,
      actualTotalMatches,
      totalFiles,
      totalFiles,
      maxResultsTruncated,
      totalFiles === actualTotalMatches
    )
  );
  if (allFilesFirstChars + allShownInitialNotice.chars <= charBudget && allFilesFirstBytes + allShownInitialNotice.bytes <= byteBudget) {
    for (const st of states) {
      const first = st.matchEntries[0];
      const markerCost = measureCost(fileOmissionMarker(st.matchEntries.length - 1));
      st.shownMatches = 1;
      st.selectedLineNums.add(first.lineNumber);
      usedChars += st.headerCost.chars + first.cost.chars + markerCost.chars;
      usedBytes += st.headerCost.bytes + first.cost.bytes + markerCost.bytes;
      shownMatches += 1;
      shownFiles += 1;
    }
  } else {
    const worstTruncNotice = measureCost(
      buildTruncatedNotice(
        actualTotalMatches,
        actualTotalMatches,
        totalFiles,
        totalFiles,
        maxResultsTruncated,
        false
      )
    );
    const minOmittedNotice = totalFiles > 1 ? measureCost(
      `
... [+${totalFiles} more files; use outputMode: "files_with_matches"]`
    ) : { chars: 0, bytes: 0 };
    const bodyChars = Math.max(0, charBudget - headerCost.chars - worstTruncNotice.chars);
    const bodyBytes = Math.max(0, byteBudget - headerCost.bytes - worstTruncNotice.bytes);
    const targetOmittedChars = totalFiles > 1 ? Math.max(minOmittedNotice.chars, Math.min(220, Math.floor(bodyChars * 0.25))) : 0;
    const targetOmittedBytes = totalFiles > 1 ? Math.max(minOmittedNotice.bytes, Math.min(220, Math.floor(bodyBytes * 0.25))) : 0;
    const tryAddFirstMatch = (st, reserveChars, reserveBytes) => {
      const first = st.matchEntries[0];
      const markerCost = measureCost(fileOmissionMarker(st.matchEntries.length - 1));
      const addChars = st.headerCost.chars + first.cost.chars + markerCost.chars;
      const addBytes = st.headerCost.bytes + first.cost.bytes + markerCost.bytes;
      if (usedChars + addChars + worstTruncNotice.chars + reserveChars <= charBudget && usedBytes + addBytes + worstTruncNotice.bytes + reserveBytes <= byteBudget) {
        st.shownMatches = 1;
        st.selectedLineNums.add(first.lineNumber);
        usedChars += addChars;
        usedBytes += addBytes;
        shownMatches += 1;
        shownFiles += 1;
        return true;
      }
      return false;
    };
    for (const st of states) {
      if (tryAddFirstMatch(st, targetOmittedChars, targetOmittedBytes)) {
        continue;
      }
      if (shownFiles === 0) {
        if (tryAddFirstMatch(st, minOmittedNotice.chars, minOmittedNotice.bytes)) {
          break;
        }
        const markerCost = measureCost(fileOmissionMarker(st.matchEntries.length - 1));
        const availLineChars = charBudget - usedChars - st.headerCost.chars - markerCost.chars - worstTruncNotice.chars - minOmittedNotice.chars - 1;
        const availLineBytes = byteBudget - usedBytes - st.headerCost.bytes - markerCost.bytes - worstTruncNotice.bytes - minOmittedNotice.bytes - 1;
        const shrunk = fitShrunkMatchLine(st.firstMatchLine, availLineChars, availLineBytes);
        if (shrunk) {
          const shrunkCost = {
            chars: 1 + shrunk.length,
            bytes: 1 + Buffer.byteLength(shrunk, "utf8")
          };
          st.matchEntries[0] = {
            ...st.matchEntries[0],
            formatted: shrunk,
            cost: shrunkCost
          };
          st.shownMatches = 1;
          st.selectedLineNums.add(st.matchEntries[0].lineNumber);
          usedChars += st.headerCost.chars + shrunkCost.chars + markerCost.chars;
          usedBytes += st.headerCost.bytes + shrunkCost.bytes + markerCost.bytes;
          shownMatches += 1;
          shownFiles += 1;
        }
      }
      break;
    }
    if (shownFiles === 0) {
      return null;
    }
  }
  if (shownFiles === totalFiles) {
    const matchExhausted = new Array(totalFiles).fill(false);
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let f = 0; f < totalFiles; f++) {
        if (matchExhausted[f]) continue;
        const st = states[f];
        if (st.shownMatches >= st.matchEntries.length) {
          matchExhausted[f] = true;
          continue;
        }
        const entry = st.matchEntries[st.shownMatches];
        const prevMarkerCost = measureCost(
          fileOmissionMarker(st.matchEntries.length - st.shownMatches)
        );
        const nextMarkerCost = measureCost(
          fileOmissionMarker(st.matchEntries.length - (st.shownMatches + 1))
        );
        const deltaChars = entry.cost.chars + nextMarkerCost.chars - prevMarkerCost.chars;
        const deltaBytes = entry.cost.bytes + nextMarkerCost.bytes - prevMarkerCost.bytes;
        const nextShownMatches = shownMatches + 1;
        const nextNoticeCost = measureCost(
          buildTruncatedNotice(
            nextShownMatches,
            actualTotalMatches,
            shownFiles,
            totalFiles,
            maxResultsTruncated,
            nextShownMatches === actualTotalMatches
          )
        );
        if (usedChars + deltaChars + nextNoticeCost.chars <= charBudget && usedBytes + deltaBytes + nextNoticeCost.bytes <= byteBudget) {
          st.shownMatches += 1;
          st.selectedLineNums.add(entry.lineNumber);
          usedChars += deltaChars;
          usedBytes += deltaBytes;
          shownMatches = nextShownMatches;
          progressed = true;
        } else {
          matchExhausted[f] = true;
        }
      }
    }
    if (contextLines > 0 && totalContextCount > 0) {
      const eligibleByFile = states.map((st) => {
        if (st.contextEntries.length === 0) return [];
        const renderedMatches = st.matchEntries.slice(0, st.shownMatches).map((m) => m.lineNumber);
        const unrenderedSet = new Set(
          st.matchEntries.slice(st.shownMatches).map((m) => m.lineNumber)
        );
        const eligible = [];
        for (const ctx of st.contextEntries) {
          let bestDist = Number.POSITIVE_INFINITY;
          for (const mLn of renderedMatches) {
            const dist = Math.abs(ctx.lineNumber - mLn);
            if (dist > contextLines || dist >= bestDist) continue;
            const lo = Math.min(ctx.lineNumber, mLn);
            const hi = Math.max(ctx.lineNumber, mLn);
            let blocked = false;
            for (let ln = lo + 1; ln < hi; ln++) {
              if (unrenderedSet.has(ln)) {
                blocked = true;
                break;
              }
            }
            if (!blocked) {
              bestDist = dist;
            }
          }
          if (bestDist <= contextLines) {
            eligible.push({ entry: ctx, dist: bestDist });
          }
        }
        eligible.sort((a, b) => a.dist - b.dist || a.entry.lineNumber - b.entry.lineNumber);
        return eligible.map((e) => e.entry);
      });
      const noticeCost = measureCost(
        buildTruncatedNotice(
          shownMatches,
          actualTotalMatches,
          shownFiles,
          totalFiles,
          maxResultsTruncated,
          shownMatches === actualTotalMatches
        )
      );
      const pickedCtxIdx = states.map(() => /* @__PURE__ */ new Set());
      let ctxProgressed = true;
      while (ctxProgressed) {
        ctxProgressed = false;
        for (let f = 0; f < totalFiles; f++) {
          const candidates = eligibleByFile[f];
          if (candidates.length === 0) continue;
          const st = states[f];
          const picked = pickedCtxIdx[f];
          for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
            if (picked.has(cIdx)) continue;
            const ctx = candidates[cIdx];
            if (!st.selectedLineNums.has(ctx.lineNumber - 1) && !st.selectedLineNums.has(ctx.lineNumber + 1)) {
              continue;
            }
            if (usedChars + ctx.cost.chars + noticeCost.chars <= charBudget && usedBytes + ctx.cost.bytes + noticeCost.bytes <= byteBudget) {
              picked.add(cIdx);
              st.selectedContexts.push(ctx);
              st.selectedLineNums.add(ctx.lineNumber);
              usedChars += ctx.cost.chars;
              usedBytes += ctx.cost.bytes;
              shownContexts += 1;
              ctxProgressed = true;
              break;
            }
          }
        }
      }
    }
  }
  const parts = [header];
  for (let f = 0; f < shownFiles; f++) {
    const st = states[f];
    parts.push(`
${st.file}`);
    const chosenLines = [
      ...st.matchEntries.slice(0, st.shownMatches),
      ...st.selectedContexts
    ].sort((a, b) => a.lineNumber - b.lineNumber);
    for (const line of chosenLines) {
      parts.push(`
${line.formatted}`);
    }
    const omittedInFile = st.matchEntries.length - st.shownMatches;
    if (omittedInFile > 0) {
      parts.push(fileOmissionMarker(omittedInFile));
    }
  }
  const omittedContextOnly = shownFiles === totalFiles && shownMatches === actualTotalMatches && shownContexts < totalContextCount;
  const truncLine = shownFiles < totalFiles || shownMatches < actualTotalMatches || shownContexts < totalContextCount ? buildTruncatedNotice(
    shownMatches,
    actualTotalMatches,
    shownFiles,
    totalFiles,
    maxResultsTruncated,
    omittedContextOnly
  ) : maxResultsTruncated ? `
... [truncated at ${totalMatches} matches]` : "";
  let omittedFilesLine = "";
  if (shownFiles < totalFiles) {
    const bodySoFar = parts.join("");
    const truncCost = measureCost(truncLine);
    const remChars = charBudget - bodySoFar.length - truncCost.chars;
    const remBytes = byteBudget - Buffer.byteLength(bodySoFar, "utf8") - truncCost.bytes;
    const unshown = states.slice(shownFiles);
    const allItems = unshown.map((st) => `${st.file} (${st.matchEntries.length})`);
    const allLine = `
... [more files: ${allItems.join(", ")}]`;
    if (allLine.length <= remChars && Buffer.byteLength(allLine, "utf8") <= remBytes) {
      omittedFilesLine = allLine;
    } else {
      const named = [];
      let bestLine = "";
      for (let i = 0; i < unshown.length; i++) {
        const item = allItems[i];
        const leftAfter = unshown.length - (i + 1);
        const list = named.length === 0 ? item : `${named.join(", ")}, ${item}`;
        const suffix = leftAfter > 0 ? `, +${leftAfter} more ${leftAfter === 1 ? "file" : "files"}; use outputMode: "files_with_matches"]` : "]";
        const candidate = `
... [more files: ${list}${suffix}`;
        if (candidate.length <= remChars && Buffer.byteLength(candidate, "utf8") <= remBytes) {
          named.push(item);
          bestLine = candidate;
        } else {
          break;
        }
      }
      if (bestLine) {
        omittedFilesLine = bestLine;
      } else {
        const fallback = `
... [+${unshown.length} more ${unshown.length === 1 ? "file" : "files"}; use outputMode: "files_with_matches"]`;
        const shortFallback = `
... [+${unshown.length} more ${unshown.length === 1 ? "file" : "files"}]`;
        if (fallback.length <= remChars && Buffer.byteLength(fallback, "utf8") <= remBytes) {
          omittedFilesLine = fallback;
        } else if (shortFallback.length <= remChars && Buffer.byteLength(shortFallback, "utf8") <= remBytes) {
          omittedFilesLine = shortFallback;
        }
      }
    }
  }
  const result = `${parts.join("")}${omittedFilesLine}${truncLine}`;
  if (result.length <= charBudget && Buffer.byteLength(result, "utf8") <= byteBudget) {
    return result;
  }
  return null;
}
async function executeSingleQuery(query, index, baseCwd, useRg) {
  const header = `## Query ${index + 1} [${query.type}] ${query.pattern}${query.path ? ` (in ${query.path})` : ""}`;
  try {
    if (!query.pattern || typeof query.pattern !== "string") {
      throw new Error("Query 'pattern' must be a non-empty string");
    }
    if (query.multiline !== void 0 && typeof query.multiline !== "boolean") {
      throw new Error("multiline must be a boolean");
    }
    if (query.outputMode !== void 0 && !["content", "files_with_matches", "count"].includes(query.outputMode)) {
      throw new Error("Invalid outputMode");
    }
    if (query.sortBy !== void 0 && !["path", "mtime"].includes(query.sortBy)) {
      throw new Error("Invalid sortBy");
    }
    const searchRoot = query.path ? resolvePath(query.path, baseCwd) : baseCwd;
    let targetStat;
    try {
      targetStat = await fs4.stat(searchRoot);
    } catch {
      throw new Error(`Path does not exist: ${query.path || baseCwd}`);
    }
    if (query.type === "git") {
      const gitCwd = targetStat.isFile() ? path5.dirname(searchRoot) : searchRoot;
      const out = await runGitQuery(query, gitCwd);
      return { header, text: `${header}
${out}` };
    }
    if (query.type === "glob") {
      const out = await runGlobQuery(query, searchRoot, baseCwd, targetStat.isFile());
      return { header, text: `${header}
${out}` };
    }
    if (query.type === "fuzzy") {
      const out = await runFuzzyQuery(query, searchRoot, baseCwd, targetStat.isFile());
      return { header, text: `${header}
${out}` };
    }
    if (query.type === "text" || query.type === "regex") {
      let res;
      if (useRg) {
        try {
          res = await runTextOrRegexWithRg(query, searchRoot, baseCwd);
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("rg spawn error:")) {
            res = await runTextOrRegexWithNode(query, searchRoot, baseCwd);
          } else {
            throw err;
          }
        }
      } else {
        res = await runTextOrRegexWithNode(query, searchRoot, baseCwd);
      }
      if (query.outputMode === "count" || query.outputMode === "files_with_matches") {
        const body = res.files.map(({ file, count }) => query.outputMode === "count" ? `${file}: ${count} ${query.multiline ? "matches" : "matching lines"}` : file).join("\n") || "(no matches)";
        const footer = res.truncated ? `
... [truncated; showing ${res.files.length} files]` : "";
        return { header, text: `${header}
${body}${footer}` };
      }
      const text = `${header}
${formatFileMatches(res.files, res.totalMatches, res.truncated)}`;
      return {
        header,
        text,
        contentResult: res.files.length > 0 ? {
          files: res.files,
          totalMatches: res.totalMatches,
          truncated: res.truncated,
          contextLines: clampInt(query.contextLines, 0, 5, 0)
        } : void 0
      };
    }
    throw new Error(`Unsupported query type: ${String(query.type)}`);
  } catch (err) {
    return { header, text: `${header}
ERROR: ${err instanceof Error ? err.message : String(err)}` };
  }
}
async function runBatchSearch(input, options = {}) {
  const parsedQueries = parseMaybeJsonArray(input?.queries);
  if (!parsedQueries.ok) {
    if (parsedQueries.kind === "corrupted_literal" || parsedQueries.kind === "wrong_type" && (typeof input?.queries === "boolean" || input?.queries === null)) {
      return {
        text: formatCorruptedArrayError({
          header: "Validation failed",
          toolName: "batch_search",
          items: [
            {
              label: "queries",
              value: parsedQueries.kind === "corrupted_literal" ? parsedQueries.value : input.queries,
              expected: "an array of query objects"
            }
          ],
          fallbackAdvice: "split into smaller queries or use a single compound read-only run_command."
        }),
        isError: true
      };
    }
    return {
      text: "Error: 'queries' must be a non-empty array of search queries.",
      isError: true
    };
  }
  const rawQueries = parsedQueries.value;
  if (rawQueries.length === 0) {
    return {
      text: "Error: 'queries' must be a non-empty array of search queries.",
      isError: true
    };
  }
  if (rawQueries.length > 20) {
    return {
      text: "Error: 'queries' supports at most 20 queries per call.",
      isError: true
    };
  }
  const corruptedQueries = [];
  for (let i = 0; i < rawQueries.length; i++) {
    if (!isPlainObject(rawQueries[i])) {
      corruptedQueries.push({
        label: `queries[${i}]`,
        value: rawQueries[i],
        expected: "a query object ({ type, pattern, ... })"
      });
    }
  }
  if (corruptedQueries.length > 0) {
    return {
      text: formatCorruptedArrayError({
        header: "Validation failed",
        toolName: "batch_search",
        items: corruptedQueries,
        fallbackAdvice: "split into smaller queries or use a single compound read-only run_command."
      }),
      isError: true
    };
  }
  const queries = rawQueries;
  const baseCwd = resolvePath(input.cwd || process.cwd());
  try {
    const st = await fs4.stat(baseCwd);
    if (!st.isDirectory()) {
      return { text: `Error: cwd is not a directory: ${baseCwd}`, isError: true };
    }
  } catch {
    return { text: `Error: cwd does not exist: ${baseCwd}`, isError: true };
  }
  const maxChars = clampInt(input.maxChars, 500, DEFAULT_INLINE_MAX_BYTES, 8500);
  const maxBytes = DEFAULT_INLINE_MAX_BYTES;
  const needsTextSearch = queries.some(
    (q) => q.type === "text" || q.type === "regex"
  );
  const useRg = needsTextSearch && !options.forceNodeFallback && await isRipgrepAvailable();
  const executed = await Promise.all(
    queries.map((q, idx) => executeSingleQuery(q, idx, baseCwd, useRg))
  );
  const separator = "\n\n";
  const rawSections = executed.map((e) => e.text);
  const joined = rawSections.join(separator);
  const sepChars = separator.length * Math.max(0, rawSections.length - 1);
  const sepBytes = Buffer.byteLength(separator, "utf8") * Math.max(0, rawSections.length - 1);
  const overChars = joined.length > maxChars;
  const overBytes = Buffer.byteLength(joined, "utf8") > maxBytes;
  let finalSections = rawSections;
  if (overChars || overBytes) {
    const rawCharLens = rawSections.map((s) => s.length);
    const rawByteLens = rawSections.map((s) => Buffer.byteLength(s, "utf8"));
    const byteBudgets = overBytes ? computeWaterFillBudgets(rawByteLens, Math.max(0, maxBytes - sepBytes)) : rawByteLens.map(() => maxBytes);
    const charBudgets = overChars ? computeWaterFillBudgets(rawCharLens, Math.max(0, maxChars - sepChars)) : computeWaterFillBudgets(
      rawCharLens.map(
        (len, idx) => rawByteLens[idx] > byteBudgets[idx] ? maxChars : len
      ),
      Math.max(0, maxChars - sepChars)
    );
    finalSections = executed.map((ex, idx) => {
      const charBudget = charBudgets[idx] ?? 0;
      const byteBudget = byteBudgets[idx] ?? 0;
      if (!ex.contentResult || rawCharLens[idx] <= charBudget && rawByteLens[idx] <= byteBudget) {
        return ex.text;
      }
      const budgeted = formatBudgetedContentSection({
        header: ex.header,
        files: ex.contentResult.files,
        totalMatches: ex.contentResult.totalMatches,
        maxResultsTruncated: ex.contentResult.truncated,
        contextLines: ex.contentResult.contextLines,
        charBudget,
        byteBudget
      });
      return budgeted ?? ex.text;
    });
  }
  return {
    text: fitSectionsToByteBudget(finalSections, maxChars, maxBytes, separator),
    isError: false
  };
}
function patternTargetsHidden(pattern) {
  const normalized = pattern.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  return /(?:^|[/,{])\.[^./]/.test(normalized);
}
function globTargetsDir(glob, dir) {
  const normalized = glob.replace(/\\/g, "/").replace(/(^|[,{])(?:\.\/)+/g, "$1");
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[/,{])${escaped}(?:$|[/},])`).test(normalized);
}
function clampInt(val, min, max, fallback = min) {
  const num = typeof val === "number" ? val : typeof val === "string" && val.trim() !== "" ? Number(val) : NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

// src/tools/read-slices.ts
import path6 from "node:path";
function isRegexStartContext(line, slashIdx) {
  let j = slashIdx - 1;
  while (j >= 0 && /\s/.test(line[j])) j--;
  if (j < 0) return true;
  const prev = line[j];
  if ("=(,:![&|?{};~+-*%^<>".includes(prev)) return true;
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(line[k])) k--;
  const word = line.slice(k + 1, j + 1);
  return word === "return" || word === "case" || word === "throw" || word === "in" || word === "of" || word === "typeof" || word === "void" || word === "delete" || word === "new";
}
function isJsxSelfClosingSlash(line, slashIdx) {
  if (line[slashIdx + 1] !== ">") return false;
  let j = slashIdx - 1;
  while (j >= 0 && /\s/.test(line[j])) j--;
  if (j >= 0 && line[j] !== "}") return false;
  return line[slashIdx + 2] !== "/";
}
function scanBracesOnLine(line, state, lang, ignoreBracesInParensBeforeOpen = false, alreadySeenOpen = false) {
  let open = 0;
  let close = 0;
  let openParen = 0;
  let closeParen = 0;
  let parenDepth = state.parenDepth ?? 0;
  let seenOpen = alreadySeenOpen;
  let inSingle = false;
  let inDouble = false;
  let inRegex = false;
  let inRegexClass = false;
  let escape = false;
  let lastCodeChar = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (state.inBlockComment) {
      if (ch === "*" && next === "/") {
        state.inBlockComment = false;
        i++;
      }
      continue;
    }
    if (escape) {
      escape = false;
      continue;
    }
    if (inRegex) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === "[") {
        inRegexClass = true;
      } else if (ch === "]") {
        inRegexClass = false;
      } else if (ch === "/" && !inRegexClass) {
        inRegex = false;
        lastCodeChar = "/";
      }
      continue;
    }
    if (state.inBacktick) {
      if (ch === "\\" && lang !== "go") {
        escape = true;
      } else if (ch === "`") {
        state.inBacktick = false;
        lastCodeChar = "`";
      } else if (lang === "js" && ch === "$" && next === "{") {
        state.inBacktick = false;
        state.templateExprStack.push(0);
        i++;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "\\") escape = true;
      else if (ch === "'") {
        inSingle = false;
        lastCodeChar = "'";
      }
      continue;
    }
    if (inDouble) {
      if (ch === "\\") escape = true;
      else if (ch === '"') {
        inDouble = false;
        lastCodeChar = '"';
      }
      continue;
    }
    if (lang === "shell" && ch === "#" && (i === 0 || /[\s;&|()]/.test(line[i - 1]))) {
      break;
    }
    if ((lang === "js" || lang === "c" || lang === "go" || lang === "rust") && ch === "/" && next === "/") break;
    if ((lang === "js" || lang === "c" || lang === "go" || lang === "rust") && ch === "/" && next === "*") {
      state.inBlockComment = true;
      i++;
      continue;
    }
    if (lang === "js" && ch === "/" && next !== "/" && next !== "*" && !isJsxSelfClosingSlash(line, i) && line[i - 1] !== "<" && isRegexStartContext(line, i)) {
      inRegex = true;
      inRegexClass = false;
      continue;
    }
    if (ch === "'" && lang !== "json") {
      if (lang === "rust") {
        if (next === "\\" || line[i + 2] === "'") {
          inSingle = true;
        }
        continue;
      }
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "`" && (lang === "js" || lang === "c" || lang === "go")) {
      state.inBacktick = true;
      continue;
    }
    if (ch === "{") {
      if (state.templateExprStack.length > 0) {
        state.templateExprStack[state.templateExprStack.length - 1] += 1;
      } else if (!(ignoreBracesInParensBeforeOpen && !seenOpen && parenDepth > 0)) {
        open++;
        seenOpen = true;
      }
      lastCodeChar = "{";
    } else if (ch === "}") {
      if (state.templateExprStack.length > 0) {
        const top = state.templateExprStack[state.templateExprStack.length - 1];
        if (top === 0) {
          state.templateExprStack.pop();
          state.inBacktick = true;
        } else {
          state.templateExprStack[state.templateExprStack.length - 1] = top - 1;
        }
      } else if (!(ignoreBracesInParensBeforeOpen && !seenOpen && parenDepth > 0)) {
        close++;
      }
      lastCodeChar = "}";
    } else if (ch === "(") {
      openParen++;
      parenDepth++;
      lastCodeChar = "(";
    } else if (ch === ")") {
      closeParen++;
      parenDepth = Math.max(0, parenDepth - 1);
      lastCodeChar = ")";
    } else if (!/\s/.test(ch)) {
      lastCodeChar = ch;
    }
  }
  state.parenDepth = parenDepth;
  return {
    open,
    close,
    openParen,
    closeParen,
    endsWithSemi: lastCodeChar === ";",
    lastCodeChar
  };
}
function findBraceBlockEnd(lines, startIdx, lang = "c") {
  let depth = 0;
  let seenOpen = false;
  const state = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
    parenDepth: 0
  };
  const maxScan = Math.min(lines.length, startIdx + 2e3);
  for (let i = startIdx; i < maxScan; i++) {
    const { open, close, endsWithSemi, lastCodeChar } = scanBracesOnLine(
      lines[i],
      state,
      lang,
      lang === "js" || lang === "go",
      seenOpen
    );
    if (open > 0) seenOpen = true;
    depth += open - close;
    if (seenOpen && depth <= 0) {
      if (lang === "js" && lastCodeChar === ">" && i <= startIdx + 12) {
        seenOpen = false;
        depth = 0;
        continue;
      }
      return i + 1;
    }
    if (!seenOpen && (state.parenDepth ?? 0) <= 0 && endsWithSemi) {
      return i + 1;
    }
    if (!seenOpen && i > startIdx + 40) {
      return startIdx + 1;
    }
  }
  return seenOpen ? Math.min(lines.length, maxScan) : startIdx + 1;
}
function findTypeAliasEnd(lines, startIdx) {
  const firstLine = lines[startIdx] ?? "";
  const eqIdx = firstLine.indexOf("=");
  const rhs = eqIdx >= 0 ? firstLine.slice(eqIdx + 1) : firstLine;
  const state = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
    parenDepth: 0
  };
  const firstScan = scanBracesOnLine(rhs, state, "js");
  if (firstScan.open > firstScan.close) {
    return findBraceBlockEnd(lines, startIdx, "js");
  }
  if (firstScan.endsWithSemi && firstScan.openParen <= firstScan.closeParen) {
    return startIdx + 1;
  }
  let endIdx = startIdx;
  let parenBal = firstScan.openParen - firstScan.closeParen;
  let prevLast = firstScan.lastCodeChar;
  const maxScan = Math.min(lines.length - 1, startIdx + 40);
  while (endIdx < maxScan) {
    const nextLine = lines[endIdx + 1] ?? "";
    const nextTrim = nextLine.trim();
    if (!nextTrim) break;
    const isContinuation = parenBal > 0 || prevLast === "=" || prevLast === "|" || prevLast === "&" || prevLast === "?" || prevLast === ":" || /^[ \t]+(?:[|&?:]|\w+\s*\?*:)/.test(nextLine);
    if (!isContinuation) break;
    endIdx++;
    const scan = scanBracesOnLine(nextLine, state, "js");
    if (scan.open > scan.close) {
      return findBraceBlockEnd(lines, endIdx, "js");
    }
    parenBal += scan.openParen - scan.closeParen;
    prevLast = scan.lastCodeChar;
    if (scan.endsWithSemi && parenBal <= 0) break;
  }
  return endIdx + 1;
}
function findParenCallEnd(lines, startIdx) {
  const state = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
    parenDepth: 0
  };
  let seenParen = false;
  const maxScan = Math.min(lines.length, startIdx + 400);
  for (let i = startIdx; i < maxScan; i++) {
    const { openParen } = scanBracesOnLine(lines[i], state, "js");
    if (openParen > 0) seenParen = true;
    if (seenParen && (state.parenDepth ?? 0) <= 0) {
      return i + 1;
    }
  }
  return startIdx + 1;
}
function hasArrowOrBraceWithin(lines, startIdx, maxLookahead = 12) {
  const state = { inBlockComment: false, templateExprStack: [], inBacktick: false };
  let parenDepth = 0;
  let seenParen = false;
  let hasArrow = false;
  const end = Math.min(lines.length, startIdx + maxLookahead);
  for (let i = startIdx; i < end; i++) {
    const line = lines[i];
    const { open, openParen, closeParen, endsWithSemi } = scanBracesOnLine(line, state, "js");
    if (openParen > 0) seenParen = true;
    parenDepth += openParen - closeParen;
    if (line.includes("=>")) hasArrow = true;
    if (open > 0 && (!seenParen || parenDepth <= 0)) {
      return { hasArrow, hasBrace: true };
    }
    if (seenParen && parenDepth <= 0 && endsWithSemi) {
      return { hasArrow, hasBrace: false };
    }
  }
  return { hasArrow, hasBrace: false };
}
function extractTsJsSymbols(lines) {
  const symbols = [];
  const patterns = [
    {
      re: /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
      kind: "class",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/,
      kind: "interface",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/,
      kind: "type",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
      kind: "enum",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
      kind: "function",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
      kind: "function",
      nameGroup: 1
    }
  ];
  const multilineArrowStartRe = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?\(/;
  const methodHeaderRe = /^([ \t]{1,4})(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
  const controlKeywords = /* @__PURE__ */ new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "else",
    "try",
    "return",
    "new",
    "throw",
    "await",
    "super",
    "typeof",
    "delete"
  ]);
  const routeRegisterRe = /^[ \t]{1,6}(?:app|router|server|fastify)\.(get|post|put|patch|delete|all|route)\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/;
  const testSuiteRe = /^(?:describe|suite)(?:\.(?:only|skip))?\s*\(\s*['"`]([^'"`]+)['"`]/;
  const testCaseRe = /^[ \t]{0,4}(?:it|test)(?:\.(?:only|skip))?\s*\(\s*['"`]([^'"`]+)['"`]/;
  let currentClassEnd = -1;
  let currentClassIndent = -1;
  let currentFnEnd = -1;
  let currentSuiteEnd = -1;
  const commentState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasInComment = commentState.inBlockComment;
    const wasInBacktick = commentState.inBacktick;
    scanBracesOnLine(line, commentState, "js");
    if (wasInComment || wasInBacktick) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }
    let matchedTop = false;
    if (!line.startsWith(" ") && !line.startsWith("	")) {
      for (const p of patterns) {
        const m = p.re.exec(line);
        if (m && m[p.nameGroup]) {
          const endLine = p.kind === "type" ? findTypeAliasEnd(lines, i) : findBraceBlockEnd(lines, i, "js");
          symbols.push({
            kind: p.kind,
            name: m[p.nameGroup],
            startLine: i + 1,
            endLine,
            depth: 0
          });
          if (p.kind === "class") {
            currentClassEnd = endLine;
            currentClassIndent = -1;
          } else if (p.kind === "function" && endLine - (i + 1) >= 40) {
            currentFnEnd = endLine;
          }
          matchedTop = true;
          break;
        }
      }
      if (!matchedTop) {
        const ma = multilineArrowStartRe.exec(line);
        if (ma && ma[1]) {
          const { hasArrow } = hasArrowOrBraceWithin(lines, i, 12);
          if (hasArrow) {
            const endLine = findBraceBlockEnd(lines, i, "js");
            symbols.push({
              kind: "function",
              name: ma[1],
              startLine: i + 1,
              endLine,
              depth: 0
            });
            if (endLine - (i + 1) >= 40) {
              currentFnEnd = endLine;
            }
            matchedTop = true;
          }
        }
      }
      if (!matchedTop) {
        const ms = testSuiteRe.exec(line);
        if (ms && ms[1]) {
          const endLine = findParenCallEnd(lines, i);
          symbols.push({
            kind: "suite",
            name: ms[1].slice(0, 64),
            startLine: i + 1,
            endLine,
            depth: 0
          });
          currentSuiteEnd = endLine;
          matchedTop = true;
        }
      }
    }
    if (!matchedTop && i + 1 <= currentClassEnd) {
      const mm = methodHeaderRe.exec(line);
      if (mm && mm[1] && mm[2] && !controlKeywords.has(mm[2])) {
        const indentWidth = mm[1].replace(/\t/g, "  ").length;
        if (currentClassIndent === -1) {
          currentClassIndent = indentWidth;
        }
        if (indentWidth === currentClassIndent) {
          const { hasBrace } = hasArrowOrBraceWithin(lines, i, 10);
          if (hasBrace) {
            const endLine = findBraceBlockEnd(lines, i, "js");
            symbols.push({
              kind: "method",
              name: mm[2],
              startLine: i + 1,
              endLine,
              depth: 1
            });
          }
        }
      }
    } else if (!matchedTop && i + 1 <= currentFnEnd) {
      const mr = routeRegisterRe.exec(line);
      if (mr && mr[1] && mr[2]) {
        const endLine = findParenCallEnd(lines, i);
        symbols.push({
          kind: "route",
          name: `${mr[1].toUpperCase()} ${mr[2]}`,
          startLine: i + 1,
          endLine,
          depth: 1
        });
      }
    } else if (!matchedTop) {
      const mt = testCaseRe.exec(line);
      if (mt && mt[1]) {
        const endLine = findParenCallEnd(lines, i);
        symbols.push({
          kind: "test",
          name: mt[1].slice(0, 64),
          startLine: i + 1,
          endLine,
          depth: i + 1 <= currentSuiteEnd ? 1 : 0
        });
      }
    }
  }
  return symbols;
}
function isPythonFStringPrefix(line, quoteIdx) {
  let k = quoteIdx - 1;
  while (k >= 0 && /[A-Za-z]/.test(line[k])) k--;
  if (k >= 0 && /[0-9_]/.test(line[k])) return false;
  const prefix = line.slice(k + 1, quoteIdx).toLowerCase();
  return prefix === "f" || prefix === "fr" || prefix === "rf";
}
function extractPythonSymbols(lines) {
  const symbols = [];
  const re = /^([ \t]*)(async\s+def|def|class)\s+([A-Za-z_]\w*)/;
  const indentOf = (l) => (/^[ \t]*/.exec(l)?.[0] ?? "").replace(/\t/g, "    ").length;
  const isContinuation = new Array(lines.length).fill(false);
  const inStringContinuation = new Array(lines.length).fill(false);
  let activeQuote = null;
  let activeSingleQuote = null;
  let activeSingleIsFString = false;
  let bracketDepth = 0;
  let backslashContinued = false;
  const fExprStack = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    inStringContinuation[i] = activeQuote !== null || activeSingleQuote !== null || backslashContinued;
    if (!inStringContinuation[i] && (bracketDepth > 0 || fExprStack.length > 0) && re.test(line)) {
      bracketDepth = 0;
      fExprStack.length = 0;
      const defIndent = indentOf(line);
      for (let k = i - 1; k >= 0; k--) {
        if (inStringContinuation[k]) break;
        const t = lines[k].trim();
        if (!t || t.startsWith("#")) {
          isContinuation[k] = false;
          continue;
        }
        if (t.startsWith("@") && indentOf(lines[k]) === defIndent) {
          isContinuation[k] = false;
          continue;
        }
        break;
      }
    }
    isContinuation[i] = inStringContinuation[i] || bracketDepth > 0 || fExprStack.length > 0;
    backslashContinued = false;
    let j = 0;
    while (j < line.length) {
      if (activeQuote) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line.startsWith(activeQuote, j)) {
          activeQuote = null;
          j += 3;
          continue;
        }
        j++;
      } else if (activeSingleQuote) {
        if (line[j] === "\\") {
          if (j === line.length - 1) {
            backslashContinued = true;
            break;
          }
          j += 2;
          continue;
        }
        if (activeSingleIsFString) {
          if (line[j] === "{") {
            if (line[j + 1] === "{") {
              j += 2;
              continue;
            }
            fExprStack.push({
              quote: activeSingleQuote,
              braceDepth: 1,
              baseBracketDepth: bracketDepth
            });
            activeSingleQuote = null;
            activeSingleIsFString = false;
            j++;
            continue;
          }
          if (line[j] === "}" && line[j + 1] === "}") {
            j += 2;
            continue;
          }
        }
        if (line[j] === activeSingleQuote) {
          activeSingleQuote = null;
          activeSingleIsFString = false;
          j++;
          continue;
        }
        j++;
      } else {
        if (line[j] === "#") break;
        if (line.startsWith('"""', j)) {
          activeQuote = '"""';
          j += 3;
          continue;
        }
        if (line.startsWith("'''", j)) {
          activeQuote = "'''";
          j += 3;
          continue;
        }
        if (line[j] === '"' || line[j] === "'") {
          activeSingleQuote = line[j] === '"' ? '"' : "'";
          activeSingleIsFString = isPythonFStringPrefix(line, j);
          j++;
          continue;
        }
        if (fExprStack.length > 0) {
          const top = fExprStack[fExprStack.length - 1];
          if (top.braceDepth === 1 && bracketDepth === top.baseBracketDepth && line[j] === ":" && line[j + 1] !== "=") {
            let specDepth = 1;
            j++;
            while (j < line.length && specDepth > 0) {
              if (line[j] === "\\") {
                j += 2;
                continue;
              }
              if (line[j] === "{") specDepth++;
              else if (line[j] === "}") specDepth--;
              j++;
            }
            if (specDepth === 0) {
              fExprStack.pop();
              activeSingleQuote = top.quote;
              activeSingleIsFString = true;
            }
            continue;
          }
          if (line[j] === "{") {
            top.braceDepth++;
            bracketDepth++;
            j++;
            continue;
          }
          if (line[j] === "}") {
            if (top.braceDepth === 1) {
              fExprStack.pop();
              activeSingleQuote = top.quote;
              activeSingleIsFString = true;
              j++;
              continue;
            }
            top.braceDepth--;
            bracketDepth = Math.max(0, bracketDepth - 1);
            j++;
            continue;
          }
        }
        if (line[j] === "(" || line[j] === "[" || line[j] === "{") bracketDepth++;
        else if (line[j] === ")" || line[j] === "]" || line[j] === "}") {
          bracketDepth = Math.max(0, bracketDepth - 1);
        } else if (line[j] === "\\" && j === line.length - 1) backslashContinued = true;
        j++;
      }
    }
    if (activeSingleQuote && !backslashContinued) {
      activeSingleQuote = null;
      activeSingleIsFString = false;
    }
  }
  const raw = [];
  for (let i = 0; i < lines.length; i++) {
    if (isContinuation[i]) continue;
    const m = re.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, "    ").length;
    const kind = m[2] === "class" ? "class" : indent > 0 ? "method" : "function";
    raw.push({ indent, kind, name: m[3], defIdx: i });
  }
  for (let idx = 0; idx < raw.length; idx++) {
    const item = raw[idx];
    let startIdx = item.defIdx;
    for (let j = item.defIdx - 1; j >= 0; j--) {
      if (isContinuation[j] || !lines[j].trim()) continue;
      const trimmed = lines[j].trimStart();
      if (trimmed.startsWith("#")) continue;
      if (!trimmed.startsWith("@") || indentOf(lines[j]) !== item.indent) break;
      startIdx = j;
    }
    let endIdx = lines.length - 1;
    for (let j = item.defIdx + 1; j < lines.length; j++) {
      if (isContinuation[j]) continue;
      const l = lines[j];
      const trimmed = l.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (indentOf(l) <= item.indent) {
        endIdx = j - 1;
        break;
      }
    }
    while (endIdx > item.defIdx) {
      const trimmed = lines[endIdx].trim();
      if (trimmed && !(!isContinuation[endIdx] && trimmed.startsWith("#") && indentOf(lines[endIdx]) <= item.indent)) {
        break;
      }
      endIdx--;
    }
    symbols.push({
      kind: item.kind,
      name: item.name,
      startLine: startIdx + 1,
      endLine: endIdx + 1,
      depth: item.indent > 0 ? 1 : 0
    });
  }
  return symbols;
}
function stripLeadingGdAnnotations(text) {
  let rest = text;
  while (rest.startsWith("@")) {
    const m = /^@[A-Za-z_]\w*/.exec(rest);
    if (!m) break;
    let idx = m[0].length;
    while (idx < rest.length && (rest[idx] === " " || rest[idx] === "	")) idx++;
    if (rest[idx] === "(") {
      let depth = 0;
      let quote = null;
      while (idx < rest.length) {
        const ch = rest[idx];
        if (quote) {
          if (ch === "\\") {
            idx += 2;
            continue;
          }
          if (ch === quote) quote = null;
        } else {
          if (ch === '"' || ch === "'") quote = ch;
          else if (ch === "(") depth++;
          else if (ch === ")") {
            depth--;
            if (depth === 0) {
              idx++;
              break;
            }
          }
        }
        idx++;
      }
    }
    while (idx < rest.length && (rest[idx] === " " || rest[idx] === "	")) idx++;
    rest = rest.slice(idx);
  }
  return rest;
}
function extractGdScriptSymbols(rawLines) {
  const lines = rawLines.map((l, idx) => {
    const clean = l.endsWith("\r") ? l.slice(0, -1) : l;
    return idx === 0 ? clean.replace(/^\uFEFF/, "") : clean;
  });
  const info = new Array(lines.length);
  let activeTriple = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const startsInTriple = activeTriple !== null;
    let openBrace = 0;
    let closeBrace = 0;
    let openParen = 0;
    let closeParen = 0;
    let hasCode = startsInTriple;
    let j = 0;
    while (j < line.length) {
      if (activeTriple) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line.startsWith(activeTriple, j)) {
          activeTriple = null;
          j += 3;
          continue;
        }
        j++;
      } else {
        const ch = line[j];
        if (ch === "#") break;
        if (line.startsWith('"""', j) || line.startsWith("'''", j)) {
          activeTriple = line.startsWith('"""', j) ? '"""' : "'''";
          hasCode = true;
          j += 3;
          continue;
        }
        if (ch === '"' || ch === "'") {
          hasCode = true;
          j++;
          while (j < line.length && line[j] !== ch) {
            if (line[j] === "\\") j += 2;
            else j++;
          }
          if (j < line.length) j++;
          continue;
        }
        if (ch !== " " && ch !== "	") {
          hasCode = true;
          if (ch === "{") openBrace++;
          else if (ch === "}") closeBrace++;
          else if (ch === "(") openParen++;
          else if (ch === ")") closeParen++;
        }
        j++;
      }
    }
    info[i] = {
      startsInTriple,
      openBrace,
      closeBrace,
      openParen,
      closeParen,
      hasCode
    };
  }
  const raw = [];
  const classNameRe = /^class_name\s+([A-Za-z_]\w*)\b/;
  const classRe = /^class\s+([A-Za-z_]\w*)\b/;
  const funcRe = /^(?:static\s+)?func\s+([A-Za-z_]\w*)\s*\(/;
  const signalRe = /^signal\s+([A-Za-z_]\w*)\b/;
  const enumRe = /^enum(?:\s+([A-Za-z_]\w*))?\s*(?:\{|$|#)/;
  for (let i = 0; i < lines.length; i++) {
    if (info[i].startsInTriple) continue;
    const line = lines[i];
    const indentStr = /^[ \t]*/.exec(line)?.[0] ?? "";
    const afterIndent = line.slice(indentStr.length);
    if (!afterIndent || afterIndent.startsWith("#")) continue;
    const rest = stripLeadingGdAnnotations(afterIndent);
    if (!rest || rest.startsWith("#")) continue;
    const indent = indentStr.replace(/\t/g, "    ").length;
    let m = classNameRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "class_name", name: m[1], startIdx: i });
      continue;
    }
    m = classRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "class", name: m[1], startIdx: i });
      continue;
    }
    m = funcRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "func", name: m[1], startIdx: i });
      continue;
    }
    m = signalRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "signal", name: m[1], startIdx: i });
      continue;
    }
    m = enumRe.exec(rest);
    if (m) {
      if (!m[1] && info[i].openBrace === 0) {
        let nextCodeIdx = i + 1;
        while (nextCodeIdx < lines.length && !info[nextCodeIdx].hasCode) {
          nextCodeIdx++;
        }
        if (nextCodeIdx >= lines.length || info[nextCodeIdx].openBrace === 0) {
          continue;
        }
      }
      raw.push({
        indent,
        rawKind: "enum",
        name: m[1] ?? "<anonymous>",
        startIdx: i
      });
    }
  }
  const symbols = [];
  const classStack = [];
  for (const item of raw) {
    let endIdx = item.startIdx;
    if (item.rawKind === "class_name") {
      endIdx = item.startIdx;
    } else if (item.rawKind === "signal") {
      let parenDepth = info[item.startIdx].openParen - info[item.startIdx].closeParen;
      const maxSigScan = Math.min(lines.length - 1, item.startIdx + 40);
      while (parenDepth > 0 && endIdx < maxSigScan) {
        endIdx++;
        parenDepth += info[endIdx].openParen - info[endIdx].closeParen;
      }
      if (parenDepth > 0) endIdx = item.startIdx;
    } else if (item.rawKind === "enum") {
      let braceDepth = 0;
      let seenOpen = false;
      const maxEnumScan = Math.min(lines.length - 1, item.startIdx + 500);
      for (let k = item.startIdx; k <= maxEnumScan; k++) {
        const li = info[k];
        if (li.openBrace > 0) seenOpen = true;
        braceDepth += li.openBrace - li.closeBrace;
        if (seenOpen && braceDepth <= 0) {
          endIdx = k;
          break;
        }
        if (!seenOpen && k > item.startIdx && li.hasCode && li.openBrace === 0) {
          break;
        }
      }
      if (seenOpen && braceDepth > 0) {
        endIdx = maxEnumScan;
      }
    } else {
      let headerEndIdx = item.startIdx;
      let parenDepth = info[item.startIdx].openParen - info[item.startIdx].closeParen;
      const maxHeaderScan = Math.min(lines.length - 1, item.startIdx + 40);
      while (parenDepth > 0 && headerEndIdx < maxHeaderScan) {
        headerEndIdx++;
        parenDepth += info[headerEndIdx].openParen - info[headerEndIdx].closeParen;
      }
      if (parenDepth > 0) headerEndIdx = item.startIdx;
      endIdx = lines.length - 1;
      for (let j = headerEndIdx + 1; j < lines.length; j++) {
        if (info[j].startsInTriple) continue;
        const l = lines[j];
        const trimmed = l.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const curIndent = (/^[ \t]*/.exec(l)?.[0] ?? "").replace(/\t/g, "    ").length;
        if (curIndent <= item.indent) {
          endIdx = j - 1;
          break;
        }
      }
      while (endIdx > headerEndIdx) {
        if (info[endIdx].startsInTriple) break;
        const endLineStr = lines[endIdx];
        const endTrimmed = endLineStr.trim();
        if (!endTrimmed) {
          endIdx--;
          continue;
        }
        if (endTrimmed.startsWith("#")) {
          const commentIndent = (/^[ \t]*/.exec(endLineStr)?.[0] ?? "").replace(
            /\t/g,
            "    "
          ).length;
          if (commentIndent <= item.indent) {
            endIdx--;
            continue;
          }
        }
        break;
      }
    }
    const startLine = item.startIdx + 1;
    const endLine = Math.max(startLine, endIdx + 1);
    while (classStack.length > 0 && (classStack[classStack.length - 1].endLine < startLine || classStack[classStack.length - 1].indent >= item.indent)) {
      classStack.pop();
    }
    const depth = classStack.length > 0 ? classStack.length : item.indent > 0 ? Math.max(1, Math.floor(item.indent / 4)) : 0;
    const kind = item.rawKind === "func" ? item.indent > 0 ? "method" : "function" : item.rawKind;
    symbols.push({
      kind,
      name: item.name,
      startLine,
      endLine,
      depth
    });
    if (item.rawKind === "class") {
      classStack.push({ indent: item.indent, endLine });
    }
  }
  return symbols;
}
function extractGoSymbols(lines) {
  const symbols = [];
  const funcRe = /^func\s+(?:\(([^)]+)\)\s+)?([A-Za-z_]\w*)/;
  const typeRe = /^type\s+([A-Za-z_]\w*(?:\[[^\]]*\])?)\s+(struct|interface)\b/;
  const commentState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasInComment = commentState.inBlockComment;
    const wasInBacktick = commentState.inBacktick;
    scanBracesOnLine(line, commentState, "go");
    if (wasInComment || wasInBacktick) continue;
    const fm = funcRe.exec(line);
    if (fm && fm[2]) {
      const recv = fm[1]?.trim();
      const name = recv ? `(${recv}) ${fm[2]}` : fm[2];
      symbols.push({
        kind: recv ? "method" : "function",
        name,
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "go"),
        depth: 0
      });
      continue;
    }
    const tm = typeRe.exec(line);
    if (tm && tm[1] && tm[2]) {
      symbols.push({
        kind: tm[2],
        name: tm[1],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "go"),
        depth: 0
      });
    }
  }
  return symbols;
}
function extractRustSymbols(lines) {
  const symbols = [];
  const re = /^([ \t]*)(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern(?:\s+"[^"]*")?)\s+)*(fn|struct|enum|trait|impl|mod)(?:\s+|\s*(?=<))([A-Za-z_<][\w:<>,+'&\s]*?)(?:\s*[\({;]|$)/;
  const commentState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasInComment = commentState.inBlockComment;
    scanBracesOnLine(line, commentState, "rust");
    if (wasInComment) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
      continue;
    }
    const m = re.exec(line);
    if (!m || !m[2] || !m[3]) continue;
    const indent = m[1].length;
    if (indent > 4) continue;
    symbols.push({
      kind: m[2],
      name: m[3].trim(),
      startLine: i + 1,
      endLine: findBraceBlockEnd(lines, i, "rust"),
      depth: indent > 0 ? 1 : 0
    });
  }
  return symbols;
}
function extractCLikeSymbols(lines) {
  const symbols = [];
  const typeRe = /^([ \t]{0,4})(?:(?:public|private|protected|internal|static|final|abstract|sealed|data|open|export|partial)\s+)*(class|interface|enum|struct|record|protocol|namespace)\s+([A-Za-z_]\w*)/;
  const kwFuncRe = /^([ \t]{0,4})(?:(?:public|private|protected|internal|static|final|override|virtual|inline|async|suspend|open|mutating)\s+)*(?:fun|func)\s+([A-Za-z_]\w*)/;
  const cMethodRe = /^([ \t]{0,4})(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|inline|constexpr|extern|async|synchronized|native|unsigned|signed|const)\s+)*(?:[A-Za-z_~][\w:<>,\[\]\s*&]*?\s+)([A-Za-z_~][\w:]*)\s*\([^;]*$/;
  const excludedNames = /* @__PURE__ */ new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "else",
    "return",
    "sizeof",
    "alignof",
    "decltype",
    "new",
    "delete",
    "throw",
    "typedef",
    "using",
    "case"
  ]);
  const commentState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasInComment = commentState.inBlockComment;
    scanBracesOnLine(line, commentState, "c");
    if (wasInComment) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("#")) {
      continue;
    }
    const tm = typeRe.exec(line);
    if (tm && tm[2] && tm[3]) {
      const indented = (tm[1]?.length ?? 0) > 0;
      symbols.push({
        kind: tm[2],
        name: tm[3],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: indented ? 1 : 0
      });
      continue;
    }
    const fm = kwFuncRe.exec(line);
    if (fm && fm[2]) {
      const indented = (fm[1]?.length ?? 0) > 0;
      symbols.push({
        kind: indented ? "method" : "function",
        name: fm[2],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: indented ? 1 : 0
      });
      continue;
    }
    const cm = cMethodRe.exec(line);
    if (cm && cm[2] && !excludedNames.has(cm[2]) && !trimmed.includes("=")) {
      const { hasBrace } = hasArrowOrBraceWithin(lines, i, 8);
      if (hasBrace) {
        const indented = (cm[1]?.length ?? 0) > 0;
        symbols.push({
          kind: indented ? "method" : "function",
          name: cm[2],
          startLine: i + 1,
          endLine: findBraceBlockEnd(lines, i, "c"),
          depth: indented ? 1 : 0
        });
      }
    }
  }
  return symbols;
}
function extractShellSymbols(lines) {
  const symbols = [];
  const re = /^(?:function\s+([A-Za-z_][\w-]*)\s*(?:\(\))?|([A-Za-z_][\w-]*)\s*\(\))\s*\{/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const name = m[1] || m[2];
    if (!name) continue;
    symbols.push({
      kind: "function",
      name,
      startLine: i + 1,
      endLine: findBraceBlockEnd(lines, i, "shell"),
      depth: 0
    });
  }
  return symbols;
}
function extractMarkdownSymbols(lines) {
  const raw = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    if (m && m[1] && m[2]) {
      raw.push({ level: m[1].length, name: m[2], startLine: i + 1 });
    }
  }
  return raw.map((item, idx) => {
    let endLine = lines.length;
    for (let j = idx + 1; j < raw.length; j++) {
      if (raw[j].level <= item.level) {
        endLine = raw[j].startLine - 1;
        break;
      }
    }
    return {
      kind: `h${item.level}`,
      name: item.name,
      startLine: item.startLine,
      endLine: Math.max(item.startLine, endLine),
      depth: item.level - 1
    };
  });
}
function extractJsonYamlSymbols(lines, isJson) {
  const symbols = [];
  if (isJson) {
    let keyIndent = null;
    for (let i = 0; i < lines.length; i++) {
      const m = /^([ \t]+)"([^"]+)"\s*:/.exec(lines[i]);
      if (m && m[1] && m[2]) {
        if (keyIndent === null) {
          keyIndent = m[1];
        }
        if (m[1] === keyIndent) {
          symbols.push({
            kind: "key",
            name: m[2],
            startLine: i + 1,
            endLine: i + 1,
            depth: 0
          });
        }
      }
    }
    for (let idx = 0; idx < symbols.length; idx++) {
      const cur = symbols[idx];
      const nextStart = idx + 1 < symbols.length ? symbols[idx + 1].startLine - 1 : lines.length - 1;
      let endLine = Math.max(cur.startLine, nextStart);
      while (endLine > cur.startLine && /^\s*[}\]]?,?\s*$/.test(lines[endLine - 1] ?? "") && idx === symbols.length - 1) {
        endLine--;
      }
      cur.endLine = endLine;
    }
    return symbols;
  }
  const re = /^([A-Za-z0-9_.-]+)\s*:/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m && m[1]) {
      symbols.push({
        kind: "key",
        name: m[1],
        startLine: i + 1,
        endLine: i + 1,
        depth: 0
      });
    }
  }
  for (let idx = 0; idx < symbols.length; idx++) {
    const cur = symbols[idx];
    let endLine = idx + 1 < symbols.length ? symbols[idx + 1].startLine - 1 : lines.length;
    while (endLine > cur.startLine && !(lines[endLine - 1] ?? "").trim()) {
      endLine--;
    }
    cur.endLine = Math.max(cur.startLine, endLine);
  }
  return symbols;
}
function extractCssSymbols(lines, compactOnly = false) {
  const symbols = [];
  const state = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false
  };
  let braceDepth = 0;
  const atRuleRe = /^@(layer|media|keyframes|supports|container|font-face|theme)\b([^{;]*)/i;
  const tokenBlockRe = /^(:root\b|html(?:\[[^\]]+\]|\.[A-Za-z_-][\w-]*)?(?=\s|[,{])|\[data-theme[^\]]*\]|body\b)[^{;]*\{/;
  const sectionCommentRe = /^\/\*\s*[=\-*#]*\s*([^*/=][^*/]{1,70}?)\s*[=\-*#]*\s*\*\/$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const wasInComment = state.inBlockComment;
    if (!wasInComment && braceDepth === 0 && trimmed) {
      const cm = sectionCommentRe.exec(trimmed);
      if (cm && cm[1] && /[A-Za-z0-9\u4e00-\u9fff]/.test(cm[1])) {
        symbols.push({
          kind: "section",
          name: cm[1].trim().slice(0, 64),
          startLine: i + 1,
          endLine: i + 1,
          depth: 0
        });
      } else {
        const am = atRuleRe.exec(trimmed);
        if (am && am[1]) {
          const endLine = trimmed.includes("{") ? findBraceBlockEnd(lines, i, "c") : i + 1;
          const rest = (am[2] ?? "").trim().replace(/\s+/g, " ").slice(0, 56);
          symbols.push({
            kind: `@${am[1].toLowerCase()}`,
            name: rest || `@${am[1].toLowerCase()}`,
            startLine: i + 1,
            endLine,
            depth: 0
          });
        } else {
          const tm = tokenBlockRe.exec(trimmed);
          if (tm && tm[1]) {
            const endLine = findBraceBlockEnd(lines, i, "c");
            const header = trimmed.slice(0, trimmed.indexOf("{")).trim().replace(/\s+/g, " ").slice(0, 60);
            symbols.push({
              kind: "tokens",
              name: header || tm[1],
              startLine: i + 1,
              endLine,
              depth: 0
            });
          }
        }
      }
    }
    const { open, close } = scanBracesOnLine(line, state, "c");
    braceDepth = Math.max(0, braceDepth + open - close);
  }
  if (!compactOnly && symbols.length < 10) {
    const fallbackState = {
      inBlockComment: false,
      templateExprStack: [],
      inBacktick: false
    };
    let d = 0;
    let lastAddedLine = -999;
    const seen = new Set(symbols.map((s) => s.startLine));
    for (let i = 0; i < lines.length && symbols.length < 40; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const wasInComment = fallbackState.inBlockComment;
      if (!wasInComment && d === 0 && !seen.has(i + 1) && i - lastAddedLine >= 10 && /^[.#\[a-zA-Z*:]/.test(trimmed) && trimmed.includes("{") && !trimmed.startsWith("@")) {
        const sel = trimmed.slice(0, trimmed.indexOf("{")).trim().replace(/\s+/g, " ").slice(0, 60);
        if (sel) {
          const endLine = findBraceBlockEnd(lines, i, "c");
          symbols.push({
            kind: "rule",
            name: sel,
            startLine: i + 1,
            endLine,
            depth: 0
          });
          lastAddedLine = i;
        }
      }
      const { open, close } = scanBracesOnLine(line, fallbackState, "c");
      d = Math.max(0, d + open - close);
    }
    symbols.sort((a, b) => a.startLine - b.startLine);
  }
  return symbols;
}
var HTML_VOID_ELEMENTS = /* @__PURE__ */ new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);
var HTML_RAW_SKIP_TAGS = /* @__PURE__ */ new Set([
  "textarea",
  "title",
  "xmp",
  "noembed",
  "noframes"
]);
var HTML_SEMANTIC_TAGS = /* @__PURE__ */ new Set([
  "head",
  "body",
  "header",
  "nav",
  "main",
  "aside",
  "section",
  "article",
  "footer",
  "form",
  "dialog",
  "template"
]);
var HTML_CONTAINER_TAGS = /* @__PURE__ */ new Set([
  "div",
  "ul",
  "ol",
  "table",
  "fieldset",
  "details"
]);
var COMPONENT_LANDMARK_RE = /^(?:[A-Z][A-Za-z0-9]*\.)?(?:[A-Z][A-Za-z0-9]*)?(?:Modal|Drawer|Dialog|Panel|Tabs?|View|Page|Form)$/;
var MAX_HTML_DEPTH = 2;
var MAX_TAG_HEADER_SCAN = 8192;
function leadingWhitespaceCols(line, tabWidth = 4) {
  let cols = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === " ") cols += 1;
    else if (ch === "	") cols += tabWidth;
    else break;
  }
  return cols;
}
function stripLeadingCols(line, colsToStrip, tabWidth = 4) {
  if (colsToStrip <= 0) return line;
  let cols = 0;
  let idx = 0;
  while (idx < line.length && cols < colsToStrip) {
    const ch = line[idx];
    if (ch === " ") {
      cols += 1;
      idx++;
    } else if (ch === "	") {
      cols += tabWidth;
      idx++;
    } else {
      break;
    }
  }
  if (cols > colsToStrip) {
    return " ".repeat(cols - colsToStrip) + line.slice(idx);
  }
  return line.slice(idx);
}
function dedentBlockLines(lines, skipFirstLineForIndent = false) {
  const startIdx = skipFirstLineForIndent ? 1 : 0;
  let firstNonEmptyIndent = -1;
  let minPosCols = Infinity;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = leadingWhitespaceCols(line);
    if (firstNonEmptyIndent === -1) firstNonEmptyIndent = cols;
    if (cols > 0 && cols < minPosCols) minPosCols = cols;
  }
  if (firstNonEmptyIndent <= 0 || !Number.isFinite(minPosCols) || minPosCols <= 0) {
    return lines;
  }
  return lines.map((line, idx) => {
    if (idx < startIdx || !line.trim()) return line;
    return stripLeadingCols(line, minPosCols);
  });
}
function findMatchingBrace2(text, start, maxLookahead = 2e3) {
  const limit = Math.min(text.length, start + maxLookahead);
  let depth = 0;
  let quote = null;
  let escape = false;
  for (let i = start; i < limit; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function findClosingMustache(text, start, maxLookahead = 2e3) {
  const limit = Math.min(text.length, start + maxLookahead);
  let quote = null;
  let escape = false;
  for (let i = start + 2; i + 1 < limit; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "}" && text[i + 1] === "}") {
      return i;
    }
  }
  return -1;
}
function parseHtmlAttrs(attrText) {
  const attrs = /* @__PURE__ */ new Map();
  let vueSlot;
  let i = 0;
  const len = attrText.length;
  while (i < len) {
    while (i < len && /[\s/]/.test(attrText[i])) i++;
    if (i >= len) break;
    const nameStart = i;
    while (i < len && !/[\s=/>"'`]/.test(attrText[i])) i++;
    const rawName = attrText.slice(nameStart, i);
    if (!rawName) {
      i++;
      continue;
    }
    const lowerName = rawName.toLowerCase();
    if (!vueSlot && rawName.startsWith("#") && rawName.length > 1) {
      vueSlot = rawName.slice(1);
    } else if (!vueSlot && lowerName.startsWith("v-slot:") && rawName.length > 7) {
      vueSlot = rawName.slice(7);
    }
    while (i < len && /\s/.test(attrText[i])) i++;
    let value = "";
    if (i < len && attrText[i] === "=") {
      i++;
      while (i < len && /\s/.test(attrText[i])) i++;
      if (i < len) {
        const ch = attrText[i];
        if (ch === '"' || ch === "'") {
          const quote = ch;
          i++;
          const valStart = i;
          while (i < len && attrText[i] !== quote) i++;
          value = attrText.slice(valStart, i);
          if (i < len) i++;
        } else if (ch === "{") {
          const endBrace = findMatchingBrace2(attrText, i);
          if (endBrace >= 0) {
            value = attrText.slice(i, endBrace + 1);
            i = endBrace + 1;
          } else {
            const valStart = i;
            while (i < len && !/[\s/>]/.test(attrText[i])) i++;
            value = attrText.slice(valStart, i);
          }
        } else {
          const valStart = i;
          while (i < len && !/[\s/>]/.test(attrText[i])) i++;
          value = attrText.slice(valStart, i);
        }
      }
    }
    if (!attrs.has(lowerName)) {
      attrs.set(lowerName, value);
    }
  }
  return { attrs, vueSlot };
}
function normalizeInlineAttr(value, maxChars) {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact ? sliceSafeChars(compact, maxChars) : "";
}
function formatHtmlTagLabel(displayTag, lowerTag, rawAttrs, parsed) {
  if (lowerTag === "script" || lowerTag === "style") {
    const compact = normalizeInlineAttr(rawAttrs, 40);
    return compact ? `<${lowerTag} ${compact}>` : `<${lowerTag}>`;
  }
  const idVal = normalizeInlineAttr(parsed.attrs.get("id"), 36);
  if (idVal) {
    return `<${displayTag} #${idVal}>`;
  }
  const testIdVal = normalizeInlineAttr(parsed.attrs.get("data-testid"), 36);
  if (testIdVal) {
    return `<${displayTag} data-testid="${testIdVal}">`;
  }
  const roleVal = normalizeInlineAttr(parsed.attrs.get("role"), 36);
  if (roleVal) {
    return `<${displayTag} role="${roleVal}">`;
  }
  const slotVal = normalizeInlineAttr(parsed.vueSlot, 36);
  if (lowerTag === "template" && slotVal) {
    return `<template #${slotVal}>`;
  }
  return `<${displayTag}>`;
}
function isJsScriptType(typeAttr) {
  if (typeAttr === void 0) return true;
  const mime = typeAttr.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  return !mime || mime === "module" || mime === "text/javascript" || mime === "application/javascript" || mime === "text/ecmascript" || mime === "application/ecmascript" || mime === "text/typescript" || mime === "ts" || mime === "tsx" || mime === "jsx";
}
function isCommentDecorChar(ch) {
  return ch === "=" || ch === "-" || ch === "*" || ch === "#" || ch === "~" || ch === ":" || ch === " " || ch === "	" || ch === "\r" || ch === "\n";
}
function extractCommentLandmark(inner) {
  let start = 0;
  let end = inner.length;
  while (start < end && isCommentDecorChar(inner[start])) start++;
  while (end > start && isCommentDecorChar(inner[end - 1])) end--;
  const cleaned = inner.slice(start, end);
  if (cleaned.length < 2 || cleaned.length > 60) return null;
  if (/[<>]/.test(cleaned)) return null;
  if (/^(?:eslint|prettier|istanbul|c8|v8|@ts-)/i.test(cleaned)) return null;
  if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(cleaned)) return null;
  return cleaned;
}
function extractTemplateSymbols(rawLines, mode = "html") {
  if (rawLines.length === 0) return [];
  const lines = rawLines[0].startsWith("\uFEFF") ? [rawLines[0].slice(1), ...rawLines.slice(1)] : rawLines;
  const text = lines.join("\n");
  const lineStarts = new Array(lines.length);
  let acc = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    lineStarts[idx] = acc;
    acc += lines[idx].length + 1;
  }
  const offsetToLineIdx = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const symbols = [];
  const stack = [];
  const stackTagCounts = /* @__PURE__ */ new Map();
  const pushFrame = (frame) => {
    stack.push(frame);
    stackTagCounts.set(frame.lowerTag, (stackTagCounts.get(frame.lowerTag) ?? 0) + 1);
  };
  const popFrame = () => {
    const frame = stack.pop();
    const prev = stackTagCounts.get(frame.lowerTag) ?? 0;
    if (prev <= 1) stackTagCounts.delete(frame.lowerTag);
    else stackTagCounts.set(frame.lowerTag, prev - 1);
    return frame;
  };
  let emittedCount = 0;
  let noCloseSingle = false;
  let noCloseDouble = false;
  let noCloseScript = false;
  let noCloseStyle = false;
  let noCloseBodyBrace = false;
  let noCloseMustache = false;
  const noCloseRawSkip = /* @__PURE__ */ new Set();
  let nextRightBrace = text.indexOf("}");
  let nextCloseMustache = mode === "vue" ? text.indexOf("}}") : -1;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    if (mode === "svelte" && !noCloseBodyBrace) {
      const bracePos = text.indexOf("{", i);
      if (bracePos >= 0 && bracePos < lt) {
        if (nextRightBrace !== -1 && nextRightBrace < bracePos) {
          nextRightBrace = text.indexOf("}", bracePos);
        }
        if (nextRightBrace === -1) {
          noCloseBodyBrace = true;
        } else if (nextRightBrace < bracePos + 2e3) {
          const endBrace = findMatchingBrace2(text, bracePos);
          if (endBrace >= 0) {
            i = endBrace + 1;
            continue;
          }
          i = bracePos + 1;
          continue;
        } else if (nextRightBrace < lt) {
          i = nextRightBrace + 1;
          continue;
        }
      }
    } else if (mode === "vue" && !noCloseMustache) {
      const mustachePos = text.indexOf("{{", i);
      if (mustachePos >= 0 && mustachePos < lt) {
        if (nextCloseMustache !== -1 && nextCloseMustache < mustachePos + 2) {
          nextCloseMustache = text.indexOf("}}", mustachePos + 2);
        }
        if (nextCloseMustache === -1) {
          noCloseMustache = true;
        } else if (nextCloseMustache < mustachePos + 2e3) {
          const endMustache = findClosingMustache(text, mustachePos);
          if (endMustache >= 0) {
            i = endMustache + 2;
            continue;
          }
          i = mustachePos + 2;
          continue;
        } else if (nextCloseMustache < lt) {
          i = nextCloseMustache + 2;
          continue;
        }
      }
    }
    i = lt;
    if (text.startsWith("<!--", i)) {
      if (text.startsWith("<!-->", i)) {
        i += 5;
        continue;
      }
      if (text.startsWith("<!--->", i)) {
        i += 6;
        continue;
      }
      const startLineIdx2 = offsetToLineIdx(i);
      const stdClose = text.indexOf("-->", i + 4);
      const bangClose = text.indexOf("--!>", i + 4);
      let closePos = -1;
      let closeLen = 3;
      if (stdClose >= 0 && (bangClose < 0 || stdClose <= bangClose)) {
        closePos = stdClose;
        closeLen = 3;
      } else if (bangClose >= 0) {
        closePos = bangClose;
        closeLen = 4;
      }
      if (closePos < 0) {
        break;
      }
      const endLineIdx = offsetToLineIdx(closePos + closeLen - 1);
      if (startLineIdx2 === endLineIdx && closeLen === 3) {
        const lineTrim = lines[startLineIdx2].trim();
        if (lineTrim.startsWith("<!--") && lineTrim.endsWith("-->") && lineTrim.indexOf("-->", 4) === lineTrim.length - 3) {
          const landmark = extractCommentLandmark(text.slice(i + 4, closePos));
          if (landmark) {
            const ln = startLineIdx2 + 1;
            symbols.push({
              kind: "section",
              name: landmark,
              startLine: ln,
              endLine: ln,
              depth: Math.min(MAX_HTML_DEPTH, emittedCount)
            });
          }
        }
      }
      i = closePos + closeLen;
      continue;
    }
    if (text.startsWith("<![CDATA[", i)) {
      const closePos = text.indexOf("]]>", i + 9);
      i = closePos < 0 ? len : closePos + 3;
      continue;
    }
    const nextCh = text[i + 1];
    if (nextCh === "?") {
      const closePi = text.indexOf("?>", i + 2);
      if (closePi >= 0) {
        i = closePi + 2;
      } else {
        const closeGt = text.indexOf(">", i + 2);
        i = closeGt >= 0 ? closeGt + 1 : len;
      }
      continue;
    }
    if (nextCh === "!") {
      let quote2 = null;
      let j2 = i + 2;
      while (j2 < len) {
        const c = text[j2];
        if (quote2) {
          if (c === quote2 || c === "\n") quote2 = null;
        } else if (c === '"' || c === "'") {
          quote2 = c;
        } else if (c === ">") {
          j2++;
          break;
        }
        j2++;
      }
      i = j2;
      continue;
    }
    if (nextCh === "/") {
      const nameStart = i + 2;
      if (nameStart >= len || !/[A-Za-z]/.test(text[nameStart])) {
        i += 2;
        continue;
      }
      let j2 = nameStart + 1;
      while (j2 < len && /[A-Za-z0-9:._-]/.test(text[j2])) j2++;
      const closeLowerTag = text.slice(nameStart, j2).toLowerCase();
      while (j2 < len && text[j2] !== ">") j2++;
      if (j2 < len && text[j2] === ">") j2++;
      const closeLine = offsetToLineIdx(Math.max(i, j2 - 1)) + 1;
      if ((stackTagCounts.get(closeLowerTag) ?? 0) > 0) {
        let matchIdx = -1;
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s].lowerTag === closeLowerTag) {
            matchIdx = s;
            break;
          }
        }
        if (matchIdx >= 0) {
          for (let s = stack.length - 1; s > matchIdx; s--) {
            const unclosed = popFrame();
            if (unclosed.emitted) {
              emittedCount = Math.max(0, emittedCount - 1);
              if (unclosed.symbol) {
                unclosed.symbol.endLine = Math.max(
                  unclosed.symbol.endLine,
                  closeLine > unclosed.startLine ? closeLine - 1 : unclosed.startLine
                );
              }
            }
          }
          const matched = popFrame();
          if (matched.emitted) {
            emittedCount = Math.max(0, emittedCount - 1);
            if (matched.symbol) {
              matched.symbol.endLine = Math.max(matched.symbol.endLine, closeLine);
            }
          }
        }
      }
      i = j2;
      continue;
    }
    if (!nextCh || !/[A-Za-z]/.test(nextCh)) {
      i++;
      continue;
    }
    const tagStart = i;
    let nameEnd = i + 1;
    while (nameEnd < len && /[A-Za-z0-9:._-]/.test(text[nameEnd])) nameEnd++;
    const afterNameCh = text[nameEnd];
    if (afterNameCh !== void 0 && !/[\s/>]/.test(afterNameCh)) {
      i = nameEnd;
      continue;
    }
    const rawTag = text.slice(i + 1, nameEnd);
    const lowerTag = rawTag.toLowerCase();
    const headerLimit = Math.min(len, nameEnd + MAX_TAG_HEADER_SCAN);
    let j = nameEnd;
    let quote = null;
    let braceDepth = 0;
    let braceQuote = null;
    let braceEscape = false;
    let lastUnquotedNonWs = "";
    let foundGt = false;
    while (j < headerLimit) {
      const c = text[j];
      if (braceDepth > 0) {
        if (braceEscape) {
          braceEscape = false;
        } else if (braceQuote) {
          if (c === "\\") braceEscape = true;
          else if (c === braceQuote) braceQuote = null;
        } else if (c === '"' || c === "'" || c === "`") {
          braceQuote = c;
        } else if (c === "{") {
          braceDepth++;
        } else if (c === "}") {
          braceDepth--;
          if (braceDepth === 0) lastUnquotedNonWs = "}";
        }
        j++;
        continue;
      }
      if (quote) {
        if (c === quote) quote = null;
        j++;
        continue;
      }
      if ((c === '"' || c === "'") && lastUnquotedNonWs === "=") {
        if (c === '"' && !noCloseDouble || c === "'" && !noCloseSingle) {
          quote = c;
        }
        lastUnquotedNonWs = c;
        j++;
        continue;
      }
      if (c === "{") {
        if (nextRightBrace !== -1 && nextRightBrace < j) {
          nextRightBrace = text.indexOf("}", j);
        }
        if (nextRightBrace === -1 || nextRightBrace >= headerLimit) {
          foundGt = false;
          break;
        }
        braceDepth = 1;
        braceQuote = null;
        braceEscape = false;
        j++;
        continue;
      }
      if (c === "<") {
        foundGt = false;
        break;
      }
      if (c === "&" && text[j + 1] === "&" || c === "|" && text[j + 1] === "|" || c === "=" && text[j + 1] === ">") {
        foundGt = false;
        break;
      }
      if (c === ">") {
        foundGt = true;
        break;
      }
      if (!/\s/.test(c)) {
        lastUnquotedNonWs = c;
      }
      j++;
    }
    if (!foundGt) {
      if (j === len) {
        if (quote === '"') noCloseDouble = true;
        else if (quote === "'") noCloseSingle = true;
      }
      i = tagStart + 1;
      continue;
    }
    const gtPos = j;
    const selfClosing = lastUnquotedNonWs === "/";
    const rawAttrSlice = text.slice(
      nameEnd,
      selfClosing ? text.lastIndexOf("/", gtPos) : gtPos
    );
    const startLineIdx = offsetToLineIdx(tagStart);
    const openEndLineIdx = offsetToLineIdx(gtPos);
    const startLine = startLineIdx + 1;
    const openEndLine = openEndLineIdx + 1;
    if (HTML_RAW_SKIP_TAGS.has(lowerTag)) {
      if (selfClosing || noCloseRawSkip.has(lowerTag)) {
        i = gtPos + 1;
        continue;
      }
      const closeRe = new RegExp(`</${lowerTag}\\s*>`, "gi");
      closeRe.lastIndex = gtPos + 1;
      const closeMatch = closeRe.exec(text);
      if (closeMatch) {
        i = closeMatch.index + closeMatch[0].length;
      } else {
        noCloseRawSkip.add(lowerTag);
        i = gtPos + 1;
      }
      continue;
    }
    if (lowerTag === "script" || lowerTag === "style") {
      const parsed = parseHtmlAttrs(rawAttrSlice);
      const tagDepth = Math.min(MAX_HTML_DEPTH, emittedCount);
      const label = formatHtmlTagLabel(lowerTag, lowerTag, rawAttrSlice, parsed);
      if (selfClosing) {
        symbols.push({
          kind: lowerTag,
          name: label,
          startLine,
          endLine: openEndLine,
          depth: tagDepth
        });
        i = gtPos + 1;
        continue;
      }
      const noCloseLatch = lowerTag === "script" ? noCloseScript : noCloseStyle;
      let closeMatch = null;
      if (!noCloseLatch) {
        const closeRe = new RegExp(`</${lowerTag}\\s*>`, "gi");
        closeRe.lastIndex = gtPos + 1;
        closeMatch = closeRe.exec(text);
        if (!closeMatch) {
          if (lowerTag === "script") noCloseScript = true;
          else noCloseStyle = true;
        }
      }
      let closeStart;
      let endLine;
      let nextPos;
      if (closeMatch) {
        closeStart = closeMatch.index;
        const closeEndPos = closeMatch.index + closeMatch[0].length;
        endLine = Math.max(startLine, offsetToLineIdx(closeEndPos - 1) + 1);
        nextPos = closeEndPos;
      } else if (lowerTag === "script" && parsed.attrs.has("src")) {
        closeStart = gtPos + 1;
        endLine = openEndLine;
        nextPos = gtPos + 1;
      } else {
        closeStart = len;
        endLine = Math.max(startLine, lines.length);
        nextPos = len;
      }
      symbols.push({
        kind: lowerTag,
        name: label,
        startLine,
        endLine,
        depth: tagDepth
      });
      const shouldRecurse = closeStart > gtPos + 1 && (lowerTag === "style" || !parsed.attrs.has("src") && isJsScriptType(parsed.attrs.get("type")));
      if (shouldRecurse) {
        const closeLineIdx = offsetToLineIdx(
          closeStart < len ? closeStart : Math.max(0, len - 1)
        );
        const innerLines = [];
        let innerBaseLineIdx;
        let hasFirstRest = false;
        if (openEndLineIdx === closeLineIdx) {
          innerBaseLineIdx = openEndLineIdx;
          const singleInner = text.slice(gtPos + 1, closeStart);
          if (singleInner.trim()) {
            innerLines.push(singleInner);
          }
        } else {
          const openLineEnd = openEndLineIdx + 1 < lineStarts.length ? lineStarts[openEndLineIdx + 1] - 1 : len;
          const firstRest = text.slice(gtPos + 1, openLineEnd);
          if (firstRest.trim()) {
            innerBaseLineIdx = openEndLineIdx;
            innerLines.push(firstRest.trimStart());
            hasFirstRest = true;
          } else {
            innerBaseLineIdx = openEndLineIdx + 1;
          }
          for (let li = openEndLineIdx + 1; li < closeLineIdx; li++) {
            innerLines.push(lines[li]);
          }
          if (closeStart < len) {
            const lastPrefix = text.slice(lineStarts[closeLineIdx], closeStart);
            if (lastPrefix.trim()) {
              innerLines.push(lastPrefix);
            }
          } else if (closeLineIdx >= openEndLineIdx + 1) {
            innerLines.push(lines[closeLineIdx]);
          }
        }
        if (innerLines.some((l) => l.trim().length > 0)) {
          const dedented = dedentBlockLines(innerLines, hasFirstRest);
          const innerSyms = lowerTag === "script" ? extractTsJsSymbols(dedented) : extractCssSymbols(dedented, true);
          for (const s of innerSyms) {
            const childStart = s.startLine + innerBaseLineIdx;
            const childEnd = Math.max(childStart, s.endLine + innerBaseLineIdx);
            symbols.push({
              kind: s.kind,
              name: s.name,
              startLine: childStart,
              endLine: childEnd,
              depth: Math.min(MAX_HTML_DEPTH, tagDepth + 1 + s.depth)
            });
          }
        }
      }
      i = nextPos;
      continue;
    }
    const isVoid = HTML_VOID_ELEMENTS.has(lowerTag);
    const isComponent = COMPONENT_LANDMARK_RE.test(rawTag);
    const isSemantic = HTML_SEMANTIC_TAGS.has(lowerTag);
    const isContainer = HTML_CONTAINER_TAGS.has(lowerTag);
    let shouldEmit = false;
    let emittedSymbol;
    if (isComponent || isSemantic || isContainer) {
      const parsed = parseHtmlAttrs(rawAttrSlice);
      const hasIdentityAttr = Boolean(parsed.attrs.get("id")?.trim()) || Boolean(parsed.attrs.get("data-testid")?.trim()) || Boolean(parsed.attrs.get("role")?.trim());
      const keepTemplate = lowerTag !== "template" || emittedCount === 0 || Boolean(parsed.vueSlot) || hasIdentityAttr;
      if (keepTemplate && (isComponent || isSemantic || isContainer && hasIdentityAttr)) {
        shouldEmit = true;
        const displayTag = isComponent ? rawTag : lowerTag;
        const kind = lowerTag === "template" ? "template" : isComponent ? "component" : "block";
        emittedSymbol = {
          kind,
          name: formatHtmlTagLabel(displayTag, lowerTag, rawAttrSlice, parsed),
          startLine,
          endLine: openEndLine,
          depth: Math.min(MAX_HTML_DEPTH, emittedCount)
        };
        symbols.push(emittedSymbol);
      }
    }
    if (!selfClosing && !isVoid) {
      pushFrame({
        lowerTag,
        startLine,
        emitted: shouldEmit,
        symbol: emittedSymbol
      });
      if (shouldEmit) emittedCount++;
    }
    i = gtPos + 1;
  }
  const eofLine = lines.length;
  while (stack.length > 0) {
    const frame = popFrame();
    if (frame.emitted && frame.symbol) {
      frame.symbol.endLine = Math.max(frame.symbol.endLine, eofLine);
    }
  }
  return symbols;
}
function extractHtmlSymbols(lines) {
  return extractTemplateSymbols(lines, "html");
}
function extractSfcSymbols(lines, mode) {
  const symbols = extractTemplateSymbols(lines, mode);
  return symbols.length > 0 ? symbols : extractTsJsSymbols(lines);
}
function extractSymbolsFromLines(filePath, lines) {
  const ext = path6.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return extractTsJsSymbols(lines);
    case ".html":
    case ".htm":
      return extractHtmlSymbols(lines);
    case ".vue":
      return extractSfcSymbols(lines, "vue");
    case ".svelte":
      return extractSfcSymbols(lines, "svelte");
    case ".css":
    case ".scss":
    case ".less":
    case ".pcss":
      return extractCssSymbols(lines);
    case ".py":
    case ".pyi":
      return extractPythonSymbols(lines);
    case ".gd":
      return extractGdScriptSymbols(lines);
    case ".go":
      return extractGoSymbols(lines);
    case ".rs":
      return extractRustSymbols(lines);
    case ".java":
    case ".kt":
    case ".kts":
    case ".cs":
    case ".swift":
    case ".c":
    case ".cc":
    case ".cpp":
    case ".h":
    case ".hpp":
      return extractCLikeSymbols(lines);
    case ".sh":
    case ".bash":
    case ".zsh":
      return extractShellSymbols(lines);
    case ".md":
    case ".mdx":
      return extractMarkdownSymbols(lines);
    case ".json":
      return extractJsonYamlSymbols(lines, true);
    case ".yaml":
    case ".yml":
      return extractJsonYamlSymbols(lines, false);
    default:
      return extractTsJsSymbols(lines);
  }
}
var MAX_OUTLINES = 40;
var MAX_SLICE_FILES = 30;
var SLICE_TRUNCATION_TIP = "\n[tip: MCP responses are hard-capped <=8.8KB inline; for >150 lines across files, use parallel read_file(StartLine, EndLine) (46KB/call, 0 remote check)]";
var OUTLINE_BATCH_TIP = "\n[tip: outlining >20 files splits the 8.8KB cap thinly; batch 10-20 files per call for fuller outlines]";
function formatSymbolLine(s) {
  const indent = "  ".repeat(s.depth);
  const span = s.endLine > s.startLine ? `L${s.startLine}-L${s.endLine}` : `L${s.startLine}`;
  return `${indent}${span} [${s.kind}] ${s.name}`;
}
function formatNestedOmissionFooter(omittedNested, compact = false) {
  return compact ? `
... (+${omittedNested} nested)` : `
... (+${omittedNested} nested symbols omitted)`;
}
function pickTopLevelOmissionFooter(omittedTop, minStart, maxEnd, hasOmittedNested, availChars, availBytes) {
  const candidates = [
    hasOmittedNested ? `
... (+${omittedTop} more top-level symbols in L${minStart}-L${maxEnd} omitted, plus nested; use batch_search or read_file)` : `
... (+${omittedTop} more top-level symbols in L${minStart}-L${maxEnd} omitted; use batch_search or read_file)`,
    `
... (+${omittedTop} more in L${minStart}-L${maxEnd} omitted)`,
    `
... (+${omittedTop} L${minStart}-L${maxEnd})`
  ];
  for (const cand of candidates) {
    if (cand.length <= availChars && Buffer.byteLength(cand, "utf8") <= availBytes) {
      return cand;
    }
  }
  return null;
}
function packOutlineToBudget(header, symbols, charBudget, byteBudget) {
  const items = symbols.map((sym) => {
    const line = formatSymbolLine(sym);
    return {
      line,
      chars: line.length + 1,
      // +1 for leading '\n'
      bytes: Buffer.byteLength(line, "utf8") + 1
    };
  });
  const headerChars = header.length;
  const headerBytes = Buffer.byteLength(header, "utf8");
  let fullChars = headerChars;
  let fullBytes = headerBytes;
  for (const item of items) {
    fullChars += item.chars;
    fullBytes += item.bytes;
  }
  if (fullChars <= charBudget && fullBytes <= byteBudget) {
    return `${header}
${items.map((it) => it.line).join("\n")}`;
  }
  const byDepth = /* @__PURE__ */ new Map();
  for (let idx = 0; idx < symbols.length; idx++) {
    const d = symbols[idx].depth;
    let list = byDepth.get(d);
    if (!list) {
      list = [];
      byDepth.set(d, list);
    }
    list.push(idx);
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const topDepth = depths[0] ?? 0;
  const topIndices = byDepth.get(topDepth) ?? [];
  const nestedTotalCount = symbols.length - topIndices.length;
  let topChars = headerChars;
  let topBytes = headerBytes;
  for (const idx of topIndices) {
    topChars += items[idx].chars;
    topBytes += items[idx].bytes;
  }
  if (nestedTotalCount > 0) {
    const fullNestedFooterLen = formatNestedOmissionFooter(nestedTotalCount, false).length;
    const compactNestedFooterLen = formatNestedOmissionFooter(nestedTotalCount, true).length;
    const fitsFullNested = topChars + fullNestedFooterLen <= charBudget && topBytes + fullNestedFooterLen <= byteBudget;
    const fitsCompactNested = !fitsFullNested && topChars + compactNestedFooterLen <= charBudget && topBytes + compactNestedFooterLen <= byteBudget;
    if (fitsFullNested || fitsCompactNested) {
      const useCompact = !fitsFullNested;
      const selected = new Set(topIndices);
      let usedChars = topChars;
      let usedBytes = topBytes;
      let omittedNested = nestedTotalCount;
      let stopped = false;
      for (const d of depths) {
        if (d === topDepth) continue;
        if (stopped) break;
        const indices = byDepth.get(d);
        for (const idx of indices) {
          const item = items[idx];
          const nextOmitted = omittedNested - 1;
          const nextFooterLen = nextOmitted > 0 ? formatNestedOmissionFooter(nextOmitted, useCompact).length : 0;
          if (usedChars + item.chars + nextFooterLen <= charBudget && usedBytes + item.bytes + nextFooterLen <= byteBudget) {
            selected.add(idx);
            usedChars += item.chars;
            usedBytes += item.bytes;
            omittedNested = nextOmitted;
          } else {
            stopped = true;
            break;
          }
        }
      }
      const ordered = [...selected].sort((a, b) => a - b);
      const footer = omittedNested > 0 ? formatNestedOmissionFooter(omittedNested, useCompact) : "";
      if (ordered.length === 0) {
        return `${header}${footer}`;
      }
      return `${header}
${ordered.map((idx) => items[idx].line).join("\n")}${footer}`;
    }
  }
  const m = topIndices.length;
  const suffixMinStart = new Array(m);
  const suffixMaxEnd = new Array(m);
  for (let k = m - 1; k >= 0; k--) {
    const sym = symbols[topIndices[k]];
    if (k === m - 1) {
      suffixMinStart[k] = sym.startLine;
      suffixMaxEnd[k] = sym.endLine;
    } else {
      suffixMinStart[k] = Math.min(sym.startLine, suffixMinStart[k + 1]);
      suffixMaxEnd[k] = Math.max(sym.endLine, suffixMaxEnd[k + 1]);
    }
  }
  const tryPackPrefixWithTier = (tier) => {
    let usedChars = headerChars;
    let usedBytes = headerBytes;
    let pickedCount = 0;
    let chosenFooter = "";
    for (let k = 0; k < m; k++) {
      const nextOmitted = m - (k + 1);
      const item = items[topIndices[k]];
      if (nextOmitted === 0) {
        if (usedChars + item.chars <= charBudget && usedBytes + item.bytes <= byteBudget) {
          pickedCount = k + 1;
          chosenFooter = "";
        }
        break;
      }
      const remChars = charBudget - (usedChars + item.chars);
      const remBytes = byteBudget - (usedBytes + item.bytes);
      const candFooter = tier === "full" ? (() => {
        const full = nestedTotalCount > 0 ? `
... (+${nextOmitted} more top-level symbols in L${suffixMinStart[k + 1]}-L${suffixMaxEnd[k + 1]} omitted, plus nested; use batch_search or read_file)` : `
... (+${nextOmitted} more top-level symbols in L${suffixMinStart[k + 1]}-L${suffixMaxEnd[k + 1]} omitted; use batch_search or read_file)`;
        return full.length <= remChars && Buffer.byteLength(full, "utf8") <= remBytes ? full : null;
      })() : pickTopLevelOmissionFooter(
        nextOmitted,
        suffixMinStart[k + 1],
        suffixMaxEnd[k + 1],
        nestedTotalCount > 0,
        remChars,
        remBytes
      );
      if (candFooter !== null) {
        usedChars += item.chars;
        usedBytes += item.bytes;
        pickedCount = k + 1;
        chosenFooter = candFooter;
      } else {
        break;
      }
    }
    return { pickedCount, footer: chosenFooter };
  };
  let packed = tryPackPrefixWithTier("full");
  if (packed.pickedCount === 0) {
    packed = tryPackPrefixWithTier("compact");
  }
  if (packed.pickedCount > 0) {
    const pickedLines = topIndices.slice(0, packed.pickedCount).map((idx) => items[idx].line);
    return `${header}
${pickedLines.join("\n")}${packed.footer}`;
  }
  const fallbackFooter = m > 0 ? pickTopLevelOmissionFooter(
    m,
    suffixMinStart[0],
    suffixMaxEnd[0],
    nestedTotalCount > 0,
    charBudget - headerChars,
    byteBudget - headerBytes
  ) : null;
  return fallbackFooter ? `${header}${fallbackFooter}` : header;
}
async function runReadSlices(input) {
  const corruptedItems = [];
  let outlines = [];
  if (input?.outlines !== void 0) {
    const parsedOutlines = parseMaybeJsonArray(input.outlines);
    if (!parsedOutlines.ok) {
      corruptedItems.push({
        label: "outlines",
        value: input.outlines,
        expected: "an array of file path strings"
      });
    } else {
      for (let i = 0; i < parsedOutlines.value.length; i++) {
        const item = parsedOutlines.value[i];
        if (typeof item !== "string" || !item.trim()) {
          corruptedItems.push({
            label: `outlines[${i}]`,
            value: item,
            expected: "a non-empty file path string"
          });
        }
      }
      if (corruptedItems.length === 0) {
        outlines = parsedOutlines.value;
      }
    }
  }
  let slices = [];
  let sliceFormatError = null;
  const parseSliceShorthand = (raw, label) => {
    const trimmed = raw.trim();
    const match = /^(.+):(\d+(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*)$/.exec(trimmed);
    if (!match || !match[1].trim()) {
      if (sliceFormatError === null) {
        sliceFormatError = `Error: ${label} must use 'path:start-end' or 'path:start1-end1,start2-end2' format (got ${JSON.stringify(raw)}).`;
      }
      return null;
    }
    const filePath = match[1].trim();
    const ranges = match[2].split(",").map((part) => {
      const seg = part.trim();
      const dash = seg.indexOf("-");
      if (dash === -1) {
        const n = Number(seg);
        return [n, n];
      }
      return [Number(seg.slice(0, dash)), Number(seg.slice(dash + 1))];
    });
    return { path: filePath, ranges };
  };
  if (input?.slices !== void 0) {
    const parsedSlices = parseMaybeJsonArray(input.slices);
    if (!parsedSlices.ok) {
      corruptedItems.push({
        label: "slices",
        value: input.slices,
        expected: "an array of slice objects ({ path, ranges }) or 'path:start-end' strings"
      });
    } else {
      const normalizedSlices = [];
      for (let i = 0; i < parsedSlices.value.length; i++) {
        const item = parsedSlices.value[i];
        if (typeof item === "string") {
          const parsed = parseSliceShorthand(item, `slices[${i}]`);
          if (parsed) normalizedSlices.push(parsed);
          continue;
        }
        if (!isPlainObject(item)) {
          corruptedItems.push({
            label: `slices[${i}]`,
            value: item,
            expected: "a slice object ({ path, ranges }) or 'path:start-end' string"
          });
          continue;
        }
        if (item.ranges !== void 0 && !Array.isArray(item.ranges)) {
          corruptedItems.push({
            label: `slices[${i}].ranges`,
            value: item.ranges,
            expected: "an array of [startLine, endLine] pairs"
          });
        } else if (Array.isArray(item.ranges)) {
          for (let j = 0; j < item.ranges.length; j++) {
            const r = item.ranges[j];
            if (typeof r === "boolean" || r === null) {
              corruptedItems.push({
                label: `slices[${i}].ranges[${j}]`,
                value: r,
                expected: "a [startLine, endLine] pair"
              });
            }
          }
        }
        normalizedSlices.push(item);
      }
      if (corruptedItems.length === 0) {
        slices.push(...normalizedSlices);
      }
    }
  }
  if (input?.lineRanges !== void 0) {
    const parsedSpecs = parseMaybeJsonArray(input.lineRanges);
    if (!parsedSpecs.ok) {
      corruptedItems.push({
        label: "lineRanges",
        value: input.lineRanges,
        expected: "an array of 'path:start-end' strings"
      });
    } else {
      const normalizedSpecs = [];
      for (let i = 0; i < parsedSpecs.value.length; i++) {
        const item = parsedSpecs.value[i];
        if (item === null || typeof item === "boolean") {
          corruptedItems.push({
            label: `lineRanges[${i}]`,
            value: item,
            expected: "a 'path:start-end' string"
          });
        } else if (typeof item !== "string" || !item.trim()) {
          if (sliceFormatError === null) {
            sliceFormatError = `Error: lineRanges[${i}] must be a non-empty 'path:start-end' string.`;
          }
        } else {
          const parsed = parseSliceShorthand(item, `lineRanges[${i}]`);
          if (parsed) normalizedSpecs.push(parsed);
        }
      }
      if (corruptedItems.length === 0) {
        slices.push(...normalizedSpecs);
      }
    }
  }
  if (corruptedItems.length > 0) {
    return {
      text: formatCorruptedArrayError({
        header: "Validation failed",
        toolName: "read_slices",
        items: corruptedItems,
        fallbackAdvice: "immediately fall back to parallel built-in read_file(StartLine, EndLine) calls."
      }),
      isError: true
    };
  }
  if (sliceFormatError !== null) {
    return { text: sliceFormatError, isError: true };
  }
  if (outlines.length === 0 && slices.length === 0) {
    return {
      text: "Error: provide at least one entry in 'outlines', 'slices', or 'lineRanges'.",
      isError: true
    };
  }
  if (outlines.length > MAX_OUTLINES || slices.length > MAX_SLICE_FILES) {
    return {
      text: `Error: limits exceeded (max ${MAX_OUTLINES} outlines and ${MAX_SLICE_FILES} slice files per call).`,
      isError: true
    };
  }
  const baseCwd = resolvePath(input.cwd || process.cwd());
  const rawMaxChars = Number(input.maxChars ?? 8500);
  const maxChars = Number.isFinite(rawMaxChars) ? Math.max(1e3, Math.min(DEFAULT_INLINE_MAX_BYTES, Math.trunc(rawMaxChars))) : 8500;
  const maxBytes = DEFAULT_INLINE_MAX_BYTES;
  const fileCache = /* @__PURE__ */ new Map();
  async function loadLines(absPath) {
    const cached = fileCache.get(absPath);
    if (cached) return cached;
    const data = await readTextFile(absPath);
    const lines = data.content.replace(/\r\n/g, "\n").split("\n");
    const entry = { lines, size: data.size };
    fileCache.set(absPath, entry);
    return entry;
  }
  const sectionEntries = [];
  if (outlines.length > 0) {
    const outlineResults = await Promise.all(
      outlines.map(async (rawPath) => {
        const absPath = resolvePath(rawPath, baseCwd);
        const relPath = toPosixPath(path6.relative(baseCwd, absPath)) || path6.basename(absPath);
        try {
          const { lines } = await loadLines(absPath);
          const symbols = extractSymbolsFromLines(absPath, lines);
          const header = `## Outline: ${relPath} (${lines.length} lines)`;
          if (symbols.length === 0) {
            return {
              kind: "static",
              fullText: `${header}
(no top-level symbols detected)`
            };
          }
          const formatted = symbols.map(formatSymbolLine);
          return {
            kind: "outline",
            header,
            symbols,
            fullText: `${header}
${formatted.join("\n")}`
          };
        } catch (err) {
          return {
            kind: "static",
            fullText: `## Outline: ${relPath}
ERROR: ${err instanceof Error ? err.message : String(err)}`
          };
        }
      })
    );
    sectionEntries.push(...outlineResults);
  }
  if (slices.length > 0) {
    const sliceResults = await Promise.all(
      slices.map(async (req) => {
        if (!req || typeof req.path !== "string" || !req.path.trim()) {
          return {
            kind: "static",
            fullText: "## Slice: (invalid)\nERROR: 'path' must be a non-empty string"
          };
        }
        const absPath = resolvePath(req.path, baseCwd);
        const relPath = toPosixPath(path6.relative(baseCwd, absPath)) || path6.basename(absPath);
        if (!Array.isArray(req.ranges) || req.ranges.length === 0) {
          return {
            kind: "static",
            fullText: `## Slice: ${relPath}
ERROR: 'ranges' must be a non-empty array of [startLine, endLine] pairs`
          };
        }
        try {
          const { lines } = await loadLines(absPath);
          const totalLines = lines.length;
          const blocks = [];
          for (const range of req.ranges) {
            if (!Array.isArray(range) || range.length < 2) {
              blocks.push("ERROR: each range must be [startLine, endLine]");
              continue;
            }
            const rawStart = Math.trunc(Number(range[0]));
            const rawEnd = Math.trunc(Number(range[1]));
            if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
              blocks.push(`ERROR: invalid range [${String(range[0])}, ${String(range[1])}]`);
              continue;
            }
            const start = Math.max(1, rawStart);
            const end = Math.min(totalLines, rawEnd);
            if (start > totalLines) {
              blocks.push(
                `--- L${rawStart}-L${rawEnd} (out of bounds; file has ${totalLines} lines) ---`
              );
              continue;
            }
            if (end < start) {
              blocks.push(
                `ERROR: startLine (${rawStart}) > endLine (${rawEnd})`
              );
              continue;
            }
            const width = String(end).length;
            const snippet = [`--- L${start}-L${end} (of ${totalLines}) ---`];
            for (let ln = start; ln <= end; ln++) {
              const num = String(ln).padStart(width, " ");
              snippet.push(`${num}: ${lines[ln - 1] ?? ""}`);
            }
            blocks.push(snippet.join("\n"));
          }
          return {
            kind: "static",
            fullText: `## Slice: ${relPath} (${totalLines} lines)
${blocks.join("\n")}`
          };
        } catch (err) {
          return {
            kind: "static",
            fullText: `## Slice: ${relPath}
ERROR: ${err instanceof Error ? err.message : String(err)}`
          };
        }
      })
    );
    sectionEntries.push(...sliceResults);
  }
  const separator = "\n\n";
  const sepChars = separator.length * Math.max(0, sectionEntries.length - 1);
  const sepBytes = Buffer.byteLength(separator, "utf8") * Math.max(0, sectionEntries.length - 1);
  const charSizes = sectionEntries.map((s) => s.fullText.length);
  const byteSizes = sectionEntries.map(
    (s) => Buffer.byteLength(s.fullText, "utf8")
  );
  const rawChars = charSizes.reduce((sum, n) => sum + n, 0) + sepChars;
  const rawBytes = byteSizes.reduce((sum, n) => sum + n, 0) + sepBytes;
  const isOverBudget = rawChars > maxChars || rawBytes > maxBytes;
  if (!isOverBudget) {
    return {
      text: sectionEntries.map((s) => s.fullText).join(separator),
      isError: false
    };
  }
  const activeTip = slices.length > 0 ? SLICE_TRUNCATION_TIP : outlines.length > 20 ? OUTLINE_BATCH_TIP : null;
  const applyTip = activeTip !== null && maxChars > activeTip.length + 200;
  const tipChars = applyTip ? activeTip.length : 0;
  const tipBytes = applyTip ? Buffer.byteLength(activeTip, "utf8") : 0;
  const bodyMaxChars = maxChars - tipChars;
  const bodyMaxBytes = maxBytes - tipBytes;
  const availChars = Math.max(0, bodyMaxChars - sepChars);
  const availBytes = Math.max(0, bodyMaxBytes - sepBytes);
  const charBudgets = computeWaterFillBudgets(charSizes, availChars);
  const byteBudgets = computeWaterFillBudgets(byteSizes, availBytes);
  const sections = sectionEntries.map((entry, idx) => {
    if (entry.kind === "outline" && (charSizes[idx] > charBudgets[idx] || byteSizes[idx] > byteBudgets[idx])) {
      return packOutlineToBudget(
        entry.header,
        entry.symbols,
        charBudgets[idx],
        byteBudgets[idx]
      );
    }
    return entry.fullText;
  });
  const body = fitSectionsToByteBudget(
    sections,
    bodyMaxChars,
    bodyMaxBytes,
    separator
  );
  return {
    text: applyTip ? `${body}${activeTip}` : body,
    isError: false
  };
}
async function runQuickOutline(input) {
  const rawInput = input;
  const rawPaths = rawInput?.paths !== void 0 ? rawInput.paths : rawInput?.outlines !== void 0 ? rawInput.outlines : rawInput?.files;
  if (rawPaths === void 0) {
    return {
      text: "Error: provide at least one file path in 'paths'.",
      isError: true
    };
  }
  const parsedPaths = parseMaybeJsonArray(rawPaths);
  const corruptedItems = [];
  let firstInvalidError = null;
  if (!parsedPaths.ok) {
    if (parsedPaths.kind === "corrupted_literal" || rawPaths === null || typeof rawPaths === "boolean") {
      corruptedItems.push({
        label: "paths",
        value: parsedPaths.kind === "corrupted_literal" ? parsedPaths.value : rawPaths,
        expected: "an array of file path strings"
      });
    } else {
      firstInvalidError = `Error: 'paths' must be an array of non-empty file path strings (${parsedPaths.detail}).`;
    }
  } else {
    for (let i = 0; i < parsedPaths.value.length; i++) {
      const item = parsedPaths.value[i];
      if (item === null || typeof item === "boolean") {
        corruptedItems.push({
          label: `paths[${i}]`,
          value: item,
          expected: "a non-empty file path string"
        });
      } else if (typeof item !== "string" || !item.trim()) {
        if (firstInvalidError === null) {
          firstInvalidError = `Error: paths[${i}] must be a non-empty file path string.`;
        }
      }
    }
  }
  if (corruptedItems.length > 0) {
    return {
      text: formatCorruptedArrayError({
        header: "Validation failed",
        toolName: "quick_outline",
        items: corruptedItems,
        fallbackAdvice: "immediately fall back to parallel built-in read_file(StartLine, EndLine) calls."
      }),
      isError: true
    };
  }
  if (firstInvalidError !== null) {
    return { text: firstInvalidError, isError: true };
  }
  const paths = parsedPaths.value;
  if (paths.length === 0) {
    return {
      text: "Error: provide at least one file path in 'paths'.",
      isError: true
    };
  }
  if (paths.length > MAX_OUTLINES) {
    return {
      text: `Error: limit exceeded (max ${MAX_OUTLINES} paths per call).`,
      isError: true
    };
  }
  return runReadSlices({
    cwd: input?.cwd,
    outlines: paths,
    maxChars: input?.maxChars
  });
}

// src/tools/run-checks.ts
import { promises as fs5 } from "node:fs";
import { performance } from "node:perf_hooks";
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIdx = 0;
  async function runWorker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]);
    }
  }
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}
async function runChecks(input, budgetMs = MCP_CALL_BUDGET_SEC * 1e3) {
  const parsedCommands = parseMaybeJsonArray(input?.commands);
  if (!parsedCommands.ok) {
    if (parsedCommands.kind === "corrupted_literal" || parsedCommands.kind === "wrong_type" && (typeof input?.commands === "boolean" || input?.commands === null)) {
      return {
        text: formatCorruptedArrayError({
          header: "Validation failed",
          toolName: "run_checks",
          items: [
            {
              label: "commands",
              value: parsedCommands.kind === "corrupted_literal" ? parsedCommands.value : input.commands,
              expected: "an array of command specs"
            }
          ],
          fallbackAdvice: "immediately fall back to a single compound run_command call."
        }),
        isError: true
      };
    }
    return {
      text: "Error: 'commands' must be a non-empty array of check commands.",
      isError: true
    };
  }
  const rawCommands = parsedCommands.value;
  if (rawCommands.length === 0) {
    return {
      text: "Error: 'commands' must be a non-empty array of check commands.",
      isError: true
    };
  }
  if (rawCommands.length > 12) {
    return {
      text: "Error: 'commands' supports at most 12 commands per call.",
      isError: true
    };
  }
  const corruptedCommands = [];
  for (let i = 0; i < rawCommands.length; i++) {
    const raw = rawCommands[i];
    if (typeof raw !== "string" && !isPlainObject(raw)) {
      corruptedCommands.push({
        label: `commands[${i}]`,
        value: raw,
        expected: "a command string or object ({ name?, command, cwd?, timeoutSec? })"
      });
    }
  }
  if (corruptedCommands.length > 0) {
    return {
      text: formatCorruptedArrayError({
        header: "Validation failed",
        toolName: "run_checks",
        items: corruptedCommands,
        fallbackAdvice: "immediately fall back to a single compound run_command call."
      }),
      isError: true
    };
  }
  const baseCwd = resolvePath(input.cwd || process.cwd());
  try {
    const st = await fs5.stat(baseCwd);
    if (!st.isDirectory()) {
      return { text: `Error: cwd is not a directory: ${baseCwd}`, isError: true };
    }
  } catch {
    return { text: `Error: cwd does not exist: ${baseCwd}`, isError: true };
  }
  const concurrency = clampInt2(input.concurrency, 1, 8, 4);
  const defaultTimeoutSec = clampInt2(input.timeoutSec, 1, MCP_CALL_BUDGET_SEC, 60);
  const outputMode = input.outputMode === "full" ? "full" : "compact";
  const maxChars = clampInt2(input.maxChars, 500, DEFAULT_INLINE_MAX_BYTES, 8e3);
  const maxBytes = DEFAULT_INLINE_MAX_BYTES;
  const normalized = [];
  for (let i = 0; i < rawCommands.length; i++) {
    const raw = rawCommands[i];
    const spec = typeof raw === "string" ? { command: raw } : raw;
    if (!spec || typeof spec.command !== "string" || !spec.command.trim()) {
      return {
        text: `Error: commands[${i}] must contain a non-empty 'command' string.`,
        isError: true
      };
    }
    if (spec.cwd !== void 0 && spec.cwd !== null && typeof spec.cwd !== "string") {
      return {
        text: `Error: commands[${i}].cwd must be a string path.`,
        isError: true
      };
    }
    const trimmedSpecCwd = spec.cwd?.trim() || "";
    const cmdCwd = trimmedSpecCwd ? resolvePath(trimmedSpecCwd, baseCwd) : baseCwd;
    if (trimmedSpecCwd) {
      try {
        const st = await fs5.stat(cmdCwd);
        if (!st.isDirectory()) {
          return {
            text: `Error: commands[${i}].cwd is not a directory: ${cmdCwd}`,
            isError: true
          };
        }
      } catch {
        return {
          text: `Error: commands[${i}].cwd does not exist: ${cmdCwd}`,
          isError: true
        };
      }
    }
    const cmdTimeoutSec = clampInt2(
      spec.timeoutSec,
      1,
      MCP_CALL_BUDGET_SEC,
      defaultTimeoutSec
    );
    normalized.push({
      index: i,
      name: spec.name?.trim() || `check-${i + 1}`,
      command: spec.command.trim(),
      cwd: cmdCwd,
      timeoutMs: cmdTimeoutSec * 1e3
    });
  }
  const safeBudgetMs = Number.isFinite(budgetMs) && budgetMs > 0 ? Math.max(100, Math.trunc(budgetMs)) : MCP_CALL_BUDGET_SEC * 1e3;
  const wallStart = performance.now();
  const deadline = wallStart + safeBudgetMs;
  const outcomes = await mapWithConcurrency(
    normalized,
    concurrency,
    async (spec) => {
      const remainingMs = deadline - performance.now();
      if (remainingMs < 100) return { spec, result: null, passed: false };
      const result = await runShellCommandAsync(spec.command, {
        cwd: spec.cwd,
        timeoutMs: Math.min(spec.timeoutMs, remainingMs)
      });
      const passed = !result.error && !result.timedOut && result.exitCode === 0;
      return { spec, result, passed };
    }
  );
  const wallMs = Math.round(performance.now() - wallStart);
  const passedCount = outcomes.filter((o) => o.passed).length;
  const notRunCount = outcomes.filter((o) => !o.result).length;
  const failedCount = outcomes.length - passedCount - notRunCount;
  const counts = [`${passedCount}/${outcomes.length} passed`];
  if (failedCount > 0) counts.push(`${failedCount} failed`);
  if (notRunCount > 0) {
    counts.push(
      `${notRunCount} not run (call time budget of ${Math.round(safeBudgetMs / 1e3)}s used up; run them in another call)`
    );
  }
  const summaryHeader = `Checks: ${counts.join(", ")} (wall: ${wallMs}ms)`;
  const separator = "\n\n";
  const bodyBudget = Math.max(0, maxChars - summaryHeader.length - separator.length);
  const bodyByteBudget = maxBytes !== void 0 ? Math.max(
    0,
    maxBytes - Buffer.byteLength(summaryHeader, "utf8") - Buffer.byteLength(separator, "utf8")
  ) : bodyBudget;
  const totalSepChars = separator.length * Math.max(0, outcomes.length - 1);
  const totalSepBytes = Buffer.byteLength(separator, "utf8") * Math.max(0, outcomes.length - 1);
  const availChars = Math.max(0, bodyBudget - totalSepChars);
  const availBytes = Math.max(0, bodyByteBudget - totalSepBytes);
  const capCmdDisplay = (cmd, maxCmdChars, maxCmdBytes) => {
    if (cmd.length <= maxCmdChars && Buffer.byteLength(cmd, "utf8") <= maxCmdBytes) {
      return cmd;
    }
    const charCap = Math.max(8, maxCmdChars - 3);
    const byteCap = Math.max(8, maxCmdBytes - 3);
    return `${sliceUtf8Bytes(sliceSafeChars(cmd, charCap), byteCap)}...`;
  };
  const formatNotRunBlock = (spec) => {
    const baseHeader = `## [NOT RUN] ${spec.name}`;
    const notRunBudgetTotal = failedCount > 0 ? Math.min(availChars, Math.floor(availChars * 0.35)) : availChars;
    const perNotRunShare = Math.floor(
      notRunBudgetTotal / Math.max(1, notRunCount)
    );
    const cmdRoom = perNotRunShare - baseHeader.length - 3;
    if (cmdRoom < 16) {
      return baseHeader.length <= perNotRunShare || perNotRunShare < 16 ? baseHeader : `${sliceSafeChars(baseHeader, perNotRunShare - 3)}...`;
    }
    const perNotRunCap = Math.min(180, cmdRoom);
    const shortCmd = capCmdDisplay(spec.command, perNotRunCap, perNotRunCap);
    return `${baseHeader}
$ ${shortCmd}`;
  };
  const formatCmdHeaderPrefix = (headerLine, cmd, blockCharShare, blockByteShare) => {
    const fullPrefix = `${headerLine}
$ ${cmd}
`;
    const headerLineBytes = Buffer.byteLength(headerLine, "utf8");
    const fullPrefixBytes = Buffer.byteLength(fullPrefix, "utf8");
    const maxPrefixChars = Math.max(
      headerLine.length + 24,
      Math.floor(blockCharShare * 0.35)
    );
    const maxPrefixBytes = Math.max(
      headerLineBytes + 24,
      Math.floor(blockByteShare * 0.35)
    );
    if (fullPrefix.length <= maxPrefixChars && fullPrefixBytes <= maxPrefixBytes) {
      return fullPrefix;
    }
    const remChars = blockCharShare - headerLine.length - 1;
    const remBytes = blockByteShare - headerLineBytes - 1;
    if (remChars < 48 || remBytes < 48) {
      return `${headerLine}
`;
    }
    const maxCmdChars = Math.max(20, maxPrefixChars - headerLine.length - 4);
    const maxCmdBytes = Math.max(20, maxPrefixBytes - headerLineBytes - 4);
    const displayCmd = capCmdDisplay(cmd, maxCmdChars, maxCmdBytes);
    return `${headerLine}
$ ${displayCmd}
`;
  };
  let blocks;
  if (outputMode === "full") {
    const rawEntries = outcomes.map(({ spec, result, passed }) => {
      if (!result) {
        const block = formatNotRunBlock(spec);
        return {
          notRun: true,
          block,
          charSize: block.length,
          byteSize: Buffer.byteLength(block, "utf8")
        };
      }
      const badge = result.error ? "ERROR" : result.timedOut ? "TIMEOUT" : passed ? "PASS" : `FAIL (${formatExitFailureLabel(result.exitCode, result.signal)})`;
      const headerLine = `## [${badge}] ${spec.name} (${result.durationMs}ms)`;
      const fullPrefix = `${headerLine}
$ ${spec.command}
`;
      const combined = [
        normalizeTerminalOutput(result.stdout),
        normalizeTerminalOutput(result.stderr)
      ].filter(Boolean).join("\n");
      const rawBody = result.error ? `spawn error: ${result.error}` : combined || "(no output)";
      const fullBlock = `${fullPrefix}${rawBody}`;
      return {
        notRun: false,
        spec,
        headerLine,
        fullPrefix,
        rawBody,
        fullBlock,
        charSize: fullBlock.length,
        byteSize: Buffer.byteLength(fullBlock, "utf8")
      };
    });
    const fullCharBudgets = computeWaterFillBudgets(
      rawEntries.map((e) => e.charSize),
      availChars
    );
    const fullByteBudgets = computeWaterFillBudgets(
      rawEntries.map((e) => e.byteSize),
      availBytes
    );
    blocks = rawEntries.map((entry, idx) => {
      if (entry.notRun) return entry.block;
      const charShare = fullCharBudgets[idx] ?? 0;
      const byteShare = fullByteBudgets[idx] ?? 0;
      if (entry.charSize <= charShare && entry.byteSize <= byteShare) {
        return entry.fullBlock;
      }
      const prefix = formatCmdHeaderPrefix(
        entry.headerLine,
        entry.spec.command,
        charShare,
        byteShare
      );
      const allowedChars = Math.max(0, charShare - prefix.length);
      const allowedBytes = Math.max(
        0,
        byteShare - Buffer.byteLength(prefix, "utf8")
      );
      let body = entry.rawBody;
      if (Buffer.byteLength(body, "utf8") > allowedBytes) {
        body = truncateHeadTailWithByteNotice(body, allowedBytes);
      }
      if (body.length > allowedChars) {
        body = truncateHeadTailWithNotice(body, allowedChars);
      }
      return `${prefix}${body}`;
    });
  } else {
    blocks = new Array(outcomes.length);
    const passEntries = [];
    const failEntries = [];
    let notRunChars = 0;
    let notRunBytes = 0;
    let passChars = 0;
    let passBytes = 0;
    for (let i = 0; i < outcomes.length; i++) {
      const { spec, result, passed } = outcomes[i];
      if (!result) {
        const block = formatNotRunBlock(spec);
        blocks[i] = block;
        notRunChars += block.length;
        notRunBytes += Buffer.byteLength(block, "utf8");
        continue;
      }
      if (passed) {
        const body = formatCompactCommandOutput({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          error: result.error,
          maxChars: 300
        });
        const compactHeader = `- [PASS ${result.durationMs}ms] ${spec.name}`;
        const fullBlock = `${compactHeader} (\`${spec.command}\`): ${body}`;
        blocks[i] = fullBlock;
        passChars += fullBlock.length;
        passBytes += Buffer.byteLength(fullBlock, "utf8");
        passEntries.push({ index: i, compactHeader, body, fullBlock });
        continue;
      }
      const badge = result.error ? "ERROR" : result.timedOut ? "TIMEOUT" : `FAIL (${formatExitFailureLabel(result.exitCode, result.signal)})`;
      const badgeLine = `## [${badge} ${result.durationMs}ms] ${spec.name}`;
      const header = `${badgeLine}
$ ${spec.command}
`;
      const prepared = prepareCompactCommandOutput({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        error: result.error
      });
      const pass1Ceiling = Math.max(
        bodyBudget,
        prepared.bodyText.length + 256
      );
      const pass1Body = renderPreparedCompactCommandOutput(
        prepared,
        pass1Ceiling
      ).text;
      failEntries.push({
        index: i,
        spec,
        badgeLine,
        header,
        prepared,
        pass1Body,
        pass1Block: `${header}${pass1Body}`
      });
    }
    if (failEntries.length > 0) {
      const availAfterNotRunChars = Math.max(0, availChars - notRunChars);
      const availAfterNotRunBytes = Math.max(0, availBytes - notRunBytes);
      const rawFailPoolChars = Math.max(0, availAfterNotRunChars - passChars);
      const rawFailPoolBytes = Math.max(0, availAfterNotRunBytes - passBytes);
      if (passEntries.length > 0) {
        const totalFailDemandChars = failEntries.reduce(
          (sum, f) => sum + f.pass1Block.length,
          0
        );
        const totalFailDemandBytes = failEntries.reduce(
          (sum, f) => sum + Buffer.byteLength(f.pass1Block, "utf8"),
          0
        );
        const maxFailCeilingChars = Math.floor(availAfterNotRunChars * 0.85);
        const maxFailCeilingBytes = Math.floor(availAfterNotRunBytes * 0.85);
        const failFloorChars = Math.min(
          maxFailCeilingChars,
          Math.max(
            failEntries.reduce(
              (sum, f) => sum + Math.min(f.header.length, 120) + Math.min(f.pass1Body.length, 160),
              0
            ),
            Math.floor(availAfterNotRunChars * 0.6)
          )
        );
        const failFloorBytes = Math.min(
          maxFailCeilingBytes,
          Math.max(
            failEntries.reduce(
              (sum, f) => sum + Math.min(Buffer.byteLength(f.header, "utf8"), 120) + Math.min(Buffer.byteLength(f.pass1Body, "utf8"), 160),
              0
            ),
            Math.floor(availAfterNotRunBytes * 0.6)
          )
        );
        const desiredFailChars = Math.min(totalFailDemandChars, failFloorChars);
        const desiredFailBytes = Math.min(totalFailDemandBytes, failFloorBytes);
        if (rawFailPoolChars < desiredFailChars || rawFailPoolBytes < desiredFailBytes) {
          const passPoolChars = Math.max(
            0,
            availAfterNotRunChars - Math.max(rawFailPoolChars, desiredFailChars)
          );
          const passPoolBytes = Math.max(
            0,
            availAfterNotRunBytes - Math.max(rawFailPoolBytes, desiredFailBytes)
          );
          const passCharShares = computeWaterFillBudgets(
            passEntries.map((p) => p.fullBlock.length),
            passPoolChars
          );
          const passByteShares = computeWaterFillBudgets(
            passEntries.map((p) => Buffer.byteLength(p.fullBlock, "utf8")),
            passPoolBytes
          );
          passChars = 0;
          passBytes = 0;
          for (let pIdx = 0; pIdx < passEntries.length; pIdx++) {
            const p = passEntries[pIdx];
            const shareChars = passCharShares[pIdx] ?? 0;
            const shareBytes = passByteShares[pIdx] ?? 0;
            let shrunk = p.fullBlock;
            if (shrunk.length > shareChars || Buffer.byteLength(shrunk, "utf8") > shareBytes) {
              const noCmd = `${p.compactHeader}: ${p.body}`;
              if (noCmd.length <= shareChars && Buffer.byteLength(noCmd, "utf8") <= shareBytes) {
                shrunk = noCmd;
              } else {
                const hdrBytes = Buffer.byteLength(p.compactHeader, "utf8");
                const bodyCharsAvail = shareChars - p.compactHeader.length - 2;
                const bodyBytesAvail = shareBytes - hdrBytes - 2;
                if (bodyCharsAvail >= 8 && bodyBytesAvail >= 8) {
                  const trimmedBody = sliceUtf8Bytes(
                    sliceSafeChars(p.body, bodyCharsAvail - 3),
                    bodyBytesAvail - 3
                  );
                  shrunk = `${p.compactHeader}: ${trimmedBody}...`;
                } else if (p.compactHeader.length <= shareChars && hdrBytes <= shareBytes) {
                  shrunk = p.compactHeader;
                } else {
                  shrunk = sliceUtf8Bytes(
                    sliceSafeChars(p.compactHeader, shareChars),
                    shareBytes
                  );
                }
              }
            }
            blocks[p.index] = shrunk;
            passChars += shrunk.length;
            passBytes += Buffer.byteLength(shrunk, "utf8");
          }
        }
      }
      const failPoolChars = Math.max(0, availAfterNotRunChars - passChars);
      const failPoolBytes = Math.max(0, availAfterNotRunBytes - passBytes);
      const charBlockBudgets = computeWaterFillBudgets(
        failEntries.map((entry) => entry.pass1Block.length),
        failPoolChars
      );
      const byteBlockBudgets = computeWaterFillBudgets(
        failEntries.map((entry) => Buffer.byteLength(entry.pass1Block, "utf8")),
        failPoolBytes
      );
      for (let j = 0; j < failEntries.length; j++) {
        const entry = failEntries[j];
        const blockCharBudget = charBlockBudgets[j] ?? 0;
        const blockByteBudget = byteBlockBudgets[j] ?? 0;
        const pass1BodyBytes = Buffer.byteLength(entry.pass1Body, "utf8");
        const effectiveHeader = formatCmdHeaderPrefix(
          entry.badgeLine,
          entry.spec.command,
          blockCharBudget,
          blockByteBudget
        );
        const headerChars = effectiveHeader.length;
        const headerBytes = Buffer.byteLength(effectiveHeader, "utf8");
        const allowedBodyChars = Math.max(0, blockCharBudget - headerChars);
        const allowedBodyBytes = Math.max(0, blockByteBudget - headerBytes);
        if (entry.pass1Body.length <= allowedBodyChars && pass1BodyBytes <= allowedBodyBytes) {
          blocks[entry.index] = `${effectiveHeader}${entry.pass1Body}`;
          continue;
        }
        const bytesPerChar = pass1BodyBytes / Math.max(1, entry.pass1Body.length);
        let targetChars = Math.min(
          allowedBodyChars,
          Math.floor(allowedBodyBytes / Math.max(1, bytesPerChar))
        );
        let compactedBody = targetChars > 0 ? renderPreparedCompactCommandOutput(entry.prepared, targetChars).text : "";
        for (let iter = 0; iter < 4 && targetChars > 1; iter++) {
          const curBytes = Buffer.byteLength(compactedBody, "utf8");
          if (curBytes <= allowedBodyBytes) break;
          const basisChars = Math.min(targetChars, compactedBody.length);
          if (basisChars <= 1) {
            targetChars = 1;
            compactedBody = renderPreparedCompactCommandOutput(entry.prepared, 1).text;
            break;
          }
          targetChars = Math.max(
            1,
            Math.min(
              basisChars - 1,
              Math.floor(basisChars * (allowedBodyBytes / curBytes) * 0.98)
            )
          );
          compactedBody = renderPreparedCompactCommandOutput(
            entry.prepared,
            targetChars
          ).text;
        }
        blocks[entry.index] = `${effectiveHeader}${compactedBody}`;
      }
    }
  }
  const nonEmptyBlocks = blocks.filter((b) => b.length > 0);
  const fittedBlocks = fitSectionsToByteBudget(
    nonEmptyBlocks,
    bodyBudget,
    bodyByteBudget,
    separator,
    "head-tail"
  );
  let text = truncateWithNotice(
    `${summaryHeader}${separator}${fittedBlocks}`,
    maxChars
  );
  if (maxBytes !== void 0) {
    text = truncateWithByteNotice(text, maxBytes);
  }
  return { text, isError: false };
}
function clampInt2(val, min, max, fallback) {
  if (typeof val !== "number" && typeof val !== "string") return fallback;
  if (typeof val === "string" && val.trim() === "") return fallback;
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

// src/cli-runner.ts
var MAX_CLI_STDIN_BYTES = 2 * 1024 * 1024;
var IMPLICIT_STDIN_FIRST_BYTE_TIMEOUT_MS = 500;
var TOOL_ALIASES = {
  search: "batch_search",
  batch_search: "batch_search",
  outline: "quick_outline",
  quick_outline: "quick_outline",
  slice: "read_slices",
  slices: "read_slices",
  read_slices: "read_slices",
  edit: "apply_edits",
  apply_edits: "apply_edits",
  check: "run_checks",
  checks: "run_checks",
  run_checks: "run_checks"
};
function resolveCliToolAlias(name) {
  if (!name) return null;
  return TOOL_ALIASES[name.trim().toLowerCase()] ?? null;
}
function formatCliUsage() {
  return [
    "agy-fast direct CLI mode (for Swarm workers, scripts, and non-MCP environments)",
    "",
    "Usage:",
    "  node <plugin>/dist/mcp-server.mjs --cli <command> [options] [args...]",
    "",
    "Commands (aliases):",
    "  outline | quick_outline <file...> [--cwd <dir>] [--max-chars <N>]",
    "  slice   | read_slices   <path:start-end,...> [--outline <file>] [--cwd <dir>]",
    "  search  | batch_search  [--text <p>] [--regex <p>] [--glob <p>] [--fuzzy <p>] [--git <cmd>]",
    "                          [--pattern <p>] [--type text|regex|glob|fuzzy|git]",
    "                          [--path <dir>] [--file-type <t>] [--glob-filter <g>]",
    "                          [--output-mode content|files_with_matches|count] [--sort-by path|mtime]",
    "                          [--context <0..5>] [--max-results <N>] [-i|--ignore-case] [--multiline]",
    "                          (modifiers before a query scope only to that query; trailing modifiers apply to all)",
    "  check   | run_checks    <cmd...> [--compact|--full] [--concurrency <N>] [--timeout <sec>]",
    "  edit    | apply_edits   [--best-effort] [--dry-run] [--verify <cmd>] (JSON via --json or stdin)",
    "",
    "JSON input (works for every command using the exact MCP tool schema):",
    "  --json '<json>'         Pass tool arguments JSON object (or shorthand array) inline",
    "  --stdin                 Read tool arguments JSON from stdin (or pipe/heredoc with no positional args)",
    "  --cwd <dir>             Override working directory (defaults to shell CWD)",
    "  --max-chars <N>         Override output character cap (hard UTF-8 ceiling <= 8800 bytes)"
  ].join("\n");
}
function parseIntFlag(flag, raw) {
  if (raw === void 0 || !/^-?\d+$/.test(raw.trim())) {
    throw new Error(`Expected integer value after ${flag}`);
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid integer value after ${flag}: ${raw}`);
  }
  return n;
}
async function readStdinText(stream, explicitStdin) {
  if (!explicitStdin && stream.isTTY) {
    return "";
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    let firstByteTimer;
    const cleanup = () => {
      if (firstByteTimer !== void 0) {
        clearTimeout(firstByteTimer);
        firstByteTimer = void 0;
      }
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
    };
    const finish = (text) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(text);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (typeof stream.pause === "function") {
        stream.pause();
      }
      const maybeUnref = stream.unref;
      if (typeof maybeUnref === "function") {
        maybeUnref.call(stream);
      }
      reject(err);
    };
    const onData = (chunk) => {
      if (firstByteTimer !== void 0) {
        clearTimeout(firstByteTimer);
        firstByteTimer = void 0;
      }
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      totalBytes += buf.length;
      if (totalBytes > MAX_CLI_STDIN_BYTES) {
        fail(new Error(`stdin payload exceeds ${MAX_CLI_STDIN_BYTES} bytes limit`));
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => {
      finish(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (err) => {
      fail(err);
    };
    if (!explicitStdin) {
      firstByteTimer = setTimeout(() => {
        if (totalBytes === 0) {
          if (typeof stream.pause === "function") {
            stream.pause();
          }
          finish("");
        }
      }, IMPLICIT_STDIN_FIRST_BYTE_TIMEOUT_MS);
    }
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    if (typeof stream.resume === "function") {
      stream.resume();
    }
  });
}
function parseJsonPayload(rawText, tool) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Invalid JSON input for '${tool}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (Array.isArray(parsed)) {
    if (tool === "batch_search") return { queries: parsed };
    if (tool === "apply_edits") return { edits: parsed };
    if (tool === "quick_outline") return { paths: parsed };
    if (tool === "read_slices") {
      if (parsed.every((item) => typeof item === "string")) {
        return { lineRanges: parsed };
      }
      return { slices: parsed };
    }
    if (tool === "run_checks") {
      return {
        commands: parsed.map(
          (item) => typeof item === "string" ? { command: item } : item
        )
      };
    }
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { ...parsed };
  }
  throw new Error(`JSON input for '${tool}' must be an object (or shorthand array).`);
}
function applySearchModifiers(q, mods) {
  return {
    ...q,
    ...mods.path !== void 0 && q.path === void 0 ? { path: mods.path } : {},
    ...mods.fileType !== void 0 && q.fileType === void 0 ? { fileType: mods.fileType } : {},
    ...mods.glob !== void 0 && q.glob === void 0 ? { glob: mods.glob } : {},
    ...mods.outputMode !== void 0 && q.outputMode === void 0 ? { outputMode: mods.outputMode } : {},
    ...mods.sortBy !== void 0 && q.sortBy === void 0 ? { sortBy: mods.sortBy } : {},
    ...mods.contextLines !== void 0 && q.contextLines === void 0 ? { contextLines: mods.contextLines } : {},
    ...mods.maxResults !== void 0 && q.maxResults === void 0 ? { maxResults: mods.maxResults } : {},
    ...mods.caseSensitive !== void 0 && q.caseSensitive === void 0 ? { caseSensitive: mods.caseSensitive } : {},
    ...mods.multiline !== void 0 && q.multiline === void 0 ? { multiline: mods.multiline } : {}
  };
}
var SEARCH_QUERY_TYPES = /* @__PURE__ */ new Set([
  "text",
  "regex",
  "glob",
  "fuzzy",
  "git"
]);
var VALUE_LONG_FLAGS = /* @__PURE__ */ new Set([
  "--cwd",
  "--max-chars",
  "--json",
  "--text",
  "--regex",
  "--glob",
  "--fuzzy",
  "--git",
  "--pattern",
  "--type",
  "--path",
  "--file-type",
  "--glob-filter",
  "--output-mode",
  "--sort-by",
  "--context",
  "--max-results",
  "--outline",
  "--concurrency",
  "--timeout",
  "--verify",
  "--verify-timeout",
  "--max-verify-chars"
]);
function parseToolFlags(tool, rawArgs) {
  const opts = {
    showHelp: false,
    explicitStdin: false,
    positionals: [],
    searchQueries: [],
    implicitTypeQueryIndices: /* @__PURE__ */ new Set(),
    trailingSearchMods: {},
    outlineFiles: []
  };
  let pendingMods = {};
  let pendingType;
  const pushScopedQuery = (base, explicitType) => {
    const idx = opts.searchQueries.length;
    opts.searchQueries.push(applySearchModifiers(base, pendingMods));
    if (!explicitType) {
      opts.implicitTypeQueryIndices.add(idx);
    }
    pendingMods = {};
    pendingType = void 0;
  };
  let afterDoubleDash = false;
  for (let i = 0; i < rawArgs.length; i++) {
    const rawArg = rawArgs[i];
    if (afterDoubleDash) {
      if (tool === "batch_search") {
        const explicit = pendingType !== void 0;
        pushScopedQuery({ type: pendingType ?? "text", pattern: rawArg }, explicit);
      } else {
        opts.positionals.push(rawArg);
      }
      continue;
    }
    if (rawArg === "--") {
      afterDoubleDash = true;
      continue;
    }
    let arg = rawArg;
    let inlineValue;
    if (rawArg.startsWith("--")) {
      const eqIdx = rawArg.indexOf("=");
      if (eqIdx > 2) {
        const candidateFlag = rawArg.slice(0, eqIdx);
        if (VALUE_LONG_FLAGS.has(candidateFlag)) {
          arg = candidateFlag;
          inlineValue = rawArg.slice(eqIdx + 1);
        }
      }
    }
    const consumeValue = () => {
      if (inlineValue !== void 0) {
        return inlineValue;
      }
      const next = rawArgs[i + 1];
      if (next === void 0) {
        throw new Error(`Missing value after ${arg}`);
      }
      i += 1;
      return next;
    };
    if (arg === "--help" || arg === "-h") {
      opts.showHelp = true;
      continue;
    }
    if (arg === "--cwd") {
      opts.cwd = consumeValue();
      continue;
    }
    if (arg === "--max-chars") {
      opts.maxChars = parseIntFlag(arg, consumeValue());
      continue;
    }
    if (arg === "--json") {
      opts.jsonRaw = consumeValue();
      continue;
    }
    if (arg === "--stdin") {
      opts.explicitStdin = true;
      continue;
    }
    if (tool === "batch_search") {
      if (arg === "--text" || arg === "-t") {
        pushScopedQuery({ type: "text", pattern: consumeValue() }, true);
        continue;
      }
      if (arg === "--regex" || arg === "-r") {
        pushScopedQuery({ type: "regex", pattern: consumeValue() }, true);
        continue;
      }
      if (arg === "--glob" || arg === "-g") {
        pushScopedQuery({ type: "glob", pattern: consumeValue() }, true);
        continue;
      }
      if (arg === "--fuzzy" || arg === "-f") {
        pushScopedQuery({ type: "fuzzy", pattern: consumeValue() }, true);
        continue;
      }
      if (arg === "--git") {
        pushScopedQuery({ type: "git", pattern: consumeValue() }, true);
        continue;
      }
      if (arg === "--type") {
        const rawType = consumeValue().trim().toLowerCase();
        if (!SEARCH_QUERY_TYPES.has(rawType)) {
          throw new Error(
            `Invalid --type: ${rawType} (expected text, regex, glob, fuzzy, or git)`
          );
        }
        pendingType = rawType;
        continue;
      }
      if (arg === "--pattern") {
        const explicit = pendingType !== void 0;
        pushScopedQuery({ type: pendingType ?? "text", pattern: consumeValue() }, explicit);
        continue;
      }
      if (arg === "--path" || arg === "-p") {
        pendingMods.path = consumeValue();
        continue;
      }
      if (arg === "--file-type") {
        pendingMods.fileType = consumeValue();
        continue;
      }
      if (arg === "--glob-filter") {
        pendingMods.glob = consumeValue();
        continue;
      }
      if (arg === "--output-mode") {
        const mode = consumeValue();
        if (mode !== "content" && mode !== "files_with_matches" && mode !== "count") {
          throw new Error(`Invalid --output-mode: ${mode}`);
        }
        pendingMods.outputMode = mode;
        continue;
      }
      if (arg === "--sort-by") {
        const sortBy = consumeValue();
        if (sortBy !== "path" && sortBy !== "mtime") {
          throw new Error(`Invalid --sort-by: ${sortBy}`);
        }
        pendingMods.sortBy = sortBy;
        continue;
      }
      if (arg === "--context" || arg === "-C") {
        pendingMods.contextLines = parseIntFlag(arg, consumeValue());
        continue;
      }
      if (arg === "--max-results") {
        pendingMods.maxResults = parseIntFlag(arg, consumeValue());
        continue;
      }
      if (arg === "--ignore-case" || arg === "-i") {
        pendingMods.caseSensitive = false;
        continue;
      }
      if (arg === "--multiline") {
        pendingMods.multiline = true;
        continue;
      }
    } else if (tool === "read_slices") {
      if (arg === "--outline" || arg === "-o") {
        opts.outlineFiles.push(consumeValue());
        continue;
      }
    } else if (tool === "run_checks") {
      if (arg === "--compact") {
        opts.outputMode = "compact";
        continue;
      }
      if (arg === "--full") {
        opts.outputMode = "full";
        continue;
      }
      if (arg === "--output-mode") {
        const mode = consumeValue();
        if (mode !== "compact" && mode !== "full") {
          throw new Error(`Invalid --output-mode for check: ${mode}`);
        }
        opts.outputMode = mode;
        continue;
      }
      if (arg === "--concurrency") {
        opts.concurrency = parseIntFlag(arg, consumeValue());
        continue;
      }
      if (arg === "--timeout") {
        opts.timeoutSec = parseIntFlag(arg, consumeValue());
        continue;
      }
    } else if (tool === "apply_edits") {
      if (arg === "--best-effort") {
        opts.bestEffort = true;
        continue;
      }
      if (arg === "--dry-run") {
        opts.dryRun = true;
        continue;
      }
      if (arg === "--verify") {
        opts.verify = consumeValue();
        continue;
      }
      if (arg === "--verify-timeout") {
        opts.verifyTimeoutSec = parseIntFlag(arg, consumeValue());
        continue;
      }
      if (arg === "--max-verify-chars") {
        opts.maxVerifyChars = parseIntFlag(arg, consumeValue());
        continue;
      }
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option '${rawArg}' for '${tool}'. Run with '--cli --help' for usage.`);
    }
    if (tool === "batch_search") {
      const explicit = pendingType !== void 0;
      pushScopedQuery({ type: pendingType ?? "text", pattern: rawArg }, explicit);
    } else {
      opts.positionals.push(rawArg);
    }
  }
  opts.trailingSearchType = pendingType;
  opts.trailingSearchMods = pendingMods;
  return opts;
}
async function runAgyFastCli(argv, io = {}) {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const defaultCwd = io.cwd ?? process.cwd();
  const cmdArg = argv[0];
  if (!cmdArg || cmdArg === "--help" || cmdArg === "-h" || cmdArg === "help") {
    stdout.write(`${formatCliUsage()}
`);
    return 0;
  }
  const rest = argv.slice(1);
  const tool = resolveCliToolAlias(cmdArg);
  if (!tool) {
    stderr.write(
      `Error: unknown --cli command '${cmdArg}'. Expected one of: search, outline, slice, edit, check (or --help).
`
    );
    return 1;
  }
  let opts;
  try {
    opts = parseToolFlags(tool, rest);
  } catch (err) {
    stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}
`);
    return 1;
  }
  if (opts.showHelp) {
    stdout.write(`${formatCliUsage()}
`);
    return 0;
  }
  const hasShorthandArgs = opts.positionals.length > 0 || opts.searchQueries.length > 0 || opts.outlineFiles.length > 0;
  let jsonInput = null;
  try {
    if (opts.jsonRaw !== void 0) {
      jsonInput = parseJsonPayload(opts.jsonRaw, tool);
    } else if (opts.explicitStdin || !hasShorthandArgs) {
      const stdinText = (await readStdinText(stdin, opts.explicitStdin)).trim();
      if (stdinText) {
        jsonInput = parseJsonPayload(stdinText, tool);
      }
    }
  } catch (err) {
    stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}
`);
    return 1;
  }
  let result;
  const effectiveCwd = opts.cwd ?? (typeof jsonInput?.cwd === "string" ? jsonInput.cwd : defaultCwd);
  if (tool === "batch_search") {
    let payload;
    if (jsonInput) {
      payload = {
        ...jsonInput,
        cwd: effectiveCwd,
        ...opts.maxChars !== void 0 ? { maxChars: opts.maxChars } : {}
      };
    } else {
      const queries = [
        ...opts.searchQueries.map(
          (q, idx) => opts.trailingSearchType !== void 0 && opts.implicitTypeQueryIndices.has(idx) ? { ...q, type: opts.trailingSearchType } : q
        ),
        ...opts.positionals.map(
          (pattern) => ({ type: opts.trailingSearchType ?? "text", pattern })
        )
      ].map((q) => applySearchModifiers(q, opts.trailingSearchMods));
      if (queries.length === 0) {
        stderr.write(
          "Error: 'search' requires at least one query (--text/--regex/--glob/--fuzzy/--git/--pattern, --json, or JSON on stdin).\n"
        );
        return 1;
      }
      payload = {
        cwd: effectiveCwd,
        queries,
        ...opts.maxChars !== void 0 ? { maxChars: opts.maxChars } : {}
      };
    }
    result = await runBatchSearch(payload);
  } else if (tool === "quick_outline") {
    let payload;
    if (jsonInput) {
      payload = {
        ...jsonInput,
        cwd: effectiveCwd,
        ...opts.maxChars !== void 0 ? { maxChars: opts.maxChars } : {}
      };
    } else {
      if (opts.positionals.length === 0) {
        stderr.write(
          "Error: 'outline' requires one or more file paths (e.g. --cli outline src/a.ts src/b.ts) or JSON input.\n"
        );
        return 1;
      }
      payload = {
        cwd: effectiveCwd,
        paths: opts.positionals,
        ...opts.maxChars !== void 0 ? { maxChars: opts.maxChars } : {}
      };
    }
    result = await runQuickOutline(payload);
  } else if (tool === "read_slices") {
    let payload;
    if (jsonInput) {
      payload = {
        ...jsonInput,
        cwd: effectiveCwd,
        ...opts.maxChars !== void 0 ? { maxChars: opts.maxChars } : {}
      };
    } else {
      if (opts.positionals.length === 0 && opts.outlineFiles.length === 0) {
        stderr.write(
          "Error: 'slice' requires lineRanges specs (e.g. src/a.ts:1-60), --outline <file>, or JSON input.\n"
        );
        return 1;
      }
      payload = {
        cwd: effectiveCwd,
        ...opts.outlineFiles.length > 0 ? { outlines: opts.outlineFiles } : {},
        ...opts.positionals.length > 0 ? { lineRanges: opts.positionals } : {},
        ...opts.maxChars !== void 0 ? { maxChars: opts.maxChars } : {}
      };
    }
    result = await runReadSlices(payload);
  } else if (tool === "apply_edits") {
    if (!jsonInput) {
      stderr.write(
        `Error: 'edit' requires JSON input via --json or stdin (e.g. {"edits":[...],"bestEffort":true}).
`
      );
      return 1;
    }
    const effectiveMaxVerifyChars = opts.maxVerifyChars ?? (opts.maxChars !== void 0 ? Math.max(300, Math.min(7500, opts.maxChars)) : void 0);
    const payload = {
      ...jsonInput,
      cwd: effectiveCwd,
      ...opts.bestEffort !== void 0 ? { bestEffort: opts.bestEffort } : {},
      ...opts.dryRun !== void 0 ? { dryRun: opts.dryRun } : {},
      ...opts.verify !== void 0 ? { verify: opts.verify } : {},
      ...opts.verifyTimeoutSec !== void 0 ? { verifyTimeoutSec: opts.verifyTimeoutSec } : {},
      ...effectiveMaxVerifyChars !== void 0 ? { maxVerifyChars: effectiveMaxVerifyChars } : {}
    };
    result = await runApplyEdits(payload);
  } else {
    let payload;
    if (jsonInput) {
      payload = {
        ...jsonInput,
        cwd: effectiveCwd,
        ...opts.outputMode !== void 0 ? { outputMode: opts.outputMode } : {},
        ...opts.concurrency !== void 0 ? { concurrency: opts.concurrency } : {},
        ...opts.timeoutSec !== void 0 ? { timeoutSec: opts.timeoutSec } : {},
        ...opts.maxChars !== void 0 ? { maxChars: opts.maxChars } : {}
      };
    } else {
      if (opts.positionals.length === 0) {
        stderr.write(
          `Error: 'check' requires one or more shell command strings (e.g. --cli check "npm run typecheck" "npm test") or JSON input.
`
        );
        return 1;
      }
      payload = {
        cwd: effectiveCwd,
        commands: opts.positionals.map((command) => ({ command })),
        ...opts.outputMode !== void 0 ? { outputMode: opts.outputMode } : {},
        ...opts.concurrency !== void 0 ? { concurrency: opts.concurrency } : {},
        ...opts.timeoutSec !== void 0 ? { timeoutSec: opts.timeoutSec } : {},
        ...opts.maxChars !== void 0 ? { maxChars: opts.maxChars } : {}
      };
    }
    result = await runChecks(payload);
  }
  stdout.write(result.text.endsWith("\n") ? result.text : `${result.text}
`);
  return shouldCliExitNonZero(tool, result) ? 1 : 0;
}
function shouldCliExitNonZero(tool, result) {
  return result.isError || tool === "run_checks" && /^Checks:\s+\d+\/\d+\s+passed,\s+(?:[1-9]\d*\s+failed|[1-9]\d*\s+not run)\b/.test(
    result.text
  ) || tool === "apply_edits" && /(?:^|\n)Verify \[(?:FAIL|TIMEOUT|ERROR)\b/.test(result.text);
}

// src/mcp-server.ts
var SERVER_VERSION = "0.3.1";
var DEFAULT_PLUGIN_ROOT = path7.resolve(
  path7.dirname(fileURLToPath2(import.meta.url)),
  ".."
);
function canonicalizeDir(dirPath) {
  const resolved = path7.resolve(dirPath);
  try {
    return typeof fs6.realpathSync.native === "function" ? fs6.realpathSync.native(resolved) : fs6.realpathSync(resolved);
  } catch {
    return resolved;
  }
}
function isSameOrSubdir(candidate, root) {
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const normCandidate = caseInsensitive ? candidate.toLowerCase() : candidate;
  const normRoot = caseInsensitive ? root.toLowerCase() : root;
  const rel = path7.relative(normRoot, normCandidate);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${path7.sep}`) && !path7.isAbsolute(rel);
}
function isInstalledPluginPath(dirPath) {
  const posix = dirPath.replace(/\\/g, "/");
  return /(?:^|\/)(?:\.gemini\/(?:config\/|antigravity[^/]*\/)?plugins|\.agents\/plugins)\/[^/]+(?:\/|$)/i.test(
    posix
  );
}
function isSameDir(a, b) {
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function detectNonWorkspaceCwd(env, currentCwd) {
  const canonCwd = canonicalizeDir(currentCwd);
  if (path7.parse(canonCwd).root === canonCwd) {
    return { dir: canonCwd, place: "the filesystem root" };
  }
  const isFullAbsPath = (p) => process.platform === "win32" ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/.test(p) : path7.isAbsolute(p);
  const driveHome = process.platform === "win32" && typeof env.HOMEDRIVE === "string" && typeof env.HOMEPATH === "string" && env.HOMEDRIVE.trim() && env.HOMEPATH.trim() ? `${env.HOMEDRIVE.trim()}${env.HOMEPATH.trim()}` : "";
  const homes = [env.HOME, env.USERPROFILE, driveHome].map((h) => typeof h === "string" ? h.trim() : "").filter((h) => h && isFullAbsPath(h));
  if (homes.length === 0 && env === process.env) {
    try {
      const osHome = os4.homedir();
      if (isFullAbsPath(osHome)) homes.push(osHome);
    } catch {
    }
  }
  for (const home of homes) {
    if (home && isSameDir(canonCwd, canonicalizeDir(home))) {
      return { dir: canonCwd, place: "the home directory" };
    }
  }
  return null;
}
function detectPluginInstallCwd(env, currentCwd, scriptPluginRoot) {
  const canonCwd = canonicalizeDir(currentCwd);
  for (const envRoot of [env.PLUGIN_ROOT, env.AGY_PLUGIN_ROOT]) {
    if (typeof envRoot === "string" && envRoot.trim()) {
      const canonEnvRoot = canonicalizeDir(envRoot.trim());
      if (isSameOrSubdir(canonCwd, canonEnvRoot)) {
        return envRoot.trim();
      }
    }
  }
  const canonScriptRoot = canonicalizeDir(scriptPluginRoot);
  if (isSameOrSubdir(canonCwd, canonScriptRoot)) {
    const isRuntimeOnlyInstall = fs6.existsSync(path7.join(canonScriptRoot, "plugin.json")) && !fs6.existsSync(path7.join(canonScriptRoot, "src", "mcp-server.ts"));
    if (isInstalledPluginPath(canonScriptRoot) || isRuntimeOnlyInstall) {
      return scriptPluginRoot;
    }
  }
  return null;
}
function buildApplyEditsToolDefinition(compat) {
  const preferStringEdits = compat.editsFormat === "string";
  const editsSchema = preferStringEdits ? {
    type: "string",
    description: 'JSON array string (1-50 files): [{"path","hunks"?:[{"target","replacement","startLine"?,"endLine"?,"replaceAll"?}],"create"?,"overwrite"?}]. Exact target in 1-based window (all if replaceAll). Nonempty hunks XOR full-file create. overwrite allows replacing via create. Native arrays also work, but call_mcp_tool can turn long ones into [].'
  } : {
    type: "array",
    minItems: 1,
    maxItems: 50,
    items: {
      type: "object",
      properties: {
        path: { type: "string" },
        hunks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              target: { type: "string" },
              replacement: { type: "string" },
              startLine: { type: "integer", minimum: 1 },
              endLine: { type: "integer", minimum: 1 },
              replaceAll: { type: "boolean" }
            },
            required: ["target", "replacement"]
          }
        },
        create: { type: "string" },
        overwrite: { type: "boolean" }
      },
      required: ["path"]
    }
  };
  const baseDesc = `Atomic multi-file edits. bestEffort writes valid files atomically per file, gives closest lines, skips verify on failure. dryRun=false (true validates only). verify shell in cwd after writes (60s/4000 chars default, agy drops at 180s). 8800 UTF-8 bytes total. Absolute cwd if no roots/list (Desktop 2.0 Hub).`;
  return {
    name: "apply_edits",
    description: preferStringEdits ? baseDesc : `${baseDesc} Exact target in 1-based window (all if replaceAll). Nonempty hunks XOR full-file create. overwrite allows replacing via create.`,
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        edits: editsSchema,
        dryRun: { type: "boolean" },
        bestEffort: { type: "boolean" },
        verify: { type: "string" },
        verifyTimeoutSec: {
          type: "integer",
          minimum: 1,
          maximum: MCP_CALL_BUDGET_SEC
        },
        maxVerifyChars: {
          type: "integer",
          minimum: 300,
          maximum: 7500
        }
      },
      required: ["edits"]
    }
  };
}
function createAgyFastServer(options = {}) {
  const env = options.env ?? process.env;
  const getProcessCwd = options.processCwd ?? (() => process.cwd());
  const scriptPluginRoot = options.pluginRoot ?? DEFAULT_PLUGIN_ROOT;
  const savedEditsFormat = options.configEditsFormat ?? readSavedEditsFormatSync(env);
  let hostCompat = resolveHostCompat({
    env,
    configEditsFormat: savedEditsFormat
  });
  let defaultCwd;
  const resolveToolArgs = (args) => {
    if (args.cwd !== void 0 && args.cwd !== null && typeof args.cwd !== "string") {
      return {
        ok: false,
        error: `Error: 'cwd' must be a string path (received ${Array.isArray(args.cwd) ? "array" : typeof args.cwd}).`
      };
    }
    const rawCwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
    const isHomePath = rawCwd === "~" || rawCwd.startsWith("~/") || rawCwd.startsWith("~\\");
    if (!rawCwd) {
      if (defaultCwd) {
        return {
          ok: true,
          value: { ...args, cwd: defaultCwd }
        };
      }
      const pluginFallbackDir = detectPluginInstallCwd(
        env,
        getProcessCwd(),
        scriptPluginRoot
      );
      if (pluginFallbackDir) {
        return {
          ok: false,
          error: `Error: 'cwd' is required because this host did not report a workspace root via MCP roots/list and the MCP server started inside the plugin directory (${pluginFallbackDir}). Pass the active workspace root explicitly in 'cwd'.`
        };
      }
      const nonWorkspace = detectNonWorkspaceCwd(env, getProcessCwd());
      if (nonWorkspace) {
        return {
          ok: false,
          error: `Error: 'cwd' is required because this host did not report a workspace root via MCP roots/list and the MCP server started in ${nonWorkspace.place} (${nonWorkspace.dir}), which is not a workspace. Pass the active workspace root explicitly in 'cwd'.`
        };
      }
      return {
        ok: true,
        value: { ...args, cwd: void 0 }
      };
    }
    if (!path7.isAbsolute(rawCwd) && !isHomePath) {
      if (defaultCwd) {
        return {
          ok: true,
          value: { ...args, cwd: path7.resolve(defaultCwd, rawCwd) }
        };
      }
      const pluginFallbackDir = detectPluginInstallCwd(
        env,
        getProcessCwd(),
        scriptPluginRoot
      );
      if (pluginFallbackDir) {
        return {
          ok: false,
          error: `Error: 'cwd' must be an absolute workspace path because this host did not report a workspace root via MCP roots/list and the MCP server started inside the plugin directory (${pluginFallbackDir}). Received relative cwd: ${JSON.stringify(rawCwd)}.`
        };
      }
      const nonWorkspace = detectNonWorkspaceCwd(env, getProcessCwd());
      if (nonWorkspace) {
        return {
          ok: false,
          error: `Error: 'cwd' must be an absolute workspace path because this host did not report a workspace root via MCP roots/list and the MCP server started in ${nonWorkspace.place} (${nonWorkspace.dir}), which is not a workspace. Received relative cwd: ${JSON.stringify(rawCwd)}.`
        };
      }
    }
    return { ok: true, value: { ...args, cwd: rawCwd } };
  };
  const server = new McpStdioServer({
    name: "agy-fast",
    version: SERVER_VERSION,
    onInitialize: ({ clientInfo }) => {
      hostCompat = resolveHostCompat({
        clientInfo,
        env,
        configEditsFormat: savedEditsFormat
      });
    },
    shouldRequestRoots: (_toolName, args) => {
      const rawCwd = args.cwd;
      if (rawCwd !== void 0 && rawCwd !== null && typeof rawCwd !== "string") {
        return false;
      }
      if (typeof rawCwd !== "string" || !rawCwd.trim()) return true;
      const trimmed = rawCwd.trim();
      const isHome = trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\");
      return !path7.isAbsolute(trimmed) && !isHome;
    },
    onWorkspaceRoots: (paths) => {
      for (const candidate of paths) {
        try {
          if (fs6.statSync(candidate).isDirectory()) {
            defaultCwd = candidate;
            return;
          }
        } catch {
        }
      }
    }
  });
  server.registerTool(
    {
      name: "batch_search",
      description: "Parallel search: literal text, regex, fuzzy paths, glob (*/{a,b}, no |), read-only git. Absolute cwd if no roots/list (Desktop 2.0 Hub). path rel/abs file/dir; glob filters text/regex; fileType lang/ext (text/regex/fuzzy). multiline spans lines (dot too); count/file=lines or multiline occurrences. Defaults: outputMode=content, caseSensitive=true, contextLines=0, maxResults=40, maxChars=8500 (8800B UTF-8 max); glob sortBy=path (mtime newest).",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          queries: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["text", "regex", "glob", "fuzzy", "git"]
                },
                pattern: { type: "string" },
                path: { type: "string" },
                glob: { type: "string" },
                multiline: { type: "boolean" },
                outputMode: {
                  type: "string",
                  enum: ["content", "files_with_matches", "count"]
                },
                fileType: { type: "string" },
                sortBy: { type: "string", enum: ["path", "mtime"] },
                caseSensitive: { type: "boolean" },
                contextLines: { type: "integer", minimum: 0, maximum: 5 },
                maxResults: { type: "integer", minimum: 1, maximum: 200 }
              },
              required: ["type", "pattern"]
            }
          },
          maxChars: { type: "integer", minimum: 500, maximum: 8800 }
        },
        required: ["queries"]
      }
    },
    async (args) => {
      const resolved = resolveToolArgs(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runBatchSearch(resolved.value);
    }
  );
  server.registerTool(
    () => buildApplyEditsToolDefinition(hostCompat),
    async (args) => {
      const resolved = resolveToolArgs(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runApplyEdits(resolved.value);
    }
  );
  server.registerTool(
    {
      name: "read_slices",
      description: "Batch outlines (TS/JS/HTML/Vue/Svelte/CSS/Py/GDScript/Go/Rust/Java/MD/JSON/YAML; prefer 10-20, max 40) + tiny <=120-line slices. For >150 known lines total, prefer parallel read_file(StartLine, EndLine) if available (agy: 46KB/call, no remote check). Absolute cwd if no roots/list (Desktop 2.0 Hub). slices: 1-based inclusive [start,end]; lineRanges: 'path:start-end,s2-e2'. maxChars default 8500; 8800 UTF-8 bytes total.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          outlines: {
            type: "array",
            maxItems: 40,
            items: { type: "string" }
          },
          slices: {
            type: "array",
            maxItems: 30,
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                ranges: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "array",
                    minItems: 2,
                    maxItems: 2,
                    items: { type: "integer", minimum: 1 }
                  }
                }
              },
              required: ["path", "ranges"]
            }
          },
          lineRanges: {
            type: "array",
            maxItems: 30,
            items: { type: "string" }
          },
          maxChars: { type: "integer", minimum: 1e3, maximum: 8800 }
        }
      }
    },
    async (args) => {
      const resolved = resolveToolArgs(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runReadSlices(resolved.value);
    }
  );
  server.registerTool(
    {
      name: "quick_outline",
      description: "Fast symbol/section line-range outlines for large files (TS/JS/HTML/Vue/Svelte/CSS/Py/GDScript/Go/Rust/Java/MD/JSON/YAML; prefer 10-20, max 40) before parallel ranged read_file(StartLine, EndLine). Flat paths-only schema. Absolute cwd if no roots/list (Desktop 2.0 Hub). maxChars default 8500; 8800 UTF-8 bytes total.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          paths: {
            type: "array",
            minItems: 1,
            maxItems: 40,
            items: { type: "string" }
          },
          maxChars: { type: "integer", minimum: 1e3, maximum: 8800 }
        },
        required: ["paths"]
      }
    },
    async (args) => {
      const resolved = resolveToolArgs(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runQuickOutline(resolved.value);
    }
  );
  server.registerTool(
    {
      name: "run_checks",
      description: `Batch >=2 independent non-interactive shell commands concurrently (for 1 lightweight command, prefer run_command). outputMode 'compact' (default) hides pass logs, keeps failures; 'full' keeps passing stdout. concurrency default 4. Per-cmd timeoutSec default 60; shared ${MCP_CALL_BUDGET_SEC}s budget (agy drops results at 180s; commands that cannot start are marked not run). Absolute cwd if no roots/list (Desktop 2.0 Hub); command.cwd overrides; name is label. maxChars default 8000; 8800 UTF-8 bytes total.`,
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          commands: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                command: { type: "string" },
                cwd: { type: "string" },
                timeoutSec: { type: "integer", minimum: 1, maximum: MCP_CALL_BUDGET_SEC }
              },
              required: ["command"]
            }
          },
          concurrency: { type: "integer", minimum: 1, maximum: 8 },
          timeoutSec: { type: "integer", minimum: 1, maximum: MCP_CALL_BUDGET_SEC },
          outputMode: { type: "string", enum: ["compact", "full"] },
          maxChars: { type: "integer", minimum: 500, maximum: 8800 }
        },
        required: ["commands"]
      }
    },
    async (args) => {
      const resolved = resolveToolArgs(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runChecks(resolved.value);
    }
  );
  return server;
}
function main() {
  if (process.argv[2] === "--cli") {
    void runAgyFastCli(process.argv.slice(3)).then((code) => {
      process.exitCode = code;
    }).catch((err) => {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}
`
      );
      process.exitCode = 1;
    });
    return;
  }
  const server = createAgyFastServer();
  let flushing = false;
  const exitImmediately = () => {
    process.exit(0);
  };
  const flushAndExit = () => {
    if (flushing) return;
    flushing = true;
    const failsafe = setTimeout(() => {
      process.exit(0);
    }, 150);
    failsafe.unref();
    try {
      process.stdout.end(() => {
        process.exit(0);
      });
    } catch {
      process.exit(0);
    }
  };
  process.stdout.on("error", (err) => {
    if (flushing || err.code === "EPIPE" || err.code === "EOF" || err.code === "ECONNRESET" || err.code === "ERR_STREAM_DESTROYED" || err.code === "ERR_STREAM_WRITE_AFTER_END") {
      exitImmediately();
    }
  });
  process.on("SIGINT", exitImmediately);
  process.on("SIGTERM", exitImmediately);
  if (process.platform === "win32") {
    process.on("SIGBREAK", exitImmediately);
  }
  server.listen(process.stdin, process.stdout, flushAndExit);
}
main();
export {
  createAgyFastServer
};

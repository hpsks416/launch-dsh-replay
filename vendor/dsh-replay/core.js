// src/core/decode.ts
var CHUNK_ROW_TYPES = /* @__PURE__ */ new Set(["text-chunks", "reasoning-chunks", "tool-call-chunks"]);
function isChunkRow(record) {
  return CHUNK_ROW_TYPES.has(record.type);
}
function expandChunkRow(row) {
  const { seq0, time0, data } = row;
  const { turn, step, index, dt } = data;
  const events = [];
  const count = (row.type === "tool-call-chunks" ? data.args?.length : data.texts?.length) ?? 0;
  let time = time0;
  for (let k = 0; k < count; k++) {
    if (k > 0) time += dt[k - 1] ?? 0;
    let chunk;
    if (row.type === "text-chunks") {
      chunk = { type: "text-delta", index, text: data.texts[k] };
    } else if (row.type === "reasoning-chunks") {
      chunk = { type: "reasoning-delta", index, text: data.texts[k] };
    } else {
      chunk = {
        type: "tool-call-delta",
        index,
        id: data.id,
        ...k === 0 && data.name !== void 0 ? { name: data.name } : {},
        args: data.args[k]
      };
    }
    events.push({
      type: "assistant/chunk",
      seq: seq0 + k,
      time,
      data: { turn, step, chunk }
    });
  }
  return events;
}
function decodeStorageRecord(record) {
  if (isChunkRow(record)) return expandChunkRow(record);
  return [record];
}
function isHeaderLine(value) {
  return value["type"] === "session" && typeof value["id"] === "string";
}
function parseSessionJsonl(text) {
  const lines = text.split("\n");
  const malformed = [];
  let header;
  const events = [];
  const endsWithNewline = text.endsWith("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    const isLastLine = i === lines.length - 1;
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      if (isLastLine && !endsWithNewline) {
        malformed.push({ line: i + 1, raw, error: "torn tail (uncommitted final record)" });
      } else {
        malformed.push({ line: i + 1, raw, error: String(error) });
      }
      continue;
    }
    if (header === void 0) {
      if (!isHeaderLine(value)) {
        malformed.push({ line: i + 1, raw, error: "expected session header line" });
        continue;
      }
      header = value;
      continue;
    }
    try {
      events.push(...decodeStorageRecord(value));
    } catch (error) {
      malformed.push({ line: i + 1, raw, error: String(error) });
    }
  }
  if (header === void 0) {
    throw new Error("session log has no header line");
  }
  events.sort((a, b) => a.seq - b.seq);
  return { header, events, malformed };
}
function fromInspection(header, records) {
  const events = records.flatMap(decodeStorageRecord).sort((a, b) => a.seq - b.seq);
  return { header, events, malformed: [] };
}

// src/core/timeline.ts
function contentText(message) {
  if (!message?.content) return "";
  return message.content.filter((b) => typeof b.text === "string" && b.type !== "reasoning").map((b) => b.text).join("");
}
function contentReasoning(message) {
  if (!message?.content) return "";
  return message.content.filter((b) => b.type === "reasoning" && typeof b.text === "string").map((b) => b.text).join("");
}
function oneLine(text, max) {
  return truncate(text.replaceAll(/\s+/gu, " ").trim(), max);
}
function summarizeToolArguments(name, raw) {
  let args;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) args = parsed;
  } catch {
    args = void 0;
  }
  if (args === void 0) return oneLine(raw, 64);
  const keys = ["command", "cmd", "script", "path", "file_path", "filePath", "url", "query", "pattern", "description"];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return oneLine(value, 64);
  }
  return name;
}
function truncate(text, max = 96) {
  const oneLine2 = text.replaceAll(/\s+/gu, " ").trim();
  return oneLine2.length > max ? `${oneLine2.slice(0, max - 1)}\u2026` : oneLine2;
}
function tryPretty(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return void 0;
  }
}
function get(obj, key) {
  return typeof obj === "object" && obj !== null ? obj[key] : void 0;
}
var HIDDEN_TYPES = /* @__PURE__ */ new Set(["assistant/chunk", "step/start", "step/end", "turn/start"]);
function metaLabel(event) {
  const d = event.data;
  switch (event.type) {
    case "turn/end": {
      const reason = get(get(d, "reason"), "kind");
      return reason === "completed" ? void 0 : `turn ended: ${String(reason)}`;
    }
    case "compaction/summary":
      return "context compacted (summary)";
    case "compaction/prune":
      return "context pruned";
    case "approval/asked":
      return `approval requested: ${String(get(d, "toolName") ?? "")}`;
    case "approval/decided": {
      const outcome = get(d, "outcome") ?? get(d, "decision");
      return `approval decided: ${typeof outcome === "string" ? outcome : JSON.stringify(outcome)}`;
    }
    case "sandbox/mode":
      return `sandbox mode \u2192 ${JSON.stringify(d)}`;
    case "permission/preset":
      return `permission preset \u2192 ${JSON.stringify(d)}`;
    case "plan/mode":
      return `plan mode change`;
    case "subagent/descriptor":
      return `subagent spawned (${String(get(d, "mode") ?? "")})`;
    case "session/end-seed":
      return "seed boundary (fork/resume point)";
    case "llm/retry":
    case "llm/retry-started":
      return "model request retried";
    case "command/run":
      return `command: ${truncate(JSON.stringify(d), 60)}`;
    case "goal/change":
      return "goal changed";
    case "session/title":
      return void 0;
    default:
      return void 0;
  }
}
function shadowedSeqs(events) {
  const surfaceOrder = [];
  const shadowed = /* @__PURE__ */ new Set();
  for (const event of events) {
    const op = event.surfaceOp;
    if (op === void 0) continue;
    if (op === "append") {
      surfaceOrder.push(event.seq);
    } else if (typeof op === "object" && op.op === "replace") {
      const removed = surfaceOrder.splice(op.start, op.end - op.start + 1, event.seq);
      for (const seq of removed) shadowed.add(seq);
    }
  }
  return shadowed;
}
function buildTimeline(session) {
  const { events } = session;
  const turns = /* @__PURE__ */ new Map();
  const items = [];
  const usageSamples = [];
  const toolCallsBySeq = /* @__PURE__ */ new Map();
  const toolCalls = [];
  const usageByStep = /* @__PURE__ */ new Map();
  const usageModelByStep = /* @__PURE__ */ new Map();
  const modelTotals = {};
  const models = /* @__PURE__ */ new Set();
  const shadowed = shadowedSeqs(events);
  let seedBoundarySeq;
  let activeTurn;
  let activeModel;
  let sessionTitle;
  const ensureTurn = (turn, event) => {
    let model = turns.get(turn);
    if (model === void 0) {
      model = { turn, startSeq: event.seq, startTime: event.time, steps: [], items: [] };
      turns.set(turn, model);
    }
    return model;
  };
  const ensureStep = (turnModel, step, event) => {
    let model = turnModel.steps.find((s) => s.step === step);
    if (model === void 0) {
      model = { turn: turnModel.turn, step, startSeq: event.seq, startTime: event.time, items: [] };
      turnModel.steps.push(model);
    }
    return model;
  };
  const push = (item) => {
    if (shadowed.has(item.seq)) item.shadowed = true;
    items.push(item);
    if (item.turn !== void 0) {
      const turnModel = ensureTurn(item.turn, item.event);
      turnModel.items.push(item);
      if (item.step !== void 0) ensureStep(turnModel, item.step, item.event).items.push(item);
    }
  };
  for (const event of events) {
    const d = event.data;
    const turn = get(d, "turn");
    const step = get(d, "step");
    switch (event.type) {
      case "turn/start":
        activeTurn = turn;
        ensureTurn(activeTurn, event);
        break;
      case "turn/end": {
        const model = ensureTurn(turn, event);
        model.endSeq = event.seq;
        model.endTime = event.time;
        model.endReason = String(get(get(d, "reason"), "kind") ?? "completed");
        activeTurn = void 0;
        break;
      }
      case "step/start":
        ensureStep(ensureTurn(turn, event), step, event);
        break;
      case "step/end": {
        const stepModel = ensureStep(ensureTurn(turn, event), step, event);
        stepModel.endSeq = event.seq;
        stepModel.endTime = event.time;
        break;
      }
      case "user/message": {
        const message = d;
        const text = contentText(message);
        push({
          kind: "user",
          seq: event.seq,
          time: event.time,
          type: event.type,
          turn: activeTurn,
          label: truncate(text) || "(user message)",
          text,
          event
        });
        break;
      }
      case "assistant/message": {
        const message = get(d, "message");
        const usage = get(d, "usage");
        const text = contentText(message);
        const reasoningText = contentReasoning(message);
        const source = message?.source;
        if (typeof source?.["model"] === "string") {
          activeModel = source["model"];
          models.add(activeModel);
        }
        if (usage) {
          const key = `${String(turn)}/${String(step)}`;
          usageByStep.set(key, usage);
          if (activeModel !== void 0) usageModelByStep.set(key, activeModel);
        }
        push({
          kind: "assistant",
          seq: event.seq,
          time: event.time,
          turn,
          step,
          type: event.type,
          label: truncate(text) || "(assistant message)",
          text,
          reasoningText,
          usage,
          event
        });
        break;
      }
      case "assistant/chunk": {
        const chunk = get(d, "chunk");
        if (get(chunk, "type") === "usage") {
          const usage = get(chunk, "usage");
          const key = `${String(turn)}/${String(step)}`;
          usageByStep.set(key, usage);
          if (activeModel !== void 0 && !usageModelByStep.has(key)) {
            usageModelByStep.set(key, activeModel);
          }
        }
        break;
      }
      case "tool/call": {
        const raw = String(get(d, "arguments") ?? "");
        const name = String(get(d, "name") ?? "");
        const info = {
          callId: String(get(d, "callId") ?? ""),
          name,
          argumentsRaw: raw,
          argumentsPretty: tryPretty(raw),
          summary: summarizeToolArguments(name, raw),
          callSeq: event.seq,
          callTime: event.time
        };
        toolCallsBySeq.set(info.callId, info);
        toolCalls.push(info);
        push({
          kind: "tool",
          seq: event.seq,
          time: event.time,
          turn,
          step,
          type: event.type,
          label: info.summary === name ? name : `${name} \xB7 ${info.summary}`,
          toolCall: info,
          event
        });
        break;
      }
      case "tool/result": {
        const message = get(d, "message");
        const source = message?.source;
        const callId = String(source?.["callId"] ?? "");
        const info = toolCallsBySeq.get(callId);
        const block = message?.content?.[0];
        const resultText = contentText(message) || (typeof get(block, "text") === "string" ? get(block, "text") : contentText({ content: get(block, "content") }));
        const error = get(d, "error");
        if (info) {
          info.resultSeq = event.seq;
          info.resultTime = event.time;
          info.durationMs = event.time - info.callTime;
          info.resultText = resultText;
          info.error = error;
        }
        break;
      }
      case "session/end-seed":
        seedBoundarySeq = event.seq;
        push({
          kind: "meta",
          seq: event.seq,
          time: event.time,
          type: event.type,
          label: "seed boundary (fork/resume point)",
          event
        });
        break;
      case "system/message": {
        const message = get(d, "message");
        const text = contentText(message);
        push({
          kind: "meta",
          seq: event.seq,
          time: event.time,
          turn: typeof turn === "number" ? turn : void 0,
          step: typeof step === "number" ? step : void 0,
          type: event.type,
          label: "system prompt",
          text,
          event
        });
        break;
      }
      case "model/selection": {
        const model = get(d, "model");
        if (typeof model === "string" && model !== "") {
          activeModel = model;
          models.add(model);
          push({
            kind: "meta",
            seq: event.seq,
            time: event.time,
            type: event.type,
            label: `model selected: ${model}`,
            event
          });
        }
        break;
      }
      case "request/context": {
        const model = get(d, "model");
        if (typeof model === "string") {
          activeModel = model;
          models.add(model);
        }
        break;
      }
      case "session/title": {
        const title = get(d, "title");
        if (typeof title === "string" && title !== "") sessionTitle = title;
        break;
      }
      default: {
        if (HIDDEN_TYPES.has(event.type)) break;
        const label = metaLabel(event);
        if (label !== void 0) {
          push({
            kind: "meta",
            seq: event.seq,
            time: event.time,
            turn: typeof turn === "number" ? turn : void 0,
            step: typeof step === "number" ? step : void 0,
            type: event.type,
            label,
            event
          });
        }
      }
    }
  }
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, billedInput: 0 };
  const emptyTotals = () => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    billedInput: 0
  });
  for (const [key, usage] of usageByStep) {
    const [turnStr, stepStr] = key.split("/");
    const billed = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    totals.input += usage.inputTokens;
    totals.output += usage.outputTokens;
    totals.cacheRead += usage.cacheReadTokens ?? 0;
    totals.cacheWrite += usage.cacheWriteTokens ?? 0;
    totals.reasoning += usage.reasoningTokens ?? 0;
    const modelName = usageModelByStep.get(key) ?? activeModel ?? "unknown";
    const modelTotal = modelTotals[modelName] ?? emptyTotals();
    modelTotal.input += usage.inputTokens;
    modelTotal.output += usage.outputTokens;
    modelTotal.cacheRead += usage.cacheReadTokens ?? 0;
    modelTotal.cacheWrite += usage.cacheWriteTokens ?? 0;
    modelTotal.reasoning += usage.reasoningTokens ?? 0;
    modelTotal.billedInput += billed;
    modelTotals[modelName] = modelTotal;
    const turnModel = turns.get(Number(turnStr));
    const stepModel = turnModel?.steps.find((s) => s.step === Number(stepStr));
    if (stepModel) stepModel.usage = usage;
    const anchor = stepModel?.items.find((i) => i.kind === "assistant");
    usageSamples.push({
      seq: anchor?.seq ?? stepModel?.startSeq ?? 0,
      turn: Number(turnStr),
      step: Number(stepStr),
      usage
    });
  }
  usageSamples.sort((a, b) => a.seq - b.seq);
  totals.billedInput = totals.input + totals.cacheRead + totals.cacheWrite;
  const orderedTurns = [...turns.values()].sort((a, b) => a.turn - b.turn);
  for (const t of orderedTurns) t.steps.sort((a, b) => a.step - b.step);
  const startTime = events[0]?.time ?? session.header.createdAt;
  const endTime = events.at(-1)?.time ?? startTime;
  return {
    turns: orderedTurns,
    items,
    totals,
    modelTotals,
    usageSamples,
    toolCalls,
    durationMs: endTime - startTime,
    startTime,
    endTime,
    eventCount: events.length,
    seedBoundarySeq,
    models: [...models],
    title: sessionTitle
  };
}

// src/core/redact.ts
var RULES = [
  { kind: "openai-key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED:openai-key]" },
  {
    kind: "github-token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    replacement: "[REDACTED:github-token]"
  },
  { kind: "aws-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: "[REDACTED:aws-key]" },
  { kind: "google-key", re: /\bAIza[0-9A-Za-z_-]{20,}\b/g, replacement: "[REDACTED:google-key]" },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: "[REDACTED:slack-token]" },
  {
    kind: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED:private-key]"
  },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "[REDACTED:jwt]"
  },
  {
    kind: "env-assignment",
    re: /(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL)[A-Z0-9_]*\s*=\s*)(["']?)([^\s"'\\]{4,})\2/g,
    replacement: (_m, prefix, quote) => `${prefix}${quote}[REDACTED]${quote}`
  },
  {
    kind: "key-value",
    re: /(["']?(?:api[_-]?key|secret|token|password|passwd|authorization|jwt[_-]?secret)["']?\s*[:=]\s*["']?)([^"'\s,}]{4,})/gi,
    replacement: (_m, prefix) => `${prefix}[REDACTED]`
  },
  { kind: "bearer", re: /(\bBearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, replacement: "$1[REDACTED]" },
  {
    kind: "basic-auth-url",
    re: /(https?:\/\/[^/\s:@]+:)([^@\s/]+)(@)/g,
    replacement: "$1[REDACTED]$3"
  },
  { kind: "windows-user", re: /([A-Za-z]:\\Users\\)([^\\\s"']+)/g, replacement: "$1[user]" },
  { kind: "unix-home", re: /(\/(?:home|Users)\/)([^/\s"']+)/g, replacement: "$1[user]" },
  { kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "[email]" },
  { kind: "session-id", re: /\bsession-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, replacement: "session-[id]" }
];
var CREDENTIAL_KINDS = /* @__PURE__ */ new Set([
  "openai-key",
  "github-token",
  "aws-key",
  "google-key",
  "slack-token",
  "private-key",
  "jwt",
  "env-assignment",
  "key-value",
  "bearer",
  "basic-auth-url"
]);
function redactText(input) {
  let text = input;
  let count = 0;
  const kinds = /* @__PURE__ */ new Set();
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    const matches = text.match(rule.re);
    if (matches === null) continue;
    count += matches.length;
    kinds.add(rule.kind);
    rule.re.lastIndex = 0;
    text = text.replace(rule.re, rule.replacement);
  }
  return { text, count, kinds: [...kinds] };
}
function containsSecret(input) {
  for (const rule of RULES) {
    if (!CREDENTIAL_KINDS.has(rule.kind)) continue;
    rule.re.lastIndex = 0;
    const hit = rule.re.test(input);
    rule.re.lastIndex = 0;
    if (hit) return true;
  }
  return false;
}
function redactValue(value, depth = 0) {
  if (depth > 20) return { value, count: 0 };
  if (typeof value === "string") {
    const result = redactText(value);
    return { value: result.text, count: result.count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const next = value.map((item) => {
      const result = redactValue(item, depth + 1);
      count += result.count;
      return result.value;
    });
    return { value: next, count };
  }
  if (typeof value === "object" && value !== null) {
    let count = 0;
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      const result = redactValue(item, depth + 1);
      count += result.count;
      next[key] = result.value;
    }
    return { value: next, count };
  }
  return { value, count: 0 };
}
function redactSession(session) {
  let count = 0;
  const kinds = /* @__PURE__ */ new Set();
  const header = { ...session.header };
  for (const key of ["cwd", "title"]) {
    const value = header[key];
    if (typeof value === "string") {
      const result = redactText(value);
      header[key] = result.text;
      count += result.count;
      for (const kind of result.kinds) kinds.add(kind);
    }
  }
  const events = session.events.map((event) => {
    const data = redactValue(event.data);
    count += data.count;
    if (data.count > 0) {
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        if (rule.re.test(JSON.stringify(event.data))) kinds.add(rule.kind);
        rule.re.lastIndex = 0;
      }
    }
    return { ...event, data: data.value };
  });
  return { session: { ...session, header, events }, count, kinds: [...kinds] };
}

// src/core/audit.ts
function get2(obj, key) {
  return typeof obj === "object" && obj !== null ? obj[key] : void 0;
}
function str(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
function clipped(value, max = 500) {
  return redactText(value).text.slice(0, max);
}
function toolName(event) {
  return str(get2(event.data, "name"));
}
function argsOf(event) {
  return str(get2(event.data, "arguments"));
}
function parseArgs(raw) {
  try {
    const value = JSON.parse(raw);
    return typeof value === "object" && value !== null ? value : void 0;
  } catch {
    return void 0;
  }
}
var PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "target",
  "destination",
  "dest",
  "filename",
  "file",
  "name"
];
function pathOf(raw) {
  const args = parseArgs(raw);
  if (args === void 0) return void 0;
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value !== "" && /[\\/.]/u.test(value)) return value;
  }
  return void 0;
}
var SHELL_TOOLS = /^(bash|shell|exec|run_command|terminal|subprocess|pwsh|powershell|cmd|run_code|code_execution)/iu;
var WRITE_TOOLS = /^(write|write_file|edit|edit_file|create_file|str_replace|multi_edit|apply_patch|notebook_edit|fs_write|mv|move|rename|copy|rm|remove|delete|del|remove_item|rmdir|rd)/iu;
var DESTRUCTIVE_TOOLS = /^(rm|remove|delete|del|remove_item|rmdir|rd|mv|move|rename)/iu;
var READ_TOOLS = /^(read|read_file|view|open|cat|type|get-content|grep|search|glob|list|find|head|tail|less|more|strings|xxd)/iu;
var NETWORK_TOOLS = /^(fetch|web_fetch|http|curl|download|web_search|browser|invoke-webrequest|iwr|invoke-restmethod|start-bitstransfer)/iu;
var DANGEROUS_SHELL = [
  // --- destructive deletes -------------------------------------------------
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/iu, why: "recursive/forced delete", key: "rm-rf", severity: "critical" },
  { re: /\bremove-item\b[^\n]*(?:-recurse|-force)/iu, why: "recursive/forced delete", key: "rm-rf", severity: "critical" },
  { re: /\b(?:del|erase)\b[^\n]*\/[sq]/iu, why: "forced delete", key: "rm-rf", severity: "critical" },
  { re: /\b(?:rd|rmdir)\b[^\n]*\/s/iu, why: "recursive directory delete", key: "rm-rf", severity: "critical" },
  // --- privilege / system --------------------------------------------------
  { re: /\bsudo\b/iu, why: "privilege escalation", key: "sudo", severity: "critical" },
  { re: /\b(?:takeown|icacls)\b[^\n]*(?:grant|\/grant|\/f|\/reset)/iu, why: "ownership/permission change", key: "chmod", severity: "serious" },
  { re: /\bchmod\s+([0-7]{3,4}|\+x)/u, why: "permission change", key: "chmod", severity: "serious" },
  { re: /\bset-executionpolicy\b/iu, why: "script execution policy change", key: "exec-policy", severity: "serious" },
  { re: /\b(?:bcdedit|vssadmin\s+delete|wevtutil\s+cl)\b/iu, why: "boot/shadow/log tampering", key: "system-tamper", severity: "critical" },
  { re: /\b(?:reg\s+delete|schtasks\b[^\n]*\/create|sc\s+create|net\s+user|net\s+localgroup)\b/iu, why: "persistence or account change", key: "persistence", severity: "serious" },
  // --- disk / remote code --------------------------------------------------
  { re: /\b(?:dd|mkfs|fdisk|diskpart|format)\b/iu, why: "raw disk operation", key: "disk", severity: "critical" },
  { re: /\b(?:iwr|invoke-webrequest|curl|wget|start-bitstransfer)\b[^\n|;]*(?:\||;)\s*(?:iex|invoke-expression)\b/iu, why: "pipe remote script to shell", key: "curl-pipe", severity: "critical" },
  { re: /\b(?:downloadstring|downloadfile)\b/iu, why: "download and execute", key: "curl-pipe", severity: "critical" },
  { re: /\b(?:powershell|pwsh)\b[^\n]*-e(?:nc|ncodedcommand)?\s+[A-Za-z0-9+/=]{40,}/iu, why: "encoded PowerShell command", key: "encoded-shell", severity: "critical" },
  // --- credentials / exfiltration -----------------------------------------
  { re: /\b(?:export|\$env:|\bset\b|\becho\b)[^\n]*(?:api[_-]?key|token|secret|password|passwd)/iu, why: "credential material in command", key: "creds", severity: "serious" },
  { re: /\b(?:get-content|type|cat)\b[^\n]*(?:\.env\b|id_rsa|\.ssh[\\/]|credentials)/iu, why: "credential file read", key: "creds", severity: "serious" },
  { re: /\b(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b[^\n]*(?:-d\b|--data|--upload-file|-f\b|\.env\b|secret|token|password)/iu, why: "possible credential exfiltration", key: "exfil", severity: "critical" },
  { re: /\b(?:ssh|scp|rsync)\b[^\n]*(?:@|\bremote\b)/iu, why: "remote host access", key: "remote", severity: "warning" },
  { re: /\b(?:invoke-command|enter-pssession|winrs)\b/iu, why: "remote execution", key: "remote", severity: "serious" },
  // --- supply chain / repo ------------------------------------------------
  { re: /\bgit\s+push\s+[^\n]*--force/iu, why: "force push", key: "force-push", severity: "serious" },
  { re: /\b(?:npm|pnpm|yarn)\s+publish\b/iu, why: "package publish", key: "publish", severity: "warning" },
  { re: /\bgh\s+release\s+create\b/iu, why: "release publish", key: "publish", severity: "warning" }
];
var SENSITIVE_PATH = /(?:^|[\\/])(?:\.env(?:\.[\w-]+)?(?:[\\/]|$)|\.ssh(?:[\\/]|$)|id_rsa|id_ed25519|\.aws(?:[\\/]|$)|\.kube(?:[\\/]|$)|\.docker(?:[\\/]config\.json|$)|credentials|\.npmrc|\.netrc|secrets?\.|\.pem|\.pfx|\.p12|ntuser\.dat|\.git[\\/]config|\.config[\\/]gh[\\/]hosts\.yml)/iu;
var NETWORK_RISK = /(?:--data|-d\s|--upload-file|-f\s|body\s*[:=]|\.env\b|secret|token|password|passwd|private[_-]?key|authorization|api[_-]?key)/iu;
function messageText(message) {
  const content = get2(message, "content");
  if (!Array.isArray(content)) return "";
  return content.map((block) => typeof get2(block, "text") === "string" ? get2(block, "text") : "").join("");
}
function findDanger(event) {
  if (event.type !== "tool/call") return void 0;
  const name = toolName(event);
  if (!SHELL_TOOLS.test(name)) return void 0;
  const args = argsOf(event);
  return DANGEROUS_SHELL.find((pattern) => pattern.re.test(args));
}
var DEFAULT_RULES = [
  {
    id: "shell-exec",
    category: "shell",
    severity: (event) => findDanger(event)?.severity ?? "warning",
    match: (event) => {
      if (event.type !== "tool/call") return void 0;
      const name = toolName(event);
      if (!SHELL_TOOLS.test(name)) return void 0;
      const args = argsOf(event);
      const hit = DANGEROUS_SHELL.find((pattern) => pattern.re.test(args));
      if (hit === void 0) return void 0;
      return {
        title: `shell: ${hit.why}`,
        detail: clipped(args),
        messageKey: "f.shell.dangerous",
        params: { whyKey: hit.key, why: hit.why, name }
      };
    }
  },
  {
    id: "file-write",
    category: "file",
    severity: (event) => {
      const args = argsOf(event);
      const path = pathOf(args) ?? args;
      return SENSITIVE_PATH.test(path) || containsSecret(args) ? "critical" : "warning";
    },
    match: (event) => {
      if (event.type !== "tool/call") return void 0;
      const name = toolName(event);
      if (!WRITE_TOOLS.test(name)) return void 0;
      const args = argsOf(event);
      const path = pathOf(args) ?? args;
      const sensitive = SENSITIVE_PATH.test(path);
      const secret = containsSecret(args);
      if (!sensitive && !secret && !DESTRUCTIVE_TOOLS.test(name)) return void 0;
      const reason = sensitive ? "file write touches a sensitive path" : secret ? "credential material written to a file" : `destructive file operation via ${name}`;
      return {
        title: reason,
        detail: clipped(args),
        messageKey: sensitive ? "f.file.sensitive" : secret ? "f.file.secret" : "f.file.destructive",
        params: { name, ...path !== args ? { path } : {} }
      };
    }
  },
  {
    id: "sensitive-read",
    category: "file",
    severity: "serious",
    match: (event) => {
      if (event.type !== "tool/call") return void 0;
      const name = toolName(event);
      if (WRITE_TOOLS.test(name) || SHELL_TOOLS.test(name) || NETWORK_TOOLS.test(name)) return void 0;
      if (!READ_TOOLS.test(name)) return void 0;
      const args = argsOf(event);
      const path = pathOf(args) ?? args;
      if (!SENSITIVE_PATH.test(path)) return void 0;
      return {
        title: `access to sensitive path via ${name}`,
        detail: clipped(args),
        messageKey: "f.read.sensitive",
        params: { name, ...path !== args ? { path } : {} }
      };
    }
  },
  {
    id: "network",
    category: "network",
    severity: (event) => {
      const args = argsOf(event);
      return containsSecret(args) || SENSITIVE_PATH.test(args) ? "critical" : "warning";
    },
    match: (event) => {
      if (event.type !== "tool/call") return void 0;
      const name = toolName(event);
      if (!NETWORK_TOOLS.test(name)) return void 0;
      const args = argsOf(event);
      if (!NETWORK_RISK.test(args)) return void 0;
      return {
        title: `network request may carry sensitive data via ${name}`,
        detail: clipped(args),
        messageKey: "f.network",
        params: { name }
      };
    }
  },
  {
    id: "secret-output",
    category: "secret",
    severity: "critical",
    match: (event) => {
      if (event.type !== "tool/result") return void 0;
      const message = get2(event.data, "message");
      const text = messageText(message) || str(message) || str(get2(event.data, "error"));
      if (text === "" || !containsSecret(text)) return void 0;
      return {
        title: "tool output contains credential material",
        detail: clipped(text, 300),
        messageKey: "f.output.secret"
      };
    }
  },
  {
    id: "approval-denied",
    category: "approval",
    severity: "warning",
    match: (event) => {
      if (event.type !== "approval/decided") return void 0;
      const outcome = str(get2(event.data, "outcome") ?? get2(event.data, "decision"));
      if (!/deny|denied|reject|refus/iu.test(outcome)) return void 0;
      return { title: "user denied an approval", detail: clipped(outcome), messageKey: "f.approval.denied" };
    }
  },
  {
    id: "sandbox-change",
    category: "config",
    severity: (event) => {
      const mode = str(get2(event.data, "mode"));
      return /danger|full/iu.test(mode) ? "critical" : "serious";
    },
    match: (event) => event.type === "sandbox/mode" ? {
      title: `sandbox mode changed to ${str(get2(event.data, "mode")) || "unknown"}`,
      detail: clipped(JSON.stringify(event.data)),
      messageKey: "f.sandbox.change",
      params: { mode: str(get2(event.data, "mode")) }
    } : void 0
  },
  {
    id: "permission-change",
    category: "config",
    severity: (event) => {
      const preset = str(get2(event.data, "preset"));
      return /danger|full/iu.test(preset) ? "critical" : "serious";
    },
    match: (event) => event.type === "permission/preset" ? {
      title: `permission preset changed to ${str(get2(event.data, "preset")) || "unknown"}`,
      detail: clipped(JSON.stringify(event.data)),
      messageKey: "f.permission.change",
      params: { preset: str(get2(event.data, "preset")) }
    } : void 0
  },
  {
    id: "tool-error",
    category: "error",
    severity: "warning",
    match: (event) => {
      if (event.type !== "tool/result") return void 0;
      const error = get2(event.data, "error");
      if (error === void 0) return void 0;
      return {
        title: `tool failed: ${str(get2(error, "name"))}`,
        detail: clipped(str(get2(error, "code"))),
        messageKey: "f.tool.error",
        params: { name: str(get2(error, "name")), code: str(get2(error, "code")) }
      };
    }
  },
  {
    id: "turn-error",
    category: "error",
    severity: "warning",
    match: (event) => {
      if (event.type !== "turn/end") return void 0;
      const kind = str(get2(get2(event.data, "reason"), "kind"));
      if (kind === "" || kind === "completed" || kind === "aborted") return void 0;
      return { title: `turn ended abnormally: ${kind}`, messageKey: "f.turn.error", params: { kind } };
    }
  }
];
var SEVERITY_ORDER = ["critical", "serious", "warning", "info"];
var CONFIG_RULES = /* @__PURE__ */ new Set(["sandbox-change", "permission-change"]);
function auditSession(session, rules = DEFAULT_RULES) {
  const lastConfig = /* @__PURE__ */ new Map();
  const changedConfig = /* @__PURE__ */ new Set();
  let suppressed = 0;
  for (const event of session.events) {
    if (event.type !== "permission/preset" && event.type !== "sandbox/mode" && event.type !== "approval/policy") {
      continue;
    }
    const value = JSON.stringify(event.data);
    if (!lastConfig.has(event.type)) {
      lastConfig.set(event.type, value);
      suppressed++;
      continue;
    }
    if (lastConfig.get(event.type) === value) {
      suppressed++;
      continue;
    }
    lastConfig.set(event.type, value);
    changedConfig.add(event.seq);
  }
  const findings = [];
  for (const event of session.events) {
    for (const rule of rules) {
      if (CONFIG_RULES.has(rule.id) && !changedConfig.has(event.seq)) continue;
      const hit = rule.match(event);
      if (hit === void 0) continue;
      const severity = typeof rule.severity === "function" ? rule.severity(event) : rule.severity;
      findings.push({
        ruleId: rule.id,
        severity,
        category: hit.category ?? rule.category,
        seq: event.seq,
        time: event.time,
        ...hit
      });
    }
  }
  findings.sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.seq - b.seq
  );
  const counts = { critical: 0, serious: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return { findings, counts, scanned: session.events.length, rules: rules.length, suppressed };
}

// src/core/forktree.ts
function buildForkForest(entries) {
  const nodes = /* @__PURE__ */ new Map();
  for (const { header, title } of entries) {
    nodes.set(header.id, {
      id: header.id,
      header,
      title,
      children: [],
      seedLength: header.seedLength,
      depth: 0,
      row: 0
    });
  }
  const roots = [];
  for (const node of nodes.values()) {
    const parentId = node.header.parentSession;
    if (parentId === void 0) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(parentId);
    if (parent === void 0) {
      node.orphan = true;
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }
  const byCreated = (a, b) => a.header.createdAt - b.header.createdAt || a.id.localeCompare(b.id);
  roots.sort(byCreated);
  for (const node of nodes.values()) node.children.sort(byCreated);
  let row = 0;
  let maxDepth = 0;
  const visited = /* @__PURE__ */ new Set();
  const assign = (node, depth) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    node.depth = depth;
    node.row = row++;
    maxDepth = Math.max(maxDepth, depth);
    for (const child of node.children) assign(child, depth + 1);
  };
  for (const root of roots) assign(root, 0);
  for (const node of nodes.values()) {
    if (!visited.has(node.id)) {
      node.orphan = true;
      roots.push(node);
      assign(node, 0);
    }
  }
  return { roots, nodes, rowCount: row, maxDepth };
}
function lineageOf(forest, id) {
  const path = [];
  let current = forest.nodes.get(id);
  const guard = /* @__PURE__ */ new Set();
  while (current !== void 0 && !guard.has(current.id)) {
    guard.add(current.id);
    path.unshift(current);
    const parentId = current.header.parentSession;
    current = parentId === void 0 ? void 0 : forest.nodes.get(parentId);
  }
  return path;
}

// src/core/compare.ts
function stats(session, timeline, title) {
  const toolMix = {};
  let toolErrors = 0;
  for (const call of timeline.toolCalls) {
    toolMix[call.name] = (toolMix[call.name] ?? 0) + 1;
    if (call.error !== void 0) toolErrors++;
  }
  const steps = timeline.turns.reduce((n, t) => n + t.steps.length, 0);
  return {
    id: session.header.id,
    title,
    turns: timeline.turns.length,
    steps,
    events: timeline.eventCount,
    toolCallCount: timeline.toolCalls.length,
    toolErrors,
    inputTokens: timeline.totals.input,
    billedInputTokens: timeline.totals.billedInput,
    outputTokens: timeline.totals.output,
    cacheReadTokens: timeline.totals.cacheRead,
    durationMs: timeline.durationMs,
    models: timeline.models,
    toolMix
  };
}
function eventFingerprint(event) {
  return `${event.type}\0${JSON.stringify(event.data)}`;
}
function relatedBy(a, b, parentOf) {
  if (a.header.id === b.header.id) return "same";
  if (b.header.parentSession === a.header.id) return "a-parent-of-b";
  if (a.header.parentSession === b.header.id) return "b-parent-of-a";
  const ancestorsOfB = /* @__PURE__ */ new Set();
  let cursor = b.header.parentSession;
  while (cursor !== void 0 && !ancestorsOfB.has(cursor)) {
    ancestorsOfB.add(cursor);
    cursor = parentOf(cursor);
  }
  if (ancestorsOfB.has(a.header.id)) return "a-parent-of-b";
  const ancestorsOfA = /* @__PURE__ */ new Set();
  cursor = a.header.parentSession;
  while (cursor !== void 0 && !ancestorsOfA.has(cursor)) {
    ancestorsOfA.add(cursor);
    cursor = parentOf(cursor);
  }
  if (ancestorsOfA.has(b.header.id)) return "b-parent-of-a";
  if (a.header.parentSession !== void 0 && a.header.parentSession === b.header.parentSession) {
    return "siblings";
  }
  return "none";
}
function compareSessions(a, b, titles, parentOf = () => void 0) {
  const timelineA = buildTimeline(a);
  const timelineB = buildTimeline(b);
  const statsA = stats(a, timelineA, titles?.a);
  const statsB = stats(b, timelineB, titles?.b);
  const toolNames = [.../* @__PURE__ */ new Set([...Object.keys(statsA.toolMix), ...Object.keys(statsB.toolMix)])].sort();
  const relation = relatedBy(a, b, parentOf);
  const related = relation !== "none";
  let divergenceSeq;
  let divergenceA;
  let divergenceB;
  const shared = Math.min(a.events.length, b.events.length);
  for (let i = 0; i < shared; i++) {
    if (a.events[i].type === "session/end-seed" || b.events[i].type === "session/end-seed") {
      if (a.events[i].type !== b.events[i].type) {
        divergenceSeq = Math.min(a.events[i].seq, b.events[i].seq);
        divergenceA = a.events[i];
        divergenceB = b.events[i];
        break;
      }
      continue;
    }
    if (eventFingerprint(a.events[i]) !== eventFingerprint(b.events[i])) {
      divergenceSeq = a.events[i].seq;
      divergenceA = a.events[i];
      divergenceB = b.events[i];
      break;
    }
  }
  if (divergenceSeq === void 0 && a.events.length !== b.events.length) {
    divergenceSeq = shared > 0 ? (a.events[shared - 1]?.seq ?? 0) + 1 : 0;
    divergenceA = a.events[shared];
    divergenceB = b.events[shared];
  }
  return { a: statsA, b: statsB, toolNames, divergenceSeq, divergenceA, divergenceB, related, relation };
}

// src/core/cost.ts
var DEFAULT_PRICING = [
  {
    match: /deepseek.*pro/iu,
    rate: { input: 1.1, cacheRead: 0.27, output: 4.4 },
    label: "DeepSeek Pro",
    updatedAt: "2026-08-18",
    source: "provider list price (estimate)"
  },
  {
    match: /deepseek/iu,
    rate: { input: 0.27, cacheRead: 0.07, output: 1.1 },
    label: "DeepSeek",
    updatedAt: "2026-08-18",
    source: "provider list price (estimate)"
  },
  {
    match: /claude|anthropic/iu,
    rate: { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
    label: "Claude",
    updatedAt: "2026-08-18",
    source: "provider list price (estimate)"
  },
  {
    match: /gpt|^o\d|openai|codex/iu,
    rate: { input: 2.5, cacheRead: 1.25, output: 10 },
    label: "OpenAI",
    updatedAt: "2026-08-18",
    source: "provider list price (estimate)"
  },
  {
    match: /gemini/iu,
    rate: { input: 1.25, cacheRead: 0.31, output: 10 },
    label: "Gemini",
    updatedAt: "2026-08-18",
    source: "provider list price (estimate)"
  }
];
function costOf(totals, rate) {
  return (totals.input * rate.input + totals.cacheRead * rate.cacheRead + totals.cacheWrite * (rate.cacheWrite ?? rate.input) + totals.output * rate.output) / 1e6;
}
function estimateCost(totals, models, pricing = DEFAULT_PRICING) {
  const entry = pricing.find((p) => models.some((m) => p.match.test(m)));
  if (entry === void 0) return void 0;
  return { usd: costOf(totals, entry.rate), label: entry.label };
}
function estimateCostDetailed(modelTotals, pricing = DEFAULT_PRICING) {
  if (modelTotals === void 0 || modelTotals === null) return void 0;
  const parts = [];
  for (const [model, totals] of Object.entries(modelTotals)) {
    const entry = pricing.find((p) => p.match.test(model));
    if (entry === void 0) continue;
    parts.push({ model, label: entry.label, usd: costOf(totals, entry.rate), totals });
  }
  if (parts.length === 0) return void 0;
  const usd = parts.reduce((sum, part) => sum + part.usd, 0);
  const labels = [...new Set(parts.map((part) => part.label))];
  return { usd, label: labels.length === 1 ? labels[0] : `Mixed (${labels.length} models)`, parts };
}
function formatUsd(usd) {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}
function formatCny(usd, rate = 7.2) {
  const cny = usd * rate;
  if (cny >= 1) return `\xA5${cny.toFixed(2)}`;
  if (cny >= 0.01) return `\xA5${cny.toFixed(3)}`;
  return `\xA5${cny.toFixed(4)}`;
}
function formatMoney(usd, currency, rate = 7.2) {
  return currency === "CNY" ? formatCny(usd, rate) : formatUsd(usd);
}
export {
  DEFAULT_PRICING,
  DEFAULT_RULES,
  auditSession,
  buildForkForest,
  buildTimeline,
  compareSessions,
  containsSecret,
  decodeStorageRecord,
  estimateCost,
  estimateCostDetailed,
  expandChunkRow,
  formatCny,
  formatMoney,
  formatUsd,
  fromInspection,
  isChunkRow,
  lineageOf,
  parseSessionJsonl,
  redactSession,
  redactText,
  redactValue,
  summarizeToolArguments
};

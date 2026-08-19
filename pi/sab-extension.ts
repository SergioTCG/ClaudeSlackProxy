import fs from "node:fs";
import type { ExtensionAPI, ExtensionContext, ProjectTrustContext } from "@earendil-works/pi-coding-agent";
import { createManagedRunner } from "./managed-run.ts";

const ENDPOINT = process.env.CCS_ENDPOINT || "http://127.0.0.1:8877";
const TMUX = process.env.CCS_TMUX || "";
const FLAGS = process.env.CCS_FLAGS || "";
const SAFE_MODE = process.env.CCS_PI_SAFE === "1";
const pid = process.pid;

type BridgeMessage = {
  type: "prompt" | "control";
  text?: string;
  privateContext?: string;
  files?: Array<{ path: string; mimetype?: string }>;
  route?: "native";
  action?: string;
  value?: unknown;
  requestId?: string;
};

let activeContext: ExtensionContext | undefined;
let streamController: AbortController | undefined;
let registeredSessionId: string | undefined;
let assistantTexts: string[] = [];
let completedUsage: any;
let currentUsage: any;
let lastStatusAt = 0;
const terminalReplays = new Set<string>();

const eventUrl = (pathname: string) => {
  const url = new URL(pathname, ENDPOINT);
  url.searchParams.set("ppid", String(pid));
  if (TMUX) url.searchParams.set("tmux", TMUX);
  return url;
};

async function post(pathname: string, body: unknown, timeout = 3000) {
  const response = await fetch(eventUrl(pathname), {
    method: "POST",
    headers: { "content-type": "application/json", "x-ccs-provider": "pi", "x-ccs-flags": FLAGS },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`bridge returned HTTP ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function modelState(ctx: ExtensionContext, selectedModel = ctx.model, selectedEffort = ctx.thinkingLevel || "off") {
  const model = selectedModel;
  return {
    model: model ? `${model.provider}/${model.id}` : null,
    model_name: model?.name || null,
    model_input: model?.input || ["text"],
    effort: selectedEffort,
    context_usage: ctx.getContextUsage() || null,
  };
}

function addUsage(left: any, right: any) {
  if (!left && !right) return undefined;
  const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
  return {
    input: number(left?.input) + number(right?.input),
    output: number(left?.output) + number(right?.output),
    cacheRead: number(left?.cacheRead) + number(right?.cacheRead),
    cacheWrite: number(left?.cacheWrite) + number(right?.cacheWrite),
    reasoning: number(left?.reasoning) + number(right?.reasoning),
    totalTokens: number(left?.totalTokens) + number(right?.totalTokens),
    cost: {
      input: number(left?.cost?.input) + number(right?.cost?.input),
      output: number(left?.cost?.output) + number(right?.cost?.output),
      cacheRead: number(left?.cost?.cacheRead) + number(right?.cost?.cacheRead),
      cacheWrite: number(left?.cost?.cacheWrite) + number(right?.cost?.cacheWrite),
      total: number(left?.cost?.total) + number(right?.cost?.total),
    },
  };
}

const turnUsage = () => addUsage(completedUsage, currentUsage);

function sessionState(ctx: ExtensionContext) {
  return {
    session_id: ctx.sessionManager.getSessionId(),
    session_file: ctx.sessionManager.getSessionFile(),
    cwd: ctx.cwd,
    ...modelState(ctx),
  };
}

function assistantText(message: any) {
  if (message?.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

async function controlResult(ctx: ExtensionContext, message: BridgeMessage, result: Record<string, unknown>) {
  await post("/pi/event", {
    event: "ControlResult",
    ...sessionState(ctx),
    request_id: message.requestId,
    ...result,
  }).catch(() => {});
}

async function handleControl(pi: ExtensionAPI, managed: any, ctx: ExtensionContext, message: BridgeMessage) {
  try {
    if (message.action === "abort") {
      const managedState = await managed.pauseForAbort(ctx);
      if (!managedState) ctx.abort();
      return controlResult(ctx, message, { ok: true, managed: managedState });
    }
    if (message.action === "shutdown") {
      ctx.shutdown();
      return controlResult(ctx, message, { ok: true });
    }
    if (message.action === "models") {
      const models = ctx.modelRegistry.getAvailable().map(model => ({
        id: `${model.provider}/${model.id}`,
        name: model.name,
        reasoning: Boolean(model.reasoning),
        input: model.input || ["text"],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }));
      return controlResult(ctx, message, { ok: true, models });
    }
    if (message.action === "model") {
      const wanted = String(message.value || "");
      const model = ctx.modelRegistry.getAvailable().find(candidate =>
        `${candidate.provider}/${candidate.id}` === wanted || candidate.id === wanted);
      if (!model) return controlResult(ctx, message, { ok: false, error: `Model not found: ${wanted}` });
      const ok = await pi.setModel(model);
      return controlResult(ctx, message, ok ? { ok: true, ...modelState(ctx, model) } : { ok: false, error: "Model authentication is unavailable." });
    }
    if (message.action === "effort") {
      const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
      const level = String(message.value || "");
      if (!levels.has(level)) return controlResult(ctx, message, { ok: false, error: `Unsupported thinking level: ${level}` });
      pi.setThinkingLevel(level as any);
      return controlResult(ctx, message, { ok: true, ...modelState(ctx, ctx.model, pi.getThinkingLevel()) });
    }
    if (message.action?.startsWith("managed-")) {
      const result = await managed.control(ctx, message.action, message.value);
      return controlResult(ctx, message, result);
    }
    if (message.action === "state") return controlResult(ctx, message, { ok: true, ...modelState(ctx), usage: turnUsage() });
    return controlResult(ctx, message, { ok: false, error: "Unknown Pi control action." });
  } catch (error: any) {
    return controlResult(ctx, message, { ok: false, error: String(error?.message || error).slice(0, 500) });
  }
}

async function handlePrompt(pi: ExtensionAPI, ctx: ExtensionContext, message: BridgeMessage, managed: any) {
  const managedState = managed.snapshot();
  const routingState = managed.routingSnapshot();
  if ((managedState && ["active", "paused"].includes(managedState.status)) || routingState?.status === "routing") {
    await post("/pi/event", {
      event: "InputError", managed: managedState, routing: routingState,
      error: routingState?.status === "routing"
        ? "Pi is already assessing another prompt. Wait for its routing decision or use /pi-stop."
        : "A managed Pi run owns this session. Use /pi-run controls or cancel it before sending an ordinary prompt.",
      ...sessionState(ctx),
    }).catch(() => {});
    return;
  }
  const result = await managed.routePrompt(ctx, {
    text: String(message.text || ""), privateContext: String(message.privateContext || ""),
    files: Array.isArray(message.files) ? message.files : [], source: "slack",
    forceNative: message.route === "native",
  });
  if (!result.ok) {
    await post("/pi/event", {
      event: "InputError", error: result.error, managed: managed.snapshot(),
      routing: managed.routingSnapshot(), ...sessionState(ctx),
    }).catch(() => {});
  }
}

async function handleBridgeMessage(pi: ExtensionAPI, managed: any, message: BridgeMessage) {
  const ctx = activeContext;
  if (!ctx) return;
  if (message.type === "control") await handleControl(pi, managed, ctx, message);
  else if (message.type === "prompt") await handlePrompt(pi, ctx, message, managed);
}

async function consumeSse(pi: ExtensionAPI, managed: any, signal: AbortSignal) {
  const response = await fetch(eventUrl("/pi/stream"), { signal });
  if (!response.ok || !response.body) throw new Error(`stream returned HTTP ${response.status}`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as any) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const record = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = record.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
      if (!data) continue;
      try { await handleBridgeMessage(pi, managed, JSON.parse(data)); } catch {}
    }
  }
}

async function maintainStream(pi: ExtensionAPI, managed: any, signal: AbortSignal) {
  while (!signal.aborted) {
    try { await consumeSse(pi, managed, signal); } catch {}
    if (signal.aborted) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function deliverNativePrompt(pi: ExtensionAPI, ctx: ExtensionContext, value: {
  text: string;
  privateContext?: string;
  files?: Array<{ path: string; mimetype?: string }>;
  source?: "slack" | "terminal";
}) {
  const text = `${String(value.text || "")}${String(value.privateContext || "")}`;
  const files = Array.isArray(value.files) ? value.files : [];
  const images = files.filter(file => /^image\//.test(file.mimetype || ""));
  if (images.length && !ctx.model?.input?.includes("image")) {
    await post("/pi/event", {
      event: "InputError", ...sessionState(ctx),
      error: `The selected model ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(unknown)"} does not accept image input.`,
    }).catch(() => {});
    return;
  }
  const content: any[] = [{ type: "text", text }];
  for (const file of images) {
    try {
      content.push({
        type: "image", mimeType: file.mimetype || "image/png",
        data: fs.readFileSync(file.path).toString("base64"),
      });
    } catch (error: any) {
      await post("/pi/event", {
        event: "InputError", ...sessionState(ctx),
        error: `Could not read attachment: ${String(error?.message || error)}`,
      }).catch(() => {});
      return;
    }
  }
  if (value.source === "terminal") terminalReplays.add(text);
  pi.sendUserMessage(images.length ? content : text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
}

export default function sabPiExtension(pi: ExtensionAPI) {
  const managed = createManagedRunner(pi, {
    safeMode: SAFE_MODE,
    event: async (ctx: ExtensionContext, event: string, fields: Record<string, unknown> = {}) => {
      await post("/pi/event", { event, ...sessionState(ctx), ...fields }).catch(() => {});
    },
    deliverNative: (ctx, value) => deliverNativePrompt(pi, ctx, value),
  });

  pi.on("project_trust", async (event, ctx: ProjectTrustContext) => {
    if (!process.env.CCS_BRIDGE) return { trusted: "undecided" };
    try {
      const result = await post("/pi/trust", { cwd: event.cwd }, 580000);
      if (result?.trusted === "yes" || result?.trusted === "no") return { trusted: result.trusted, remember: Boolean(result.remember) };
    } catch {}
    return { trusted: "undecided" };
  });

  pi.on("session_start", async (event, ctx) => {
    activeContext = ctx;
    registeredSessionId = ctx.sessionManager.getSessionId();
    assistantTexts = [];
    completedUsage = undefined;
    currentUsage = undefined;
    streamController?.abort();
    streamController = new AbortController();
    const managedState = await managed.onSessionStart(ctx);
    const source = event.reason === "startup" && /(?:^|\s)(?:--session|-s)(?:=|\s)/.test(FLAGS) ? "resume" : event.reason;
    await post("/pi/event", { event: "SessionStart", source, ...managedState, ...sessionState(ctx) }).catch(() => {});
    void maintainStream(pi, managed, streamController.signal);
  });

  pi.on("input", async (event, ctx) => {
    if (!registeredSessionId) return;
    activeContext = ctx;
    const managedState = managed.snapshot();
    const routingState = managed.routingSnapshot();
    if ((managedState && ["active", "paused"].includes(managedState.status)) || routingState?.status === "routing") {
      const error = routingState?.status === "routing"
        ? "Pi is already assessing another prompt. Wait for its routing decision or interrupt it."
        : "A managed Pi run owns this session. Use its Slack controls or cancel it before entering an ordinary prompt.";
      ctx.ui.notify(error, "warning");
      await post("/pi/event", { event: "InputError", error, managed: managedState, routing: routingState, ...sessionState(ctx) }).catch(() => {});
      return { action: "handled" };
    }
    const replay = event.source === "extension" && terminalReplays.delete(event.text);
    if (!replay) {
      await post("/pi/event", { event: "UserPromptSubmit", prompt: event.text, source: event.source, ...sessionState(ctx) }).catch(() => {});
    }
    if (event.source === "extension" || managed.policy() === "native" || (event as any).images?.length) return;
    const result = await managed.routePrompt(ctx, { text: event.text, source: "terminal" });
    if (!result.ok) {
      ctx.ui.notify(result.error, "warning");
      await post("/pi/event", {
        event: "InputError", error: result.error, managed: managed.snapshot(),
        routing: managed.routingSnapshot(), ...sessionState(ctx),
      }).catch(() => {});
    }
    return { action: "handled" };
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!registeredSessionId) return;
    activeContext = ctx;
    assistantTexts = [];
    completedUsage = undefined;
    currentUsage = undefined;
    lastStatusAt = 0;
    await post("/pi/event", { event: "AgentStart", managed: managed.snapshot(), ...sessionState(ctx) }).catch(() => {});
  });

  pi.on("message_update", async (event, ctx) => {
    if (!registeredSessionId) return;
    activeContext = ctx;
    const message: any = event.message;
    if (message?.usage) currentUsage = message.usage;
    if (Date.now() - lastStatusAt < 2500) return;
    lastStatusAt = Date.now();
    await post("/pi/event", { event: "Status", usage: turnUsage(), managed: managed.snapshot(), ...sessionState(ctx) }).catch(() => {});
  });

  pi.on("message_end", async (event, ctx) => {
    if (!registeredSessionId) return;
    activeContext = ctx;
    const text = assistantText(event.message);
    if (text && assistantTexts.at(-1) !== text) assistantTexts.push(text);
    const message: any = event.message;
    if (message?.usage) {
      completedUsage = addUsage(completedUsage, message.usage);
      currentUsage = undefined;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!registeredSessionId) return;
    activeContext = ctx;
    const text = assistantTexts.join("\n\n");
    const decision = await managed.onAgentSettled(ctx, text, turnUsage());
    await post("/pi/event", {
      event: decision.mirror ? "Stop" : "ManagedCheckpoint",
      last_assistant_message: decision.mirror ? text : undefined,
      usage: turnUsage(), managed: managed.snapshot(),
      turn_id: ctx.sessionManager.getLeafId(), ...sessionState(ctx),
    }).catch(() => {});
    assistantTexts = [];
  });

  pi.on("model_select", async (_event, ctx) => {
    if (!registeredSessionId) return;
    activeContext = ctx;
    await post("/pi/event", { event: "Settings", ...sessionState(ctx) }).catch(() => {});
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    if (!registeredSessionId) return;
    activeContext = ctx;
    await post("/pi/event", { event: "Settings", ...sessionState(ctx) }).catch(() => {});
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!registeredSessionId) return undefined;
    activeContext = ctx;
    if (!SAFE_MODE) return undefined;
    if (event.toolName === "sab_goal") return undefined;
    try {
      const result = await post("/pi/permission", {
        session_id: ctx.sessionManager.getSessionId(), tool_name: event.toolName,
        tool_input: event.input,
      }, 580000);
      if (result?.behavior === "allow") return undefined;
      return { block: true, reason: result?.reason || "Denied from Slack." };
    } catch {
      return { block: true, reason: "Slack permission relay was unavailable." };
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    streamController?.abort();
    streamController = undefined;
    managed.shutdown();
    if (_event.reason === "quit" && registeredSessionId) {
      await post("/pi/event", { event: "SessionEnd", ...sessionState(ctx) }).catch(() => {});
    }
    registeredSessionId = undefined;
    activeContext = undefined;
  });
}

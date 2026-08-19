import { spawn, execFile as execFileCallback } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  budgetExceeded, createManagedRun, managedSnapshot, markCompletedSteps,
  normalizeManagedPolicy, parseManagedPlan, parseManagedReview, parseManagedRoute,
  restoreManagedRun, sanitizeRoutingSnapshot, subagentBudgetReason,
} from "./managed-core.mjs";

const execFile = promisify(execFileCallback);
const STATE_ENTRY = "sab-managed-run";
const POLICY_ENTRY = "sab-managed-policy";
const ROUTE_ENTRY = "sab-managed-route";
const CHILD_OUTPUT_LIMIT = 50 * 1024;
const REVIEW_DIFF_LIMIT = 60 * 1024;
const CHILD_TIMEOUT_MS = 15 * 60_000;
const ROUTER_TIMEOUT_MS = 2 * 60_000;

type ManagedHooks = {
  safeMode: boolean;
  event: (ctx: ExtensionContext, event: string, fields?: Record<string, unknown>) => Promise<void>;
  deliverNative: (ctx: ExtensionContext, value: {
    text: string;
    privateContext?: string;
    files?: Array<{ path: string; mimetype?: string }>;
    source?: "slack" | "terminal";
  }) => Promise<void>;
};

type ChildRole = "planner" | "scout" | "reviewer" | "worker";
type ChildResult = {
  role: ChildRole;
  text: string;
  exitCode: number;
  stderr: string;
  usage: Record<string, any>;
  turns: number;
  model?: string;
};

type ManagedDecision = { managed: boolean; mirror: boolean };

type RoutingValue = {
  text: string;
  privateContext?: string;
  files?: Array<{ path: string; mimetype?: string }>;
  source?: "slack" | "terminal";
  forceNative?: boolean;
};

const ROUTER_PROMPT = `You are a read-only complexity router for an interactive coding agent. Decide whether the user's prompt should run as a native single Pi turn or as a persistent managed run with planning, goals, optional subagents, validation, and independent review.

Choose native only for conversation, a factual explanation, one small read-only lookup, or an explicitly direct request that does not modify the workspace. Choose managed for implementation, fixes, refactors, file creation, multi-step investigation, review followed by action, long-running work, or any request that benefits from planning, persistent goals, subagents, validation, or review. When uncertain, choose managed.

Do not solve the task. Do not use tools. Your response MUST contain exactly one block and no prose after it:
<SAB_ROUTE_JSON>{"route":"managed","reason":"short reason"}</SAB_ROUTE_JSON>
or
<SAB_ROUTE_JSON>{"route":"native","reason":"short reason"}</SAB_ROUTE_JSON>`;

const ROLE_TOOLS: Record<ChildRole, string[]> = {
  planner: ["read", "grep", "find", "ls"],
  scout: ["read", "grep", "find", "ls"],
  reviewer: ["read", "grep", "find", "ls"],
  worker: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};

const ROLE_PROMPTS: Record<ChildRole, string> = {
  planner: `You are the planning leg of a managed coding run. Work read-only. Thoroughly inspect the repository and its canonical instructions before planning. Produce concrete, ordered, verifiable steps. Do not implement anything.

Your final response MUST contain exactly one machine-readable block:
<SAB_PLAN_JSON>{"summary":"one sentence","steps":["specific step 1","specific step 2"],"risks":["risk"]}</SAB_PLAN_JSON>

Use 2-24 steps. Each step must identify the intended result and relevant files or validation where known. Do not put prose after the closing tag.`,
  scout: `You are a read-only scout subagent. Investigate the assigned question with the available read/search tools. Return compressed evidence with exact file paths, relevant symbols, risks, and a recommended next action. Do not modify files.`,
  reviewer: `You are the independent review leg of a managed coding run. Work read-only. Inspect the stated goal, plan, repository state, changed files, and supplied diff. Be aggressive but adjudicate findings: report only defects that are concrete and relevant to the goal.

Your final response MUST contain exactly one machine-readable block:
<SAB_REVIEW_JSON>{"verdict":"pass","summary":"...","findings":[]}</SAB_REVIEW_JSON>
or
<SAB_REVIEW_JSON>{"verdict":"fix","summary":"...","findings":["file:line - concrete defect and required correction"]}</SAB_REVIEW_JSON>

Do not modify files and do not put prose after the closing tag.`,
  worker: `You are an isolated worker subagent in a managed coding run. Follow repository instructions, make only the requested scoped changes, validate them, and report exact files changed and remaining risks. Do not commit, push, deploy, or alter unrelated work.`,
};

function getPiInvocation(args: string[]) {
  const script = process.argv[1];
  if (script && fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
  return { command: "pi", args };
}

function childEnvironment() {
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (/^(?:CCS_|SLACK_|CODEX_|CLAUDE_CODE_)/.test(key)) delete childEnv[key];
  }
  return childEnv;
}

function finalAssistantText(message: any) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function capped(value: string, limit = CHILD_OUTPUT_LIMIT) {
  const text = String(value || "");
  if (Buffer.byteLength(text) <= limit) return text;
  let result = text.slice(0, limit);
  while (Buffer.byteLength(result) > limit) result = result.slice(0, -1);
  return `${result}\n\n[truncated by managed runner]`;
}

function executionPrompt(run: any) {
  const remaining = run.plan.filter((step: any) => step.status !== "done");
  return `[SAB MANAGED RUN ${run.id}]
Goal: ${run.goal}

Execute this approved plan autonomously:
${remaining.map((step: any) => `${step.id}. ${step.text}`).join("\n")}

Rules:
- Follow AGENTS.md and preserve unrelated changes.
- Work through the steps in order; use sab_subagent for focused read-only scouting when useful.
- After completing a step, call sab_goal with action=complete_step and its step id. Also emit [DONE:n].
- Run all relevant validation before declaring the implementation ready.
- Do not stop merely to report progress. If work remains, continue.
- When implementation and validation are ready for independent review, call sab_goal with action=review_ready and emit [REVIEW_READY].
- Do not commit, push, merge, deploy, or roll unless the original goal explicitly authorizes it.
${run.privateContext ? `\n${run.privateContext}` : ""}`;
}

function continuationPrompt(run: any) {
  const next = run.plan.find((step: any) => step.status !== "done");
  return `[SAB MANAGED RUN CONTINUE]
The goal remains active. ${next ? `Continue with step ${next.id}: ${next.text}` : "Finish validation and request review."}
Do not provide a terminal summary while work remains. Update progress with sab_goal and request review only when implementation and validation are ready.`;
}

function fixPrompt(run: any) {
  const findings = run.review?.findings || [];
  return `[SAB MANAGED RUN REVIEW FIXES]
The independent reviewer found issues that must be adjudicated and resolved:
${findings.map((finding: string, index: number) => `${index + 1}. ${finding}`).join("\n")}

Implement every valid correction, run relevant validation, then call sab_goal action=review_ready and emit [REVIEW_READY]. If a finding is demonstrably inapplicable, explain the concrete evidence in the next review handoff.`;
}

function finalPrompt(run: any) {
  return `[SAB MANAGED RUN FINAL RESPONSE]
The plan is complete and independent review passed.
Goal: ${run.goal}
Review: ${run.review?.summary || "passed"}

Give the user a concise final report: outcome, important files changed, validation performed, and any genuine residual risk. Do not begin new work. End with [GOAL_COMPLETE].`;
}

export function createManagedRunner(pi: ExtensionAPI, hooks: ManagedHooks) {
  let run: any = null;
  let policy = "auto";
  let routing: any = null;
  let context: ExtensionContext | undefined;
  let childAbort: AbortController | undefined;
  let routeAbort: AbortController | undefined;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  let reviewRequested = false;
  let suppressNextSettled = false;

  const snapshot = () => managedSnapshot(run);
  const routingSnapshot = () => sanitizeRoutingSnapshot(routing);

  async function emit(event = "ManagedStatus", fields: Record<string, unknown> = {}) {
    if (!context) return;
    await hooks.event(context, event, {
      managed: snapshot(), managed_policy: policy, routing: routingSnapshot(), ...fields,
    }).catch(() => {});
  }

  function persistPolicy() {
    pi.appendEntry(POLICY_ENTRY, { version: 1, policy, updatedAt: Date.now() });
  }

  function persistRouting() {
    if (!routing) return;
    routing.updatedAt = Date.now();
    pi.appendEntry(ROUTE_ENTRY, JSON.parse(JSON.stringify(routing)));
  }

  function persist() {
    if (!run) return;
    run.updatedAt = Date.now();
    pi.appendEntry(STATE_ENTRY, JSON.parse(JSON.stringify(run)));
  }

  async function update(event = "ManagedStatus", fields: Record<string, unknown> = {}) {
    persist();
    await emit(event, fields);
  }

  async function updateRouting(event = "ManagedRouting", fields: Record<string, unknown> = {}) {
    persistRouting();
    await emit(event, fields);
  }

  async function terminal(status: "failed" | "cancelled" | "paused", reason: string, notify = true) {
    if (!run) return;
    if (budgetTimer) clearTimeout(budgetTimer);
    budgetTimer = undefined;
    run.status = status;
    run.phase = status;
    run.activeAgent = null;
    run.lastError = reason.slice(0, 1000);
    await update("ManagedStatus", notify ? { notice: reason } : {});
  }

  function armBudgetTimer() {
    if (budgetTimer) clearTimeout(budgetTimer);
    budgetTimer = undefined;
    if (!run || run.status !== "active") return;
    const expectedId = run.id;
    const timerContext = context;
    const remaining = run.startedAt + run.budgets.maxMinutes * 60_000 - Date.now();
    budgetTimer = setTimeout(() => {
      if (!run || run.id !== expectedId || run.status !== "active") return;
      const parentWasBusy = timerContext ? !timerContext.isIdle() : false;
      run.resumePhase = run.phase;
      childAbort?.abort();
      suppressNextSettled = parentWasBusy;
      if (parentWasBusy) timerContext?.abort();
      void terminal("paused", `Managed run paused: time budget reached (${run.budgets.maxMinutes}m).`);
    }, Math.max(0, remaining));
  }

  async function runChild(role: ChildRole, task: string, ctx: ExtensionContext, signal?: AbortSignal, required = false): Promise<ChildResult> {
    if (!run || run.status !== "active") throw new Error("No managed run is active.");
    const expectedId = run.id;
    const budgetReason = subagentBudgetReason(run, role, required);
    if (budgetReason) throw new Error(budgetReason);
    if (hooks.safeMode && role === "worker") {
      throw new Error("Worker subagents are disabled in --safe mode because child writes cannot use the parent Slack approval gate.");
    }

    run.counters.subagents++;
    run.activeAgent = role;
    await update();
    if (!run || run.id !== expectedId || run.status !== "active") throw new Error(`${role} subagent was interrupted`);

    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
    const args = [
      "--mode", "json", "--print", "--no-session", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-approve",
      "--tools", ROLE_TOOLS[role].join(","),
      "--system-prompt", ROLE_PROMPTS[role],
    ];
    if (model) args.push("--model", model);
    if (ctx.thinkingLevel) args.push("--thinking", ctx.thinkingLevel);
    args.push(`Task: ${task}`);

    const controller = new AbortController();
    childAbort = controller;
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const result: ChildResult = {
      role, text: "", exitCode: 1, stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
      turns: 0, model: model || undefined,
    };

    const invocation = getPiInvocation(args);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(invocation.command, invocation.args, {
        cwd: ctx.cwd,
        env: childEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => { if (proc.exitCode == null) proc.kill("SIGKILL"); }, 3000);
      }, CHILD_TIMEOUT_MS);

      const abort = () => {
        proc.kill("SIGTERM");
        setTimeout(() => { if (proc.exitCode == null) proc.kill("SIGKILL"); }, 3000);
      };
      if (combined.aborted) abort();
      else combined.addEventListener("abort", abort, { once: true });

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type !== "message_end" || !event.message) return;
        const text = finalAssistantText(event.message);
        if (text) result.text = text;
        if (event.message.role === "assistant") {
          result.turns++;
          const usage = event.message.usage || {};
          for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
            result.usage[key] += Number(usage[key]) || 0;
          }
          result.usage.cost.total += Number(usage.cost?.total) || 0;
          if (event.message.model) result.model = event.message.model;
        }
      };

      proc.stdout.on("data", data => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", data => { result.stderr = capped(result.stderr + data.toString(), 8000); });
      proc.on("error", error => {
        clearTimeout(timer);
        combined.removeEventListener("abort", abort);
        reject(error);
      });
      proc.on("close", code => {
        clearTimeout(timer);
        combined.removeEventListener("abort", abort);
        if (buffer.trim()) processLine(buffer);
        result.exitCode = code ?? 1;
        resolve();
      });
    });
    if (childAbort === controller) childAbort = undefined;

    if (combined.aborted || !run || run.id !== expectedId || run.status !== "active") {
      throw new Error(`${role} subagent was interrupted`);
    }
    run.counters.childTurns += result.turns;
    run.counters.childTokens += Number(result.usage.totalTokens) || 0;
    run.counters.childOutputTokens += Number(result.usage.output) || 0;
    await update("ManagedChildUsage", { usage: result.usage, child_role: role });
    if (result.exitCode !== 0 || !result.text.trim()) {
      throw new Error(`${role} subagent failed${result.stderr ? `: ${result.stderr.slice(0, 1000)}` : ""}`);
    }
    result.text = capped(result.text);
    return result;
  }

  async function runRouter(task: string, ctx: ExtensionContext, signal: AbortSignal) {
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
    const args = [
      "--mode", "json", "--print", "--no-session", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-approve", "--no-tools",
      "--thinking", "low", "--system-prompt", ROUTER_PROMPT,
    ];
    if (model) args.push("--model", model);
    args.push(`User prompt:\n${String(task || "").slice(0, 8000)}`);

    const result = {
      text: "", exitCode: 1, stderr: "", turns: 0, model: model || undefined,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    };
    const invocation = getPiInvocation(args);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(invocation.command, invocation.args, {
        cwd: ctx.cwd, env: childEnvironment(), shell: false, stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";
      const stop = () => {
        proc.kill("SIGTERM");
        setTimeout(() => { if (proc.exitCode == null) proc.kill("SIGKILL"); }, 3000);
      };
      const timer = setTimeout(stop, ROUTER_TIMEOUT_MS);
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type !== "message_end" || !event.message) return;
        const text = finalAssistantText(event.message);
        if (text) result.text = text;
        if (event.message.role === "assistant") {
          result.turns++;
          const usage = event.message.usage || {};
          for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
            result.usage[key] += Number(usage[key]) || 0;
          }
          result.usage.cost.total += Number(usage.cost?.total) || 0;
          if (event.message.model) result.model = event.message.model;
        }
      };
      proc.stdout.on("data", data => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", data => { result.stderr = capped(result.stderr + data.toString(), 8000); });
      proc.on("error", error => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        reject(error);
      });
      proc.on("close", code => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        if (buffer.trim()) processLine(buffer);
        result.exitCode = code ?? 1;
        resolve();
      });
    });
    if (signal.aborted) throw new Error("Adaptive routing was cancelled.");
    if (result.exitCode !== 0 || !result.text.trim()) {
      throw new Error(`router failed${result.stderr ? `: ${result.stderr.slice(0, 1000)}` : ""}`);
    }
    return result;
  }

  async function beginExecution() {
    if (!run || !context) return;
    const expectedId = run.id;
    run.status = "active";
    run.phase = "executing";
    run.activeAgent = "worker";
    reviewRequested = false;
    await update();
    if (!run || run.id !== expectedId || run.status !== "active" || run.phase !== "executing") return;
    armBudgetTimer();
    pi.sendMessage({ customType: "sab-managed-execute", content: executionPrompt(run), display: true }, { triggerTurn: true });
  }

  async function plan() {
    if (!run || !context) return;
    const expectedId = run.id;
    try {
      const result = await runChild("planner", `Goal: ${run.goal}\nCreate the implementation plan.`, context, undefined, true);
      if (!run || run.id !== expectedId || run.status !== "active") return;
      const parsed = parseManagedPlan(result.text);
      run.plan = parsed.steps;
      run.summary = parsed.summary;
      run.risks = parsed.risks;
      run.activeAgent = null;
      if (run.mode === "plan") {
        run.status = "paused";
        run.phase = "awaiting-approval";
      }
      await update("ManagedPlan", { plan: parsed, auto: run.mode === "auto" });
      if (run.mode === "auto" && run.status === "active" && run.phase === "planning") await beginExecution();
    } catch (error: any) {
      if (run?.id === expectedId && run.status === "active") await terminal("failed", `Planning failed: ${String(error?.message || error)}`);
    }
  }

  async function repositoryReviewContext(ctx: ExtensionContext) {
    const options = { cwd: ctx.cwd, maxBuffer: 2 * 1024 * 1024 };
    const [status, diff, staged] = await Promise.all([
      execFile("git", ["status", "--short"], options).then(result => result.stdout).catch(() => ""),
      execFile("git", ["diff", "--no-ext-diff", "--"], options).then(result => result.stdout).catch(() => ""),
      execFile("git", ["diff", "--cached", "--no-ext-diff", "--"], options).then(result => result.stdout).catch(() => ""),
    ]);
    return `Goal: ${run.goal}\n\nPlan:\n${run.plan.map((step: any) => `${step.id}. [${step.status}] ${step.text}`).join("\n")}\n\nGit status:\n${capped(status, 12000) || "clean"}\n\nWorking diff:\n${capped(diff, REVIEW_DIFF_LIMIT) || "(none)"}\n\nStaged diff:\n${capped(staged, REVIEW_DIFF_LIMIT) || "(none)"}`;
  }

  async function review() {
    if (!run || !context) return;
    const expectedId = run.id;
    if (run.counters.reviewCycles >= run.budgets.maxReviewCycles) {
      return terminal("paused", `Review-cycle budget reached (${run.budgets.maxReviewCycles}). Inspect the run and start a new managed slice if further work is needed.`);
    }
    run.phase = "reviewing";
    run.activeAgent = "reviewer";
    run.counters.reviewCycles++;
    await update();
    if (!run || run.id !== expectedId || run.status !== "active" || run.phase !== "reviewing") return;
    try {
      const task = await repositoryReviewContext(context);
      const result = await runChild("reviewer", task, context, undefined, true);
      if (!run || run.id !== expectedId || run.status !== "active") return;
      const verdict = parseManagedReview(result.text);
      run.review = verdict;
      run.activeAgent = null;
      reviewRequested = false;
      if (verdict.verdict === "pass") {
        run.phase = "finalizing";
        run.activeAgent = "worker";
        await update("ManagedReview", { review: verdict });
        if (!run || run.id !== expectedId || run.status !== "active" || run.phase !== "finalizing") return;
        pi.sendMessage({ customType: "sab-managed-final", content: finalPrompt(run), display: true }, { triggerTurn: true });
      } else {
        run.phase = "fixing";
        run.activeAgent = "worker";
        await update("ManagedReview", { review: verdict });
        if (!run || run.id !== expectedId || run.status !== "active" || run.phase !== "fixing") return;
        pi.sendMessage({ customType: "sab-managed-fix", content: fixPrompt(run), display: true }, { triggerTurn: true });
      }
    } catch (error: any) {
      if (run?.id === expectedId && run.status === "active") await terminal("failed", `Review failed: ${String(error?.message || error)}`);
    }
  }

  async function resume() {
    if (!run || !context || run.status !== "active") return;
    if (run.phase === "planning") return plan();
    if (run.phase === "reviewing") return review();
    const content = run.phase === "fixing" ? fixPrompt(run)
      : run.phase === "finalizing" ? finalPrompt(run)
        : continuationPrompt(run);
    pi.sendMessage({ customType: "sab-managed-resume", content, display: true }, { triggerTurn: true });
  }

  async function start(ctx: ExtensionContext, value: any) {
    context = ctx;
    if (!ctx.isIdle()) return { ok: false, error: "Pi is busy. Wait for the current turn or interrupt it before starting a managed run." };
    if (run && ["active", "paused"].includes(run.status)) {
      return { ok: false, error: `Managed run ${run.id.slice(0, 8)} is ${run.status}; cancel it before starting another.` };
    }
    run = createManagedRun({
      id: crypto.randomUUID(), goal: value?.goal, mode: value?.mode,
      budgets: value?.budgets, privateContext: value?.privateContext,
    });
    const expectedId = run.id;
    suppressNextSettled = false;
    run.activeAgent = "planner";
    await update();
    if (!run || run.id !== expectedId || run.status !== "active" || run.phase !== "planning") {
      return { ok: false, error: "Managed run was interrupted before planning started." };
    }
    armBudgetTimer();
    void plan();
    return { ok: true, managed: snapshot() };
  }

  async function completeRouting(ctx: ExtensionContext, expectedId: string) {
    if (!routing || routing.id !== expectedId || routing.status !== "routing") return;
    let decision: { route: "managed" | "native"; reason: string };
    let usage: any = null;
    try {
      if (routing.policy === "always") {
        decision = { route: "managed", reason: "session policy is always managed" };
      } else {
        const result = await runRouter(routing.text, ctx, routeAbort!.signal);
        usage = result.usage;
        decision = parseManagedRoute(result.text) as typeof decision;
      }
    } catch (error: any) {
      if (!routing || routing.id !== expectedId || routeAbort?.signal.aborted) return;
      decision = {
        route: "managed",
        reason: `classification failed safely; promoted to managed (${String(error?.message || error).slice(0, 300)})`,
      };
    }
    if (!routing || routing.id !== expectedId || routeAbort?.signal.aborted) return;
    const value = routing;
    routing.status = decision.route;
    routing.reason = decision.reason;
    await updateRouting("ManagedRoute", { route: decision.route, reason: decision.reason, usage });
    routeAbort = undefined;
    routing = null;
    if (decision.route === "native") {
      await hooks.deliverNative(ctx, {
        text: value.text, privateContext: value.privateContext, files: value.files, source: value.source,
      });
      return;
    }
    const result = await start(ctx, {
      goal: value.text, mode: "auto", privateContext: value.privateContext,
    });
    if (!result.ok) await emit("ManagedStatus", { notice: `Adaptive promotion failed: ${result.error}` });
  }

  async function routePrompt(ctx: ExtensionContext, value: RoutingValue) {
    context = ctx;
    const text = String(value?.text || "").trim().slice(0, 8000);
    if (!text) return { ok: false, error: "Pi prompt is empty." };
    if (run && ["active", "paused"].includes(run.status)) {
      return { ok: false, error: `Managed run ${run.id.slice(0, 8)} is ${run.status}; cancel it before sending another prompt.` };
    }
    if (routing?.status === "routing") {
      return { ok: false, error: "Pi is already assessing another prompt. Wait for its routing decision or use /pi-stop." };
    }
    const files = Array.isArray(value.files)
      ? value.files.slice(0, 20).map(file => ({
        path: String(file.path || "").slice(0, 4000),
        mimetype: file.mimetype ? String(file.mimetype).slice(0, 200) : undefined,
      }))
      : [];
    if (value.forceNative || policy === "native") {
      await hooks.deliverNative(ctx, { text, privateContext: value.privateContext, files, source: value.source });
      return { ok: true, route: "native", policy };
    }
    routing = {
      version: 1, id: crypto.randomUUID(), status: "routing", policy,
      source: value.source === "terminal" ? "terminal" : "slack",
      text, privateContext: String(value.privateContext || "").slice(0, 4000), files,
      startedAt: Date.now(), updatedAt: Date.now(), reason: null,
    };
    routeAbort = new AbortController();
    const expectedId = routing.id;
    await updateRouting("ManagedRouting");
    void completeRouting(ctx, expectedId);
    return { ok: true, route: "routing", policy, routing: routingSnapshot() };
  }

  async function control(ctx: ExtensionContext, action: string, value?: any) {
    context = ctx;
    if (action === "managed-start") return start(ctx, value);
    if (action === "managed-status" || action === "managed-policy-status") {
      return { ok: true, managed: snapshot(), managed_policy: policy, routing: routingSnapshot(), plan: run?.plan || [], review: run?.review || null };
    }
    if (action === "managed-policy") {
      policy = normalizeManagedPolicy(value?.policy ?? value);
      persistPolicy();
      await emit("ManagedPolicy");
      return { ok: true, managed_policy: policy, managed: snapshot(), routing: routingSnapshot() };
    }
    if (action === "managed-direct") {
      return routePrompt(ctx, {
        text: value?.goal ?? value, privateContext: value?.privateContext,
        files: value?.files, source: "slack", forceNative: true,
      });
    }
    if (action === "managed-cancel" && routing?.status === "routing") {
      const cancelled = routingSnapshot();
      routeAbort?.abort();
      routing.status = "cancelled";
      routing.reason = "adaptive routing cancelled by the owner";
      await updateRouting("ManagedRoute", { route: "cancelled", reason: routing.reason });
      routeAbort = undefined;
      routing = null;
      return { ok: true, routing_cancelled: true, routing: cancelled, managed_policy: policy };
    }
    if (!run) return { ok: false, error: "No managed run exists in this Pi session." };
    if (action === "managed-pause") {
      if (run.status !== "active") return { ok: false, error: `Managed run is ${run.status}.` };
      const parentWasBusy = !ctx.isIdle();
      run.resumePhase = run.phase;
      childAbort?.abort();
      suppressNextSettled = parentWasBusy;
      if (parentWasBusy) ctx.abort();
      await terminal("paused", "Managed run paused by the owner. Resume with /pi-run continue.", false);
      return { ok: true, managed: snapshot() };
    }
    if (action === "managed-cancel") {
      if (!["active", "paused"].includes(run.status)) return { ok: false, error: `Managed run is already ${run.status}.` };
      const parentWasBusy = !ctx.isIdle();
      childAbort?.abort();
      suppressNextSettled = parentWasBusy;
      if (parentWasBusy) ctx.abort();
      await terminal("cancelled", "Managed run cancelled by the owner.", false);
      return { ok: true, managed: snapshot() };
    }
    if (action === "managed-approve") {
      if (run.phase !== "awaiting-approval") return { ok: false, error: "The managed run is not waiting for plan approval." };
      const exhausted = budgetExceeded(run);
      if (exhausted) return { ok: false, error: `Cannot approve: ${exhausted}. Start a new managed slice with a larger budget.` };
      return beginExecution().then(() => ({ ok: true, managed: snapshot() }));
    }
    if (action === "managed-continue") {
      if (run.status !== "paused") return { ok: false, error: `Managed run is ${run.status}, not paused.` };
      const exhausted = budgetExceeded(run);
      if (exhausted) return { ok: false, error: `Cannot continue: ${exhausted}. Start a new managed slice with a larger budget.` };
      if (run.phase === "awaiting-approval") return beginExecution().then(() => ({ ok: true, managed: snapshot() }));
      const resumePhase = run.resumePhase || "executing";
      if (!["planning", "executing", "reviewing", "fixing", "finalizing"].includes(resumePhase) ||
          (resumePhase !== "planning" && run.plan.length < 2)) {
        return { ok: false, error: "The persisted managed-run phase is incomplete and cannot be continued safely. Cancel it and start a new managed slice." };
      }
      run.status = "active";
      run.phase = resumePhase;
      run.activeAgent = ["planning", "reviewing"].includes(run.phase) ? run.phase === "planning" ? "planner" : "reviewer" : "worker";
      run.lastError = null;
      await update();
      armBudgetTimer();
      void resume();
      return { ok: true, managed: snapshot() };
    }
    return { ok: false, error: `Unknown managed-run action: ${action}` };
  }

  async function onSessionStart(ctx: ExtensionContext) {
    context = ctx;
    const entries = ctx.sessionManager.getEntries();
    const entry = entries
      .filter((item: any) => item.type === "custom" && item.customType === STATE_ENTRY)
      .at(-1) as any;
    run = restoreManagedRun(entry?.data);
    const policyEntry = entries
      .filter((item: any) => item.type === "custom" && item.customType === POLICY_ENTRY)
      .at(-1) as any;
    policy = normalizeManagedPolicy(policyEntry?.data?.policy);
    const routeEntry = entries
      .filter((item: any) => item.type === "custom" && item.customType === ROUTE_ENTRY)
      .at(-1) as any;
    const savedRoute = routeEntry?.data;
    routing = savedRoute?.version === 1 && savedRoute?.status === "routing" && savedRoute?.id && savedRoute?.text
      ? JSON.parse(JSON.stringify(savedRoute))
      : null;
    if (run?.status === "active") {
      const expectedId = run.id;
      armBudgetTimer();
      setTimeout(() => { if (run?.id === expectedId) void resume(); }, 1000);
    } else if (routing) {
      const expectedId = routing.id;
      routeAbort = new AbortController();
      setTimeout(() => { if (routing?.id === expectedId) void completeRouting(ctx, expectedId); }, 1000);
    }
    return { managed: snapshot(), managed_policy: policy, routing: routingSnapshot() };
  }

  function beforeAgentStart() {
    if (!run || run.status !== "active" || !["executing", "fixing", "finalizing"].includes(run.phase)) return undefined;
    const remaining = run.plan.filter((step: any) => step.status !== "done");
    return {
      message: {
        customType: "sab-managed-context",
        display: false,
        content: `[SAB MANAGED RUN ACTIVE]\nGoal: ${run.goal}\nPhase: ${run.phase}\nRemaining plan:\n${remaining.map((step: any) => `${step.id}. ${step.text}`).join("\n") || "implementation complete; produce the requested final response"}`,
      },
    };
  }

  async function onAgentSettled(ctx: ExtensionContext, text: string, usage: any = null): Promise<ManagedDecision> {
    context = ctx;
    if (suppressNextSettled) {
      suppressNextSettled = false;
      return { managed: true, mirror: false };
    }
    if (!run || run.status !== "active" || !["executing", "fixing", "finalizing"].includes(run.phase)) {
      return { managed: false, mirror: true };
    }
    run.counters.parentTurns++;
    run.counters.parentTokens += Number(usage?.totalTokens) || 0;
    run.counters.parentOutputTokens += Number(usage?.output) || 0;
    markCompletedSteps(run, text);

    if (run.phase === "finalizing") {
      if (budgetTimer) clearTimeout(budgetTimer);
      budgetTimer = undefined;
      run.status = "complete";
      run.phase = "complete";
      run.activeAgent = null;
      await update("ManagedStatus", { notice: "Managed run completed after independent review." });
      return { managed: true, mirror: true };
    }

    const budget = budgetExceeded(run);
    if (budget) {
      await terminal("paused", `Managed run paused: ${budget}.`);
      return { managed: true, mirror: false };
    }

    const allDone = run.plan.length > 0 && run.plan.every((step: any) => step.status === "done");
    const ready = reviewRequested || allDone || /\[(?:REVIEW_READY|GOAL_COMPLETE)]/i.test(text);
    if (ready) {
      void review();
      return { managed: true, mirror: false };
    }

    run.counters.continuations++;
    await update("ManagedStatus");
    const expectedId = run.id;
    setTimeout(() => {
      if (!run || run.id !== expectedId || run.status !== "active") return;
      const content = run.phase === "fixing" ? fixPrompt(run) : continuationPrompt(run);
      pi.sendMessage({ customType: "sab-managed-continue", content, display: true }, { triggerTurn: true });
    }, 250);
    return { managed: true, mirror: false };
  }

  async function pauseForAbort(ctx: ExtensionContext) {
    if (routing?.status === "routing") {
      const cancelled = routingSnapshot();
      routeAbort?.abort();
      routing.status = "cancelled";
      routing.reason = "adaptive routing cancelled by interrupt";
      await updateRouting("ManagedRoute", { route: "cancelled", reason: routing.reason });
      routeAbort = undefined;
      routing = null;
      return { routing_cancelled: true, routing: cancelled };
    }
    if (!run || run.status !== "active") return null;
    const parentWasBusy = !ctx.isIdle();
    run.resumePhase = run.phase;
    childAbort?.abort();
    suppressNextSettled = parentWasBusy;
    if (parentWasBusy) ctx.abort();
    await terminal("paused", "Managed run paused by interrupt. Resume with /pi-run continue.", false);
    return snapshot();
  }

  function shutdown() {
    if (budgetTimer) clearTimeout(budgetTimer);
    budgetTimer = undefined;
    childAbort?.abort();
    childAbort = undefined;
    routeAbort?.abort();
    routeAbort = undefined;
    context = undefined;
  }

  pi.registerTool({
    name: "sab_goal",
    label: "Managed goal",
    description: "Inspect or update the active SAB managed goal. Mark completed plan steps and request independent review instead of stopping early.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "complete_step", "review_ready", "block"] },
        step: { type: "number" },
        note: { type: "string" },
      },
      required: ["action"], additionalProperties: false,
    } as any,
    async execute(_id: string, params: any, _signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) {
      if (!run) return { content: [{ type: "text", text: "No managed run is active." }], details: null };
      if (params.action === "complete_step") {
        const step = run.plan.find((item: any) => item.id === Number(params.step));
        if (!step) return { content: [{ type: "text", text: `Unknown plan step: ${params.step}` }], details: snapshot() };
        step.status = "done";
      } else if (params.action === "review_ready") {
        reviewRequested = true;
      } else if (params.action === "block") {
        run.resumePhase = run.phase;
        suppressNextSettled = true;
        await terminal("paused", `Managed run blocked: ${String(params.note || "agent reported a blocker")}`);
        setTimeout(() => ctx.abort(), 0);
      }
      await update();
      return { content: [{ type: "text", text: `Managed goal: ${run.phase}; ${run.plan.filter((item: any) => item.status === "done").length}/${run.plan.length} steps complete.` }], details: snapshot() };
    },
  });

  pi.registerTool({
    name: "sab_subagent",
    label: "Managed subagent",
    description: "Run one isolated planner, scout, reviewer, or worker Pi child. Children inherit the model/thinking level but never inherit the Slack bridge. Prefer read-only scout/reviewer roles; worker is unavailable in SAB --safe mode.",
    parameters: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["planner", "scout", "reviewer", "worker"] },
        task: { type: "string" },
      },
      required: ["role", "task"], additionalProperties: false,
    } as any,
    async execute(_id: string, params: any, signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) {
      if (!run || run.status !== "active") return { content: [{ type: "text", text: "No active managed run." }], details: null };
      try {
        const result = await runChild(params.role as ChildRole, String(params.task || "").slice(0, 12_000), ctx, signal);
        run.activeAgent = run.phase === "reviewing" ? "reviewer" : "worker";
        await update();
        return { content: [{ type: "text", text: result.text }], details: { role: result.role, usage: result.usage, turns: result.turns, model: result.model } };
      } catch (error: any) {
        if (run?.status === "active") {
          run.activeAgent = "worker";
          await update();
        }
        return { content: [{ type: "text", text: `Subagent failed: ${String(error?.message || error)}` }], details: { error: String(error?.message || error) } };
      }
    },
  });

  pi.on("before_agent_start", async () => beforeAgentStart());

  return {
    control, onSessionStart, onAgentSettled, pauseForAbort, snapshot, routingSnapshot,
    policy: () => policy, routePrompt, shutdown,
  };
}

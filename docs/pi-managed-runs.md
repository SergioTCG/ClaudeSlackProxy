# Managed Pi runs

Pi intentionally keeps its native interaction model simple; it does not ship a
Claude Code/Codex-style plan mode, persistent goal loop, or subagent system.
Slack Agent Bridge adds those behaviors as an adaptive orchestration layer.
Ordinary owner prompts default to `auto`: a separate read-only, tool-free,
low-thinking Pi call decides whether to preserve native one-turn behavior or
promote the request into a managed run. Classification failure or ambiguity
promotes safely. Collaborator prompts always remain native.

The policy is stored in the native Pi session and survives resume:

```text
/pi-run mode                 # show auto, always, or native
/pi-run mode auto            # classify each ordinary owner prompt (default)
/pi-run mode always          # promote every ordinary owner prompt
/pi-run mode native          # never classify ordinary prompts
/pi-run direct Explain this  # bypass routing for this prompt only
```

The router sees the visible prompt but not its private artifact-upload grant.
Its child process has no tools, session, bridge identity, extensions, skills,
themes, project approval, or inherited bridge/Slack/other-agent environment.
Selected-model authentication still follows Pi's normal provider configuration. Slack shows
an ephemeral complexity-assessment status and posts a durable reason only when
a prompt is promoted.

## Start and control a run

Run these commands in a live Pi session channel:

```text
/pi-run Implement the requested feature and validate it
/pi-run plan Investigate the repository and propose the migration
/pi-run status
/pi-run approve
/pi-run pause
/pi-run continue
/pi-run cancel
```

The explicit goal form forces managed execution: it plans and then executes
automatically. The `plan` form runs
the same read-only planner but pauses before any implementation; inspect the
plan in Slack and use `/pi-run approve` to proceed. A normal `/pi-stop` pauses
an active managed run rather than silently abandoning its state.

While routing is pending, or a run is active or paused, it exclusively owns the Pi leg. Ordinary
Slack prompts and terminal input are rejected visibly instead of racing the
planner, worker, or reviewer. Complete or cancel the run before returning to
ordinary prompting.

The working message includes the phase, current plan step, active role, elapsed
time, and cumulative parent/child Pi token plus current-context counters.
Durable Slack messages carry the
plan, review findings, terminal failures, budget pauses, and final result.

## Execution model

One native Pi session remains the parent and owns all conversation history.
The bridge drives this state machine:

```text
read-only planner → parent worker turns → read-only reviewer
                                      ↘ fixes → reviewer
                                              ↘ final response
```

The parent receives a `sab_goal` tool for explicit step completion, blockers,
and review readiness. It may use `sab_subagent` for a focused planner, scout,
reviewer, or worker task. Children run sequentially, without a persisted Pi
session, and return compressed results to the parent. The independent final
review is always bridge-scheduled rather than self-certified by the worker.

Each child inherits the current Pi model and thinking level. It does not inherit
the Slack bridge, tmux identity, upload grant, parent session, extensions,
skills, prompt templates, themes, or Pi project-resource approval. Planner,
scout, and reviewer roles are read-only. A worker child can write only in
ordinary unrestricted mode; SAB `--safe` disables worker children so no child
can bypass the parent's Slack tool-approval gate.

## Budgets and persistence

Defaults are 120 minutes, 24 parent turns, eight total child legs, and two
review cycles. Override them per run:

```text
/pi-run Implement the migration --minutes=240 --turns=40 --agents=12 --reviews=3
```

Accepted ranges are 5–1440 minutes, 1–100 parent turns, 2–32 child legs, and
1–10 review cycles. Planner and independent-reviewer legs count against the
child budget; the runner reserves capacity for review before optional scouts or
workers can consume it. The child budget must be at least one greater than the
review-cycle budget so the initial planner also fits. Reaching a wall-clock,
turn, or review limit pauses the
run with a visible explanation instead of silently looping.

Routing policy, a pending routing request, goal, plan, phase, counters, review
result, and progress are bounded custom entries in Pi's native session. They
survive daemon restart, terminal close, and native session resume. The Slack daemon keeps only a bounded status
snapshot for display. A provider switch requires the run to be paused; managed
state stays with the saved Pi leg and is not copied into Claude or Codex.
The original slash request receives the same private, expiring artifact-upload
capability as an ordinary Slack prompt. It is kept out of daemon snapshots and
Slack status output.

## Boundaries

Managed mode improves reliability through explicit decomposition,
continuation, and independent review. It does not enlarge the selected model's
context or reasoning ability, guarantee correctness, parallelize one local GPU,
or create a security sandbox. In unrestricted mode, work still runs with the
same local user privileges as ordinary Pi. The runner never commits, pushes,
merges, deploys, or rolls unless the original managed goal explicitly asks for
that action.

# Orchestrator Brain — User Guide

The Orchestrator Brain is the central AI agent that manages all other agents in your Development workspace. It decomposes goals into tasks, assigns them to specialized agents, tracks performance with a credit economy, and enforces governance rules.

## Table of Contents

1. [Quick Start](#quick-start)
2. [System Architecture](#system-architecture)
3. [How to Use the Orchestrator](#how-to-use-the-orchestrator)
4. [Available Agents](#available-agents)
5. [Task Lifecycle](#task-lifecycle)
6. [Economy System (DevCredits)](#economy-system-devcredits)
7. [Governance Rules](#governance-rules)
8. [State Files Reference](#state-files-reference)
9. [Real-World Examples](#real-world-examples)
10. [Troubleshooting](#troubleshooting)

---

## Quick Start

The orchestrator is a Claude Code agent. You invoke it by describing complex, multi-step work. Claude Code automatically routes to it, or you can ask explicitly.

**Just say what you want done:**

```
"Build the booking feature for ParkingApp — backend API, Flutter screens, and tests"
```

The orchestrator will:
1. Break this into 4-6 atomic tasks
2. Show you a plan table with agents and priorities
3. Ask you to confirm
4. Dispatch agents in parallel where possible
5. Validate results and report back with credit updates

**Or manage the system directly:**

```
"Show me agent standings"
"What tasks are pending?"
"Reset the economy ledger"
```

---

## System Architecture

```
.claude/
├── agents/
│   └── orchestrator-brain.md       # Agent definition (the brain itself)
│
└── system/                         # Persistent state (the brain's memory)
    ├── registry/
    │   └── agents.json             # Agent roster: capabilities, credits, trust, status
    ├── economy/
    │   └── ledger.json             # DevCredits rules + transaction history
    ├── governance/
    │   └── rules.json              # 8 governance rules + per-agent access control
    ├── tasks/
    │   └── queue.json              # Task queue: active, completed, failed
    └── logs/
        └── execution.json          # Full execution history
```

**How it flows:**

```
You (the user)
  │
  ▼
Orchestrator Brain ──reads──▶ State Files (.claude/system/)
  │
  ├──dispatches──▶ general-purpose agent (coding, debugging, refactoring)
  ├──dispatches──▶ explore agent (codebase search, read-only)
  ├──dispatches──▶ plan agent (architecture design, no editing)
  ├──dispatches──▶ deployer agent (production server operations)
  └──dispatches──▶ flutter-ui-ux-auditor (mobile UI review)
  │
  ▼
Results validated → Agents scored → State files updated → Report delivered to you
```

---

## How to Use the Orchestrator

### When to Use It

Use the orchestrator for work that involves **multiple steps, multiple agents, or cross-project coordination**:

| Scenario | Why Orchestrator |
|----------|-----------------|
| "Add user profiles with avatar upload, API, and frontend" | Multiple agents needed (coder + reviewer) |
| "Refactor the payment module and make sure nothing breaks" | Coding + testing + review pipeline |
| "Investigate why the POS app is slow and fix it" | Research → diagnosis → fix → validate |
| "Deploy soulline and run migrations" | Coordinated deployer tasks with dependency |
| "Audit the ParkingApp Flutter UI then fix the issues" | Auditor agent → coder agent pipeline |

### When NOT to Use It

For simple, single-step tasks, talk to Claude Code directly — no orchestration needed:

- "Fix this typo in line 42"
- "What does this function do?"
- "Add a comment to this file"

### How to Trigger It

**Implicit** — Claude Code will route to the orchestrator when it detects multi-step complexity:
```
"Build the complete booking flow for ParkingApp"
```

**Explicit** — Ask for orchestration directly:
```
"Use the orchestrator to coordinate building the auth system"
"Orchestrate: research, plan, then implement the notification feature"
```

**System management** — Query the orchestrator's state:
```
"Show me the agent registry"
"What's the task queue look like?"
"Which agent has the most credits?"
```

---

## Available Agents

The orchestrator manages these agents. Each has defined capabilities and restrictions.

### general-purpose (Worker)
- **Does:** Coding, debugging, refactoring, documentation, research, file operations
- **Cannot:** Access production server, touch credential files
- **Starting credits:** 50
- **Best for:** Implementation tasks, bug fixes, feature development

### explore (Scout)
- **Does:** Codebase search, file discovery, architecture analysis, pattern detection
- **Cannot:** Edit files, write git operations, access production
- **Starting credits:** 50
- **Best for:** "Find where X is used", "How does Y work?", investigation tasks

### plan (Architect)
- **Does:** Architecture design, implementation planning, trade-off analysis, dependency mapping
- **Cannot:** Edit files, write git operations, access production
- **Starting credits:** 50
- **Best for:** "Design the approach for X", planning before implementation

### deployer (Ops)
- **Does:** Deployment, server management, Docker operations, log analysis, service restarts
- **Cannot:** Drop databases, force push to main, access credentials directly
- **Starting credits:** 50 | **Trust:** elevated
- **Best for:** Production deploys, server troubleshooting, migration runs

### flutter-ui-ux-auditor (Reviewer)
- **Does:** UI review, UX audit, design consistency checks, accessibility, Material Design compliance
- **Cannot:** Edit files, access backend, access production
- **Starting credits:** 50
- **Best for:** "Review the booking screen", post-implementation UI audits

---

## Task Lifecycle

Every request goes through this lifecycle:

```
 ┌─────────┐
 │ RECEIVE │  User makes a request
 └────┬────┘
      ▼
 ┌─────────┐
 │ ANALYZE │  Orchestrator assesses scope, complexity, risks
 └────┬────┘
      ▼
 ┌───────────┐
 │ DECOMPOSE │  Break into atomic tasks with dependencies
 └────┬──────┘
      ▼
 ┌──────┐
 │ PLAN │  Present task table to user for approval
 └──┬───┘
    ▼
 ┌──────────┐     ┌─────────┐
 │ DISPATCH │────▶│  AGENT  │  Agent executes the task
 └──────────┘     └────┬────┘
                       ▼
                 ┌──────────┐
                 │ VALIDATE │  Orchestrator checks output quality
                 └────┬─────┘
                      ▼
                 ┌───────┐
                 │ SCORE │  Award or penalize DevCredits
                 └───┬───┘
                     ▼
                ┌─────────┐
                │ DELIVER │  Final report to user
                └─────────┘
```

### Task States

| Status | Meaning |
|--------|---------|
| `pending` | Created but not yet assigned |
| `assigned` | Agent selected, dispatch imminent |
| `in_progress` | Agent is working on it |
| `completed` | Done and validated |
| `failed` | Agent could not complete (retry or escalate) |
| `blocked` | Waiting on dependency tasks to complete |

### Dependencies

Tasks can depend on other tasks. The orchestrator will not dispatch a blocked task until its dependencies are completed.

```
Example:
  TASK-1: Research current auth implementation (explore agent)
  TASK-2: Design new auth architecture (plan agent) — depends on TASK-1
  TASK-3: Implement auth backend (general-purpose) — depends on TASK-2
  TASK-4: Write auth tests (general-purpose) — depends on TASK-3
```

TASK-1 and any independent tasks run in parallel. TASK-2 waits for TASK-1, and so on.

---

## Economy System (DevCredits)

Every agent has a credit balance that affects which tasks they can be assigned.

### Earning Credits

| Event | Credits |
|-------|---------|
| Task completed successfully | +10 |
| High-quality or optimized output | +5 bonus |
| Fast completion | +3 bonus |
| Critical task completed | +7 bonus |

### Losing Credits

| Event | Credits |
|-------|---------|
| Task failed or unusable result | -10 |
| Delayed delivery | -5 |
| Rework required | -3 |
| Governance rule violation | -15 |

### Credit Thresholds

| Credit Balance | Effect |
|---------------|--------|
| >= 100 | Promoted to "elevated" trust — gets critical tasks |
| >= 30 | Eligible for critical-priority tasks |
| >= 10 | Eligible for high-priority tasks |
| < 0 | Restricted to low-priority tasks only |
| < -20 | Flagged for review — agent may be deemed ineffective |

### How Credits Affect Agent Selection

When the orchestrator picks an agent for a task, it runs this algorithm:

```
1. Filter by required capability
2. Filter by status = idle
3. Filter by trust_level >= task requirement
4. Filter by credits >= priority threshold
5. Sort by performance_score DESC, then credits DESC
6. Pick the top candidate
```

Higher-credit agents get better tasks. Poor performers get sidelined.

### Checking Balances

Ask the orchestrator:
```
"Show me agent standings"
"What are the current DevCredit balances?"
```

It will read `registry/agents.json` and report.

---

## Governance Rules

8 rules that the orchestrator enforces. Violations result in credit penalties.

| ID | Rule | Severity | Penalty |
|----|------|----------|---------|
| GOV-001 | **Single Authority** — No agent acts without orchestrator assignment | Critical | -15 |
| GOV-002 | **No Direct Communication** — Agents never talk to each other directly | Critical | -15 |
| GOV-003 | **Structured Output** — Results must include status, summary, files_changed | High | -5 |
| GOV-004 | **Scope Restriction** — Agents only touch files relevant to their task | High | -10 |
| GOV-005 | **Validation Required** — All outputs validated before acceptance | High | -5 |
| GOV-006 | **No Destructive Prod Actions** — Force push, drop tables, delete deploys need user confirmation | Critical | -20 |
| GOV-007 | **Conflict Resolution** — Orchestrator resolves all inter-agent conflicts | High | -10 |
| GOV-008 | **Retry Limit** — 1 retry per failure, then escalate to user | Medium | 0 |

### Access Control

Each agent has explicit allowed/restricted actions:

| Agent | Allowed | Restricted |
|-------|---------|------------|
| general-purpose | All project files, git ops, testing | Production server, credential files |
| explore | Read all files, search, glob | File editing, git writes, production |
| plan | Read all files, search, architecture | File editing, git writes, production |
| deployer | Production server, Docker, logs, migrations | Database drops, force push main, credentials |
| flutter-ui-ux-auditor | Read Flutter files, search mobile dir | File editing, backend, production |

### Chain of Command

```
User (supreme authority — can override anything)
  └── Orchestrator Brain (manages all agents)
       ├── general-purpose
       ├── explore
       ├── plan
       ├── deployer
       └── flutter-ui-ux-auditor
```

Only the user can override the orchestrator's decisions.

---

## State Files Reference

### registry/agents.json

The roster of all agents. The orchestrator reads this to know who's available.

```json
{
  "agents": {
    "agent-name": {
      "type": "worker|scout|architect|ops|reviewer|orchestrator",
      "status": "idle|busy|failed|active",
      "capabilities": ["coding", "research", ...],
      "trust_level": "standard|elevated|supreme",
      "credits": 50,
      "performance_score": 50,
      "tasks_completed": 0,
      "tasks_failed": 0,
      "notes": "Description"
    }
  }
}
```

### economy/ledger.json

Credit rules and full transaction history.

```json
{
  "rules": {
    "rewards": { "task_completed": 10, ... },
    "penalties": { "task_failed": -10, ... },
    "thresholds": { "minimum_for_critical_tasks": 30, ... }
  },
  "transactions": [
    {
      "timestamp": "2026-03-17T10:30:00Z",
      "agent": "general-purpose",
      "task_id": "TASK-001",
      "type": "reward|penalty",
      "amount": 10,
      "reason": "Successfully implemented feature X",
      "balance_after": 60
    }
  ]
}
```

### governance/rules.json

Governance rules and per-agent access control lists. See [Governance Rules](#governance-rules).

### tasks/queue.json

Three arrays: `active_tasks`, `completed_tasks`, `failed_tasks`. Each task:

```json
{
  "id": "TASK-001",
  "goal_id": "GOAL-001",
  "type": "coding|review|testing|research|planning|documentation|deployment|audit",
  "objective": "Clear description of what must be done",
  "priority": "critical|high|medium|low",
  "assigned_agent": "general-purpose",
  "dependencies": ["TASK-000"],
  "status": "pending|assigned|in_progress|completed|failed|blocked",
  "created_at": "ISO timestamp",
  "started_at": null,
  "completed_at": null,
  "result": null,
  "retry_count": 0,
  "credits_awarded": 0
}
```

### logs/execution.json

Append-only log of all orchestrator operations. Used for debugging and historical analysis.

---

## Real-World Examples

### Example 1: Build a New Feature

**You say:**
```
"Add a notification system to the ParkingApp — backend events, push notifications, and a notification bell in Flutter"
```

**Orchestrator responds with a plan:**

```
## Orchestrator Plan
**Goal:** Add notification system to ParkingApp
**Complexity:** high

### Tasks
| # | Task | Agent | Priority | Dependencies | Status |
|---|------|-------|----------|-------------|--------|
| 1 | Research current ParkingApp event system | explore | high | none | pending |
| 2 | Design notification architecture | plan | high | TASK-1 | blocked |
| 3 | Implement notification backend (events, storage, FCM) | general-purpose | high | TASK-2 | blocked |
| 4 | Implement Flutter notification UI (bell, list, badges) | general-purpose | high | TASK-3 | blocked |
| 5 | Audit notification UI for design consistency | flutter-ui-ux-auditor | medium | TASK-4 | blocked |

### Execution Strategy
- TASK-1 runs first (read-only research)
- TASK-2 waits for research results to design properly
- TASK-3 and TASK-4 are sequential (API before UI)
- TASK-5 runs after UI is built

Proceed? [Y/n]
```

**You say:** `Y`

The orchestrator dispatches agents, monitors results, scores them, and gives you a final report.

### Example 2: Investigate and Fix a Bug

**You say:**
```
"The POS app is crashing when adding items to cart — find out why and fix it"
```

**Orchestrator plan:**

| # | Task | Agent | Priority | Deps |
|---|------|-------|----------|------|
| 1 | Search for cart-related code and recent changes | explore | critical | none |
| 2 | Identify root cause from exploration results | plan | critical | TASK-1 |
| 3 | Implement the fix | general-purpose | critical | TASK-2 |

### Example 3: Deploy to Production

**You say:**
```
"Deploy the latest soulline changes — run migrations first"
```

**Orchestrator plan:**

| # | Task | Agent | Priority | Deps |
|---|------|-------|----------|------|
| 1 | Run database migrations on production | deployer | critical | none |
| 2 | Deploy latest code to production | deployer | critical | TASK-1 |

Note: Both tasks go to the deployer agent, but sequentially — migration must succeed before deploy.

### Example 4: Check System Status

**You say:**
```
"Show me agent standings and pending tasks"
```

**Orchestrator reads state files and responds:**

```
## Agent Standings
| Agent | Credits | Score | Tasks Done | Trust |
|-------|---------|-------|------------|-------|
| orchestrator-brain | 1000 | 100 | 0 | supreme |
| general-purpose | 65 | 87 | 12 | standard |
| explore | 58 | 92 | 8 | standard |
| deployer | 43 | 75 | 4 | elevated |
| plan | 50 | 50 | 0 | standard |
| flutter-ui-ux-auditor | 50 | 50 | 0 | standard |

## Pending Tasks
No active tasks in queue.
```

---

## Troubleshooting

### "The orchestrator didn't pick the right agent"
The selection algorithm prioritizes capability match first, then trust, credits, and performance score. If an agent keeps getting picked incorrectly, the orchestrator's credit economy will self-correct over time as poor performers lose credits.

### "A task keeps failing"
After 2 failures (1 original + 1 retry), the orchestrator escalates to you. It will explain what failed, why, and what was tried. You can then decide to:
- Adjust the task objective
- Assign a specific agent manually
- Handle it yourself

### "State files seem wrong"
The orchestrator updates state files after every operation. If something looks off:
```
"Reset the task queue"
"Fix the agent registry — general-purpose should have 50 credits"
```
The orchestrator will correct the files.

### "I want to add a new agent type"
1. Create the agent definition in `.claude/agents/your-agent.md`
2. Tell the orchestrator: "Register the new your-agent in the registry"
3. It will add the entry to `registry/agents.json` with initial credits and capabilities

### "I want to change economy rules"
Edit `.claude/system/economy/ledger.json` → `rules` section directly, or tell the orchestrator:
```
"Change the task_completed reward to +15 credits"
```

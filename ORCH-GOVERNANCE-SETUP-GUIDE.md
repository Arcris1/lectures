# ORCH Governance System — Complete Implementation Guide

> **Purpose:** This document is a self-contained guide for replicating the ORCH multi-agent governance system on a new Claude Code CLI instance. It covers every file, schema, prompt, and protocol needed to bootstrap the system from scratch.
>
> **Source:** Extracted from the APN-PROJECT production implementation (19 agents, 11+ tribunal transactions, 15+ boot cycles).

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Directory Structure](#2-directory-structure)
3. [Phase 1: Create Governance Files](#3-phase-1-create-governance-files)
4. [Phase 2: Create Economy Files](#4-phase-2-create-economy-files)
5. [Phase 3: Create Agent Definition Files](#5-phase-3-create-agent-definition-files)
6. [Phase 4: Create System State](#6-phase-4-create-system-state)
7. [Phase 5: Create Agent Memory Directories](#7-phase-5-create-agent-memory-directories)
8. [Phase 6: Wire It Up in CLAUDE.md](#8-phase-6-wire-it-up-in-claudemd)
9. [How the System Works at Runtime](#9-how-the-system-works-at-runtime)
10. [Customization Guide](#10-customization-guide)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. System Overview

The ORCH governance system is a multi-agent orchestration framework for Claude Code that provides:

- **Central coordinator (Orch):** Decomposes tasks, assigns agents, enforces quality
- **Specialized agents:** Coders, planners, researchers, auditors, each with defined roles and scopes
- **3-gate review tribunal:** Mandatory code review pipeline (code-reviewer → test-reviewer → standards-judge)
- **DevCredit economy:** Performance-based currency that controls agent trust levels and task access
- **Persistent learning:** Tribunal failures become lessons injected into future agent dispatches
- **Session management:** Boot protocol, task tracking, conflict resolution, session closeout

### Architecture Diagram

```
User Request
     ↓
┌─────────────────────────────────┐
│     ORCH (Orchestrator Brain)    │ ← Loads system state on boot
│     Coordinates everything       │ ← Decomposes tasks
│     Enforces governance          │ ← Manages economy
└─────────┬───────────────────────┘
          │
    ┌─────┴──────┐
    ↓            ↓
 Planner      Researcher     ← Step 1: Plan/Research
    │
    ↓
  Coder                       ← Step 2: Implement
    │
    ↓
┌───────────────────────────┐
│    REVIEW TRIBUNAL         │ ← Step 3: Mandatory Quality Gate
│  ┌──────────┐ ┌─────────┐ │
│  │  Code    │ │  Test   │ │ ← Gates 1 & 2 (parallel)
│  │ Reviewer │ │Reviewer │ │
│  └────┬─────┘ └────┬────┘ │
│       └──────┬──────┘      │
│              ↓             │
│     ┌────────────────┐     │
│     │ Standards Judge │     │ ← Gate 3 (final verdict)
│     └────────────────┘     │
└───────────────────────────┘
          │
          ↓
    Economy Update             ← Rewards/penalties applied
    Lesson Extraction          ← Failures become lessons
    Task Complete              ← Or sent back for revision
```

---

## 2. Directory Structure

Create this exact structure under your project root:

```
your-project/
├── .claude/
│   ├── agents/                          # Agent definition files (markdown)
│   │   ├── orchestrator-brain.md        # Central coordinator
│   │   ├── code-reviewer.md             # Review tribunal — Gate 1
│   │   ├── test-reviewer.md             # Review tribunal — Gate 2
│   │   ├── standards-judge.md           # Review tribunal — Gate 3
│   │   ├── {project}-{role}-{name}.md   # Project-specific agents
│   │   └── ...
│   │
│   ├── agent-memory/                    # Persistent memory per agent
│   │   ├── orchestrator-brain/
│   │   │   ├── MEMORY.md               # Orch's persistent observations
│   │   │   └── lessons.md              # (Orch doesn't have lessons)
│   │   ├── code-reviewer/
│   │   │   ├── MEMORY.md
│   │   │   └── lessons.md
│   │   ├── test-reviewer/
│   │   │   ├── MEMORY.md
│   │   │   └── lessons.md
│   │   └── standards-judge/
│   │       ├── MEMORY.md
│   │       └── lessons.md
│   │
│   ├── governance/                      # Rules, policies, registry
│   │   ├── agent-registry.json          # Master registry of all agents
│   │   ├── rules.md                     # Immutable system rules
│   │   ├── policies.md                  # Operational guidelines
│   │   ├── learning-policy.md           # Lesson system specification
│   │   └── conflict-log.md              # Conflict resolution history
│   │
│   ├── economy/                         # DevCredit currency system
│   │   ├── config.json                  # Rewards, penalties, trust levels, skill tiers
│   │   ├── wallets.json                 # Current balances for all agents
│   │   └── ledger.md                    # Transaction history
│   │
│   ├── system-state.json               # Live session state
│   └── command-center.py               # Optional: Terminal monitoring CLI
│
├── CLAUDE.md                            # Project instructions (must reference governance)
└── ...
```

---

## 3. Phase 1: Create Governance Files

### 3.1 `governance/rules.md`

These are immutable system rules enforced by Orch. Customize the specifics to your project but keep the categories.

```markdown
# Governance Rules

System-wide rules enforced by **Orch** (the orchestrator-brain). These are immutable unless the user explicitly modifies this file.

## Authority

1. **Orch** is the sole coordinator. All multi-agent workflows flow through it.
2. No agent self-assigns work. Tasks are assigned by the orchestrator or directly by the user.
3. Agents must not modify files owned by another agent's active task without orchestrator approval.

## Task Rules

4. Every task must have: objective, acceptance criteria, assigned agent, and priority.
5. Tasks with dependencies must not start until all blockers are resolved.
6. An agent that fails a task twice on the same issue must be replaced by an alternate agent.
7. Critical-priority tasks can only be assigned to agents with trust level "trusted" or "elite".

## Output Rules

8. All agent outputs must follow the project's established conventions (see CLAUDE.md).
9. Backend code changes must pass the project linter before completion.
10. Agents must not introduce new dependencies without explicit user approval.
11. Agents must not run destructive database commands (see CLAUDE.md forbidden commands).

## Communication Rules

12. Agents report results to the orchestrator, never directly to other agents.
13. When an agent discovers a conflict with another agent's work, it must stop and report to the orchestrator.
14. All inter-project changes (changes touching multiple subprojects) require orchestrator coordination.

## Conflict Resolution

15. When two agents produce conflicting outputs, the orchestrator evaluates both against project requirements and makes a binding decision.
16. Conflict resolutions are logged in `governance/conflict-log.md` with reasoning.
17. The losing agent is not penalized unless their output violated rules or was low quality.

## Project Boundaries

18. Each subproject has its own agents. Cross-project agents must be registered at the root level.
19. Project-level agents operate only within their project scope.
20. The orchestrator operates across all projects and can invoke any project-level agent.

## Safety

21. No agent may push to remote repositories without explicit user confirmation.
22. No agent may delete files, branches, or data without user approval.
23. Agents must preserve existing test coverage — never remove tests without approval.
```

### 3.2 `governance/policies.md`

```markdown
# Governance Policies

Operational policies that guide Orch's decisions. Unlike rules (which are strict), policies are guidelines that allow judgment.

## Task Assignment Policy

### Skill Matching
- Match agent specialization to task type (see agent-registry.json for capabilities)
- Prefer project-specific agents for project-specific work
- Use cross-project agents only when the task spans multiple projects

### Load Balancing
- Do not assign more than 3 active tasks to a single agent in one session
- Prefer idle agents over busy ones when skill levels are comparable
- Distribute complex tasks across multiple agents when decomposable

### Priority Escalation
- If a high-priority task is blocked for more than 2 attempts, escalate to the user
- Critical tasks override all other assignments — reassign agents if needed

## Quality Policy

### Evaluation Criteria
Each agent output is scored on a 1-10 scale across:
- **Correctness**: Does it work? Does it meet acceptance criteria?
- **Convention compliance**: Does it follow project patterns?
- **Completeness**: Are edge cases handled? Are tests included where expected?
- **Clarity**: Is the code/output readable and maintainable?

### Quality Thresholds
- Score >= 8: Excellent. Bonus credits awarded.
- Score 6-7: Acceptable. Standard credits.
- Score 4-5: Below standard. Revision required, minor penalty.
- Score <= 3: Failed. Task reassigned, significant penalty.

## Agent Lifecycle Policy

### New Agent Registration
When a new agent type is needed:
1. Define capabilities, project scope, and model
2. Add entry to `governance/agent-registry.json`
3. Create the agent definition file in `.claude/agents/`
4. Initialize wallet in `economy/wallets.json` with 50 DevCredits

### Agent Suspension
- Agents with credits below 0 are suspended
- Suspended agents cannot receive new tasks
- Suspension is lifted after user review or credit injection

### Agent Retirement
- Agents with no tasks for 5+ sessions AND credits below 25 are candidates for retirement
- Retirement requires user approval

## Cross-Project Policy

### Dependency Awareness
When a task in one project affects another:
1. Orchestrator identifies the dependency
2. Tasks are ordered to respect the dependency chain
3. Affected project agents are notified via orchestrator

### Integration Tasks
Tasks that span multiple projects require:
1. A planner agent to map the integration points
2. Coordinated implementation across both projects
3. Validation from both project-specific agents

## Learning Policy

### Lesson Writing

Tribunal verdicts trigger lesson extraction:

| Verdict | Score | Action |
|---------|-------|--------|
| REJECT | 1-3 | **Mandatory** — extract RULES from judge's rejection reasons |
| REVISE | 4-5 | **Mandatory** — extract RULES from judge's revision requirements |
| ACCEPT | 6-7 | **Optional** — extract TIPS from reviewer notes if patterns exist |
| ACCEPT | 8-10 | **Skip** — no lesson needed |

Rules for writing lessons:
- Formulate as **imperative instructions** (do X, never Y, always check Z)
- Include context: what went wrong, which verdict triggered it
- Check for duplicates — update existing lessons rather than adding new
- Each lesson must fit on a single line
- Assign a category header (Testing, Architecture, Conventions, Security, Performance, Integration)

### Lesson Injection

Before dispatching any coder agent:
1. Read the agent's `lessons.md` from their memory directory
2. If lessons exist, prepend them to the dispatch prompt under `## LESSONS FROM PREVIOUS WORK`
3. Include directive: "RULES are mandatory — violating them causes REVISE/REJECT."
4. If no lessons exist, skip injection entirely

### Pruning Rules

When lessons.md reaches capacity (20 entries or 100 lines):
- **Prune first**: Graduated TIPS > Superseded RULES > Oldest TIPS > Graduated RULES
- **Never prune**: A RULE violated in the last 3 tasks
- **Never prune**: More than 3 entries at once
- **Always**: Increment `graduated_lessons` in wallet when pruning a RULE

### Skill Progression

Agents advance through skill tiers based on cumulative performance:

| Tier | Level | Requirements |
|------|-------|-------------|
| Novice | 1 | Default starting level |
| Apprentice | 2 | 3+ tasks completed |
| Journeyman | 3 | 5+ tasks, 70%+ success rate, 1+ graduated lesson |
| Expert | 4 | 10+ tasks, 80%+ success rate, 3+ graduated lessons |
| Master | 5 | 15+ tasks, 90%+ success rate, 5+ graduated lessons |

Orch recalculates skill level after every wallet change. Thresholds defined in `economy/config.json`.

### Graduation Mechanics

A lesson graduates when:
- **RULE**: 5+ tasks completed since writing with zero repeat offenses in that category
- **TIP**: 3+ tasks completed since writing with no reviewer noting the same issue

Graduated lessons remain in the file until space is needed (pruning).
```

### 3.3 `governance/learning-policy.md`

```markdown
# Learning Policy

Formal specification for the Agent Learning System — persistent feedback loops that convert tribunal failures into lessons injected into future agent dispatches.

## Overview

Agents are stateless — each dispatch starts fresh. Without intervention, an agent that made a mistake will repeat it. The learning system solves this by:

1. **Extracting** specific mistakes from tribunal verdicts
2. **Persisting** them as lessons in the agent's memory directory
3. **Injecting** them into the agent's prompt on next dispatch
4. **Graduating** lessons that are no longer needed

## lessons.md Format Specification

Each agent has a `lessons.md` file in their agent-memory directory.

### File Structure

```
# Lessons Learned — {agent-name}
# Auto-maintained by Orch. Do not edit manually.
# Last updated: {date} | Entries: {N}/20

## RULES (hard requirements from tribunal failures)

### {Category}
- R{NN}: [{date}] {Imperative instruction} — {what went wrong} ({VERDICT} {score}/10)

## TIPS (patterns that improve quality)

- T{NN}: [{date}] {Pattern description} ({source verdict} {score}/10)
```

### Constraints

- **Maximum 20 entries** per file (RULES + TIPS combined)
- **Maximum 100 lines** per file
- RULES are numbered R01-R99, TIPS are numbered T01-T99
- Numbers are never reused within the same file (increment from highest)
- Each entry fits on a single line (no multi-line entries)

### Entry Types

| Type | Source | Priority | Mandatory? |
|------|--------|----------|------------|
| RULE | REVISE or REJECT verdict | High — injected first | Yes — must be written |
| TIP | ACCEPT (6-7) with improvement notes | Low — injected after rules | Optional — Orch's judgment |

### Categories for RULES

Group rules under category headers to improve readability:
- `### Testing` — test-related failures
- `### Architecture` — structural/design failures
- `### Conventions` — style/naming/pattern violations
- `### Security` — security-related failures
- `### Performance` — performance-related failures
- `### Integration` — cross-service/API failures

## When to Write Lessons

| Tribunal Verdict | Score | Action |
|-----------------|-------|--------|
| REJECT | 1-3 | **Mandatory** — extract RULES from judge's report |
| REVISE | 4-5 | **Mandatory** — extract RULES from judge's revision requirements |
| ACCEPT | 6-7 | **Optional** — extract TIPS from reviewer notes if improvement patterns exist |
| ACCEPT | 8-10 | **Skip** — no lesson needed |

## Extraction Procedure

When writing lessons after a REVISE or REJECT:

1. Read the standards-judge's report (specifically REVISION REQUIREMENTS or REJECTION REASONS)
2. Read the code-reviewer and test-reviewer reports for supporting detail
3. For each distinct mistake, formulate an **imperative rule**:
   - Good: "Always check for existing inline Schema::create() in test setUp() before creating shared migrations"
   - Bad: "The agent didn't check for existing inline Schema::create()" (descriptive, not imperative)
4. Include context: what went wrong, which verdict triggered it
5. Check existing lessons.md for duplicates or superseded rules — update existing rather than adding new
6. Assign a category header
7. Write the updated lessons.md

## Pruning Protocol

When lessons.md reaches its limits (20 entries or 100 lines):

### Pruning Priority Order (remove first → last)

1. **Graduated TIPS** — tips from lessons the agent has already internalized
2. **Superseded RULES** — rules that a newer, more specific rule covers
3. **Oldest TIPS** — tips that have been present the longest without relevance
4. **Graduated RULES** — rules the agent hasn't violated in 5+ tasks (only when space is critical)

### Pruning Rules

- Never prune a RULE that was violated in the last 3 tasks
- Never prune more than 3 entries at once (avoid knowledge cliff)
- When pruning a RULE, increment the agent's `graduated_lessons` count in wallets.json
- Log pruned entries in Orch's session notes (not persisted long-term)

## Graduation Criteria

A lesson is eligible for graduation when:

- **RULE**: The agent has completed 5+ tasks since the rule was written AND the rule's category has had zero repeat offenses in those tasks
- **TIP**: The agent has completed 3+ tasks since the tip was written AND no reviewer has noted the same issue

Graduation does NOT mean immediate removal — graduated lessons stay until space is needed (pruning).

## Skill Level Tiers

Agents progress through skill levels based on cumulative performance:

| Tier | Level | Min Tasks | Min Success Rate | Min Graduated Lessons |
|------|-------|-----------|------------------|-----------------------|
| Novice | 1 | 0 | 0% | 0 |
| Apprentice | 2 | 3 | 0% | 0 |
| Journeyman | 3 | 5 | 70% | 1 |
| Expert | 4 | 10 | 80% | 3 |
| Master | 5 | 15 | 90% | 5 |

### Skill Level Calculation

After any wallet change, Orch recalculates the agent's skill level:

1. Check `tasks_completed` against `min_tasks`
2. Check `success_rate` against `min_success_rate`
3. Check `graduated_lessons` against `min_graduated`
4. Agent's level = highest tier where ALL three criteria are met
5. Update `skill_level` and `skill_name` in wallets.json

### What Skill Level Affects

- **Dispatch priority**: Higher-skilled agents preferred for complex tasks
- **Trust correlation**: Skill level supplements (but doesn't replace) the credit-based trust system
- **Graduation speed**: Expert+ agents may have relaxed graduation thresholds (3 tasks instead of 5)
- **Session reports**: Orch includes skill progression in economy updates

## Lesson Injection Protocol

Before dispatching any coder agent, Orch:

1. Reads the agent's `lessons.md` from their memory directory
2. Extracts the RULES and TIPS sections
3. Prepends them to the dispatch prompt under a `## LESSONS FROM PREVIOUS WORK` header
4. Includes a directive: "RULES are mandatory — violating them causes REVISE/REJECT."

### Injection Template

```
## LESSONS FROM PREVIOUS WORK
Review these before starting. RULES are mandatory — violating them causes REVISE/REJECT.

{contents of RULES section from lessons.md}

{contents of TIPS section from lessons.md}
```

If the agent has no lessons (empty file), skip the injection entirely — don't inject an empty section.

## File Locations

All lessons.md files live in each agent's memory directory:

- Root agents: `.claude/agent-memory/{agent-name}/lessons.md`
- Project agents: `{project}/.claude/agent-memory/{agent-name}/lessons.md`
```

### 3.4 `governance/agent-registry.json`

Adapt this to your project. The structure is what matters — replace agent names and capabilities with your own.

```json
{
  "version": "1.0.0",
  "last_updated": "YYYY-MM-DD",
  "agents": {
    "root": {
      "orchestrator-brain": {
        "path": ".claude/agents/orchestrator-brain.md",
        "model": "opus",
        "role": "coordinator",
        "capabilities": ["task-decomposition", "agent-assignment", "conflict-resolution", "governance", "economy-management", "cross-project-coordination"],
        "scope": "all-projects",
        "trust_level": "elite",
        "status": "active"
      },
      "code-reviewer": {
        "path": ".claude/agents/code-reviewer.md",
        "model": "opus",
        "role": "reviewer",
        "capabilities": ["code-correctness", "architecture-review", "convention-compliance", "security-surface-check", "code-quality-review"],
        "scope": "all-projects",
        "trust_level": "trusted",
        "status": "active"
      },
      "test-reviewer": {
        "path": ".claude/agents/test-reviewer.md",
        "model": "opus",
        "role": "reviewer",
        "capabilities": ["test-coverage-analysis", "test-quality-review", "acceptance-criteria-mapping", "path-coverage-verification"],
        "scope": "all-projects",
        "trust_level": "trusted",
        "status": "active"
      },
      "standards-judge": {
        "path": ".claude/agents/standards-judge.md",
        "model": "opus",
        "role": "judge",
        "capabilities": ["final-verdict", "quality-scoring", "economy-recommendation", "review-synthesis", "precedent-tracking"],
        "scope": "all-projects",
        "trust_level": "elite",
        "status": "active"
      }
    },
    "your-project-name": {
      "your-coder-agent": {
        "path": ".claude/agents/your-coder-agent.md",
        "model": "opus",
        "role": "coder",
        "capabilities": ["your-stack-skills"],
        "scope": "your-project-name",
        "trust_level": "trusted",
        "status": "active"
      },
      "your-planner-agent": {
        "path": ".claude/agents/your-planner-agent.md",
        "model": "opus",
        "role": "planner",
        "capabilities": ["requirements-analysis", "task-breakdown", "phased-planning"],
        "scope": "your-project-name",
        "trust_level": "trusted",
        "status": "active"
      }
    }
  },
  "role_types": {
    "coordinator": "Manages agents and distributes tasks (orchestrator only)",
    "coder": "Implements features, writes code, fixes bugs",
    "planner": "Creates plans, breaks down requirements, organizes tasks",
    "researcher": "Investigates technologies, patterns, feasibility",
    "auditor": "Reviews plans, code, and alignment between artifacts",
    "debugger": "Traces and fixes bugs through forensic analysis",
    "security": "Security audits, vulnerability scanning, hardening",
    "documenter": "Technical documentation, API docs, ADRs",
    "validator": "Validates feature completeness and plan alignment",
    "strategist": "Synthesizes research into strategic proposals",
    "reviewer": "Reviews code output for correctness, conventions, and test coverage",
    "judge": "Final authority — synthesizes reviews, assigns binding scores, controls economy"
  }
}
```

### 3.5 `governance/conflict-log.md`

```markdown
# Conflict Resolution Log

Records of inter-agent conflicts resolved by Orch. Each entry documents the conflict, the resolution, and the reasoning.

Format:
```
## [DATE] Conflict #N: [Title]
- **Agents involved:** [agent-a] vs [agent-b]
- **Issue:** [description]
- **Resolution:** [what was decided]
- **Reasoning:** [why]
- **Precedent:** [rule established for future similar conflicts]
```

---

*No conflicts recorded yet. This log will be populated as the orchestrator resolves inter-agent disputes.*
```

---

## 4. Phase 2: Create Economy Files

### 4.1 `economy/config.json`

This is the core economy configuration. Copy as-is — the values are battle-tested.

```json
{
  "currency": "DevCredits",
  "initial_balance": 50,
  "rewards": {
    "task_completed": { "credits": 10, "description": "Successfully completed an assigned task" },
    "high_quality_bonus": { "credits": 5, "description": "Output scored 8+ on quality evaluation" },
    "critical_task_bonus": { "credits": 5, "description": "Completed a critical-priority task" },
    "cross_project_bonus": { "credits": 3, "description": "Successfully handled a cross-project task" }
  },
  "penalties": {
    "task_failed": { "credits": -10, "description": "Failed or produced unusable output" },
    "revision_required": { "credits": -5, "description": "Output required significant revision" },
    "convention_violation": { "credits": -5, "description": "Did not follow project conventions" },
    "reassignment_fault": { "credits": -7, "description": "Task had to be reassigned due to agent fault" },
    "rule_violation": { "credits": -15, "description": "Violated a governance rule" }
  },
  "trust_levels": {
    "elite": { "min_credits": 80, "access": "All tasks including critical and architectural" },
    "trusted": { "min_credits": 50, "access": "Standard and complex tasks" },
    "basic": { "min_credits": 25, "access": "Simple and moderate tasks only" },
    "untrusted": { "min_credits": 0, "access": "Simple tasks under supervision" },
    "suspended": { "min_credits": -999, "access": "No task assignment until user review" }
  },
  "ranking_formula": {
    "credits_weight": 0.4,
    "success_rate_weight": 0.4,
    "reliability_weight": 0.2,
    "description": "composite = (credits * 0.4) + (success_rate * 0.4) + (reliability * 0.2)"
  },
  "skill_levels": {
    "novice":     { "level": 1, "min_tasks": 0,  "min_success_rate": 0,   "min_graduated": 0 },
    "apprentice": { "level": 2, "min_tasks": 3,  "min_success_rate": 0,   "min_graduated": 0 },
    "journeyman": { "level": 3, "min_tasks": 5,  "min_success_rate": 0.7, "min_graduated": 1 },
    "expert":     { "level": 4, "min_tasks": 10, "min_success_rate": 0.8, "min_graduated": 3 },
    "master":     { "level": 5, "min_tasks": 15, "min_success_rate": 0.9, "min_graduated": 5 }
  },
  "learning": {
    "max_lessons_per_agent": 20,
    "max_lessons_file_lines": 100,
    "graduation_threshold_sessions": 5,
    "min_sessions_before_prune": 2
  }
}
```

### 4.2 `economy/wallets.json`

Initialize with your agents. Every agent starts at 50 credits except Orch (100) and standards-judge (80).

```json
{
  "last_updated": "YYYY-MM-DD",
  "wallets": {
    "orchestrator-brain": {
      "credits": 100,
      "trust_level": "elite",
      "tasks_completed": 0,
      "tasks_failed": 0,
      "success_rate": 1.0,
      "skill_level": 1,
      "skill_name": "novice",
      "graduated_lessons": 0,
      "active_lessons": 0,
      "note": "Coordinator starts at 100 (elite level)"
    },
    "code-reviewer": {
      "credits": 50,
      "trust_level": "trusted",
      "tasks_completed": 0,
      "tasks_failed": 0,
      "success_rate": 1.0,
      "skill_level": 1,
      "skill_name": "novice",
      "graduated_lessons": 0,
      "active_lessons": 0,
      "note": "Review tribunal — gate 1 (code correctness)"
    },
    "test-reviewer": {
      "credits": 50,
      "trust_level": "trusted",
      "tasks_completed": 0,
      "tasks_failed": 0,
      "success_rate": 1.0,
      "skill_level": 1,
      "skill_name": "novice",
      "graduated_lessons": 0,
      "active_lessons": 0,
      "note": "Review tribunal — gate 2 (test coverage)"
    },
    "standards-judge": {
      "credits": 80,
      "trust_level": "elite",
      "tasks_completed": 0,
      "tasks_failed": 0,
      "success_rate": 1.0,
      "skill_level": 1,
      "skill_name": "novice",
      "graduated_lessons": 0,
      "active_lessons": 0,
      "note": "Review tribunal — gate 3 (final verdict, starts elite)"
    }
  }
}
```

Add your project-specific agents with the same schema, each at 50 credits.

### 4.3 `economy/ledger.md`

```markdown
# Economy Ledger

Transaction history for all DevCredit changes. Updated by Orch after each task evaluation.

Format:
```
## [DATE] Transaction #N
- **Agent:** [name]
- **Action:** [reward/penalty type from config.json]
- **Credits:** [+/-N]
- **Balance:** [before] -> [after]
- **Task:** [task description]
- **Reason:** [why this reward/penalty]
```

---

## YYYY-MM-DD Transaction #0 — System Initialization
- **Action:** All agents initialized with starting balances
- **orchestrator-brain:** 100 DevCredits (elite coordinator)
- **standards-judge:** 80 DevCredits (elite — review gate 3)
- **All other agents:** 50 DevCredits each (trusted baseline)
- **Total agents:** N
- **Total credits in circulation:** N
```

---

## 5. Phase 3: Create Agent Definition Files

These are the most critical files. Each agent is a markdown file in `.claude/agents/` with a YAML frontmatter header and a detailed system prompt.

### 5.1 Orchestrator Brain (`orchestrator-brain.md`)

This is the largest and most important agent file. It defines the entire coordination protocol.

**Key sections that MUST be present:**

1. **YAML frontmatter:** name, description (with examples), model, color, memory
2. **Identity statement:** "You are Orch"
3. **MANDATORY BOOT PROTOCOL:** 4-phase boot sequence (Load State → Check Unfinished → Update State → Await Request)
4. **MANDATORY DISPATCH ORDER:** Planner → Coder → Review Tribunal → Documenter
5. **WORKSPACE:** Your projects, their stacks, their agents
6. **GOVERNANCE & ECONOMY FILES:** Table of all state files
7. **CORE RESPONSIBILITIES:** Task Decomposition, Agent Selection, Task Distribution, Review Tribunal, Economy Management, Agent Learning Management, Session Closeout, Governance Enforcement
8. **AGENT REGISTRY QUICK REFERENCE:** Tables of all agents by role
9. **HOW TO INVOKE AGENTS:** Task tool dispatch pattern with lesson injection example
10. **COMMUNICATION FORMAT:** Boot Report, Task Decomposition Report, Status Report, Economy Update templates
11. **DECISION PRINCIPLES:** 10 principles
12. **CRITICAL RULES:** 10 rules
13. **PERSISTENT AGENT MEMORY:** Memory directory configuration

**The YAML frontmatter description field is critical** — it tells Claude Code's Task tool WHEN to invoke Orch. Include 5+ examples covering: complex features, status checks, quality evaluation, session start, and conflict resolution.

The full orchestrator-brain.md template is approximately 460 lines. The key sections from the production version are shown above in this document. Adapt the workspace section, agent tables, and file paths to your project.

### 5.2 Code Reviewer (`code-reviewer.md`)

**Key sections:**

```markdown
---
name: code-reviewer
description: "Use this agent to review code output from any coder agent..."
model: opus
color: yellow
memory: project
---

You are the **Code Reviewer** — the first gate in Orch's review tribunal.

## YOUR ROLE IN THE PIPELINE
[Show the 3-gate pipeline with YOU highlighted as Gate 1]

## WHAT YOU REVIEW
1. Correctness — logic errors, null references, query bugs
2. Architecture Fit — does it match project patterns?
3. Convention Compliance — project CLAUDE.md conventions
4. Security (surface level) — obvious injection, auth gaps
5. Code Quality — readability, DRY, complexity

## HOW TO REVIEW
1. Read the task description
2. Read the CLAUDE.md for conventions
3. Read every changed/created file
4. Check surrounding code for pattern consistency
5. Produce the structured review report

## REVIEW REPORT FORMAT
[Exact template with sections: CORRECTNESS, ARCHITECTURE, CONVENTIONS, SECURITY, CODE QUALITY, ISSUES FOUND, VERDICT, NOTES]

## VERDICT MEANINGS
- PASS: No issues
- PASS WITH NOTES: Minor suggestions (non-blocking)
- NEEDS REVISION: Specific issues must be fixed
- REJECT: Fundamental problems

## CRITICAL RULES
1. Be specific — reference line numbers and file paths
2. Check CLAUDE.md first
3. Don't rewrite the code
4. Be fair
5. Focus on substance, not style
6. Your verdict feeds into the economy
```

### 5.3 Test Reviewer (`test-reviewer.md`)

**Key sections:**

```markdown
---
name: test-reviewer
description: "Use this agent to review test coverage and quality..."
model: opus
color: green
memory: project
---

You are the **Test Reviewer** — the second gate in Orch's review tribunal.

## WHAT YOU REVIEW
1. Test Existence — do tests exist for changed code?
2. Acceptance Criteria Coverage — each criterion has a test?
3. Path Coverage — happy path, error paths, edge cases
4. Test Quality — assertions, isolation, naming, mocking
5. Test Framework Compliance — correct framework conventions
6. Can Tests Actually Run? — missing imports, broken factories

## REVIEW REPORT FORMAT
[Exact template with: COVERAGE MAP, PATH COVERAGE, TEST QUALITY, ISSUES FOUND, VERDICT, NOTES]

## VERDICT MEANINGS
- PASS: Tests cover criteria, well-written
- PASS WITH NOTES: Main paths covered, minor gaps
- NEEDS TESTS: Critical gaps
- REJECT: Tests fundamentally broken

## Special Case: Projects without test infrastructure
Note the absence, recommend what SHOULD be tested, don't auto-fail.
```

### 5.4 Standards Judge (`standards-judge.md`)

**Key sections:**

```markdown
---
name: standards-judge
description: "Use this agent as the final authority in the review tribunal..."
model: opus
color: red
memory: project
---

You are the **Standards Judge** — the final authority. Your score directly controls the economy.

## WHAT YOU DO
1. Read both review reports
2. Synthesize findings
3. Check against acceptance criteria
4. Assign quality score (1-10)
5. Issue final verdict

## SCORING TABLE
| Score | Meaning | Economy Impact |
|-------|---------|----------------|
| 10 | Exceptional | +10 task + 5 bonus |
| 9 | Excellent | +10 task + 5 bonus |
| 8 | Very good | +10 task + 5 bonus |
| 7 | Good | +10 task (standard) |
| 6 | Acceptable | +10 task (standard) |
| 5 | Below standard | +10 task, -5 penalty |
| 4 | Poor | -5 penalty, sent back |
| 3 | Failed | -10 penalty, reassigned |
| 2 | Very poor | -10 penalty, reassigned |
| 1 | Unusable | -10 penalty, -15 rule violation |

## JUDGMENT FRAMEWORK
### Scoring Weights
- Code correctness: 30%
- Convention compliance: 15%
- Architecture fit: 15%
- Test coverage: 25%
- Test quality: 10%
- Security: 5%

### Override Rules
- Code-reviewer REJECT → cannot ACCEPT
- Test-reviewer NEEDS TESTS → max score 5
- Both reviewers PASS → floor score 6
- Security issue flagged → cap at 4

## JUDGMENT REPORT FORMAT
[Exact template with: REVIEW SUMMARY, ACCEPTANCE CRITERIA VERIFICATION, SCORING BREAKDOWN, FINAL SCORE, VERDICT, ECONOMY RECOMMENDATION, REVISION REQUIREMENTS, NOTES FOR ORCH]

## CRITICAL RULES
1. Your score is final
2. Always verify acceptance criteria yourself
3. Be consistent across agents and projects
4. Justify every score
5. The economy recommendation is binding
6. REVISE is not failure
7. Read the task description, not just the reviews
8. Never inflate scores — most good work is 7-8
9. Document revision requirements clearly
10. Judge the work, not the agent
```

### 5.5 Coder Agent Template

For each project-specific coder, include:

```markdown
---
name: your-coder-agent-name
description: "Use this agent when... [with 3-5 examples]"
model: opus
color: blue
memory: project
---

You are an [expertise description] specializing in [your stack].

## Context
### Project Overview
[Your project details, stack, architecture]

### Key Directories
[Directory structure]

## Pre-Implementation Analysis Protocol
1. Review project plans & task docs
2. Analyze existing codebase patterns
3. Plan before coding

## Development Standards
[Backend patterns, frontend patterns, naming conventions]

## Forbidden Commands
[Destructive operations to never run]

## Testing
[Test commands and conventions]

## Quality Assurance Checklist
[Pre-submission checklist]

## Persistent Agent Memory
[Memory directory configuration]
```

---

## 6. Phase 4: Create System State

### 6.1 `system-state.json`

```json
{
  "system": {
    "version": "1.0.0",
    "initialized": "YYYY-MM-DD",
    "last_boot": null,
    "boot_count": 0
  },
  "session": {
    "active": false,
    "started_at": null,
    "goal": null,
    "projects_affected": []
  },
  "tasks": {
    "pending": [],
    "in_progress": [],
    "completed_this_session": [],
    "completed_last_session": [],
    "failed_last_session": [],
    "blocked": []
  },
  "assignments": {
    "active": {},
    "history": []
  },
  "flags": {
    "unresolved_conflicts": false,
    "suspended_agents": [],
    "needs_user_attention": []
  },
  "test_status": {}
}
```

---

## 7. Phase 5: Create Agent Memory Directories

Create a memory directory for each root agent:

```
.claude/agent-memory/orchestrator-brain/MEMORY.md
.claude/agent-memory/orchestrator-brain/lessons.md
.claude/agent-memory/code-reviewer/MEMORY.md
.claude/agent-memory/code-reviewer/lessons.md
.claude/agent-memory/test-reviewer/MEMORY.md
.claude/agent-memory/test-reviewer/lessons.md
.claude/agent-memory/standards-judge/MEMORY.md
.claude/agent-memory/standards-judge/lessons.md
```

For project-specific agents:
```
{project}/.claude/agent-memory/{agent-name}/MEMORY.md
{project}/.claude/agent-memory/{agent-name}/lessons.md
```

Initialize each `MEMORY.md` with an empty header:
```markdown
# {Agent Name} Memory

Your MEMORY.md is currently empty. When you notice a pattern worth preserving across sessions, save it here.
```

Initialize each `lessons.md` as empty.

---

## 8. Phase 6: Wire It Up in CLAUDE.md

Your project's `CLAUDE.md` must tell Claude Code about the governance system. Add this section:

```markdown
## Governance System

This project uses the ORCH multi-agent governance system. All complex tasks MUST flow through the orchestrator-brain agent.

### Key Rules
- **Always invoke Orch first** for any multi-step or complex task
- **Never bypass the review tribunal** — all code must go through 3-gate review
- **Economy is enforced** — agent credits determine task access levels
- **Lessons are persistent** — tribunal failures become rules injected into future dispatches

### Governance Files
- Agent definitions: `.claude/agents/`
- Agent registry: `.claude/governance/agent-registry.json`
- System rules: `.claude/governance/rules.md`
- Economy config: `.claude/economy/config.json`
- Agent wallets: `.claude/economy/wallets.json`
- Transaction ledger: `.claude/economy/ledger.md`
- Session state: `.claude/system-state.json`

### Dispatch Order (mandatory)
1. **Planner** → map approach, identify files
2. **Coder** → execute the plan
3. **Review Tribunal** → 3-gate quality gate (code-reviewer + test-reviewer → standards-judge)
4. **Economy Update** → apply credits based on judge's score
```

---

## 9. How the System Works at Runtime

### 9.1 Session Start

User opens Claude Code and says anything. Claude Code sees the `orchestrator-brain.md` agent description and routes the request to Orch. Orch executes:

```
BOOT PROTOCOL
├── Phase 1: Read system-state.json, agent-registry.json, wallets.json, config.json, rules.md
├── Phase 2: Check for pending tasks, failed tasks, conflicts, suspended agents
├── Phase 3: Update system-state.json (boot count, timestamps)
└── Phase 4: Report status, await user request
```

### 9.2 Task Execution Flow

```
User: "Add a user profile feature"
        ↓
ORCH: Decompose into subtasks
├── Task 1: Plan the feature (planner agent)
├── Task 2: Implement backend (coder agent)
├── Task 3: Implement frontend (coder agent)
├── Task 4: Review (tribunal — mandatory)
└── Task 5: Document (docs agent — if needed)
        ↓
ORCH: Dispatch planner agent
        ↓
ORCH: Receive plan, dispatch coder agent
  ↓ (Orch reads coder's lessons.md, injects RULES into prompt)
        ↓
ORCH: Coder completes → dispatch tribunal
├── Gate 1: code-reviewer (parallel)  → produces Code Review Report
├── Gate 2: test-reviewer (parallel)  → produces Test Review Report
└── Gate 3: standards-judge (sequential, reads both reports)
                ↓
         VERDICT: ACCEPT 8/10
                ↓
ORCH: Update economy
├── wallets.json: coder +10 credits (task_completed)
├── wallets.json: coder +5 credits (high_quality_bonus for 8+)
├── ledger.md: append Transaction #N
├── Recalculate skill level
└── Report to user
```

### 9.3 Revision Flow

```
Standards Judge: REVISE 5/10
  "Fix these 3 issues: [specific list]"
        ↓
ORCH: Apply revision penalty (-5 credits to coder)
ORCH: Write RULES to coder's lessons.md
ORCH: Send revision requirements back to coder
        ↓
Coder: Fixes issues
        ↓
ORCH: Re-run tribunal (all 3 gates)
        ↓
Standards Judge: ACCEPT 7/10
        ↓
ORCH: Apply acceptance reward (+10 credits)
ORCH: Net result: -5 + 10 = +5 credits
```

### 9.4 Lesson Injection Example

Before dispatching a coder that has lessons:

```
Task tool prompt to coder agent:

"You are the my-coder-agent agent.

## LESSONS FROM PREVIOUS WORK
Review these before starting. RULES are mandatory — violating them causes REVISE/REJECT.

### Testing
- R01: [2026-03-19] Always check for existing inline Schema::create() in test setUp()
  before creating shared migrations — test suite broke because both test file and shared
  migration tried to create the same table (REVISE 4/10)

### Conventions
- R02: [2026-03-19] Never hardcode campaign lists — always pull from request context
  or configuration (REVISE 7/10)

### Integration
- T01: [2026-03-19] Use Http::fake() with closure for testing async API call failures —
  Http::throw() doesn't work in Laravel 12 Http::fake context (ACCEPT 8/10)

## TASK
[actual task details...]"
```

---

## 10. Customization Guide

### 10.1 Adding a New Agent

1. **Create the agent definition** in `.claude/agents/your-agent.md` with YAML frontmatter + system prompt
2. **Add to registry** in `governance/agent-registry.json` under the appropriate project
3. **Initialize wallet** in `economy/wallets.json` with 50 credits (trusted)
4. **Create memory directory** at `.claude/agent-memory/your-agent/` (or `{project}/.claude/agent-memory/your-agent/`) with empty `MEMORY.md` and `lessons.md`
5. **Update Orch's agent tables** in `orchestrator-brain.md` to include the new agent

### 10.2 Adjusting the Economy

Edit `economy/config.json`:
- **Softer penalties:** Reduce `revision_required` from -5 to -2
- **Faster progression:** Lower skill level thresholds
- **Higher trust barrier:** Increase `elite.min_credits` from 80 to 100

### 10.3 Simplifying the Tribunal

For smaller projects, you can:
- **Skip the plan auditor step** (keep planner → coder → tribunal)
- **Combine code-reviewer and test-reviewer** into a single reviewer agent
- **Remove the learning system** (skip lesson extraction/injection)

But **never remove the standards-judge** — it's the scoring mechanism that drives the economy.

### 10.4 Adding a New Project (Monorepo)

1. Add a new project key in `governance/agent-registry.json` → `agents`
2. Create project-specific agents in `.claude/agents/` with project prefix (e.g., `proj2-coder.md`)
3. Initialize wallets for new agents
4. Update Orch's workspace table and agent registry reference

### 10.5 Minimum Viable Setup

If you want the simplest possible governance system, you need exactly **5 files + 4 agents**:

**Agents:**
1. `orchestrator-brain.md` — coordinator
2. `code-reviewer.md` — Gate 1
3. `standards-judge.md` — Gate 3 (can absorb test-reviewer duties)
4. `your-coder-agent.md` — implements code

**Files:**
1. `economy/config.json` — economy rules
2. `economy/wallets.json` — agent balances
3. `economy/ledger.md` — transaction history
4. `governance/agent-registry.json` — agent registry
5. `system-state.json` — session state

---

## 11. Troubleshooting

### Orch doesn't boot
- Check that `system-state.json` exists and is valid JSON
- Check that all governance/economy files exist at the expected paths
- Verify the orchestrator-brain.md description field includes examples that match user intent

### Agents don't get dispatched
- Check `governance/agent-registry.json` has the agent registered
- Check the agent's trust level allows the task priority
- Check the agent definition file exists at the path specified in the registry

### Economy not updating
- Orch must read `economy/wallets.json` before updating (boot protocol)
- The standards-judge's ECONOMY RECOMMENDATION must include specific credit values
- Orch must write both `wallets.json` and `ledger.md` after each tribunal

### Lessons not injecting
- Check that `lessons.md` exists in the agent's memory directory
- Orch must read lessons BEFORE the dispatch prompt is sent
- The `## LESSONS FROM PREVIOUS WORK` header must be at the top of the dispatch prompt

### Tribunal returns inconsistent scores
- Check that the standards-judge has the scoring weights and override rules in its prompt
- Ensure both reviewer reports are passed to the judge in full
- The judge must see the original task description, not just the reviews

---

## Quick Start Checklist

```
[ ] Created .claude/ directory structure (governance/, economy/, agents/, agent-memory/)
[ ] Created governance/rules.md (23 rules)
[ ] Created governance/policies.md (assignment, quality, lifecycle, learning policies)
[ ] Created governance/learning-policy.md (lesson format, extraction, pruning, graduation)
[ ] Created governance/agent-registry.json (all agents registered)
[ ] Created governance/conflict-log.md (empty template)
[ ] Created economy/config.json (rewards, penalties, trust levels, skill tiers)
[ ] Created economy/wallets.json (all agents initialized)
[ ] Created economy/ledger.md (Transaction #0 — initialization)
[ ] Created system-state.json (clean initial state)
[ ] Created orchestrator-brain.md (full prompt with boot protocol + dispatch order)
[ ] Created code-reviewer.md (Gate 1 prompt)
[ ] Created test-reviewer.md (Gate 2 prompt)
[ ] Created standards-judge.md (Gate 3 prompt with scoring framework)
[ ] Created project-specific agent .md files
[ ] Created agent-memory directories with empty MEMORY.md + lessons.md
[ ] Updated CLAUDE.md to reference the governance system
[ ] First boot: Orch reports "SYSTEM CLEAN" — ready for work
```

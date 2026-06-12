# Orchestrator Extension — Vision Document

## Core Concept

The orchestrator is a **planner and coordinator**, not an executor. It receives a problem, creates a dynamic plan, delegates to specialist subagents, receives their output, recalibrates the approach, and repeats until the goal is achieved.

## Architecture

```
User Problem
     │
     ▼
┌─────────────────────────────┐
│      ORCHESTRATOR            │
│  ┌─────────────────────┐    │
│  │ Dynamic Step List    │    │  ← plans, updates, recalibrates
│  │ 1. Investigate ...   │    │
│  │ 2. Implement ...     │    │
│  │ 3. Review ...        │    │
│  └─────────────────────┘    │
│                              │
│  Tool: delegate(specialist)  │  ← ONLY tool available
│                              │
│  Receives: output + scope    │  ← subagent findings
│  Updates: step list          │  ← recalibrates plan
│  Repeats: until goal met     │
└─────────────────────────────┘
     │              │              │
     ▼              ▼              ▼
┌─────────┐  ┌─────────┐  ┌─────────┐
│  Scout   │  │  Coder   │  │Reviewer │
│          │  │          │  │         │
│ Goal:    │  │ Goal:    │  │ Goal:   │
│ "Find    │  │ "Create  │  │ "Check  │
│  auth    │  │  auth    │  │  auth   │
│  files"  │  │  module" │  │  code"  │
│          │  │          │  │         │
│ Steps:   │  │ Steps:   │  │ Steps:  │
│ 1. grep  │  │ 1. read  │  │ 1. read │
│ 2. read  │  │ 2. edit  │  │ 2. check│
│ 3. trace │  │ 3. write │  │ 3. flag │
│          │  │          │  │         │
│ Output → │  │ Output → │  │ Output→ │
│ orchstr  │  │ orchstr  │  │ orchstr │
└─────────┘  └─────────┘  └─────────┘
```

## Principles

### 1. Orchestrator = Planner Only
- Creates dynamic step list from user problem
- Each step involves calling a subagent or comprehending received data
- Steps are NOT predetermined — they update based on what subagents find
- Can ask user for clarification before starting if something is uncertain
- Only tool available: `delegate(specialist, task)` — deterministic measure to enforce workflow

### 2. Context Window Protection
- Orchestrator never reads files, runs commands, or does implementation
- Each delegation is isolated — subagent has its own context window
- Orchestrator receives only the final output (compressed, capped)
- Prevents context pollution that causes models to get lost
- Enables non-SOTA models to follow a deterministic workflow effectively

### 3. Subagents = Goal-Oriented Executors
When a subagent receives a task:
- Creates its own goal (what it's trying to achieve)
- Lists its own steps (what it thinks it needs to do)
- Executes those steps (reads files, searches code, runs commands)
- Updates steps dynamically if findings change the approach
- Returns structured output to orchestrator

### 4. Full Visibility to User
The user should see:
- **Orchestrator level**: Dynamic step list, which step is active, what was completed
- **Subagent level**: What the delegate is currently doing (reading file X, searching for Y, analyzing Z)
- **Tool level**: Individual tool calls and their results within subagents

### 5. Dynamic Recalibration
- Orchestrator doesn't follow a fixed script
- After each delegation, it comprehends the output
- Updates remaining steps based on new information
- Can change approach entirely if subagent finds unexpected things
- Can spawn additional subagents if needed

## Communication: Caveman Mode

Both the orchestrator and all subagents (except writer/creative tasks) operate in caveman mode by default.

### Rules
- Short, efficient, no mental filler
- Think caveman too: reasoning and output both terse
- Drop: articles (a/an/the), filler (just/really/basics), pleasantries (sure/certainly), hedging
- Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for")
- Technical terms exact. Code blocks unchanged. Errors quoted exact
- Pattern: [thing] [action] [reason]. [next step].

### Auto-Clarity
Drop caveman for: security warnings, destructive ops, multi-step ambiguity, user asks clarify. Resume after clear part done.

### Boundaries
- Orchestrator planning/reasoning: caveman
- Subagent execution/output: caveman
- Code/commits/PRs: write normal English
- Creative writing tasks: normal mode (writer specialist exempt)
- User says "stop caveman" or "normal mode": revert everywhere

### Why
- Reduces token usage (context window protection)
- Faster reasoning loops
- Non-SOTA models perform better with concise instructions
- Deterministic workflow + terse communication = maximum efficiency

## User Experience

### What the user should see:

```
Plan: ◆ Implement user authentication  ● 2/5     45s
  ✓ Scout  Discover auth architecture
  ⠼ Scout  Analyze existing patterns
      → Reading src/auth/middleware.ts
      → Running: grep -r "authenticate" src/
      → Reading src/types/auth.ts
  ○ Coder  Implement JWT token flow
  ○ Reviewer  Security review
  ○ Scout  Verify tests pass
```

### What the user should NOT see:
- Raw prompt text as plan title
- Phantom steps that never execute
- Mechanical task descriptions
- Missing subagent activity details

## Current State vs Vision

| Aspect | Current | Vision |
|--------|---------|--------|
| Plan title | Raw prompt shortened | Meaningful goal summary |
| Steps | Hardcoded template + additions | Fully dynamic from orchestrator |
| Step labels | `Specialist: shortenLabel(task)` | Human-readable descriptions |
| Subagent activity | Tool calls shown in feed | Goal + steps + tool activity |
| Subagent output | Flat text blob to orchestrator | Structured: goal, steps, findings, scope |
| Recalibration | None — linear scout→coder→review | Dynamic — steps update based on findings |
| Caveman mode | Only in subagent TERSE_INSTRUCTION | Orchestrator + all subagents (except writer) |
| User visibility | Plan panel + activity feed | Rich: orchestrator + subagent + tool levels |

## Implementation Priorities

1. **Plan title summarization** — meaningful goal text, not raw prompt
2. **Dynamic step generation** — orchestrator creates steps from problem, not template
3. **Subagent activity visibility** — show what delegate is doing in real-time
4. **Subagent self-planning** — delegate creates own goal + steps on receipt
5. **Recalibration feedback** — orchestrator updates steps based on subagent output

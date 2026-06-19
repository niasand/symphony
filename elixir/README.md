# Symphony Elixir

Symphony is a long-running orchestration service that polls an issue tracker, creates isolated workspaces, and dispatches coding agents to resolve issues autonomously.

> [!WARNING]
> Symphony Elixir is prototype software intended for evaluation only and is presented as-is.

## Architecture Overview

```
Tracker (Bitable) → Orchestrator → Agent Runner → Claude/Codex
                       ↑                              |
                       └── workspace lifecycle ───────┘
```

1. **Polls** the tracker for candidate issues in active states (default: "Open", "In Progress")
2. **Creates** an isolated workspace per issue (git clone + hooks)
3. **Dispatches** a coding agent (Claude CLI or Codex) with the workflow prompt
4. **Monitors** agent execution, handles retries on failure, stalls, and max-turns exits
5. **Reconciles** running issues against tracker state — stops agents if issue goes terminal

### Task Decomposition (Optional)

When `decomposition.enabled: true`, Symphony evaluates task complexity before dispatch:

- **Simple tasks** → single agent (unchanged behavior)
- **Complex tasks** (epic labels, long descriptions) → planner agent decomposes into sub-tasks → fan out parallel agents → merge agent integrates results

```
Complex Issue → Planner Agent → .symphony/decomposition.json
                                      ↓
                              Sub-task 1 ──→ Agent 1
                              Sub-task 2 ──→ Agent 2   (parallel)
                              Sub-task N ──→ Agent N
                                      ↓
                              Merge Agent → Resolved
```

## Quick Start

### Prerequisites

- [mise](https://mise.jdx.dev/) for Elixir/Erlang version management
- Git, SSH access to target repositories

### Install & Build

```bash
cd elixir
mise trust          # trust the .tool-versions file
mise install        # install Elixir 1.19.x + Erlang 28.x
mise exec -- mix setup    # fetch deps + compile
mise exec -- mix build    # full build
```

### Configure

Copy `WORKFLOW.md` to your project and customize the YAML front matter. Key sections:

```yaml
tracker:
  kind: bitable                        # or "memory" for local dev
  bitable_app_token: "..."             # Feishu Bitable app token
  bitable_table_id: "..."              # Bitable table ID
  bitable_project_label: "symphony"    # Labels value used to isolate this project
  active_states: ["Open", "In Progress"]
  terminal_states: ["Resolved", "Done", "Failed", "Cancelled"]

agent:
  kind: claude                         # or "codex"
  maxConcurrentAgents: 3
  maxTurns: 10

claude:
  command: claude
  maxTurnsPerInvocation: 10
  turnTimeoutMs: 3600000               # 1 hour per turn
  stallTimeoutMs: 300000               # 5 min stall detection
  skip_permissions: true

workspace:
  root: /tmp/symphony_workspaces       # workspace root directory

server:
  port: 3100                           # dashboard + JSON API port

decomposition:                         # optional task decomposition
  enabled: false
  complexityKeywords: ["epic", "complex", "multi-part", "refactor", "migration"]
  descriptionLengthThreshold: 2000
  maxSubTasks: 5
  maxSubTasksTotal: 15
  plannerMaxTurns: 3
  mergeMaxTurns: 3
```

Secrets can be set via environment variables:
```bash
export FEISHU_BITABLE_APP_TOKEN="..."    # overrides bitable_app_token in WORKFLOW.md
export FEISHU_BITABLE_TABLE_ID="..."     # overrides bitable_table_id in WORKFLOW.md
export FEISHU_BITABLE_PROJECT_LABEL="..." # overrides bitable_project_label in WORKFLOW.md
```

### Start

```bash
# Foreground (useful for dev, logs go to stdout + file)
mise exec -- ./bin/symphony ./WORKFLOW.md

# With custom log directory
mise exec -- ./bin/symphony ./WORKFLOW.md --logs-root ./my-logs

# With custom port
mise exec -- ./bin/symphony ./WORKFLOW.md --port 3100
```

### Stop

```bash
# Find the BEAM process
lsof -i :3100

# Graceful shutdown
kill <PID>

# Force kill (if graceful doesn't work)
kill -9 <PID>
```

### Restart

```bash
# Stop + Start
kill $(lsof -ti :3100) && mise exec -- ./bin/symphony ./WORKFLOW.md
```

Symphony also picks up WORKFLOW.md changes on the fly (file watcher). You usually don't need to restart for config changes — just edit WORKFLOW.md and wait ~1 second for the reload.

### Health Check

```bash
# Dashboard
open http://localhost:3100

# JSON API
curl http://localhost:3100/api/v1/state | jq .

# Force a poll cycle
curl -X POST http://localhost:3100/api/v1/refresh
```

## Operations

### Quality Gates

```bash
# Full CI pipeline (format + lint + test + dialyzer)
mise exec -- make all

# Individual checks
mise exec -- make fmt            # auto-format code
mise exec -- make fmt-check      # check formatting without modifying
mise exec -- make lint           # credo lint
mise exec -- make test           # run tests (requires port 3100 to be free)
mise exec -- make coverage       # run tests with coverage
mise exec -- make dialyzer       # type checking
```

### Logs

Logs are written to `./log/` by default. The log file includes timestamps and log levels:

```bash
# Tail live logs
tail -f log/symphony.log

# Search for dispatch events
grep "Dispatching" log/symphony.log

# Search for errors
grep -i "error\|warning\|failed" log/symphony.log | tail -50
```

### Workspace Management

Workspaces are created under `workspace.root` (default: `/tmp/symphony_workspaces/`):

```bash
# List active workspaces
ls /tmp/symphony_workspaces/

# Check disk usage
du -sh /tmp/symphony_workspaces/*

# Clean up all workspaces (safe — only terminal issue workspaces are auto-cleaned)
rm -rf /tmp/symphony_workspaces/*
```

### Monitoring Running Tasks

Via JSON API:
```bash
# Full state snapshot (running, retrying, blocked, parents)
curl -s http://localhost:3100/api/v1/state | jq '.'

# Just running tasks
curl -s http://localhost:3100/api/v1/state | jq '.running'

# Decomposition parents
curl -s http://localhost:3100/api/v1/state | jq '.parents'
```

Via Dashboard: open `http://localhost:3100` in a browser.

### Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Dashboard shows 0 running tasks | `active_states` missing "In Progress" | Add "In Progress" to `active_states` in WORKFLOW.md |
| Agent killed after ~5s | Same as above — reconciliation terminates non-active agents | Same as above |
| Port 3100 in use | Previous instance still running | `kill $(lsof -ti :3100)` |
| Tests fail with eaddrinuse | Symphony instance running on test port | Stop Symphony first |
| Agent stalls | `stallTimeoutMs` too low or agent stuck | Increase timeout or check workspace logs |
| Max turns reached | Task too large for single agent | Enable `decomposition` for complex tasks |

## Testing

```bash
# Run all tests (must stop Symphony first if port 3100 is occupied)
mise exec -- make test

# Run with coverage
mise exec -- make coverage

# Run specific test file
mise exec -- mix test test/symphony_elixir/complexity_classifier_test.exs

# Full CI (format + lint + test + dialyzer)
mise exec -- make all
```

## Project Layout

```
lib/
  symphony_elixir/
    orchestrator.ex          # Core: poll, dispatch, reconcile, retry
    agent_runner.ex          # Agent execution: workspace + multi-turn
    complexity_classifier.ex # Task complexity evaluation
    planner_prompt.ex        # Planner/merge agent prompts
    task_decomposer.ex       # Decomposition JSON parsing + sub-task creation
    config/
      schema.ex              # Ecto schema for WORKFLOW.md config
    tracker/
      issue.ex               # Normalized Issue struct
      memory.ex              # In-memory tracker adapter (for tests)
    feishu/bitable/
      adapter.ex             # Bitable tracker adapter
      client.ex              # Bitable REST API client
      issue.ex               # Bitable record → Issue mapping
    claude/cli.ex             # Claude Code CLI adapter
    codex/app_server.ex      # Codex app-server adapter
    workspace.ex              # Workspace lifecycle + hooks
    prompt_builder.ex         # Liquid template → agent prompt
    workflow.ex               # WORKFLOW.md parser
    workflow_store.ex         # Config cache + file watcher
test/
  symphony_elixir/            # ExUnit tests
WORKFLOW.md                   # Runtime configuration + prompt template
```

## FAQ

### Why Elixir?

Elixir/BEAM/OTP excels at supervising long-running concurrent processes. Task.Supervisor gives per-agent isolation, Process.monitor handles crash detection, and the actor model maps naturally to the orchestrator pattern. Hot code reloading works during development without stopping active agents.

### How do I switch from Codex to Claude?

Set `agent.kind: claude` in WORKFLOW.md and configure the `claude` section. No code changes needed.

### Can I run multiple Symphony instances?

Yes, but each needs its own WORKFLOW.md with a distinct tracker and `server.port`. For distributed workers, configure `worker.ssh_hosts`.

## License

This project is licensed under the [Apache License 2.0](../LICENSE).

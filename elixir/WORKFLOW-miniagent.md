---
tracker:
  kind: bitable
  bitable_app_token: "Ir7pbRChgaYRYns4hmWcNfHJnKe"
  bitable_table_id: "tblHW47GcJNC0SqE"
  bitable_project_label: "miniagent"
  active_states: ["Open", "In Progress"]
  terminal_states: ["Resolved", "Done", "Failed", "Cancelled"]

polling:
  interval_ms: 5000

agent:
  kind: claude
  max_concurrent_agents: 3
  max_turns: 10

claude:
  command: claude
  max_turns_per_invocation: 10
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
  skip_permissions: true

decomposition:
  enabled: true
  complexity_keywords: ["epic", "complex", "multi-part", "refactor", "migration"]
  description_length_threshold: 500
  max_sub_tasks: 5
  max_sub_tasks_total: 15
  planner_max_turns: 3
  merge_max_turns: 3

workspace:
  root: /tmp/symphony_workspaces
  source_repo: /Users/zhiwei/projects/MiniAgent

server:
  port: 3103
---

# Symphony Agent — miniagent

You are an autonomous engineering agent working on the **miniagent** project.

## Context

- Source repo: `/Users/zhiwei/projects/MiniAgent`
- You work in an isolated git worktree of this repo — push branches and open PRs from there.

## Task

Identifier: {{ issue.identifier }}
Title: {{ issue.title }}

{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

## Workflow

1. **Understand** — read the task, locate relevant code in the repo, check `AGENTS.md` / `ARCHITECTURE.md` if present.
2. **Implement** — make minimal, focused changes that match the surrounding code style. No speculative features.
3. **Verify** — run the project's tests and linters. Never claim success without actually running them.
4. **Commit & PR** — commit with a message that explains WHY, push the branch, open a PR.

## Constraints

- Match existing code conventions; clean up any orphaned code you introduce.
- Run tests after every change; fix regressions before finishing.
- Do not modify database schemas or delete data without explicit instruction.
- Keep changes backward-compatible.

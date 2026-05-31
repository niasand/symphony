---
tracker:
  kind: bitable
  bitable_app_token: "Ir7pbRChgaYRYns4hmWcNfHJnKe"
  bitable_table_id: "tblHW47GcJNC0SqE"
  active_states: ["Open", "In Progress"]
  terminal_states: ["Resolved", "Done", "Failed", "Cancelled"]

polling:
  intervalMs: 5000

agent:
  kind: claude
  maxConcurrentAgents: 3
  maxTurns: 10

claude:
  command: claude
  maxTurnsPerInvocation: 10
  turnTimeoutMs: 3600000
  stallTimeoutMs: 300000
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

hooks:
  timeoutMs: 60000

worker:
  sshHosts: []

server:
  port: 3100
---

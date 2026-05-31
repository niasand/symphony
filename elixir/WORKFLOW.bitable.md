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
  complexityKeywords: ["epic", "complex", "multi-part", "refactor", "migration"]
  descriptionLengthThreshold: 2000
  maxSubTasks: 5
  maxSubTasksTotal: 15
  plannerMaxTurns: 3
  mergeMaxTurns: 3

workspace:
  root: /tmp/symphony_workspaces

hooks:
  timeoutMs: 60000

worker:
  sshHosts: []

server:
  port: 3100
---

---
tracker:
  kind: bitable
  bitable_app_token: "Ir7pbRChgaYRYns4hmWcNfHJnKe"
  bitable_table_id: "tblHW47GcJNC0SqE"
  active_states: ["Open"]
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

workspace:
  root: /tmp/symphony_workspaces

hooks:
  timeoutMs: 60000

worker:
  sshHosts: []

server:
  port: 3100
---

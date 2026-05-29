---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: my-project
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done

polling:
  interval_ms: 30000

workspace:
  root: /tmp/symphony_workspaces

hooks:
  after_create: |
    git clone --depth 1 https://github.com/example/repo.git .
  before_run: |
    git pull --rebase
  after_run: |
    echo "Run completed for {{ issue.identifier }}"
  before_remove: |
    echo "Removing workspace for {{ issue.identifier }}"
  timeout_ms: 60000

agent:
  max_concurrent_agents: 10
  max_turns: 20
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state: {}

codex:
  command: codex app-server
  approval_policy: never
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000

server:
  port: 8080

---

# Task: {{ issue.identifier }} — {{ issue.title }}

You are working on an issue from Linear.

## Issue Details

- **Identifier**: {{ issue.identifier }}
- **Title**: {{ issue.title }}
- **State**: {{ issue.state }}
- **Priority**: {{ issue.priority }}
- **Description**:

{{ issue.description }}

{% if issue.labels.size > 0 %}
## Labels
{% for label in issue.labels %}- {{ label }}
{% endfor %}
{% endif %}

{% if issue.blocked_by.size > 0 %}
## Blocked By
{% for blocker in issue.blocked_by %}- {{ blocker.identifier }} ({{ blocker.state }})
{% endfor %}
{% endif %}

{% if attempt %}
> This is attempt #{{ attempt }}. Previous attempts encountered issues. Please review any existing work in the workspace and continue from where the last attempt left off.
{% endif %}

## Instructions

1. Read the issue description carefully
2. Implement the required changes
3. Write tests if applicable
4. Create a PR with a clear description referencing {{ issue.identifier }}
5. Update the Linear issue status as appropriate

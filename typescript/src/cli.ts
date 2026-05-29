#!/usr/bin/env node
// CLI entry point — Spec Section 17.7

import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { logger } from './observability/logger.js';
import { loadWorkflow } from './workflow/watcher.js';
import { parseConfig, validateDispatchConfig } from './config/index.js';
import { WorkflowWatcher } from './workflow/watcher.js';
import { Orchestrator } from './orchestrator/index.js';
import { startHttpServer } from './http/server.js';
import type { Issue, CodexUpdateEvent, ServiceConfig } from './types.js';
import { runAgent, type RunnerDependencies } from './agent/runner.js';
import { createForIssue } from './workspace/manager.js';
import { runHook } from './workspace/hooks.js';
import { buildPrompt } from './prompt/builder.js';
import { fetchIssueStatesByIds } from './tracker/client.js';

const GUARDRAILS_BANNER = `
╔══════════════════════════════════════════════════════════════╗
║  Symphony: Autonomous Coding Agent Orchestrator             ║
║                                                              ║
║  WARNING: This service runs coding agents autonomously.      ║
║  Agents execute shell commands, modify files, and access     ║
║  external services without manual confirmation.              ║
║                                                              ║
║  Only run this in environments you trust.                    ║
╚══════════════════════════════════════════════════════════════╝
`;

function parseArgs(argv: string[]): {
  workflowPath: string | null;
  port: number | null;
  acknowledged: boolean;
} {
  let workflowPath: string | null = null;
  let port: number | null = null;
  let acknowledged = false;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' && i + 1 < args.length) {
      port = parseInt(args[++i], 10);
      if (isNaN(port) || port < 0) {
        console.error('Invalid --port value');
        process.exit(1);
      }
    } else if (arg === '--i-understand-that-this-will-be-running-without-the-usual-guardrails') {
      acknowledged = true;
    } else if (!arg.startsWith('-')) {
      workflowPath = arg;
    }
  }

  return { workflowPath, port, acknowledged };
}

async function main(): Promise<void> {
  const { workflowPath: rawPath, port, acknowledged } = parseArgs(process.argv);

  if (!acknowledged) {
    console.log(GUARDRAILS_BANNER);
    console.log('To proceed, rerun with:');
    console.log('  --i-understand-that-this-will-be-running-without-the-usual-guardrails\n');
    process.exit(1);
  }

  // Resolve workflow path
  const workflowPath = rawPath
    ? resolve(rawPath)
    : resolve(process.cwd(), 'WORKFLOW.md');

  if (!existsSync(workflowPath)) {
    console.error(`Workflow file not found: ${workflowPath}`);
    process.exit(1);
  }

  // Load and parse workflow
  const wfResult = loadWorkflow(workflowPath);
  if (!wfResult.ok) {
    console.error(`Failed to load workflow: ${wfResult.error.message}`);
    process.exit(1);
  }

  const workflowDir = dirname(workflowPath);
  const configResult = parseConfig(wfResult.value.config, workflowDir);
  if (!configResult.ok) {
    console.error(`Invalid workflow config: ${configResult.error.message}`);
    process.exit(1);
  }

  const config = configResult.value;

  // Validate dispatch config
  const validation = validateDispatchConfig(config);
  if (!validation.ok) {
    console.error(`Dispatch validation failed: ${validation.error.message}`);
    process.exit(1);
  }

  logger.info('Symphony starting', {
    workflow_path: workflowPath,
    tracker_kind: config.tracker.kind,
    poll_interval_ms: config.polling.intervalMs,
    max_concurrent_agents: config.agent.maxConcurrentAgents,
  });

  // Create orchestrator with agent runner
  const workflow = wfResult.value;
  const deps: RunnerDependencies = {
    createForIssue,
    runHook,
    buildPrompt,
    fetchIssueStatesByIds,
    getPromptTemplate: () => workflow.prompt_template,
  };

  const workerRunFn = (
    issue: Issue,
    attempt: number | null,
    cfg: ServiceConfig,
    onMessage: (event: CodexUpdateEvent) => void,
    signal: AbortSignal,
  ) => runAgent(issue, attempt, cfg, onMessage, signal, deps);

  const orchestrator = new Orchestrator(workflowPath, config, workerRunFn);

  // Start workflow watcher
  const watcher = new WorkflowWatcher();
  watcher.start(
    workflowPath,
    (workflow) => {
      const cfgResult = parseConfig(workflow.config, workflowDir);
      if (cfgResult.ok) {
        orchestrator.updateConfig(cfgResult.value);
      }
    },
    (error) => {
      logger.error('Workflow reload error', { error: error.message });
    },
  );

  // Start HTTP server if configured
  const effectivePort = port ?? config.server.port;
  if (effectivePort != null) {
    startHttpServer(orchestrator, { port: effectivePort });
  }

  // Start orchestrator
  orchestrator.start();

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info('Shutting down', { signal });
    watcher.stop();
    orchestrator.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Symphony failed to start:', err);
  process.exit(1);
});

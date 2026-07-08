#!/usr/bin/env node
import { Command } from 'commander';
import { basename } from 'node:path';
import { ForgeRuntime } from './core/forge.js';
import { FileTaskStore } from './providers/store-filesystem/index.js';
import { FileRunStore } from './providers/store-filesystem/runs.js';
import { GitVcsProvider } from './providers/vcs-git/index.js';
import { GitWorktreeProvider } from './providers/workspace-git-worktree/index.js';
import { PiAgentProvider } from './providers/agent-pi/index.js';
import { GitHubScmProvider } from './providers/scm-github/index.js';
import { HeuristicBuildPlannerProvider } from './providers/build-heuristic/index.js';
import { HostIsolationProvider } from './providers/isolation-host/index.js';
import { DockerIsolationProvider } from './providers/isolation-docker/index.js';
import { PodmanIsolationProvider } from './providers/isolation-podman/index.js';
import { readForgeConfigSync } from './core/config.js';

export function isolationProvider() {
  const configured = readForgeConfigSync()?.providers?.isolation;
  const requested = process.env.FORGE_ISOLATION ?? configured ?? 'host';
  if (requested === 'docker' || requested === 'isolation.docker') return new DockerIsolationProvider();
  if (requested === 'podman' || requested === 'isolation.podman') return new PodmanIsolationProvider({ image: process.env.FORGE_PODMAN_IMAGE, readyCommand: process.env.FORGE_PODMAN_READY ? ['sh', '-lc', process.env.FORGE_PODMAN_READY] : undefined, readyAttempts: process.env.FORGE_PODMAN_READY_ATTEMPTS ? Number(process.env.FORGE_PODMAN_READY_ATTEMPTS) : undefined, mountPiConfig: process.env.FORGE_PODMAN_MOUNT_PI_CONFIG !== '0', piConfigPath: process.env.FORGE_PODMAN_PI_CONFIG });
  if (requested === 'host' || requested === 'isolation.host') return new HostIsolationProvider();
  throw new Error(`Unknown isolation provider '${requested}'. Expected host, docker, podman, isolation.host, isolation.docker, or isolation.podman.`);
}

function runtime() {
  return new ForgeRuntime({ store: new FileTaskStore(), runStore: new FileRunStore(), vcs: new GitVcsProvider(), workspace: new GitWorktreeProvider(), isolation: isolationProvider(), agent: new PiAgentProvider('pi', ['-p']), scm: new GitHubScmProvider(), buildPlanner: new HeuristicBuildPlannerProvider() });
}

const program = new Command();
program.name('forge').description('Wide agentic software-work orchestration').version('0.0.0');

program.command('init').option('-n, --name <name>').action(async (opts) => {
  const cfg = await runtime().init(opts.name ?? basename(process.cwd()));
  console.log(`Initialized Forge project ${cfg.project.name}`);
});

program.command('doctor').description('Run provider-declared environment checks').action(async () => {
  const results = await runtime().doctor();
  let failed = false;
  for (const r of results) {
    const mark = r.status === 'pass' ? '✓' : r.status === 'warn' ? '!' : '✗';
    console.log(`${mark} ${r.id}: ${r.message}`);
    if (r.detail) console.log(`  ${r.detail.trim().split('\n').join('\n  ')}`);
    if (r.status === 'fail') failed = true;
  }
  if (failed) process.exitCode = 1;
});

const isolation = program.command('isolation').description('Inspect the selected isolation provider');
isolation.command('status').description('Report the selected isolation provider and readiness').action(async () => {
  const status = await runtime().isolationStatus();
  console.log(`provider=${status.providerId}`);
  console.log(`readiness=${status.readiness}`);
  for (const r of status.checks) {
    const mark = r.status === 'pass' ? '✓' : r.status === 'warn' ? '!' : '✗';
    console.log(`${mark} ${r.id}: ${r.message}`);
    if (r.detail) console.log(`  ${r.detail.trim().split('\n').join('\n  ')}`);
  }
  if (status.readiness === 'fail') process.exitCode = 1;
});

program.command('sync').description('Run provider-declared sync tasks').option('-m, --message <message>', 'commit/sync message').option('--dry-run', 'show sync work without changing state').action(async (opts) => {
  const results = await runtime().sync({ message: opts.message, dryRun: opts.dryRun });
  let failed = false;
  for (const r of results) {
    const mark = r.status === 'changed' ? '↻' : r.status === 'unchanged' ? '✓' : r.status === 'blocked' ? '!' : '✗';
    console.log(`${mark} ${r.id}: ${r.message}`);
    if (r.detail) console.log(`  ${r.detail.trim().split('\n').join('\n  ')}`);
    if (r.status === 'blocked' || r.status === 'failed') failed = true;
  }
  if (failed) process.exitCode = 1;
});

program.command('build <request...>').alias('b').description('Plan a natural-language build task and run the Forge flow').option('--name <name>', 'hard-define task title').option('--pattern <pattern>', 'provider-specific task matching pattern').option('--auto-approve', 'approve generated specs without stopping').option('--no-run', 'create/plan task without running implementation').action(async (request: string[], opts) => {
  const result = await runtime().build({ prompt: request.join(' '), taskName: opts.name, taskPattern: opts.pattern, autoApprove: opts.autoApprove, run: opts.run }, chunk => process.stdout.write(chunk));
  console.log(`${result.task.id} ${result.task.status} ${result.task.title}`);
  console.log(`complexity=${result.plan.complexity} spec=${result.plan.requiresSpec ? 'required' : 'not-required'}`);
  console.log(result.plan.reason);
  if (result.task.spec && !result.task.spec.approved) console.log(`spec=${result.task.spec.path} approve with: forge task approve ${result.task.id}`);
  if (result.runResults) console.log(JSON.stringify(result.runResults, null, 2));
});

const task = program.command('task');
task.command('create <title>').option('-d, --description <text>').option('-c, --complexity <level>', 'trivial|small|medium|large', 'small').option('--issue', 'create GitHub issue').action(async (title, opts) => {
  const t = await runtime().createTask(title, { description: opts.description, complexity: opts.complexity, createIssue: opts.issue });
  console.log(`${t.id} ${t.status} ${t.title}`);
});
task.command('list').action(async () => { for (const t of await runtime().deps.store.list()) console.log(`${t.id}\t${t.status}\t${t.complexity}\t${t.title}`); });
task.command('spec <id> <body>').action(async (id, body) => { const t = await runtime().writeSpec(id, body); console.log(`${t.id} ${t.status} ${t.spec?.path}`); });
task.command('approve [pattern]').description('Approve one awaiting task, optionally by id/title pattern').action(async pattern => { const t = await runtime().approve(pattern); console.log(`${t.id} ${t.status}`); });
task.command('run [pattern]').description('Run one ready task, optionally by id/title pattern').action(async pattern => { console.log(JSON.stringify(await runtime().runTask(pattern, chunk => process.stdout.write(chunk)), null, 2)); });
task.command('run-ready').action(async () => { console.log(JSON.stringify(await runtime().runReady(), null, 2)); });

const run = program.command('run-history').alias('runs').description('Inspect durable task run records');
run.command('list').option('--task <id>', 'filter by task id').action(async opts => {
  const store = runtime().deps.runStore;
  if (!store) throw new Error('No run store configured');
  for (const r of await store.list({ taskId: opts.task })) console.log(`${r.id}\t${r.status}\t${r.taskId}\t${r.startedAt}\t${r.finishedAt ?? ''}\t${r.taskTitle}`);
});
run.command('log <id>').description('Print captured agent output for a run').action(async id => {
  const store = runtime().deps.runStore;
  if (!store) throw new Error('No run store configured');
  process.stdout.write(await store.readLog(id));
});

program.command('approve [pattern]').description('Approve one awaiting task, optionally by id/title pattern').action(async pattern => { const t = await runtime().approve(pattern); console.log(`${t.id} ${t.status}`); });
program.command('run [pattern]').description('Run one ready task, optionally by id/title pattern').action(async pattern => { console.log(JSON.stringify(await runtime().runTask(pattern, chunk => process.stdout.write(chunk)), null, 2)); });

program.parseAsync().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });

#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { basename } from 'node:path';
import { ForgeRuntime } from './core/forge.js';
import { FileTaskStore } from './providers/store-filesystem/index.js';
import { FileRunStore } from './providers/store-filesystem/runs.js';
import { FileReleaseStore } from './providers/store-filesystem/releases.js';
import { GitVcsProvider } from './providers/vcs-git/index.js';
import { GitWorktreeProvider } from './providers/workspace-git-worktree/index.js';
import { GitWorktreeChangeSetProvider } from './providers/workspace-git-worktree/changes.js';
import { PiAgentProvider } from './providers/agent-pi/index.js';
import { GitHubScmProvider } from './providers/scm-github/index.js';
import { HeuristicBuildPlannerProvider } from './providers/build-heuristic/index.js';
import { HostIsolationProvider } from './providers/isolation-host/index.js';
import { DockerIsolationProvider } from './providers/isolation-docker/index.js';
import { PodmanIsolationProvider } from './providers/isolation-podman/index.js';
import { readForgeConfigSync } from './core/config.js';
import { ShellValidationProvider } from './providers/validation-shell/index.js';
import { HeuristicTaskDiscoveryProvider } from './providers/discovery-heuristic/index.js';
import { MemoryLeaseProvider } from './providers/lease-memory/index.js';
import { FileLeaseProvider } from './providers/lease-filesystem/index.js';
import { FileWorkstreamProvider } from './providers/workstream-filesystem/index.js';
import { LinearWorkstreamProvider } from './providers/workstream-linear/index.js';
import { GitHubIssuesWorkstreamProvider } from './providers/workstream-github/index.js';
import { PiWorkstreamPlannerProvider } from './providers/planner-pi/index.js';
import { PiSpecProvider } from './providers/spec-pi/index.js';
import { ConsoleNotificationProvider, type ConsoleNotificationChannel } from './providers/notification-console/index.js';
import { createInterface } from 'node:readline/promises';

const useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY;
const color = (code: number, text: string) => useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
const dim = (text: string) => color(2, text);
const cyan = (text: string) => color(36, text);
const green = (text: string) => color(32, text);
const yellow = (text: string) => color(33, text);
const red = (text: string) => color(31, text);
const magenta = (text: string) => color(35, text);

export function logPrefix(label: string, now = new Date()) {
  const timestamp = now.toISOString().slice(11, 19);
  return `${dim(timestamp)} ${cyan(label.padEnd(10))}`;
}

export function processLogLine(label: string, message: string, emoji = '•', now = new Date()) {
  return `${logPrefix(label, now)} ${emoji} ${message}`;
}

function logProcess(label: string, message: string, emoji = '•') {
  console.log(processLogLine(label, message, emoji));
}

function processObserver() {
  let buffered = '';
  return (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const lower = line.toLowerCase();
      const label = lower.startsWith('yolo:') ? 'wdo' : lower.includes('lease') ? 'lease' : lower.includes('workspace') ? 'workspace' : lower.includes('environment') ? 'runner' : lower.includes('agent') ? 'agent' : lower.startsWith('starting task') ? 'task' : 'runner';
      const emoji = label === 'wdo' ? '⚡' : label === 'lease' ? '🔒' : label === 'workspace' ? '🌿' : label === 'agent' ? '🤖' : label === 'task' ? '🚀' : '▶';
      process.stdout.write(`${processLogLine(label, line, emoji)}\n`);
    }
  };
}

export function isolationProvider() {
  const configured = readForgeConfigSync()?.providers?.isolation;
  const requested = process.env.FORGE_ISOLATION ?? configured ?? 'host';
  if (requested === 'docker' || requested === 'isolation.docker') return new DockerIsolationProvider();
  if (requested === 'podman' || requested === 'isolation.podman') return new PodmanIsolationProvider({ image: process.env.FORGE_PODMAN_IMAGE, readyCommand: process.env.FORGE_PODMAN_READY ? ['sh', '-lc', process.env.FORGE_PODMAN_READY] : undefined, readyAttempts: process.env.FORGE_PODMAN_READY_ATTEMPTS ? Number(process.env.FORGE_PODMAN_READY_ATTEMPTS) : undefined, mountPiConfig: process.env.FORGE_PODMAN_MOUNT_PI_CONFIG !== '0', piConfigPath: process.env.FORGE_PODMAN_PI_CONFIG });
  if (requested === 'host' || requested === 'isolation.host') return new HostIsolationProvider();
  throw new Error(`Unknown isolation provider '${requested}'. Expected host, docker, podman, isolation.host, isolation.docker, or isolation.podman.`);
}

export function notificationProvider() {
  const config = readForgeConfigSync();
  const requested = config?.providers?.notification ?? (config ? undefined : 'console');
  if (!requested) return undefined;
  if (requested !== 'console' && requested !== 'notification.console') throw new Error(`Unknown notification provider '${requested}'. Expected console or notification.console.`);
  const channel = config?.notifications?.channel ?? 'stderr';
  if (channel !== 'stdout' && channel !== 'stderr') throw new Error(`Unknown notification channel '${channel}'. Expected stdout or stderr.`);
  return new ConsoleNotificationProvider(channel as ConsoleNotificationChannel);
}

function runtime() {
  const config = readForgeConfigSync();
  const validationCommands = config?.validation?.commands ?? [];
  const requestedValidation = config?.providers?.validation;
  if (requestedValidation && requestedValidation !== 'shell' && requestedValidation !== 'validation.shell') throw new Error(`Unknown validation provider '${requestedValidation}'. Expected shell or validation.shell.`);
  const validation = validationCommands.length ? new ShellValidationProvider(validationCommands) : undefined;
  const requestedDiscovery = config?.providers?.taskDiscovery;
  if (requestedDiscovery && requestedDiscovery !== 'heuristic' && requestedDiscovery !== 'task-discovery.heuristic') throw new Error(`Unknown task discovery provider '${requestedDiscovery}'. Expected heuristic or task-discovery.heuristic.`);
  const requestedLease = config?.providers?.lease;
  if (requestedLease && !['memory', 'lease.memory', 'filesystem', 'lease.filesystem'].includes(requestedLease)) throw new Error(`Unknown lease provider '${requestedLease}'. Expected memory, filesystem, lease.memory, or lease.filesystem.`);
  const requestedWorkstream = config?.providers?.workstream;
  if (requestedWorkstream && !['filesystem', 'workstream.filesystem', 'linear', 'workstream.linear', 'github', 'workstream.github'].includes(requestedWorkstream)) throw new Error(`Unknown workstream provider '${requestedWorkstream}'. Expected filesystem, linear, github, workstream.filesystem, workstream.linear, or workstream.github.`);
  const requestedPlanner = config?.providers?.workstreamPlanner;
  if (requestedPlanner && requestedPlanner !== 'pi' && requestedPlanner !== 'workstream-planner.pi') throw new Error(`Unknown workstream planner provider '${requestedPlanner}'. Expected pi or workstream-planner.pi.`);
  const requestedSpec = config?.providers?.spec ?? 'pi';
  if (requestedSpec && requestedSpec !== 'pi' && requestedSpec !== 'spec.pi') throw new Error(`Unknown spec provider '${requestedSpec}'. Expected pi or spec.pi.`);
  const staleAfterMs = process.env.FORGE_LEASE_STALE_AFTER_MS ? Number(process.env.FORGE_LEASE_STALE_AFTER_MS) : undefined;
  const lease = requestedLease === 'filesystem' || requestedLease === 'lease.filesystem' ? new FileLeaseProvider(process.cwd(), staleAfterMs) : new MemoryLeaseProvider();
  const workstream = requestedWorkstream === 'linear' || requestedWorkstream === 'workstream.linear'
    ? new LinearWorkstreamProvider(config?.linear ?? {})
    : requestedWorkstream === 'github' || requestedWorkstream === 'workstream.github'
      ? new GitHubIssuesWorkstreamProvider(config?.github ?? {})
      : new FileWorkstreamProvider();
  return new ForgeRuntime({ store: new FileTaskStore(), runStore: new FileRunStore(), releaseStore: new FileReleaseStore(), vcs: new GitVcsProvider(), workspace: new GitWorktreeProvider(), isolation: isolationProvider(), agent: new PiAgentProvider('pi', ['-p']), scm: new GitHubScmProvider(), buildPlanner: new HeuristicBuildPlannerProvider(), changeSet: new GitWorktreeChangeSetProvider(), validation, taskDiscovery: new HeuristicTaskDiscoveryProvider(), lease, workstream, workstreamPlanner: new PiWorkstreamPlannerProvider(config?.pi?.command ?? 'pi', config?.pi?.args ?? ['-p']), spec: requestedSpec ? new PiSpecProvider(config?.pi?.command ?? 'pi', config?.pi?.args ?? ['-p']) : undefined, notification: notificationProvider() });
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

program.command('status').description('List pending human actions with ready-to-run next commands').action(async () => {
  const lines = await runtime().status();
  if (!lines.length) console.log('no pending human actions');
  for (const line of lines) console.log(line);
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

const lease = program.command('lease').description('Inspect and clean provider-neutral resource leases');
lease.command('status').description('List active resource leases after stale cleanup').action(async () => {
  const entries = await runtime().leaseStatus();
  if (!entries.length) console.log('no active leases');
  for (const entry of entries) console.log(`${entry.id}\t${entry.taskId}\t${entry.scope.kind}:${entry.scope.value}\tacquired=${entry.acquiredAt}${entry.staleAt ? `\tstaleAt=${entry.staleAt}` : ''}`);
});
lease.command('cleanup').description('Remove stale resource leases').action(async () => {
  const removed = await runtime().cleanupLeases();
  console.log(`removed ${removed} stale lease(s)`);
});

program.command('process').description('Continuously sweep the workstream: enqueue unblocked items, run ready tasks, then print pending human actions').option('--once', 'run a single sweep and exit').option('--interval <seconds>', 'seconds between sweeps', v => Number(v), 60).option('-p, --parallel <count>', 'maximum ready tasks to run concurrently during each sweep', v => Number(v), 2).option('--yolo', 'bypass human spec approval and run acceptance gates').action(async opts => {
  const rt = runtime();
  let stopping = false;
  let wakeSleep: (() => void) | undefined;
  const stop = () => { stopping = true; wakeSleep?.(); };
  process.once('SIGINT', stop);
  const sleep = (seconds: number) => new Promise<void>(resolve => {
    const timer = setTimeout(resolve, Math.max(0, seconds) * 1000);
    wakeSleep = () => { clearTimeout(timer); resolve(); };
  }).finally(() => { wakeSleep = undefined; });
  try {
    do {
      logProcess('sweep', `starting sweep (parallel=${opts.parallel}${opts.yolo ? ', yolo=on' : ''})`, '🔄');
      const result = await rt.sweepWorkstream(processObserver(), { concurrency: opts.parallel, yolo: opts.yolo });
      logProcess('sweep', `enqueued ${result.enqueued.length}, ran ${result.runResults.length}`, result.errors.length ? '⚠️' : '✅');
      for (const error of result.errors) logProcess('sweep-error', error, '❌');
      if (opts.yolo) logProcess('wdo', `specced ${result.yolo.specced.length}, approved ${result.yolo.approved.length}, accepted ${result.yolo.accepted.length}, errors ${result.yolo.errors.length}`, result.yolo.errors.length ? '⚠️' : '⚡');
      for (const error of result.yolo.errors) logProcess('wdo-error', error, '❌');
      if (!result.status.length) logProcess('status', 'no pending human actions', '✨');
      for (const line of result.status) logProcess('status', line, '📌');
      if (opts.once || stopping) break;
      logProcess('sleep', `waiting ${opts.interval}s before next sweep`, '⏱️');
      await sleep(opts.interval);
    } while (!stopping);
  } finally {
    process.off('SIGINT', stop);
  }
});

const workstream = program.command('workstream').description('Manage provider-neutral workstream backlog items');
workstream.command('plan <prompt...>').description('Define a workstream with the configured planner provider, answering its clarifying questions').option('--no-questions', 'plan without clarifying questions').action(async (promptParts: string[], opts) => {
  const rl = opts.questions === false ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ask = rl ? async (question: string) => (await rl.question(`\n? ${question}\n> `)).trim() : undefined;
    const { plan, added } = await runtime().planWorkstream({ prompt: promptParts.join(' '), ask });
    if (plan.summary) console.log(`\n${plan.summary}`);
    for (const item of added) console.log(`${item.id}\t${item.complexity}\tdeps=${item.dependencies.join(',') || '-'}\t${item.title}`);
    console.log(`\nadded ${added.length} item(s). Next: forge workstream enqueue, then forge task run-ready --parallel <n>`);
  } finally {
    rl?.close();
  }
});
workstream.command('import [path]').description('Merge roadmap workstream items from a JSON file into the configured provider').option('--replace', 'replace the entire backlog instead of merging by item id').action(async (path, opts) => {
  const items = await runtime().importWorkstream(path, { replace: opts.replace });
  console.log(`imported ${items.length} workstream item(s)${opts.replace ? ' (replaced backlog)' : ''}`);
});
workstream.command('list').description('List imported workstream backlog items').action(async () => {
  for (const item of await runtime().listWorkstream()) console.log(`${item.id}\t${item.status}\t${item.complexity}\tdeps=${item.dependencies.join(',') || '-'}\t${item.title}${item.taskId ? `\ttask=${item.taskId}` : ''}`);
});
workstream.command('enqueue [ids...]').description('Create Forge tasks from planned workstream items whose dependencies are done; pass ids to force specific items').action(async ids => {
  const tasks = await runtime().enqueueWorkstream(ids);
  if (!tasks.length) console.log('no eligible planned items (already queued, or waiting on dependencies)');
  for (const task of tasks) console.log(`${task.id} ${task.status} ${task.title}`);
});

program.command('build <request...>').alias('b').description('Plan a natural-language build task and run the Forge flow').option('--name <name>', 'hard-define task title').option('--pattern <pattern>', 'provider-specific task matching pattern').option('--auto-approve', 'approve generated specs without stopping').option('--no-run', 'create/plan task without running implementation').action(async (request: string[], opts) => {
  const result = await runtime().build({ prompt: request.join(' '), taskName: opts.name, taskPattern: opts.pattern, autoApprove: opts.autoApprove, run: opts.run }, chunk => process.stdout.write(chunk));
  console.log(`${result.task.id} ${result.task.status} ${result.task.title}`);
  console.log(`complexity=${result.plan.complexity} spec=${result.plan.requiresSpec ? 'required' : 'not-required'}`);
  console.log(result.plan.reason);
  if (result.task.spec && !result.task.spec.approved) console.log(`spec=${result.task.spec.path} approve with: forge task approve ${result.task.id}`);
  if (result.runResults) console.log(JSON.stringify(result.runResults, null, 2));
});

const release = program.command('release').description('Manage provider-neutral release records');
release.command('create <version>').requiredOption('--target-kind <kind>', 'provider-neutral target kind, such as package or environment').requiredOption('--target-id <id>', 'provider-neutral target identifier').option('--target-name <name>', 'human-readable target name').option('--status <status>', 'planned|preparing|ready|released|failed|canceled', 'planned').option('--notes <notes>').action(async (version, opts) => {
  const record = await runtime().createRelease({ version, status: opts.status, target: { kind: opts.targetKind, id: opts.targetId, name: opts.targetName }, notes: opts.notes });
  console.log(`${record.id}\t${record.status}\t${record.version}\t${record.target.kind}:${record.target.id}`);
});
release.command('list').option('--status <status>', 'filter by release lifecycle status').option('--target-kind <kind>', 'filter by target kind').action(async opts => {
  for (const record of await runtime().listReleases({ status: opts.status, targetKind: opts.targetKind })) console.log(`${record.id}\t${record.status}\t${record.version}\t${record.target.kind}:${record.target.id}\t${record.createdAt}`);
});
release.command('show <id>').action(async id => {
  const record = await runtime().getRelease(id);
  if (!record) throw new Error(`Release not found: ${id}`);
  console.log(JSON.stringify(record, null, 2));
});
release.command('status <id> <status>').description('Update a release lifecycle status').action(async (id, status) => {
  const now = new Date().toISOString();
  const timestamps: Record<string, string> = status === 'preparing' ? { startedAt: now } : status === 'released' ? { releasedAt: now } : status === 'failed' ? { failedAt: now } : status === 'canceled' ? { canceledAt: now } : {};
  const record = await runtime().updateRelease(id, { status, ...timestamps });
  console.log(`${record.id}\t${record.status}\t${record.updatedAt}`);
});

const task = program.command('task');
task.command('create <title>').option('-d, --description <text>').option('-c, --complexity <level>', 'trivial|small|medium|large', 'small').option('--issue', 'create GitHub issue').action(async (title, opts) => {
  const t = await runtime().createTask(title, { description: opts.description, complexity: opts.complexity, createIssue: opts.issue });
  console.log(`${t.id} ${t.status} ${t.title}`);
});
task.command('list').action(async () => { for (const t of await runtime().deps.store.list()) console.log(`${t.id}\t${t.status}\t${t.complexity}\t${t.title}${t.discovery?.resourceScopes.length ? `\tscopes=${t.discovery.resourceScopes.map(scope => `${scope.kind}:${scope.value}`).join(',')}` : ''}`); });
task.command('spec <id> [body]').option('--generate', 'generate the spec with the configured spec provider').action(async (id, body, opts) => { const t = opts.generate ? await runtime().generateSpec(id) : await runtime().writeSpec(id, body ?? ''); console.log(`${t.id} ${t.status} ${t.spec?.path}`); });
task.command('approve [pattern]').description('Approve one awaiting task, optionally by id/title pattern').action(async pattern => { const t = await runtime().approve(pattern); console.log(`${t.id} ${t.status}`); });
task.command('run [pattern]').description('Run one ready task, optionally by id/title pattern').action(async pattern => { console.log(JSON.stringify(await runtime().runTask(pattern, chunk => process.stdout.write(chunk)), null, 2)); });
task.command('run-ready').option('-p, --parallel <count>', 'maximum ready tasks to run concurrently', v => Number(v), 1).option('--lease-wait <seconds>', 'maximum seconds to wait for resource scope leases before deferring a task', v => Number(v)).action(async opts => { console.log(JSON.stringify(await runtime().runReady(undefined, chunk => process.stdout.write(chunk), { concurrency: opts.parallel, leaseWaitMs: Number.isFinite(opts.leaseWait) ? opts.leaseWait * 1000 : undefined }), null, 2)); });

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
run.command('show <id>').description('Show durable run metadata by id, prefix, task id, title, or branch fragment').action(async id => {
  const r = await runtime().showRun(id);
  console.log(`${r.id} ${r.status} ${r.taskTitle}`);
  console.log(`task=${r.taskId}`);
  console.log(`started=${r.startedAt} updated=${r.updatedAt}${r.finishedAt ? ` finished=${r.finishedAt}` : ''}`);
  if (r.workspace) console.log(`workspace=${r.workspace.path} branch=${r.workspace.branch}`);
  if (r.environment) console.log(`environment=${r.environment.id} ${r.environment.description}`);
  console.log(`agent=${r.agentId} exit=${r.exitCode ?? ''}`);
  console.log(`log=${r.logPath}`);
  if (r.validation) console.log(`validation=${r.validation.results.every(g => g.status === 'pass') ? 'pass' : 'fail'} ${r.validation.validatedAt}`);
  if (r.acceptance) console.log(`acceptance=${r.acceptance.status} ${r.acceptance.acceptedAt} ${r.acceptance.message}`);
  if (r.error) console.log(`error=${r.error}`);
});
run.command('review <id>').description('Summarize the change set produced by a succeeded run').action(async id => {
  const summary = await runtime().reviewRun(id);
  console.log(`${summary.status} ${summary.runId} ${summary.files.length} file(s)`);
  if (summary.summary) console.log(summary.summary);
});
run.command('validate <id>').description('Run validation gates for a succeeded run').action(async id => {
  const results = await runtime().validateRun(id);
  for (const r of results) {
    const mark = r.status === 'pass' ? '✓' : '✗';
    console.log(`${mark} ${r.id}: ${r.message}`);
    if (r.detail) console.log(`  ${r.detail.trim().split('\n').join('\n  ')}`);
  }
});
run.command('accept <id>').description('Accept the change set from a succeeded run and mark its task done').option('-m, --message <message>', 'accept/commit message').option('--dry-run', 'validate and show what would be accepted without changing state').action(async (id, opts) => {
  const result = await runtime().acceptRun(id, opts.message, { dryRun: opts.dryRun });
  console.log(`${opts.dryRun ? 'dry-run ' : ''}${result.status} ${result.runId}: ${result.message}`);
  if (result.status === 'blocked') process.exitCode = 1;
});

program.command('approve [pattern]').description('Approve one awaiting task, optionally by id/title pattern').action(async pattern => { const t = await runtime().approve(pattern); console.log(`${t.id} ${t.status}`); });
program.command('run [pattern]').description('Run one ready task, optionally by id/title pattern').action(async pattern => { console.log(JSON.stringify(await runtime().runTask(pattern, chunk => process.stdout.write(chunk)), null, 2)); });

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  program.parseAsync().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}

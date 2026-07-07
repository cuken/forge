#!/usr/bin/env node
import { Command } from 'commander';
import { basename } from 'node:path';
import { ForgeRuntime } from './core/forge.js';
import { FileTaskStore } from './providers/store-filesystem/index.js';
import { GitVcsProvider } from './providers/vcs-git/index.js';
import { GitWorktreeProvider } from './providers/workspace-git-worktree/index.js';
import { PiAgentProvider } from './providers/agent-pi/index.js';
import { GitHubScmProvider } from './providers/scm-github/index.js';

function runtime() {
  return new ForgeRuntime({ store: new FileTaskStore(), vcs: new GitVcsProvider(), workspace: new GitWorktreeProvider(), agent: new PiAgentProvider('pi', ['-p']), scm: new GitHubScmProvider() });
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

const task = program.command('task');
task.command('create <title>').option('-d, --description <text>').option('-c, --complexity <level>', 'trivial|small|medium|large', 'small').option('--issue', 'create GitHub issue').action(async (title, opts) => {
  const t = await runtime().createTask(title, { description: opts.description, complexity: opts.complexity, createIssue: opts.issue });
  console.log(`${t.id} ${t.status} ${t.title}`);
});
task.command('list').action(async () => { for (const t of await runtime().deps.store.list()) console.log(`${t.id}\t${t.status}\t${t.complexity}\t${t.title}`); });
task.command('spec <id> <body>').action(async (id, body) => { const t = await runtime().writeSpec(id, body); console.log(`${t.id} ${t.status} ${t.spec?.path}`); });
task.command('approve <id>').action(async id => { const t = await runtime().approve(id); console.log(`${t.id} ${t.status}`); });
task.command('run-ready').action(async () => { console.log(JSON.stringify(await runtime().runReady(), null, 2)); });

program.parseAsync().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });

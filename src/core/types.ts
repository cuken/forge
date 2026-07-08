import type { TaskDiscoveryMetadata } from './discovery.js';
import type { ExecutionEnvironment } from './isolation.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ForgeProvider { id: string; kind: string; }

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: 'draft' | 'needs-spec' | 'awaiting-approval' | 'ready' | 'running' | 'blocked' | 'reviewing' | 'done' | 'failed';
  complexity: 'trivial' | 'small' | 'medium' | 'large';
  createdAt: string;
  updatedAt: string;
  issue?: IssueRef;
  spec?: SpecRef;
  contextRefs: string[];
  discovery?: TaskDiscoveryMetadata;
  targetRelease?: TaskReleaseTarget;
}

export interface TaskReleaseTarget { id: string; version: string; }
export interface IssueRef { provider: string; id: string; url?: string; }
export interface SpecRef { path: string; approved: boolean; approvedAt?: string; }

export interface ForgeConfig {
  version: 1;
  project: { name: string };
  providers: {
    store: string;
    releaseStore?: string;
    vcs: string;
    workspace: string;
    isolation?: string;
    agent: string;
    scm?: string;
    buildPlanner?: string;
    changeSet?: string;
    validation?: string;
    taskDiscovery?: string;
    lease?: string;
    workstream?: string;
    workstreamPlanner?: string;
    spec?: string;
    notification?: string;
    lifecycle?: string;
    gate?: string;
  };
  pi?: { command: string; args: string[] };
  github?: { owner?: string; repo?: string; releaseBranchTemplate?: string; releaseBaseBranch?: string };
  linear?: { teamKey?: string; project?: string };
  validation?: { commands: string[] };
  notifications?: { channel?: string };
}

export interface TaskStore extends ForgeProvider {
  kind: 'task-store';
  init(): Promise<void>;
  create(input: Omit<Task, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<Task>;
  get(id: string): Promise<Task | null>;
  list(): Promise<Task[]>;
  update(id: string, patch: Partial<Task>): Promise<Task>;
}

export interface RunRecord {
  id: string;
  taskId: string;
  taskTitle: string;
  status: 'running' | 'succeeded' | 'failed' | 'deferred';
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  workspace?: { id: string; path: string; branch: string };
  environment?: ExecutionEnvironment;
  agentId: string;
  exitCode?: number;
  logPath: string;
  error?: string;
  validation?: { validatedAt: string; results: { id: string; status: 'pass' | 'fail'; message: string; detail?: string }[] };
  acceptance?: { acceptedAt: string; providerId: string; status: 'accepted' | 'empty' | 'blocked' | 'merge-conflict'; message: string; dryRun?: boolean };
}

export interface RunStore extends ForgeProvider {
  kind: 'run-store';
  init(): Promise<void>;
  start(input: { task: Task; agentId: string }): Promise<RunRecord>;
  appendLog(id: string, chunk: string): Promise<void>;
  update(id: string, patch: Partial<RunRecord>): Promise<RunRecord>;
  get(id: string): Promise<RunRecord | null>;
  list(input?: { taskId?: string }): Promise<RunRecord[]>;
  readLog(id: string): Promise<string>;
}

export type ReleaseStatus = 'planned' | 'active' | 'ready' | 'completed';

export interface ReleaseTarget {
  kind: string;
  id: string;
  name?: string;
  metadata?: Record<string, Json>;
}

export interface ReleaseRecord {
  id: string;
  version: string;
  status: ReleaseStatus;
  target: ReleaseTarget;
  createdAt: string;
  updatedAt: string;
  scheduledAt?: string;
  startedAt?: string;
  readyAt?: string;
  completedAt?: string;
  notes?: string;
  metadata?: Record<string, Json>;
}

export interface ReleaseStore extends ForgeProvider {
  kind: 'release-store';
  init(): Promise<void>;
  create(input: Omit<ReleaseRecord, 'createdAt' | 'updatedAt'>): Promise<ReleaseRecord>;
  get(id: string): Promise<ReleaseRecord | null>;
  list(input?: { status?: ReleaseStatus; targetKind?: string }): Promise<ReleaseRecord[]>;
  update(id: string, patch: Partial<ReleaseRecord>): Promise<ReleaseRecord>;
}

export interface VcsProvider extends ForgeProvider {
  kind: 'vcs';
  isRepo(): Promise<boolean>;
  init(): Promise<void>;
  currentBranch(): Promise<string>;
  status(): Promise<{ clean: boolean; summary: string }>;
}

export interface WorkspaceProvider extends ForgeProvider {
  kind: 'workspace';
  create(input: { task: Task; baseBranch?: string }): Promise<{ id: string; path: string; branch: string }>;
}

export interface AgentProvider extends ForgeProvider {
  kind: 'agent';
  run(input: { task: Task; workspacePath: string; context: string; environment?: ExecutionEnvironment; onOutput?: (chunk: string) => void }): Promise<{ exitCode: number; output: string }>;
}

export interface ScmProvider extends ForgeProvider {
  kind: 'scm';
  createIssue(input: { title: string; body: string }): Promise<IssueRef>;
}

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
}

export interface IssueRef { provider: string; id: string; url?: string; }
export interface SpecRef { path: string; approved: boolean; approvedAt?: string; }

export interface ForgeConfig {
  version: 1;
  project: { name: string };
  providers: {
    store: string;
    vcs: string;
    workspace: string;
    isolation?: string;
    agent: string;
    scm?: string;
    buildPlanner?: string;
  };
  pi?: { command: string; args: string[] };
  github?: { owner?: string; repo?: string };
}

export interface TaskStore extends ForgeProvider {
  kind: 'task-store';
  init(): Promise<void>;
  create(input: Omit<Task, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<Task>;
  get(id: string): Promise<Task | null>;
  list(): Promise<Task[]>;
  update(id: string, patch: Partial<Task>): Promise<Task>;
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

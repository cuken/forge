import type { ForgeProvider, Json, Task } from './types.js';

export interface WorkstreamItem {
  id: string;
  title: string;
  description?: string;
  dependencies: string[];
  complexity: Task['complexity'];
  status: 'planned' | 'queued';
  taskId?: string;
}

export interface WorkstreamProvider extends ForgeProvider {
  kind: 'workstream';
  import(input: { path?: string; items?: unknown[]; replace?: boolean }): Promise<WorkstreamItem[]>;
  list(): Promise<WorkstreamItem[]>;
  update(id: string, patch: Partial<Pick<WorkstreamItem, 'status' | 'taskId'>>): Promise<WorkstreamItem>;
}

export function hasWorkstream(provider: unknown): provider is WorkstreamProvider {
  return !!provider && typeof provider === 'object' && (provider as { kind?: unknown }).kind === 'workstream' && typeof (provider as { import?: unknown }).import === 'function' && typeof (provider as { list?: unknown }).list === 'function' && typeof (provider as { update?: unknown }).update === 'function';
}

export interface WorkstreamCompletionRef {
  providerId?: string;
  id?: string;
  sha?: string;
  branch?: string;
  url?: string;
  message?: string;
  status?: string;
}

export interface WorkstreamCompletionUpdate {
  itemId: string;
  status: 'completed' | 'accepted' | 'closed' | string;
  labels?: string[];
  tags?: string[];
  comment?: string;
  body?: string;
  acceptedRunId?: string;
  commit?: WorkstreamCompletionRef;
  sync?: WorkstreamCompletionRef;
  metadata?: Record<string, Json>;
}

export interface WorkstreamCompletionProvider extends ForgeProvider {
  kind: 'workstream-completion';
  completeWorkstreamItem(input: WorkstreamCompletionUpdate): Promise<void>;
}

export function hasWorkstreamCompletion(provider: unknown): provider is WorkstreamCompletionProvider {
  return !!provider && typeof provider === 'object' && (provider as { kind?: unknown }).kind === 'workstream-completion' && typeof (provider as { completeWorkstreamItem?: unknown }).completeWorkstreamItem === 'function';
}

export interface WorkstreamDraft {
  id?: string;
  title: string;
  description?: string;
  dependencies?: string[];
  complexity?: Task['complexity'];
}

export interface WorkstreamPlan {
  providerId: string;
  summary?: string;
  items: WorkstreamDraft[];
}

export interface WorkstreamPlanRequest {
  prompt: string;
  context?: string;
  // Generic clarification channel: the provider decides what to ask, the caller decides
  // how a human answers (terminal prompt, web form, chat). Absent means plan without asking.
  ask?: (question: string) => Promise<string>;
}

export interface WorkstreamPlannerProvider extends ForgeProvider {
  kind: 'workstream-planner';
  planWorkstream(input: WorkstreamPlanRequest): Promise<WorkstreamPlan>;
}

export function hasWorkstreamPlanner(provider: unknown): provider is WorkstreamPlannerProvider {
  return !!provider && typeof provider === 'object' && (provider as { kind?: unknown }).kind === 'workstream-planner' && typeof (provider as { planWorkstream?: unknown }).planWorkstream === 'function';
}

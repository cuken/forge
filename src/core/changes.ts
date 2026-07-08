import type { ForgeProvider, RunRecord } from './types.js';

export interface ChangeSetSummary {
  providerId: string;
  runId: string;
  taskId: string;
  status: 'empty' | 'changed';
  files: string[];
  summary: string;
}

export interface CompletionReference {
  providerId?: string;
  id?: string;
  sha?: string;
  branch?: string;
  url?: string;
  message?: string;
  status?: string;
}

export interface AcceptChangeSetResult {
  providerId: string;
  runId: string;
  taskId: string;
  status: 'accepted' | 'empty' | 'blocked' | 'merge-conflict';
  message: string;
  commit?: CompletionReference;
  sync?: CompletionReference;
}

export interface ChangeSetProvider extends ForgeProvider {
  kind: 'change-set';
  review(input: { run: RunRecord }): Promise<ChangeSetSummary>;
  accept(input: { run: RunRecord; message?: string }): Promise<AcceptChangeSetResult>;
}

export function hasChangeSet(provider: ForgeProvider | undefined): provider is ChangeSetProvider {
  return provider?.kind === 'change-set' && typeof (provider as ChangeSetProvider).review === 'function' && typeof (provider as ChangeSetProvider).accept === 'function';
}

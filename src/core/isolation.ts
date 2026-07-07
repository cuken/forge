import type { Task } from './types.js';

export type IsolationKind = 'host' | 'container' | 'vm' | 'remote';

export interface WorkspaceRef {
  id: string;
  path: string;
  branch: string;
}

export interface ExecutionEnvironment {
  id: string;
  kind: IsolationKind;
  workspacePath: string;
  description: string;
  metadata?: Record<string, string>;
}

export interface IsolationPolicy {
  kind?: IsolationKind;
  network?: 'inherit' | 'disabled' | 'restricted';
  writable?: boolean;
  tools?: string[];
}

export interface IsolationProvider {
  id: string;
  kind: 'isolation';
  prepare(input: { task: Task; workspace: WorkspaceRef; policy?: IsolationPolicy }): Promise<ExecutionEnvironment>;
  cleanup?(environment: ExecutionEnvironment): Promise<void>;
}

export function hasIsolation(value: unknown): value is IsolationProvider {
  return typeof value === 'object' && value !== null && 'prepare' in value && typeof (value as { prepare?: unknown }).prepare === 'function';
}

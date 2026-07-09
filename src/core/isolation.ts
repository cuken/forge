import type { HealthCheckResult, HealthStatus } from './health.js';
import type { Task } from './types.js';

export type IsolationKind = 'host' | 'container' | 'vm' | 'remote';

export interface WorkspaceRef {
  id: string;
  path: string;
  branch: string;
}

export interface EnvironmentExecInput {
  command: string;
  args?: string[];
  cwd?: string;
  onOutput?: (chunk: string) => void;
}

export interface EnvironmentExecResult {
  exitCode: number;
  output: string;
}

export interface ExecutionEnvironment {
  id: string;
  kind: IsolationKind;
  workspacePath: string;
  description: string;
  metadata?: Record<string, string>;
  execute?(input: EnvironmentExecInput): Promise<EnvironmentExecResult>;
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

export interface IsolationStatus {
  providerId: string;
  readiness: HealthStatus;
  checks: HealthCheckResult[];
}

export interface EnvironmentRuntimeStatus {
  environmentId: string;
  state: 'running' | 'stopped' | 'missing' | 'unknown';
  agentProcess: 'running' | 'absent' | 'unknown';
  detail?: string;
}

export interface IsolationRuntimeInspector {
  inspectEnvironment(environment: ExecutionEnvironment): Promise<EnvironmentRuntimeStatus>;
}

export function hasRuntimeInspector(value: unknown): value is IsolationRuntimeInspector {
  return typeof value === 'object' && value !== null && typeof (value as { inspectEnvironment?: unknown }).inspectEnvironment === 'function';
}

export function hasIsolation(value: unknown): value is IsolationProvider {
  return typeof value === 'object' && value !== null && 'prepare' in value && typeof (value as { prepare?: unknown }).prepare === 'function';
}

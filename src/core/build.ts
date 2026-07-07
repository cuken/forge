import type { Task } from './types.js';

export interface BuildRequest {
  prompt: string;
  taskName?: string;
  taskPattern?: string;
  autoApprove?: boolean;
  run?: boolean;
}

export interface BuildPlan {
  title: string;
  description: string;
  complexity: Task['complexity'];
  requiresSpec: boolean;
  reason: string;
  specBody?: string;
}

export interface BuildPlannerProvider {
  planBuild(input: BuildRequest): Promise<BuildPlan>;
}

export interface BuildResult {
  task: Task;
  plan: BuildPlan;
  action: 'ran' | 'awaiting-approval' | 'ready' | 'blocked';
  runResults?: unknown[];
}

export function hasBuildPlanner(value: unknown): value is BuildPlannerProvider {
  return typeof value === 'object' && value !== null && 'planBuild' in value && typeof (value as { planBuild?: unknown }).planBuild === 'function';
}

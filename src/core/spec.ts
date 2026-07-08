import type { Task } from './types.js';

export interface SpecPlan {
  providerId: string;
  body: string;
}

export interface SpecProvider {
  id: string;
  kind: 'spec';
  generateSpec(input: { task: Task; context?: string }): Promise<SpecPlan>;
}

export function hasSpec(value: unknown): value is SpecProvider {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'spec' && typeof (value as { generateSpec?: unknown }).generateSpec === 'function';
}

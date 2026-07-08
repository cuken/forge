import type { Task } from './types.js';

export interface TaskResourceScope {
  kind: 'path' | 'provider' | 'config' | 'docs' | 'tests' | 'unknown';
  value: string;
  confidence: 'low' | 'medium' | 'high';
  reason: string;
}

export interface TaskDiscoveryMetadata {
  providerId: string;
  discoveredAt: string;
  resourceScopes: TaskResourceScope[];
}

export interface TaskDiscoveryProvider {
  discoverTask(input: { title: string; description?: string; complexity: Task['complexity'] }): Promise<TaskDiscoveryMetadata>;
}

export function hasTaskDiscovery(value: unknown): value is TaskDiscoveryProvider {
  return typeof value === 'object' && value !== null && 'discoverTask' in value && typeof (value as { discoverTask?: unknown }).discoverTask === 'function';
}

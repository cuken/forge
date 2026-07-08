import type { RunRecord } from './types.js';

export interface ValidationGateResult {
  id: string;
  status: 'pass' | 'fail';
  message: string;
  detail?: string;
}

export interface ValidationInput { run: RunRecord; }

export interface ValidationProvider {
  validate(input: ValidationInput): Promise<ValidationGateResult[]>;
}

export function hasValidation(provider: unknown): provider is ValidationProvider {
  return !!provider && typeof (provider as ValidationProvider).validate === 'function';
}

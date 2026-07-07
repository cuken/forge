export type HealthStatus = 'pass' | 'warn' | 'fail';

export interface HealthCheckResult {
  id: string;
  status: HealthStatus;
  message: string;
  detail?: string;
}

export interface HealthCheck {
  id: string;
  label: string;
  run(): Promise<HealthCheckResult>;
}

export interface DoctorProvider {
  checks(): HealthCheck[];
}

export function hasDoctor(value: unknown): value is DoctorProvider {
  return typeof value === 'object' && value !== null && 'checks' in value && typeof (value as { checks?: unknown }).checks === 'function';
}

export async function runChecks(checks: HealthCheck[]): Promise<HealthCheckResult[]> {
  return Promise.all(checks.map(async check => {
    try {
      return await check.run();
    } catch (error) {
      return { id: check.id, status: 'fail', message: `${check.label} failed`, detail: error instanceof Error ? error.message : String(error) };
    }
  }));
}

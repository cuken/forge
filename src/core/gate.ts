import type { ForgeProvider, Json, RunRecord, Task } from './types.js';

export type GateDecisionKind = 'spec-approval' | 'run-acceptance';

export type GateDecisionStatus = 'pending' | 'approved' | 'rejected' | 'canceled';

export interface GateSubjectBase {
  task: Task;
}

export interface SpecApprovalGateSubject extends GateSubjectBase {
  kind: 'spec-approval';
  specPath: string;
  specBody?: string;
}

export interface RunAcceptanceGateSubject extends GateSubjectBase {
  kind: 'run-acceptance';
  run: RunRecord;
  summary?: string;
}

export type GateSubject = SpecApprovalGateSubject | RunAcceptanceGateSubject;

export interface PendingGateDecision {
  providerId: string;
  gateId: string;
  kind: GateDecisionKind;
  status: 'pending';
  taskId: string;
  runId?: string;
  url?: string;
  message: string;
  metadata?: Record<string, Json>;
}

export interface GateDecision {
  providerId: string;
  gateId: string;
  kind: GateDecisionKind;
  status: GateDecisionStatus;
  taskId: string;
  runId?: string;
  decidedAt?: string;
  decidedBy?: string;
  message?: string;
  metadata?: Record<string, Json>;
}

export interface GateProvider extends ForgeProvider {
  kind: 'gate';
  publishDecision(input: { subject: GateSubject; message?: string; metadata?: Record<string, Json> }): Promise<PendingGateDecision>;
  readDecision(input: { gateId: string; kind?: GateDecisionKind; task?: Task; run?: RunRecord }): Promise<GateDecision | null>;
}

export function hasGate(value: unknown): value is GateProvider {
  return typeof value === 'object'
    && value !== null
    && (value as { kind?: unknown }).kind === 'gate'
    && typeof (value as { publishDecision?: unknown }).publishDecision === 'function'
    && typeof (value as { readDecision?: unknown }).readDecision === 'function';
}

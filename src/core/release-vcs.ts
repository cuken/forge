import type { ForgeProvider, ReleaseRecord } from './types.js';

export interface ReleaseVcsTarget {
  providerId: string;
  releaseId: string;
  targetKind: string;
  targetId: string;
  exists: boolean;
  url?: string;
  message?: string;
}

export interface ReleaseVcsRef {
  providerId: string;
  releaseId: string;
  ref: string;
  baseRef?: string;
  headRef?: string;
  message?: string;
}

export interface ReleaseReviewPreparation {
  providerId: string;
  releaseId: string;
  status: 'ready' | 'blocked';
  reviewUrl?: string;
  message: string;
  detail?: string;
  blockingItems?: string[];
  nextSteps?: string[];
}

export interface ReleaseVcsProvider {
  ensureReleaseTarget(input: { release: ReleaseRecord }): Promise<ReleaseVcsTarget>;
  resolveReleaseRef(input: { release: ReleaseRecord; target: ReleaseVcsTarget }): Promise<ReleaseVcsRef>;
  prepareReleaseReview(input: { release: ReleaseRecord; target: ReleaseVcsTarget; ref: ReleaseVcsRef }): Promise<ReleaseReviewPreparation>;
}

export interface PrepareReleaseResult {
  release: ReleaseRecord;
  target: ReleaseVcsTarget;
  ref: ReleaseVcsRef;
  review: ReleaseReviewPreparation;
}

export function hasReleaseVcs(value: unknown): value is ReleaseVcsProvider & ForgeProvider {
  return typeof value === 'object' && value !== null
    && 'ensureReleaseTarget' in value && typeof (value as { ensureReleaseTarget?: unknown }).ensureReleaseTarget === 'function'
    && 'resolveReleaseRef' in value && typeof (value as { resolveReleaseRef?: unknown }).resolveReleaseRef === 'function'
    && 'prepareReleaseReview' in value && typeof (value as { prepareReleaseReview?: unknown }).prepareReleaseReview === 'function';
}

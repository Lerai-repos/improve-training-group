/**
 * Recommendation engine (M2b). Pure core: eligibility, scoring, pricing, ranking,
 * travel enrichment, and the reproducible input artifact. Adapters (live Monday
 * reads, roster, address, Routes travel, cache) layer on top. There is no
 * persistence layer — `runRecommendation` returns its answer; the queue and the
 * Monday board writes arrive with the KV pass.
 */
export * from './types';
export * from './eligibility';
export * from './scores';
export * from './pricing';
export * from './travel-enrich';
export * from './artifact';
export * from './address';
export * from './address-key';
export * from './travel';
export * from './travel-cache';
export * from './travel-resolve';
export * from './delivery';
export * from './roster';
export * from './qualifications';
export * from './service';
export * from './event';
export * from './signature';
export * from './webhook';
export * from './authorize';
export * from './deadline';
export * from './trainer-groups';
export * from './engine-config';
export * from './completion';
export * from './monday-reader';
export * from './monday-status';
export * from './deps';

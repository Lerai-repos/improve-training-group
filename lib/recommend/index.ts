/**
 * Recommendation engine (M2b). Pure core: eligibility, scoring, pricing, ranking,
 * travel enrichment, and the reproducible input artifact. Adapters (live Monday
 * reads, roster, address, Routes travel, cache) layer on top.
 *
 * Around that core sits the queue: a durable trigger record and per-training
 * generation in Redis, QStash as the job transport, one immutable outcome per
 * generation, and delivery that converges the board on the newest answer.
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
export * from './kv';
export * from './queue-store';
export * from './queue';
export * from './view-row';
export * from './outcome';
export * from './deliver';
export * from './job';
export * from './failure-callback';
export * from './qstash';
export * from './approached';
export * from './capabilities';
export * from './item-board';
export * from './recommendation-actions';
export * from './whatsapp';
export * from './whatsapp-service';
export * from './whatsapp-store';
export * from './city-store';
export * from './recommendation-view';
export * from './session-token';
export * from './view-auth';
export * from './view-dto';
export * from './deps';

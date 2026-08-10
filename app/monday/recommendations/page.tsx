'use client';

import { useMemo } from 'react';

import { createRecommendationsApi } from '@components/recommendations/api';
import { createMondayBridge } from '@components/recommendations/monday-client';
import { RecommendationsView } from '@components/recommendations/recommendations-view';
import { useRecommendationView } from '@components/recommendations/use-recommendation-view';

/**
 * The Monday item view — what the app's "Externe hosting" URL points at.
 *
 * Thin on purpose: it builds the two real adapters and hands them to the hook and the
 * component, both of which are tested against fakes. Nothing here is testable without a
 * live iframe, so nothing here does anything worth testing.
 *
 * The bridge is memoized because the hook's effects depend on its identity; a new object
 * per render would re-subscribe to the context on every pass.
 */
export default function MondayRecommendationsPage() {
  const monday = useMemo(() => createMondayBridge(), []);
  const api = useMemo(() => createRecommendationsApi(monday), [monday]);
  // No board id passed: the hook takes it from Monday's context. `agendaBoardId()` reads
  // an env var Next never exposes to the browser, so here it would silently mean "the
  // production board" — which is where Pick would then write while the backend is aimed
  // at the TEST duplicate.
  const view = useRecommendationView(monday, api);

  return <RecommendationsView monday={monday} api={api} view={view} />;
}

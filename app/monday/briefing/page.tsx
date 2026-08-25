'use client';

import { useMemo } from 'react';

import { createMondayBridge } from '@components/recommendations/monday-client';
import { BriefingView } from '@components/briefing/briefing-view';
import { createBriefingApi } from '@components/briefing/api';
import { useBriefingView } from '@components/briefing/use-briefing-view';

/**
 * De tweede Monday-itemweergave: de briefing van één training.
 *
 * Met opzet net zo dun als `app/monday/recommendations/page.tsx` — hij bouwt de twee echte
 * adapters en geeft ze door aan de hook en het component, die allebei tegen nepversies
 * getest zijn. Niets hier is te testen zonder een levende iframe, dus niets hier doet iets
 * wat het testen waard is.
 *
 * De brug wordt gememoiseerd omdat de effecten van de hook aan zijn identiteit hangen; een
 * nieuw object per render zou zich bij elke doorloop opnieuw op de context abonneren.
 *
 * Geen item-id als prop: de hook haalt hem uit Monday's context. Meegeven vanaf hier zou
 * betekenen dat we hem raden, en de weergave wordt **niet** opnieuw gemonteerd als de
 * adviseur op de volgende training klikt.
 */
export default function MondayBriefingPage() {
  const monday = useMemo(() => createMondayBridge(), []);
  const api = useMemo(() => createBriefingApi(monday), [monday]);
  const view = useBriefingView(monday, api);

  return <BriefingView view={view} />;
}

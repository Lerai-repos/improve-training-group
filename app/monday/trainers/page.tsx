'use client';

import { useMemo } from 'react';

import { createMondayBoardBridge } from '@components/recommendations/monday-client';
import { createTrainerOverviewApi } from '@components/trainers/api';
import { TrainerOverview } from '@components/trainers/trainer-overview';
import { useTrainerOverview } from '@components/trainers/use-trainer-overview';

/**
 * De derde Monday-weergave, en de eerste die géén itemweergave is: een tabblad op het
 * trainersbord met de evaluatiecijfers van de hele roster.
 *
 * Net zo dun als de andere twee pagina's — hij bouwt de adapters en geeft ze door. De brug
 * wordt gememoiseerd omdat de effecten van de hook aan zijn identiteit hangen; een nieuw
 * object per render zou zich bij elke doorloop opnieuw abonneren.
 */
export default function MondayTrainersPage() {
  const monday = useMemo(() => createMondayBoardBridge(), []);
  const api = useMemo(() => createTrainerOverviewApi(monday), [monday]);
  const state = useTrainerOverview(monday, api);

  return <TrainerOverview state={state} />;
}

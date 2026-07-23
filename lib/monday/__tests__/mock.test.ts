import { describe, expect, it } from 'vitest';

import { createMockMondayPort } from '../mock';

describe('createMockMondayPort', () => {
  it('returns a self-consistent default graph', async () => {
    const monday = createMockMondayPort();

    const { items: trainers } = await monday.getTrainers({ boardId: 'x' });
    const { items: trainings } = await monday.getTrainings({ boardId: 'x' });

    // Every id referenced by a training exists among the returned masters.
    const trainerIds = new Set(trainers.map((t) => t.externalItemId));
    for (const tr of trainings) {
      for (const id of tr.trainerExternalIds) {
        expect(trainerIds.has(id)).toBe(true);
      }
    }
  });

  it('records writeTrainingSync calls instead of sending them', async () => {
    const monday = createMockMondayPort();

    await monday.writeTrainingSync('5087400001', {
      backendRecordId: 'uuid-1',
      appUrl: 'https://app/trainings/uuid-1',
      recommendationStatus: 'GEREED',
      trainerStatus: 'RUN',
    });

    expect(monday.writes).toHaveLength(1);
    expect(monday.writes[0].itemId).toBe('5087400001');
    expect(monday.writes[0].sync?.recommendationStatus).toBe('GEREED');
  });

  it('honors injected data overrides', async () => {
    const monday = createMockMondayPort({ trainings: [] });
    const { items } = await monday.getTrainings({ boardId: 'x' });
    expect(items).toEqual([]);
  });
});

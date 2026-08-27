import { describe, expect, it } from 'vitest';

import { createApproachedStore } from '../approached';
import { staticAssignments, type CachedAssignments } from '../assignment-cache';
import { buildAssignmentIndex, type AgendaScan } from '../assignments';
import { NO_CAPABILITIES, type Capabilities } from '../capabilities';
import { createMemoryKvStore } from '../kv';
import { createOutcomeStore, ROWS_TTL_MS } from '../outcome';
import { createQueueStore } from '../queue-store';
import { resolveView, type ViewDeps } from '../recommendation-view';
import type { CachePeek } from '../shared-cache';
import { storedRow } from './stored-row.fixture';

const ITEM = '5029726254';

const FULL: Capabilities = { view: true, plan: true, full: true };
const RESTRICTED: Capabilities = { view: true, plan: false, full: false };
/** Mag kiezen, mag geen tarieven zien — de gebruiker die op Kies drukt. */
const PLANNER: Capabilities = { view: true, plan: true, full: false };

function harness(now: () => number = () => 1_000) {
  const kv = createMemoryKvStore(now);
  const outcomes = createOutcomeStore(kv);
  const queue = createQueueStore(kv);
  const approached = createApproachedStore(kv);
  const deps: ViewDeps = { queue, outcomes, approached };
  return { kv, deps, outcomes, queue, approached };
}

/**
 * Allocate the next generation, as a trigger or a recalculate would.
 *
 * The uuid must be unique per call: `enqueueOrGet` is idempotent by trigger uuid — that
 * is what makes a redelivered webhook harmless — so reusing one returns the existing
 * record and allocates nothing.
 */
let triggerSeq = 0;
async function bump(h: ReturnType<typeof harness>): Promise<void> {
  triggerSeq += 1;
  await h.queue.enqueueOrGet({ triggerUuid: `u${triggerSeq}`, mondayItemId: ITEM, nowMs: 0 });
}

/**
 * A workload cache in one of the three states `peek` can report, with a counter for the
 * background refresh the view may ask for.
 *
 * `read` rejects on purpose. The view reads through `peek` now, so a fixture that still
 * answered `read` would keep every one of these tests green while proving nothing about
 * the code path that actually runs.
 */
function workload(
  peek: CachePeek<AgendaScan>
): CachedAssignments & { peeks: () => number; refreshes: () => number } {
  let peeks = 0;
  let refreshes = 0;
  return {
    read: () => Promise.reject(new Error('the view must not scan on the request path')),
    peek: () => {
      peeks += 1;
      return Promise.resolve(peek);
    },
    refresh: () => {
      refreshes += 1;
      return Promise.resolve({ refreshed: true });
    },
    peeks: () => peeks,
    refreshes: () => refreshes,
  };
}

/**
 * Deze tests bouwen een scan met de hand en gaan alleen over de werklast, dus de
 * dagvelden krijgen een lege standaard. Een test die wél over dagbotsingen gaat geeft ze
 * expliciet mee en overschrijft die standaard.
 */
const scanOf = (
  scan: Pick<AgendaScan, 'workload' | 'monthByItemId'> & Partial<AgendaScan>
): CachePeek<AgendaScan> => ({
  kind: 'hit',
  value: { dateByItemId: new Map(), dayIndex: new Map(), ...scan },
});

describe('resolveView', () => {
  it('reports idle when the training has never been triggered', async () => {
    const h = harness();
    expect((await resolveView(h.deps, ITEM, FULL)).state).toEqual({ kind: 'idle' });
  });

  it('reports computing while a generation has no outcome yet', async () => {
    const h = harness();
    await bump(h);

    expect((await resolveView(h.deps, ITEM, FULL)).state).toEqual({
      kind: 'computing',
      generation: 1,
    });
  });

  it('reports the ranked rows once they are claimed', async () => {
    const h = harness();
    await bump(h);
    await h.outcomes.claim(ITEM, 1, {
      kind: 'ready',
      settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
      trainingMonth: null,
      duurTraining: null,
      travelPrecision: null,
      rows: [storedRow({ trainerItemId: 't1', rank: 1 })],
    });

    const { state } = await resolveView(h.deps, ITEM, FULL);

    expect(state).toMatchObject({ kind: 'ready', generation: 1 });
    expect(state.kind === 'ready' && state.rows).toHaveLength(1);
  });

  /**
   * ITG may type only a town in Locatie, and Google then measures to its centre. The
   * kilometres come back looking exactly as measured as any other, so the list has to
   * carry the difference or it presents a guess as a fact.
   */
  describe('a destination known only by its town', () => {
    it('reports that the distances are measured to a town centre', async () => {
      const h = harness();
      await bump(h);
      await h.outcomes.claim(ITEM, 1, {
        kind: 'ready',
        settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
        trainingMonth: null,
        duurTraining: null,
        travelPrecision: 'city',
        rows: [storedRow()],
      });

      const { state } = await resolveView(h.deps, ITEM, FULL);

      expect(state.kind === 'ready' && state.travelPrecision).toBe('city');
    });

    /** Only someone who can see km and reistijd can be misled by them. */
    it('says nothing to a caller who cannot see the travel columns', async () => {
      const h = harness();
      await bump(h);
      await h.outcomes.claim(ITEM, 1, {
        kind: 'ready',
        settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
        trainingMonth: null,
        duurTraining: null,
        travelPrecision: 'city',
        rows: [storedRow()],
      });

      const { state } = await resolveView(h.deps, ITEM, RESTRICTED);

      expect(state.kind === 'ready' && state.travelPrecision).toBeNull();
    });

    /**
     * Lists stored before this field existed have no claim either way, and must read as
     * "no warning" rather than failing to decode — `ROWS_TTL_MS` is a year, so every one
     * of them is still being served.
     */
    it('reads a list written before the field existed as no warning', async () => {
      const h = harness();
      await bump(h);
      await h.outcomes.claim(ITEM, 1, {
        kind: 'ready',
        settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
        trainingMonth: null,
        duurTraining: null,
        travelPrecision: null,
        rows: [storedRow()],
      });
      // Strip the field the way a record written yesterday would have it.
      const raw: unknown = JSON.parse(String(await h.kv.get(`rows:${ITEM}:1`)));
      if (typeof raw === 'object' && raw !== null && 'travelPrecision' in raw) {
        delete (raw as Record<string, unknown>).travelPrecision;
      }
      await h.kv.set(`rows:${ITEM}:1`, JSON.stringify(raw));

      const { state } = await resolveView(h.deps, ITEM, FULL);

      expect(state.kind).toBe('ready');
      expect(state.kind === 'ready' && state.travelPrecision).toBeNull();
    });
  });

  /** "We looked and found nobody" is an answer, and must not read as a missing one. */
  it('distinguishes no_match from an absent computation', async () => {
    const h = harness();
    await bump(h);
    await h.outcomes.claim(ITEM, 1, {
      kind: 'no_match',
      settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
    });

    expect((await resolveView(h.deps, ITEM, FULL)).state).toEqual({
      kind: 'no_match',
      generation: 1,
    });
  });

  /**
   * The stage travels; the message does not. Messages carry provider text and internal
   * paths, and the view only needs to say which step gave up.
   */
  it('reports a failure by stage, without its message', async () => {
    const h = harness();
    await bump(h);
    await h.outcomes.claim(ITEM, 1, {
      kind: 'failed',
      settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
      stage: 'travel',
      message: 'Routes API 503 at https://internal…',
    });

    const { state } = await resolveView(h.deps, ITEM, FULL);

    expect(state).toEqual({ kind: 'failed', generation: 1, stage: 'travel' });
    expect(JSON.stringify(state)).not.toContain('Routes API');
  });

  describe('unavailable, rather than a spinner that never resolves', () => {
    /**
     * The case the watermark exists for. Once the rows expire, "label with no rows" and
     * "still computing" are indistinguishable from the outside, and a planner would
     * watch a year-old training spin forever.
     */
    it('reports expired rows as unavailable, keeping the label', async () => {
      let now = 1_000;
      const h = harness(() => now);
      await bump(h);
      await h.outcomes.claim(ITEM, 1, {
        kind: 'ready',
        duurTraining: null,
        travelPrecision: null,
        rows: [storedRow()],
        trainingMonth: null,
        settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
      });

      now += ROWS_TTL_MS + 1;

      expect((await resolveView(h.deps, ITEM, FULL)).state).toEqual({
        kind: 'unavailable',
        generation: 1,
        label: 'GEREED',
      });
    });

    /** Records written before the rows key existed are bare labels under the same key. */
    it('reports a legacy bare label as unavailable', async () => {
      const h = harness();
      await bump(h);
      await h.kv.set(`result:${ITEM}:1`, 'GEEN MATCH');

      expect((await resolveView(h.deps, ITEM, FULL)).state).toEqual({
        kind: 'unavailable',
        generation: 1,
        label: 'GEEN MATCH',
      });
    });

    it('does not report an older generation’s answer for a newer generation', async () => {
      const h = harness();
      await bump(h);
      await h.outcomes.claim(ITEM, 1, {
        kind: 'ready',
        duurTraining: null,
        travelPrecision: null,
        rows: [storedRow()],
        trainingMonth: null,
        settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
      });
      await bump(h); // a recalculate: generation 2, nothing stored yet

      expect((await resolveView(h.deps, ITEM, FULL)).state).toEqual({
        kind: 'computing',
        generation: 2,
      });
    });
  });

  /**
   * Reading the generation and then reading its rows is not atomic, so a recalculate can
   * land in between. Returning the old generation as `ready` is not cosmetic staleness:
   * the pick flow re-reads this endpoint immediately before writing the trainer relation
   * precisely to catch a recalculate, so a response that can itself be stale turns that
   * check into a formality. The `approached` route would disagree too — it validates
   * against the CURRENT generation, so every tick on the returned list would 409.
   */
  describe('when a recalculate lands mid-read', () => {
    /** A queue whose generation advances on a schedule, as another planner would cause. */
    function scriptedQueue(readings: number[]): { readGeneration: () => Promise<number> } {
      let index = 0;
      return {
        readGeneration: () => {
          const value = readings[Math.min(index, readings.length - 1)];
          index += 1;
          return Promise.resolve(value);
        },
      };
    }

    it('does not return the superseded generation as ready', async () => {
      const h = harness();
      await h.outcomes.claim(ITEM, 1, {
        kind: 'ready',
        duurTraining: null,
        travelPrecision: null,
        rows: [storedRow()],
        trainingMonth: null,
        settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
      });

      // Read generation 1, resolve its rows, then discover the current one is 2.
      const deps = { ...h.deps, queue: scriptedQueue([1, 2, 2]) };

      expect((await resolveView(deps, ITEM, FULL)).state).toEqual({
        kind: 'computing',
        generation: 2,
      });
    });

    it('re-resolves against the new generation rather than giving up', async () => {
      const h = harness();
      await h.outcomes.claim(ITEM, 1, {
        kind: 'ready',
        duurTraining: null,
        travelPrecision: null,
        rows: [storedRow()],
        trainingMonth: null,
        settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
      });
      await h.outcomes.claim(ITEM, 2, {
        kind: 'ready',
        settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
        trainingMonth: null,
        duurTraining: null,
        travelPrecision: null,
        rows: [storedRow({ trainerItemId: 'newer' })],
      });

      const deps = { ...h.deps, queue: scriptedQueue([1, 2, 2]) };
      const { state } = await resolveView(deps, ITEM, FULL);

      expect(state).toMatchObject({ kind: 'ready', generation: 2 });
      expect(state.kind === 'ready' && state.rows[0].trainerItemId).toBe('newer');
    });

    /**
     * Bounded, not infinite. If it never settles, something is actively churning and
     * `computing` is both true and the answer that makes the client poll instead of
     * acting on a list that is already superseded.
     */
    it('gives up after a few attempts and reports computing', async () => {
      const h = harness();
      await h.outcomes.claim(ITEM, 1, {
        kind: 'ready',
        duurTraining: null,
        travelPrecision: null,
        rows: [storedRow()],
        trainingMonth: null,
        settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
      });

      const deps = { ...h.deps, queue: scriptedQueue([1, 2, 3, 4, 5, 6, 7, 8, 9]) };

      expect((await resolveView(deps, ITEM, FULL)).state).toMatchObject({ kind: 'computing' });
    });
  });

  /**
   * Workload is resolved live, not stored: booking a trainer on a DIFFERENT training
   * changes their load without advancing this generation, so a persisted count would be
   * served for up to twelve months with nothing to mark it stale.
   */
  describe('workload, resolved at read time', () => {
    const busy = staticAssignments([
      { itemId: 'i1275', date: '2026-09-01', trainerItemIds: ['t1'], times: null, client: null },
      { itemId: 'i7107', date: '2026-09-20', trainerItemIds: ['t1'], times: null, client: null },
      { itemId: 'i5735', date: '2026-11-02', trainerItemIds: ['t1'], times: null, client: null },
    ]);

    async function readyList(h: ReturnType<typeof harness>) {
      await bump(h);
      await h.outcomes.claim(ITEM, 1, {
        kind: 'ready',
        settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
        trainingMonth: '2026-09',
        duurTraining: null,
        travelPrecision: null,
        rows: [storedRow({ trainerItemId: 't1' })],
      });
    }

    it('counts the training’s month and year, live', async () => {
      const h = harness();
      await readyList(h);

      const { state } = await resolveView({ ...h.deps, assignments: busy }, ITEM, FULL);

      expect(state.kind === 'ready' && state.rows[0]).toMatchObject({
        assignmentsThisMonth: 2,
        assignmentsThisYear: 3,
      });
    });

    /**
     * The whole reason it is not stored: nothing about this training changed, yet the
     * numbers must. A frozen count could not do this.
     */
    it('reflects a booking made elsewhere, without a recalculate', async () => {
      const h = harness();
      await readyList(h);

      const before = await resolveView({ ...h.deps, assignments: busy }, ITEM, FULL);
      const after = await resolveView(
        {
          ...h.deps,
          assignments: staticAssignments([
            {
              itemId: 'i1275',
              date: '2026-09-01',
              trainerItemIds: ['t1'],
              times: null,
              client: null,
            },
            {
              itemId: 'i7107',
              date: '2026-09-20',
              trainerItemIds: ['t1'],
              times: null,
              client: null,
            },
            {
              itemId: 'i5735',
              date: '2026-11-02',
              trainerItemIds: ['t1'],
              times: null,
              client: null,
            },
            {
              itemId: 'i7699',
              date: '2026-09-28',
              trainerItemIds: ['t1'],
              times: null,
              client: null,
            },
          ]),
        },
        ITEM,
        FULL
      );

      expect(before.state.kind === 'ready' && before.state.rows[0]).toMatchObject({
        assignmentsThisMonth: 2,
      });
      expect(after.state.kind === 'ready' && after.state.rows[0]).toMatchObject({
        assignmentsThisMonth: 3,
      });
    });

    /**
     * Degrade to null, NEVER to 0. The scan fails closed on malformed Monday data, but
     * that must not take down a list that reads perfectly well from Redis — and a 0
     * would be indistinguishable from a genuinely quiet month.
     */
    it('renders unknown rather than zero when the scan fails', async () => {
      const h = harness();
      await readyList(h);
      const assignments = workload({ kind: 'failed' });

      const { state } = await resolveView({ ...h.deps, assignments }, ITEM, FULL);

      expect(state.kind === 'ready' && state.rows[0]).toMatchObject({
        assignmentsThisMonth: null,
        assignmentsThisYear: null,
      });
    });

    /**
     * Clearing a training's date does not advance its generation, so falling back to the
     * month stored with the rows would keep counting against a month this training is no
     * longer in. Scanned-and-undated is KNOWN to have no month; only an item the scan
     * never saw may fall back.
     */
    it('reports unknown when the date has since been cleared', async () => {
      const h = harness();
      await readyList(h);

      const { state } = await resolveView(
        {
          ...h.deps,
          assignments: workload(
            scanOf({
              workload: buildAssignmentIndex([
                {
                  itemId: 'other',
                  date: '2026-09-01',
                  trainerItemIds: ['t1'],
                  times: null,
                  client: null,
                },
              ]),
              // Scanned, and it has no date any more.
              monthByItemId: new Map([[ITEM, null]]),
            })
          ),
        },
        ITEM,
        FULL
      );

      expect(state.kind === 'ready' && state.rows[0]).toMatchObject({
        assignmentsThisMonth: null,
        assignmentsThisYear: null,
      });
    });

    /** An item the scan never saw still falls back to what the rows recorded. */
    it('falls back to the stored month for an item outside the scan', async () => {
      const h = harness();
      await readyList(h);

      const { state } = await resolveView(
        {
          ...h.deps,
          assignments: workload(
            scanOf({
              workload: buildAssignmentIndex([
                {
                  itemId: 'other',
                  date: '2026-09-01',
                  trainerItemIds: ['t1'],
                  times: null,
                  client: null,
                },
              ]),
              monthByItemId: new Map(),
            })
          ),
        },
        ITEM,
        FULL
      );

      expect(state.kind === 'ready' && state.rows[0]).toMatchObject({ assignmentsThisMonth: 1 });
    });

    /**
     * De dagbotsingen komen uit dezelfde scan en dezelfde `peek`. Deze test loopt door de
     * hele weg — scan, resolver, DTO — omdat juist de bedrading ertussen misgaat.
     */
    it('meldt wat de trainer die dag al heeft', async () => {
      const h = harness();
      await readyList(h);
      const scan = staticAssignments([
        {
          itemId: ITEM,
          date: '2026-09-01',
          trainerItemIds: ['t1'],
          times: '13:00-16:00',
          client: 'Calduran',
        },
        {
          itemId: 'ander',
          date: '2026-09-01',
          trainerItemIds: ['t1'],
          times: '09:30-12:30',
          client: 'Probiblio',
        },
      ]);

      const { state } = await resolveView({ ...h.deps, assignments: scan }, ITEM, FULL);

      expect(state.kind === 'ready' && state.rows[0]).toMatchObject({
        dayConflicts: [{ itemId: 'ander', client: 'Probiblio', times: '09:30-12:30' }],
      });
    });

    /**
     * Zonder deze uitsluiting krijgt élke gekoppelde trainer een waarschuwing over de
     * sessie die de planner op dat moment vóór zich heeft.
     */
    it('rekent de training zelf niet als botsing', async () => {
      const h = harness();
      await readyList(h);
      const scan = staticAssignments([
        {
          itemId: ITEM,
          date: '2026-09-01',
          trainerItemIds: ['t1'],
          times: '13:00-16:00',
          client: 'Calduran',
        },
      ]);

      const { state } = await resolveView({ ...h.deps, assignments: scan }, ITEM, FULL);

      expect(state.kind === 'ready' && state.rows[0]).toMatchObject({ dayConflicts: [] });
    });

    /**
     * Geen datum, geen bewering. Anders dan bij de maand is er geen opgeslagen terugval
     * voor de dag, en een botsing verzinnen uit een verouderde datum is erger dan zwijgen.
     */
    it('claimt niets voor een training die de scan niet zag', async () => {
      const h = harness();
      await readyList(h);

      /**
       * De scan kent `other` op 1 september mét deze trainer, maar kent ITEM helemaal
       * niet. Zou de resolver een dag verzinnen in plaats van te zwijgen, dan komt die
       * training er als botsing uit — en dáár faalt deze test op.
       */
      const scan = staticAssignments([
        {
          itemId: 'other',
          date: '2026-09-01',
          trainerItemIds: ['t1'],
          times: '09:30-12:30',
          client: 'Probiblio',
        },
      ]);

      const { state } = await resolveView({ ...h.deps, assignments: scan }, ITEM, FULL);

      expect(state.kind === 'ready' && state.rows[0]).toMatchObject({ dayConflicts: [] });
    });

    /**
     * De Kies-knop hangt aan `plan`, dus de waarschuwing erachter ook.
     *
     * Zat het label achter `full`, dan miste precies de gebruiker die de koppeling maakt
     * hem — en die koppeling is de handeling waar de waarschuwing voor bestaat.
     */
    it('geeft de dagbotsingen ook aan een planner zonder kostenkolommen', async () => {
      const h = harness();
      await readyList(h);
      const scan = staticAssignments([
        {
          itemId: ITEM,
          date: '2026-09-01',
          trainerItemIds: ['t1'],
          times: '13:00-16:00',
          client: 'Calduran',
        },
        {
          itemId: 'ander',
          date: '2026-09-01',
          trainerItemIds: ['t1'],
          times: '09:30-12:30',
          client: 'Probiblio',
        },
      ]);

      const { state } = await resolveView({ ...h.deps, assignments: scan }, ITEM, PLANNER);

      /**
       * Het feit wél, de inhoud niet.
       *
       * `plan` is account-breed en zegt niets over toegang tot het agendabord, dus de
       * klantnaam en het tijdstip van een ándere training horen hier niet te staan. Wat
       * blijft is de waarschuwing zelf, bij de knop waar hij voor bestaat.
       */
      expect(state.kind === 'ready' && state.rows[0]).toMatchObject({
        dayConflicts: [{ itemId: 'ander', client: null, times: null }],
      });
      // En nog steeds geen tarieven: de kostenkolommen blijven aan `full` hangen.
      expect(state.kind === 'ready' && state.rows[0]).not.toHaveProperty('hourlyRateCents');
      expect(state.kind === 'ready' && state.rows[0]).not.toHaveProperty('assignmentsThisMonth');
    });

    /** En een `full`-lezer krijgt de inhoud wél — anders is het label zinloos geworden. */
    it('geeft klant en tijd alleen aan een full-lezer', async () => {
      const h = harness();
      await readyList(h);
      const scan = staticAssignments([
        {
          itemId: ITEM,
          date: '2026-09-01',
          trainerItemIds: ['t1'],
          times: '13:00-16:00',
          client: 'Calduran',
        },
        {
          itemId: 'ander',
          date: '2026-09-01',
          trainerItemIds: ['t1'],
          times: '09:30-12:30',
          client: 'Probiblio',
        },
      ]);

      const { state } = await resolveView({ ...h.deps, assignments: scan }, ITEM, FULL);

      expect(state.kind === 'ready' && state.rows[0]).toMatchObject({
        dayConflicts: [{ itemId: 'ander', client: 'Probiblio', times: '09:30-12:30' }],
      });
    });

    /**
     * Lezen wat er ligt mag; een bordscan op zijn naam starten niet. Die regel is ouder
     * dan het label en blijft letterlijk overeind — hij ziet bij een koude cache gewoon
     * geen waarschuwing.
     */
    it('laat een planner zonder kostenkolommen geen scan aftrappen', async () => {
      const h = harness();
      await readyList(h);
      const assignments = workload({ kind: 'miss' });
      const warmed: Promise<unknown>[] = [];

      const { state } = await resolveView(
        { ...h.deps, assignments, warm: (task) => warmed.push(task) },
        ITEM,
        PLANNER
      );

      expect(warmed).toHaveLength(0);
      expect(assignments.refreshes()).toBe(0);
      expect(state.kind === 'ready' && state.rows[0]).toMatchObject({ dayConflicts: [] });
    });

    /** A restricted caller has no workload columns, so their page view must not scan. */
    it('does not scan for a caller who cannot see the columns', async () => {
      const h = harness();
      await readyList(h);
      const assignments = workload(scanOf({ workload: new Map(), monthByItemId: new Map() }));

      await resolveView({ ...h.deps, assignments }, ITEM, RESTRICTED);

      expect(assignments.peeks()).toBe(0);
      expect(assignments.refreshes()).toBe(0);
    });

    /**
     * A cold cache costs the planner nothing and warms itself for the next caller. The
     * refresh cron owns filling this, so blocking the response on an 8-second board scan
     * — which is what `read` would do — is exactly the behaviour that made the columns a
     * coin flip.
     */
    it('warms a cold cache in the background instead of scanning inline', async () => {
      const h = harness();
      await readyList(h);
      const assignments = workload({ kind: 'miss' });
      const warmed: Promise<unknown>[] = [];

      const { state } = await resolveView(
        { ...h.deps, assignments, warm: (task) => warmed.push(task) },
        ITEM,
        FULL
      );

      expect(state.kind === 'ready' && state.rows[0]).toMatchObject({
        assignmentsThisMonth: null,
        assignmentsThisYear: null,
      });
      expect(assignments.refreshes()).toBe(1);
      expect(warmed).toHaveLength(1);
      await Promise.all(warmed);
    });

    /**
     * A recent failure must NOT schedule a refresh. The sentinel's short TTL is the only
     * thing stopping every 20-second poll from every open tab restarting the same doomed
     * scan for as long as Monday is unreachable.
     */
    it('does not schedule a refresh while a recent one is known to have failed', async () => {
      const h = harness();
      await readyList(h);
      const assignments = workload({ kind: 'failed' });
      const warmed: Promise<unknown>[] = [];

      await resolveView({ ...h.deps, assignments, warm: (task) => warmed.push(task) }, ITEM, FULL);

      expect(assignments.refreshes()).toBe(0);
      expect(warmed).toHaveLength(0);
    });

    /** Without a `warm` hook the miss is simply a miss — never an inline scan. */
    it('never scans inline when no background hook is available', async () => {
      const h = harness();
      await readyList(h);
      const assignments = workload({ kind: 'miss' });

      const { state } = await resolveView({ ...h.deps, assignments }, ITEM, FULL);

      expect(state.kind === 'ready' && state.rows[0]).toMatchObject({
        assignmentsThisMonth: null,
      });
      expect(assignments.refreshes()).toBe(0);
    });
  });

  describe('the approached marks', () => {
    it('marks the trainers this generation was ticked for', async () => {
      const h = harness();
      await bump(h);
      await h.outcomes.claim(ITEM, 1, {
        kind: 'ready',
        settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
        trainingMonth: null,
        duurTraining: null,
        travelPrecision: null,
        rows: [
          storedRow({ trainerItemId: 't1', rank: 1 }),
          storedRow({ trainerItemId: 't2', rank: 2 }),
        ],
      });
      await h.approached.write({
        mondayItemId: ITEM,
        generation: 1,
        trainerItemId: 't2',
        approached: true,
        rowsTtl: await h.outcomes.readRowsTtl(ITEM, 1),
      });

      const { state } = await resolveView(h.deps, ITEM, FULL);

      expect(state.kind === 'ready' && state.rows.map((r) => r.approached)).toEqual([false, true]);
    });

    /**
     * A recalculate produces a new list against fresh data. Carrying ticks across would
     * assert something nobody did — that the planner approached this trainer about THIS
     * list, which might not even contain them.
     */
    it('does not carry marks across a recalculate', async () => {
      const h = harness();
      await bump(h);
      await h.outcomes.claim(ITEM, 1, {
        kind: 'ready',
        duurTraining: null,
        travelPrecision: null,
        rows: [storedRow({ trainerItemId: 't1' })],
        trainingMonth: null,
        settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
      });
      await h.approached.write({
        mondayItemId: ITEM,
        generation: 1,
        trainerItemId: 't1',
        approached: true,
        rowsTtl: await h.outcomes.readRowsTtl(ITEM, 1),
      });

      await bump(h);
      await h.outcomes.claim(ITEM, 2, {
        kind: 'ready',
        duurTraining: null,
        travelPrecision: null,
        rows: [storedRow({ trainerItemId: 't1' })],
        trainingMonth: null,
        settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
      });

      const { state } = await resolveView(h.deps, ITEM, FULL);

      expect(state.kind === 'ready' && state.rows[0].approached).toBe(false);
    });
  });

  describe('what each caller is handed', () => {
    it('gives a full caller the money, and a restricted one none of it', async () => {
      const h = harness();
      await bump(h);
      await h.outcomes.claim(ITEM, 1, {
        kind: 'ready',
        duurTraining: null,
        travelPrecision: null,
        rows: [storedRow()],
        trainingMonth: null,
        settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
      });

      const full = await resolveView(h.deps, ITEM, FULL);
      const restricted = await resolveView(h.deps, ITEM, RESTRICTED);

      expect(full.state.kind === 'ready' && full.state.rows[0]).toHaveProperty('totalCostCents');
      expect(restricted.state.kind === 'ready' && restricted.state.rows[0]).not.toHaveProperty(
        'totalCostCents'
      );
    });

    /**
     * Both a `view` user and a `plan` user receive `RestrictedRow`, so the rows alone
     * cannot tell them apart. Without this the view would render Recalculate and
     * `Benaderd` controls that 403 on click.
     */
    it('tells the client which controls to render', async () => {
      const h = harness();

      expect((await resolveView(h.deps, ITEM, RESTRICTED)).caps).toEqual({
        canPlan: false,
        canViewFull: false,
      });
      expect((await resolveView(h.deps, ITEM, FULL)).caps).toEqual({
        canPlan: true,
        canViewFull: true,
      });
      expect(
        (await resolveView(h.deps, ITEM, { ...NO_CAPABILITIES, view: true, plan: true })).caps
      ).toEqual({ canPlan: true, canViewFull: false });
    });
  });
});

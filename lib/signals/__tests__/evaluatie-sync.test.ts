import { describe, expect, it } from 'vitest';

import { metGeduld, runEvaluatieSync, runEvaluatieSyncExclusive } from '../evaluatie-sync';
import { createMemoryKvStore } from '@lib/recommend/kv';
import { rowForFinding } from '../text';
import { SUMMARY_KEY } from '../write';

import { GROUPS, signal, spyWriter } from './helpers';

import type { EvaluatieSyncDeps } from '../evaluatie-sync';
import type { Finding } from '../types';

const NOW = new Date('2026-10-12T10:00:00.000Z');

const probleem = {
  itemId: '2912597013',
  klanttitel: 'Persoonlijke effectiviteit',
  datum: '2026-09-17',
  reden: 'Er is geen trainer gekoppeld aan deze training.',
  atMs: 1,
};
const knopVondst: Finding = {
  kind: 'eval-knop',
  itemId: probleem.itemId,
  klanttitel: probleem.klanttitel,
  datum: probleem.datum,
  reden: probleem.reden,
};

function deps(over: Partial<EvaluatieSyncDeps> = {}): EvaluatieSyncDeps & {
  writer: ReturnType<typeof spyWriter>;
} {
  const writer = spyWriter();
  return {
    readSignals: async () => [],
    readMailFailures: async () => [],
    readKnopProblemen: async () => [],
    groups: GROUPS,
    now: () => NOW,
    ...over,
    writer,
  };
}

/**
 * De snelle controle na een druk op Eval Rapport: alleen de twee evaluatiemeldingen, meteen
 * op het Systeem-bord, en verder niets aanraken.
 */
describe('runEvaluatieSync', () => {
  it('zet een knopprobleem meteen op het bord', async () => {
    const d = deps({ readKnopProblemen: async () => [probleem] });
    const report = await runEvaluatieSync(d);
    expect(report.created).toBe(1);
    expect(d.writer.created.map((c) => c.sleutel)).toEqual([`eval-knop:${probleem.itemId}`]);
  });

  it('vinkt een knopmelding af zodra het probleem weg is', async () => {
    const bestaand = signal({
      itemId: 's1',
      key: `eval-knop:${probleem.itemId}`,
      naam: rowForFinding(knopVondst).naam,
    });
    const d = deps({ readSignals: async () => [bestaand] });
    const report = await runEvaluatieSync(d);
    expect(report.resolved).toBe(1);
    expect(d.writer.ticked).toEqual(['s1']);
    // En hij verhuist naar de afgehandelde groep, net als in de nachtelijke run.
    expect(d.writer.moved).toEqual([{ itemId: 's1', groupId: GROUPS.afgehandeld }]);
  });

  /** De rest van het bord is van de nachtelijke controle; die gaat over zijn eigen soorten. */
  it('laat elke andere melding met rust', async () => {
    const thema = signal({ itemId: 's2', key: 'thema-zonder-inhoud:12', naam: 'x' });
    const d = deps({ readSignals: async () => [thema] });
    await runEvaluatieSync(d);
    expect(d.writer.ticked).toEqual([]);
    expect(d.writer.updated).toEqual([]);
  });

  /** "Laatste controle" gaat over de volledige nachtelijke run, niet over deze. */
  it('schrijft de samenvatting niet', async () => {
    const d = deps({
      readKnopProblemen: async () => [probleem],
      readSignals: async () => [signal({ itemId: 's0', key: SUMMARY_KEY, groupId: 'g_sam' })],
    });
    await runEvaluatieSync(d);
    expect(d.writer.summaries).toEqual([]);
  });

  /**
   * Een storing in KV is iets voor de nachtelijke run om als foutmelding te zetten. Deze
   * snelle controle laat het bord dan ongemoeid: geen foutrij, en zeker geen bestaande
   * melding afvinken alsof hij opgelost is.
   */
  it('raakt bij een KV-storing niets aan', async () => {
    const bestaand = signal({
      itemId: 's1',
      key: `eval-knop:${probleem.itemId}`,
      naam: rowForFinding(knopVondst).naam,
    });
    const d = deps({
      readSignals: async () => [bestaand],
      readKnopProblemen: async () => {
        throw new Error('redis weg');
      },
    });
    const report = await runEvaluatieSync(d);
    expect(report.failures.map((f) => f.check)).toEqual(['evaluatieknop']);
    expect(d.writer.created).toEqual([]);
    expect(d.writer.ticked).toEqual([]);
  });

  it('meldt ook een mislukte mail meteen', async () => {
    const d = deps({
      readMailFailures: async () => [
        {
          itemId: '3063876720',
          variant: 'met',
          klanttitel: 'Feedback',
          datum: '2026-10-01',
          reden: 'Graph 403',
          atMs: 1,
        },
      ],
    });
    await runEvaluatieSync(d);
    expect(d.writer.created.map((c) => c.sleutel)).toEqual(['mail-mislukt:3063876720:met']);
  });
});

describe('runEvaluatieSyncExclusive', () => {
  /** Eén schrijver op het bord: loopt de nachtelijke controle, dan wacht deze niet maar stopt. */
  it('doet niets als een andere run de grendel heeft', async () => {
    const kv = createMemoryKvStore();
    await kv.setIfAbsent('signals:lease:bord', 'iemand-anders', { ttlMs: 60_000 });
    const d = deps({ readKnopProblemen: async () => [probleem] });
    const uitkomst = await runEvaluatieSyncExclusive(d, { kv, token: () => 'ik' }, 'bord');
    expect(uitkomst.kind).toBe('busy');
    expect(d.writer.created).toEqual([]);
  });

  it('draait en geeft de grendel daarna vrij', async () => {
    const kv = createMemoryKvStore();
    const d = deps({ readKnopProblemen: async () => [probleem] });
    const uitkomst = await runEvaluatieSyncExclusive(d, { kv, token: () => 'ik' }, 'bord');
    expect(uitkomst.kind).toBe('ran');
    expect(await kv.get('signals:lease:bord')).toBeNull();
  });
});

describe('metGeduld', () => {
  /**
   * Twee knopdrukken vlak na elkaar: de tweede vindt de grendel bezet. Zonder herhaling wacht
   * zijn melding tot de volgende ochtend, want de eerste had KV al gelezen.
   */
  it('probeert het opnieuw zolang de grendel bezet is', async () => {
    const uitkomsten = ['busy', 'busy', 'ran'] as const;
    let keer = 0;
    const geslapen: number[] = [];
    const uitkomst = await metGeduld(
      async () => {
        const kind = uitkomsten[keer];
        keer += 1;
        return kind === 'busy' ? { kind } : { kind, report: LEEG_RAPPORT };
      },
      { pogingen: 3, wachtMs: 10, slaap: async (ms) => void geslapen.push(ms) }
    );
    expect(uitkomst.kind).toBe('ran');
    expect(keer).toBe(3);
    expect(geslapen).toEqual([10, 10]);
  });

  it('geeft na het laatste bezette antwoord op', async () => {
    let keer = 0;
    const uitkomst = await metGeduld(
      async () => {
        keer += 1;
        return { kind: 'busy' };
      },
      { pogingen: 3, wachtMs: 1, slaap: async () => undefined }
    );
    expect(uitkomst.kind).toBe('busy');
    expect(keer).toBe(3);
  });
});

const LEEG_RAPPORT = {
  findings: [],
  created: 0,
  updated: 0,
  reopened: 0,
  resolved: 0,
  moved: 0,
  failures: [],
};

/**
 * De snelle controle draait aan het eind van een route met een harde grens van 300 s. Wachten
 * op een bezette grendel terwijl er geen tijd meer is voor een poging, laat Vercel de functie
 * afkappen — nadat het eigenlijke werk al gelukt was.
 */
describe('metGeduld binnen de looptijdgrens', () => {
  it('wacht niet meer als er na het wachten geen tijd is voor een poging', async () => {
    let keer = 0;
    const geslapen: number[] = [];
    const uitkomst = await metGeduld(
      async () => {
        keer += 1;
        return { kind: 'busy' };
      },
      {
        pogingen: 3,
        wachtMs: 10_000,
        slaap: async (ms) => void geslapen.push(ms),
        // 15 s over: niet genoeg voor 10 s wachten plus een poging.
        tijdOverMs: () => 15_000,
      }
    );
    expect(uitkomst.kind).toBe('busy');
    expect(keer).toBe(1);
    expect(geslapen).toEqual([]);
  });

  it('wacht wel als er ruim tijd is', async () => {
    let keer = 0;
    await metGeduld(
      async () => {
        keer += 1;
        return keer < 2 ? { kind: 'busy' } : { kind: 'ran', report: LEEG_RAPPORT };
      },
      { pogingen: 3, wachtMs: 10_000, slaap: async () => undefined, tijdOverMs: () => 120_000 }
    );
    expect(keer).toBe(2);
  });
});

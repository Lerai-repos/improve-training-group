import { describe, expect, it, vi } from 'vitest';

import { runDailyCheck } from '../run';
import { SUMMARY_KEY } from '../write';

import type { LabelCode } from '@lib/labels';
import type { LabelRecord } from '@lib/labels/read';
import type { AgendaUsage, ThemaRecord } from '../findings';
import type { ExistingSignal } from '../reconcile';
import { rowForFailure } from '../text';

import { GROUPS, signal, usage } from './helpers';

import type { DailyCheckDeps } from '../run';
import type { SignalWriter } from '../write';

const NOW = new Date('2026-09-04T03:15:00.000Z');
const asset = { id: 'a', name: 'n', publicUrl: 'https://x' };

const label = (over: Partial<LabelRecord> = {}): LabelRecord => ({
  code: 'IT',
  volledigeNaam: 'Incompany Trainer',
  kleur: '#0A2B58',
  term: 'Training',
  rapportterm: 'de training',
  evaluatieformulier: '',
  website: '',
  inventarisatieformulier: '',
  logo: asset,
  voorblad: asset,
  achterblad: asset,
  ...over,
});

function spyWriter(): SignalWriter & {
  created: Array<{ naam: string; sleutel: string; soort: string }>;
  ticked: string[];
  summaries: string[];
  moved: Array<{ itemId: string; groupId: string }>;
  updated: Array<{ itemId: string; naam: string }>;
  reopened: Array<{ itemId: string; naam: string }>;
  cleared: string[];
} {
  const created: Array<{ naam: string; sleutel: string; soort: string }> = [];
  const ticked: string[] = [];
  const summaries: string[] = [];
  const moved: Array<{ itemId: string; groupId: string }> = [];
  const updated: Array<{ itemId: string; naam: string }> = [];
  const reopened: Array<{ itemId: string; naam: string }> = [];
  const cleared: string[] = [];
  return {
    updated,
    reopened,
    cleared,
    created,
    ticked,
    summaries,
    moved,
    create: async (f) => {
      created.push({ naam: f.naam, sleutel: f.sleutel, soort: f.soort });
      if (f.sleutel === SUMMARY_KEY) {
        summaries.push(f.detail);
      }
    },
    tick: async (s) => {
      ticked.push(s.itemId);
    },
    updateSummary: async (_id, detail) => {
      summaries.push(detail);
    },
    move: async (m) => {
      moved.push({ itemId: m.itemId, groupId: m.groupId });
    },
    update: async (itemId, fields) => {
      updated.push({ itemId, naam: fields.naam });
    },
    reopen: async (itemId, fields) => {
      reopened.push({ itemId, naam: fields.naam });
    },
    clearClosedBy: async (itemId) => {
      cleared.push(itemId);
    },
  };
}

function deps(over: Partial<DailyCheckDeps> = {}): DailyCheckDeps {
  return {
    readSignals: async () => [],
    readAgendaUsage: async (): Promise<AgendaUsage> =>
      usage({ labels: new Map([['TMT', 7]]), themas: new Map([['12', 3]]) }),
    readLabels: async (): Promise<ReadonlyMap<LabelCode, LabelRecord>> =>
      new Map([['IT', label()]]),
    readThemas: async (): Promise<ReadonlyMap<string, ThemaRecord>> =>
      new Map([['12', { naam: 'Boksen', conceptInhoud: '' }]]),
    readTrainers: async (): Promise<ReadonlySet<string>> => new Set(),
    writer: null,
    groups: GROUPS,
    now: () => NOW,
    ...over,
  };
}

describe('runDailyCheck', () => {
  it('vindt het onbekende label en het lege thema', async () => {
    const report = await runDailyCheck(deps());
    expect(report.findings.map((f) => f.kind)).toEqual(['onbekend-label', 'thema-zonder-inhoud']);
    expect(report.dryRun).toBe(true);
  });

  /**
   * Een droogloop meldt wat hij ZOU doen, niet nul.
   *
   * Nul melden gaf een rapport dat zichzelf tegensprak: de samenvattingstekst zei "Nieuw deze
   * run: 2" en het regeltje eronder "nieuw: 0".
   */
  it('meldt in een droogloop de voorgenomen aantallen, en schrijft niets', async () => {
    const writer = spyWriter();
    const report = await runDailyCheck(deps({ writer: null }));
    expect(report.created).toBe(2);
    expect(report.summary).toContain('Nieuw deze run: 2');
    expect(writer.created).toEqual([]);
    expect(writer.summaries).toEqual([]);
  });

  it('telt in een droogloop ook de verplaatsingen die uit de eigen acties volgen', async () => {
    const report = await runDailyCheck(
      deps({
        writer: null,
        readAgendaUsage: async () => usage({ labels: new Map([['IT', 5]]), themas: new Map() }),
        readSignals: async () => [
          signal({ itemId: 'oud', key: 'onbekend-label:TMT', groupId: 'g_open' }),
        ],
      })
    );
    // Wordt afgevinkt, en moet dus ook verhuizen.
    expect(report.resolved).toBe(1);
    expect(report.moved).toBe(1);
  });

  it('plaatst de vondsten en maakt de samenvattingsrij aan', async () => {
    const writer = spyWriter();
    const report = await runDailyCheck(deps({ writer }));
    expect(report.created).toBe(2);
    expect(writer.created.map((c) => c.sleutel)).toEqual([
      'onbekend-label:TMT',
      'thema-zonder-inhoud:12',
      SUMMARY_KEY,
    ]);
  });

  it('werkt een bestaande samenvattingsrij bij in plaats van een tweede te maken', async () => {
    const writer = spyWriter();
    const summary: ExistingSignal = signal({
      itemId: 's1',
      key: SUMMARY_KEY,
      afgehandeld: false,
      detail: 'oud',
      groupId: 'g_sam',
    });
    await runDailyCheck(deps({ writer, readSignals: async () => [summary] }));
    expect(writer.created.map((c) => c.sleutel)).not.toContain(SUMMARY_KEY);
    expect(writer.summaries).toHaveLength(1);
  });

  it('telt de samenvattingsrij niet mee als openstaande melding', async () => {
    const report = await runDailyCheck(
      deps({
        readSignals: async () => [signal({ itemId: 's1', key: SUMMARY_KEY, groupId: 'g_sam' })],
      })
    );
    // Twee vondsten worden deze run geplaatst, dus dat is wat er straks openstaat. De
    // samenvattingsrij zelf telt niet mee als melding.
    expect(report.summary).toContain('Openstaand op dit bord: 2');
  });

  /**
   * De kern van de foutafhandeling: één kapotte bron mag de andere controle niet meeslepen,
   * en mag al helemaal geen meldingen opruimen.
   */
  it('ruimt geen labelmeldingen op als het Labels-bord onbereikbaar is', async () => {
    const writer = spyWriter();
    const report = await runDailyCheck(
      deps({
        writer,
        readLabels: async () => {
          throw new Error('Labels-bord 500');
        },
        readSignals: async () => [
          signal({
            itemId: 'oud',
            key: 'onbekend-label:TMT',
            afgehandeld: false,
            detail: '',
            groupId: 'g_open',
          }),
        ],
      })
    );
    expect(writer.ticked).toEqual([]);
    expect(report.failures).toEqual([{ check: 'labels', error: 'Labels-bord 500' }]);
    expect(report.summary).toContain('LET OP');
  });

  it('draait de themacontrole gewoon door als de labelcontrole faalt', async () => {
    const writer = spyWriter();
    await runDailyCheck(
      deps({
        writer,
        readLabels: async () => {
          throw new Error('stuk');
        },
      })
    );
    expect(writer.created.map((c) => c.sleutel)).toContain('thema-zonder-inhoud:12');
  });

  it('controleert niets en ruimt niets op als de agenda niet te lezen is', async () => {
    const writer = spyWriter();
    const report = await runDailyCheck(
      deps({
        writer,
        readAgendaUsage: async () => {
          throw new Error('agenda weg');
        },
        readSignals: async () => [
          signal({
            itemId: 'a',
            key: 'onbekend-label:TMT',
            afgehandeld: false,
            detail: '',
            groupId: 'g_open',
          }),
          signal({
            itemId: 'b',
            key: 'thema-zonder-inhoud:12',
            afgehandeld: false,
            detail: '',
            groupId: 'g_open',
          }),
        ],
      })
    );
    expect(writer.ticked).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.failures.map((f) => f.check)).toEqual(['agenda']);
  });

  it('werpt als het Systeem-bord zelf niet te lezen is', async () => {
    await expect(
      runDailyCheck(
        deps({
          readSignals: async () => {
            throw new Error('bord weg');
          },
        })
      )
    ).rejects.toThrow('bord weg');
  });

  it('vinkt een melding af die niet meer gevonden wordt', async () => {
    const writer = spyWriter();
    const report = await runDailyCheck(
      deps({
        writer,
        readAgendaUsage: async () => usage({ labels: new Map([['IT', 5]]), themas: new Map() }),
        readSignals: async () => [
          signal({
            itemId: 'oud',
            key: 'onbekend-label:TMT',
            afgehandeld: false,
            detail: 'was zo',
            groupId: 'g_open',
          }),
        ],
      })
    );
    expect(writer.ticked).toEqual(['oud']);
    expect(report.resolved).toBe(1);
  });

  it('telt een afgevinkt maar nog bestaand probleem in de samenvatting', async () => {
    // De enige zwakte van afvinken: wie TMT wegvinkt hoort er nooit meer van. Het getal
    // hoort daarom elke ochtend in de samenvatting te staan.
    const report = await runDailyCheck(
      deps({
        // Alleen het label, zodat "nieuw" niets anders kan tellen dan deze ene vondst.
        readAgendaUsage: async () => usage({ labels: new Map([['TMT', 7]]), themas: new Map() }),
        readSignals: async () => [
          signal({
            itemId: 'x',
            key: 'onbekend-label:TMT',
            afgehandeld: true,
            detail: '',
            groupId: 'g_open',
          }),
        ],
      })
    );
    expect(report.summary).toContain('Labels zonder (volledige) configuratie: 1 (7 trainingen)');
    expect(report.summary).toContain('Door ITG weggezet maar nog steeds zo: 1');
    expect(report.summary).toContain('Nieuw deze run: 0');
  });

  it('noemt het totaal aantal trainingen', async () => {
    const report = await runDailyCheck(
      deps({
        readAgendaUsage: async () =>
          usage({
            labels: new Map([
              ['IT', 527],
              ['TMT', 7],
            ]),
          }),
      })
    );
    expect(report.trainingen).toBe(534);
    expect(report.summary).toContain('534 trainingen');
  });

  it('gebruikt de meegegeven klok en niet de echte tijd', async () => {
    const now = vi.fn(() => NOW);
    const report = await runDailyCheck(deps({ now }));
    expect(now).toHaveBeenCalled();
    expect(report.summary).toContain('4-9-2026 03:15 UTC');
  });
});

describe('runDailyCheck — groepen', () => {
  it('zet nieuwe meldingen in de openstaande groep en de samenvatting in haar eigen groep', async () => {
    const groepen: string[] = [];
    const writer = spyWriter();
    await runDailyCheck(
      deps({
        writer: {
          ...writer,
          create: async (fields) => {
            groepen.push(`${fields.sleutel}=${fields.groupId}`);
          },
        },
      })
    );
    expect(groepen).toContain('onbekend-label:TMT=g_open');
    expect(groepen).toContain('samenvatting=g_sam');
  });

  it('verplaatst een met de hand afgevinkte melding weg uit de meldingengroep', async () => {
    const writer = spyWriter();
    const report = await runDailyCheck(
      deps({
        writer,
        readSignals: async () => [
          signal({
            itemId: 'oud',
            key: 'onbekend-label:TMT',
            afgehandeld: true,
            detail: '',
            groupId: 'g_open',
          }),
        ],
      })
    );
    expect(writer.moved).toContainEqual({ itemId: 'oud', groupId: 'g_klaar' });
    expect(report.moved).toBe(1);
  });

  it('verplaatst wat het deze run zelf heeft afgevinkt, meteen', async () => {
    const writer = spyWriter();
    await runDailyCheck(
      deps({
        writer,
        readAgendaUsage: async () => usage({ labels: new Map([['IT', 5]]), themas: new Map() }),
        readSignals: async () => [
          signal({
            itemId: 'oud',
            key: 'onbekend-label:TMT',
            afgehandeld: false,
            detail: '',
            groupId: 'g_open',
          }),
        ],
      })
    );
    expect(writer.ticked).toEqual(['oud']);
    expect(writer.moved).toContainEqual({ itemId: 'oud', groupId: 'g_klaar' });
  });

  it('meldt in een droogloop hoeveel rijen scheef staan, zonder ze te verplaatsen', async () => {
    const writer = spyWriter();
    const report = await runDailyCheck(
      deps({
        writer: null,
        readSignals: async () => [
          signal({
            itemId: 'oud',
            key: 'onbekend-label:TMT',
            afgehandeld: true,
            detail: '',
            groupId: 'g_open',
          }),
        ],
      })
    );
    expect(report.moved).toBe(1);
    expect(writer.moved).toEqual([]);
  });
});

describe('runDailyCheck — bijwerken en heropenen', () => {
  const tmtNaam = (n: number) => `Label "TMT" is niet ingesteld — ${n} trainingen`;

  it('werkt een openstaande melding bij als het aantal trainingen is gegroeid', async () => {
    const writer = spyWriter();
    const report = await runDailyCheck(
      deps({
        writer,
        readAgendaUsage: async () => usage({ labels: new Map([['TMT', 40]]), themas: new Map() }),
        readSignals: async () => [
          signal({ itemId: 'oud', key: 'onbekend-label:TMT', naam: tmtNaam(7) }),
        ],
      })
    );
    expect(writer.updated).toEqual([{ itemId: 'oud', naam: tmtNaam(40) }]);
    expect(writer.created.map((c) => c.sleutel)).not.toContain('onbekend-label:TMT');
    expect(report.updated).toBe(1);
  });

  it('werkt niets bij als er niets is veranderd', async () => {
    const writer = spyWriter();
    await runDailyCheck(
      deps({
        writer,
        readAgendaUsage: async () => usage({ labels: new Map([['TMT', 7]]), themas: new Map() }),
        readSignals: async () => [
          signal({ itemId: 'oud', key: 'onbekend-label:TMT', naam: tmtNaam(7) }),
        ],
      })
    );
    expect(writer.updated).toEqual([]);
  });

  /**
   * Het scenario waar de kolom `Afgehandeld door` voor bestaat: ITG lost TMT op, wij vinken
   * af, en maanden later verwijdert iemand de rij op het Labels-bord weer.
   */
  it('heropent wat de controle eerder zelf had afgevinkt', async () => {
    const writer = spyWriter();
    const report = await runDailyCheck(
      deps({
        writer,
        readAgendaUsage: async () => usage({ labels: new Map([['TMT', 7]]), themas: new Map() }),
        readSignals: async () => [
          signal({
            itemId: 'dicht',
            key: 'onbekend-label:TMT',
            naam: tmtNaam(7),
            afgehandeld: true,
            closedByCheck: true,
            groupId: 'g_klaar',
          }),
        ],
      })
    );
    expect(writer.reopened).toEqual([{ itemId: 'dicht', naam: tmtNaam(7) }]);
    expect(report.reopened).toBe(1);
    // En hij moet meteen terug naar de openstaande groep, niet pas morgen.
    expect(writer.moved).toContainEqual({ itemId: 'dicht', groupId: 'g_open' });
  });

  it('laat staan wat ITG bewust heeft weggezet, ook als het probleem er nog is', async () => {
    const writer = spyWriter();
    await runDailyCheck(
      deps({
        writer,
        readAgendaUsage: async () => usage({ labels: new Map([['TMT', 7]]), themas: new Map() }),
        readSignals: async () => [
          signal({
            itemId: 'weg',
            key: 'onbekend-label:TMT',
            naam: tmtNaam(7),
            afgehandeld: true,
            closedByCheck: false,
            groupId: 'g_klaar',
          }),
        ],
      })
    );
    expect(writer.reopened).toEqual([]);
    // Alleen de samenvattingsrij; geen tweede melding voor iets dat bewust is weggezet.
    expect(writer.created.map((c) => c.sleutel)).toEqual([SUMMARY_KEY]);
    expect(writer.moved).toEqual([]);
  });

  it('meldt de aantallen ná de acties, niet ervoor', async () => {
    const report = await runDailyCheck(
      deps({
        readAgendaUsage: async () => usage({ labels: new Map([['TMT', 7]]), themas: new Map() }),
        readSignals: async () => [],
      })
    );
    expect(report.summary).toContain('Nieuw deze run: 1.');
    expect(report.summary).toContain('Openstaand op dit bord: 1.');
  });

  it('telt een melding die deze run wordt opgelost niet meer als openstaand', async () => {
    const report = await runDailyCheck(
      deps({
        readAgendaUsage: async () => usage({ labels: new Map([['IT', 5]]), themas: new Map() }),
        readSignals: async () => [
          signal({ itemId: 'oud', key: 'onbekend-label:TMT', naam: tmtNaam(7) }),
        ],
      })
    );
    expect(report.summary).toContain('Opgelost: 1.');
    expect(report.summary).toContain('Openstaand op dit bord: 0.');
  });
});

describe('runDailyCheck — verweesde trainers en stale markers', () => {
  it('meldt een training die naar een verwijderde trainer wijst', async () => {
    const writer = spyWriter();
    await runDailyCheck(
      deps({
        writer,
        readAgendaUsage: async () => usage({ trainers: new Map([['999', 4]]) }),
        readTrainers: async () => new Set(['111']),
      })
    );
    expect(writer.created.map((c) => c.sleutel)).toContain('trainer-ontbreekt:999');
  });

  it('zwijgt over een trainer die gewoon bestaat', async () => {
    const writer = spyWriter();
    await runDailyCheck(
      deps({
        writer,
        readAgendaUsage: async () => usage({ trainers: new Map([['111', 4]]) }),
        readTrainers: async () => new Set(['111']),
      })
    );
    expect(writer.created.map((c) => c.sleutel)).toEqual([SUMMARY_KEY]);
  });

  it('ruimt geen trainermeldingen op als het trainersbord onbereikbaar is', async () => {
    const writer = spyWriter();
    const report = await runDailyCheck(
      deps({
        writer,
        readAgendaUsage: async () => usage(),
        readTrainers: async () => {
          throw new Error('trainersbord weg');
        },
        readSignals: async () => [
          signal({ itemId: 'oud', key: 'trainer-ontbreekt:999', naam: 'oude melding' }),
        ],
      })
    );
    expect(writer.ticked).toEqual([]);
    expect(report.failures.map((f) => f.check)).toEqual(['trainers']);
  });

  it('maakt een achtergebleven marker leeg op een rij waar het vinkje uit is', async () => {
    const writer = spyWriter();
    await runDailyCheck(
      deps({
        writer,
        readSignals: async () => [
          signal({ itemId: 'los', key: 'onbekend-label:TMT', closedByCheck: true }),
        ],
      })
    );
    expect(writer.cleared).toEqual(['los']);
  });
});

describe('runDailyCheck — mislukte controles als Foutmelding', () => {
  /**
   * `Foutmelding` is in het datamodel gereserveerd voor een controle die niet kon draaien, maar
   * werd door niets geschreven: een storing stond alleen in de tekst van de dagsamenvatting.
   * Wie het bord filtert op Foutmelding zag dus niets, juist tijdens een storing.
   */
  it('zet een rij met Soort Foutmelding neer als een controle faalt', async () => {
    const writer = spyWriter();
    await runDailyCheck(
      deps({
        writer,
        readLabels: async () => {
          throw new Error('Labels-bord 500');
        },
      })
    );
    const rij = writer.created.find((c) => c.sleutel === 'controle-mislukt:labels');
    expect(rij).toBeDefined();
    expect(rij?.soort).toBe('Foutmelding');
  });

  it('vinkt de storingsrij af zodra de controle weer draait', async () => {
    const writer = spyWriter();
    const report = await runDailyCheck(
      deps({
        writer,
        readSignals: async () => [
          signal({
            itemId: 'storing',
            key: 'controle-mislukt:labels',
            naam: 'Controle "labels" kon niet draaien',
          }),
        ],
      })
    );
    expect(writer.ticked).toContain('storing');
    expect(report.resolved).toBe(1);
  });

  it('plaatst geen tweede storingsrij als de storing aanhoudt', async () => {
    const writer = spyWriter();
    await runDailyCheck(
      deps({
        writer,
        readLabels: async () => {
          throw new Error('nog steeds stuk');
        },
        readSignals: async () => [
          signal({
            itemId: 'storing',
            key: 'controle-mislukt:labels',
            naam: 'Controle "labels" kon niet draaien',
          }),
        ],
      })
    );
    expect(writer.created.map((c) => c.sleutel)).not.toContain('controle-mislukt:labels');
  });

  /**
   * De naam van een storingsrij is met opzet stabiel — foutteksten wisselen per poging, en een
   * naam die meebeweegt zou de rij elke nacht herschrijven. Maar dan moet het Detail wél
   * bijgewerkt worden, anders staat er dagenlang een achterhaalde fout onder het kopje
   * "Laatste foutmelding".
   */
  it('werkt de foutmelding van een lopende storing bij', async () => {
    const writer = spyWriter();
    await runDailyCheck(
      deps({
        writer,
        readLabels: async () => {
          throw new Error('nu een time-out');
        },
        readSignals: async () => [
          signal({
            itemId: 'storing',
            key: 'controle-mislukt:labels',
            naam: 'Controle "labels" kon niet draaien',
            detail: 'Laatste foutmelding: Labels-bord 500',
          }),
        ],
      })
    );
    expect(writer.updated.map((u) => u.itemId)).toEqual(['storing']);
  });

  it('werkt niets bij als de foutmelding hetzelfde blijft', async () => {
    const writer = spyWriter();
    const rij = rowForFailure({ check: 'labels', error: 'zelfde fout' });
    await runDailyCheck(
      deps({
        writer,
        readLabels: async () => {
          throw new Error('zelfde fout');
        },
        readSignals: async () => [
          signal({ itemId: 'storing', key: rij.key, naam: rij.naam, detail: rij.detail }),
        ],
      })
    );
    expect(writer.updated).toEqual([]);
  });

  /**
   * Valt de agenda weg, dan zijn labels, thema's en trainers niet eens aan de beurt geweest.
   * Hun storingsrij van gisteren afvinken zou herstel melden dat niemand heeft vastgesteld.
   */
  it('vinkt de storingsrij van een NIET-geprobeerde controle niet af', async () => {
    const writer = spyWriter();
    await runDailyCheck(
      deps({
        writer,
        readAgendaUsage: async () => {
          throw new Error('agenda weg');
        },
        readSignals: async () => [
          signal({
            itemId: 'gisteren',
            key: 'controle-mislukt:labels',
            naam: 'Controle "labels" kon niet draaien',
          }),
        ],
      })
    );
    expect(writer.ticked).toEqual([]);
  });

  it('vinkt de storingsrij van de agenda zelf wél af, want die is altijd geprobeerd', async () => {
    const writer = spyWriter();
    await runDailyCheck(
      deps({
        writer,
        readSignals: async () => [
          signal({
            itemId: 'agendastoring',
            key: 'controle-mislukt:agenda',
            naam: 'Controle "agenda" kon niet draaien',
          }),
        ],
      })
    );
    expect(writer.ticked).toEqual(['agendastoring']);
  });

  it('houdt de storing óók in de samenvatting, en meldt hem nog steeds als failure', async () => {
    const report = await runDailyCheck(
      deps({
        readLabels: async () => {
          throw new Error('Labels-bord 500');
        },
      })
    );
    expect(report.summary).toContain('LET OP');
    expect(report.failures).toEqual([{ check: 'labels', error: 'Labels-bord 500' }]);
  });
});

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useGenerate } from '../use-generate';

import { BriefingPlanChanged } from '../api';

import type { BriefingApi, GenerateResponse } from '../api';

afterEach(cleanup);

/**
 * De Genereren-knop.
 *
 * Het zwaartepunt ligt bij het wisselen van training, want **de iframe wordt niet opnieuw
 * opgebouwd** als de adviseur op het volgende item klikt. Alles wat niet aan een item-id
 * hangt blijft dan staan — en hier is dat geen cosmetisch probleem: een bevestiging die
 * blijft hangen laat één klik het overschrijven van de verkéérde briefing goedkeuren.
 */

const PLAN = (over: Partial<Extract<GenerateResponse, { stage: 'planned' }>> = {}) =>
  ({
    stage: 'planned' as const,
    folderPath: 'General/1. JE/5. Klanten/Calduran',
    folderExists: true,
    conflicts: [],
    related: [],
    filenames: ['Briefing.docx'],
    planToken: 'plan-1',
    ...over,
  }) satisfies GenerateResponse;

const WRITTEN: GenerateResponse = {
  stage: 'written',
  documents: [
    {
      trainerNaam: 'Frank Paats',
      role: 'lead',
      file: { name: 'Briefing.docx', webUrl: 'https://sp/b.docx' },
      versioned: false,
      open: [],
    },
  ],
  notes: [],
  administratie: [],
  brie: 'Staat klaar',
};

interface Aanroep {
  readonly itemId: string;
  readonly confirm: boolean;
  readonly planToken?: string;
}

function api(
  antwoord: (itemId: string, confirm: boolean) => Promise<GenerateResponse>
): BriefingApi & { aanroepen: readonly Aanroep[] } {
  const aanroepen: Aanroep[] = [];
  return {
    aanroepen,
    get: () => Promise.reject(new Error('niet nodig in deze suite')),
    saveChecklist: () => Promise.reject(new Error('niet nodig in deze suite')),
    generate: (itemId, options) => {
      const confirm = options?.confirmExisting === true;
      aanroepen.push({ itemId, confirm, planToken: options?.planToken });
      return antwoord(itemId, confirm);
    },
  };
}

/** Het concept staat veilig; de meeste tests gaan niet over opslaan. */
const bewaard = () => Promise.resolve(true);

/** Herladen doet in de meeste tests niets; waar het telt wordt het geteld. */
const geenHerlaad = () => undefined;

describe('useGenerate', () => {
  it('plant eerst, en schrijft pas bij de tweede druk', async () => {
    const a = api((_id, confirm) => Promise.resolve(confirm ? WRITTEN : PLAN()));
    const { result } = renderHook(() => useGenerate(a, '900', bewaard, geenHerlaad));

    act(() => {
      result.current.generate();
    });
    await waitFor(() => {
      expect(result.current.state.kind).toBe('gepland');
    });
    // Plannen raakt niets aan: geen bevestiging meegestuurd.
    expect(a.aanroepen).toEqual([{ itemId: '900', confirm: false, planToken: undefined }]);

    act(() => {
      result.current.generate();
    });
    await waitFor(() => {
      expect(result.current.state.kind).toBe('klaar');
    });
    // Het token van het plan dat de adviseur zag reist mee.
    expect(a.aanroepen[1]).toEqual({ itemId: '900', confirm: true, planToken: 'plan-1' });
  });

  /** Ligt er al iets, dan is de tweede stap een bewuste bevestiging en geen doorklik. */
  it('vraagt om bevestiging als er al een briefing ligt', async () => {
    const a = api((_id, confirm) =>
      Promise.resolve(confirm ? WRITTEN : PLAN({ conflicts: ['Briefing.docx'] }))
    );
    const { result } = renderHook(() => useGenerate(a, '900', bewaard, geenHerlaad));

    act(() => {
      result.current.generate();
    });
    await waitFor(() => {
      expect(result.current.state.kind).toBe('bevestigen');
    });

    act(() => {
      result.current.confirm();
    });
    await waitFor(() => {
      expect(result.current.state.kind).toBe('klaar');
    });
  });

  it('laat annuleren de bevestiging vallen zonder te schrijven', async () => {
    const a = api(() => Promise.resolve(PLAN({ conflicts: ['Briefing.docx'] })));
    const { result } = renderHook(() => useGenerate(a, '900', bewaard, geenHerlaad));

    act(() => {
      result.current.generate();
    });
    await waitFor(() => {
      expect(result.current.state.kind).toBe('bevestigen');
    });

    act(() => {
      result.current.cancel();
    });

    expect(result.current.state.kind).toBe('idle');
    expect(a.aanroepen.every((aanroep) => !aanroep.confirm)).toBe(true);
  });

  /**
   * HET geval waar deze tab eerder op stuk ging.
   *
   * De weergave wordt niet opnieuw gemonteerd, dus een bevestiging van training A zou boven
   * training B blijven staan — en dan keurt één klik het overschrijven van de verkeerde
   * briefing goed.
   */
  it('laat een bevestiging niet meereizen naar de volgende training', async () => {
    const a = api(() => Promise.resolve(PLAN({ conflicts: ['Briefing.docx'] })));
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useGenerate(a, id, bewaard, geenHerlaad),
      {
        initialProps: { id: '900' },
      }
    );

    act(() => {
      result.current.generate();
    });
    await waitFor(() => {
      expect(result.current.state.kind).toBe('bevestigen');
    });

    rerender({ id: '901' });

    expect(result.current.state.kind).toBe('idle');
  });

  /**
   * Een traag antwoord voor training A mag niet op training B landen.
   *
   * Zonder deze bewaking verschijnt de map en de bestandslijst van de vorige training onder
   * de kop van de volgende, en klopt alles wat de adviseur vervolgens bevestigt niet.
   */
  it('negeert een antwoord dat te laat komt voor de vorige training', async () => {
    let laat: ((antwoord: GenerateResponse) => void) | null = null;
    const a = api(
      () =>
        new Promise<GenerateResponse>((resolve) => {
          laat = resolve;
        })
    );
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useGenerate(a, id, bewaard, geenHerlaad),
      {
        initialProps: { id: '900' },
      }
    );

    act(() => {
      result.current.generate();
    });
    rerender({ id: '901' });

    await act(async () => {
      laat?.(PLAN({ folderPath: 'map van de vorige training' }));
      await Promise.resolve();
    });

    expect(result.current.state.kind).toBe('idle');
  });

  /**
   * De server leest de OPGESLAGEN checklist, niet het scherm.
   *
   * Zet een vinkje en druk binnen de 800 ms van het automatisch opslaan op Genereren, en het
   * document zou op de vórige antwoorden gebouwd worden — zonder dat iets op het scherm dat
   * verraadt. Dus: eerst vastleggen, dan pas genereren.
   */
  it('legt het concept eerst vast en genereert pas daarna', async () => {
    const volgorde: string[] = [];
    const a = api(() => {
      volgorde.push('generate');
      return Promise.resolve(PLAN());
    });
    const flush = () => {
      volgorde.push('flush');
      return Promise.resolve(true);
    };
    const { result } = renderHook(() => useGenerate(a, '900', flush, geenHerlaad));

    act(() => {
      result.current.generate();
    });
    await waitFor(() => {
      expect(result.current.state.kind).toBe('gepland');
    });

    expect(volgorde).toEqual(['flush', 'generate']);
  });

  /**
   * Lukt het opslaan niet — een botsing, of de verbinding weg — dan is doorgaan erger dan
   * wachten: we zouden een briefing maken van antwoorden waarvan we net hebben vastgesteld
   * dat ze niet zijn bewaard.
   */
  it('genereert niet als het concept niet kon worden opgeslagen', async () => {
    const a = api(() => Promise.resolve(PLAN()));
    const { result } = renderHook(() =>
      useGenerate(a, '900', () => Promise.resolve(false), geenHerlaad)
    );

    act(() => {
      result.current.generate();
    });

    await waitFor(() => {
      expect(result.current.state.kind).toBe('mislukt');
    });
    expect(a.aanroepen).toEqual([]);
  });

  /**
   * A → B → A, en dán pas het antwoord van de éérste A-aanroep.
   *
   * Op het item-id vergelijken is hier niet genoeg: dat staat weer op "900", dus het oude
   * antwoord zou de toestand van de nieuwe aanroep overschrijven. Een nummer per aanroep
   * kan dat niet.
   */
  it('laat een oud antwoord de nieuwe aanroep voor dezelfde training niet overschrijven', async () => {
    const wachtenden: ((antwoord: GenerateResponse) => void)[] = [];
    const a = api(
      () =>
        new Promise<GenerateResponse>((resolve) => {
          wachtenden.push(resolve);
        })
    );
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useGenerate(a, id, bewaard, geenHerlaad),
      {
        initialProps: { id: '900' },
      }
    );

    act(() => {
      result.current.generate();
    });
    /**
     * Even doorlopen zodat de eerste aanroep écht bij de server ligt.
     *
     * Zonder dit wisselt de adviseur nog tijdens het opslaan, en dan wordt die aanroep
     * helemaal niet meer gedaan — een ander (ook goed) geval, dat hierboven zijn eigen test
     * heeft. Hier gaat het om de aanroep die al ONDERWEG is.
     */
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ id: '901' });
    rerender({ id: '900' });
    act(() => {
      result.current.generate();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Het antwoord van de EERSTE aanroep komt nu pas binnen.
    await act(async () => {
      wachtenden[0]?.(PLAN({ folderPath: 'map van de eerste aanroep' }));
      await Promise.resolve();
    });

    // De tweede aanroep loopt nog, dus het scherm hoort nog steeds "bezig" te zijn.
    expect(result.current.state.kind).toBe('bezig');

    await act(async () => {
      wachtenden[1]?.(PLAN({ folderPath: 'map van de tweede aanroep' }));
      await Promise.resolve();
    });
    expect(result.current.state.kind === 'gepland' && result.current.state.plan.folderPath).toBe(
      'map van de tweede aanroep'
    );
  });

  describe('als het plan is verschoven', () => {
    const verschoven = (plan: Extract<GenerateResponse, { stage: 'planned' }>) => {
      const a = api(() => Promise.reject(new BriefingPlanChanged(plan, 'er is iets veranderd')));
      return a;
    };

    /**
     * Een gewijzigde CHECKLIST is iets anders dan een gewijzigde map.
     *
     * Het formulier hierboven toont dan nog de antwoorden van déze adviseur, terwijl de
     * volgende generatie op die van de collega gebouwd zou worden. Alleen het paneel
     * bijwerken zou hem laten bevestigen wat hij niet ziet.
     */
    it('herlaadt het scherm als een collega de checklist wijzigde', async () => {
      let herladen = 0;
      const a = verschoven(PLAN({ changed: 'input', conflicts: [] }));
      const { result } = renderHook(() =>
        useGenerate(a, '900', bewaard, () => {
          herladen += 1;
        })
      );

      act(() => {
        result.current.generate();
      });

      await waitFor(() => {
        expect(herladen).toBe(1);
      });
      expect(result.current.state.kind).toBe('mislukt');
    });

    /** Zijn er bestanden bij gekomen, dan is dát het nieuws — en blijft het formulier staan. */
    it('toont het nieuwe plan zonder te herladen bij gewijzigde bestanden', async () => {
      let herladen = 0;
      const a = verschoven(PLAN({ changed: 'files', conflicts: ['Briefing.docx'] }));
      const { result } = renderHook(() =>
        useGenerate(a, '900', bewaard, () => {
          herladen += 1;
        })
      );

      act(() => {
        result.current.generate();
      });

      await waitFor(() => {
        expect(result.current.state.kind).toBe('bevestigen');
      });
      expect(herladen).toBe(0);
    });

    /**
     * Een schone map met een rode "er ligt al een briefing"-waarschuwing erboven dwingt een
     * keuze af die er niet is.
     */
    it('vraagt niet om bevestiging als het nieuwe plan niets botst', async () => {
      const a = verschoven(PLAN({ changed: 'files', conflicts: [] }));
      const { result } = renderHook(() => useGenerate(a, '900', bewaard, geenHerlaad));

      act(() => {
        result.current.generate();
      });

      await waitFor(() => {
        expect(result.current.state.kind).toBe('gepland');
      });
    });
  });

  /**
   * Het opslaan van het concept kost tijd, en in die tijd kan de adviseur doorklikken.
   *
   * Dit is de laatste plek waar afhaken nog vrijblijvend is: één regel verder begint er een
   * échte generatie. Bij een bevestigde druk zouden er bestanden in de klantmap komen te
   * staan waarvan het antwoord daarna wordt weggegooid — niemand ziet ze, en wie het opnieuw
   * probeert krijgt er een versie naast.
   */
  it('begint niet meer aan een generatie voor een training die van het scherm is', async () => {
    let klaar: (() => void) | null = null;
    const traagOpslaan = () =>
      new Promise<boolean>((resolve) => {
        klaar = () => {
          resolve(true);
        };
      });
    const a = api(() => Promise.resolve(PLAN()));
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useGenerate(a, id, traagOpslaan, geenHerlaad),
      { initialProps: { id: '900' } }
    );

    act(() => {
      result.current.generate();
    });
    // De adviseur klikt door terwijl het opslaan nog loopt.
    rerender({ id: '901' });

    await act(async () => {
      klaar?.();
      await Promise.resolve();
    });

    expect(a.aanroepen).toEqual([]);
    expect(result.current.state.kind).toBe('idle');
  });

  /**
   * Een bevestigde generatie is onomkeerbaar: hij loopt op de server door en zet bestanden in
   * de klantmap. Klikt de adviseur intussen weg en komt hij terug, dan hoort hij de links te
   * zien — niet een lege knop boven documenten die er wél staan.
   */
  it('bewaart de uitkomst van een generatie die tijdens het wegklikken doorliep', async () => {
    let klaar: ((antwoord: GenerateResponse) => void) | null = null;
    const a = api(
      () =>
        new Promise<GenerateResponse>((resolve) => {
          klaar = resolve;
        })
    );
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useGenerate(a, id, bewaard, geenHerlaad),
      { initialProps: { id: '900' } }
    );

    act(() => {
      result.current.confirm();
    });
    // Even doorlopen zodat de aanroep de server bereikt heeft.
    await act(async () => {
      await Promise.resolve();
    });

    rerender({ id: '901' });
    expect(result.current.state.kind).toBe('idle');

    // De generatie voor 900 rondt af terwijl 901 op het scherm staat.
    await act(async () => {
      klaar?.(WRITTEN);
      await Promise.resolve();
    });
    expect(result.current.state.kind).toBe('idle');

    // Terug naar 900: de documenten en hun links staan er nog.
    rerender({ id: '900' });
    expect(result.current.state.kind).toBe('klaar');
    expect(
      result.current.state.kind === 'klaar' && result.current.state.result.documents
    ).toHaveLength(1);
  });

  it('meldt een mislukking zonder de knop te blokkeren', async () => {
    const a = api(() => Promise.reject(new Error('SharePoint onbereikbaar')));
    const { result } = renderHook(() => useGenerate(a, '900', bewaard, geenHerlaad));

    act(() => {
      result.current.generate();
    });

    await waitFor(() => {
      expect(result.current.state).toEqual({
        kind: 'mislukt',
        message: 'SharePoint onbereikbaar',
      });
    });
  });
});

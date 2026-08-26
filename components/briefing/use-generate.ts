'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { BriefingApiError, BriefingPlanChanged } from './api';

import type { BriefingApi } from './api';
import type { GenerateState } from './generate-panel';

/**
 * De toestand van de Genereren-knop, per training.
 *
 * Net als de rest van deze tab is álles hier gebonden aan het item-id, want **de iframe wordt
 * niet opnieuw opgebouwd wanneer de adviseur op de volgende training klikt.** Zonder die
 * binding blijft de bevestiging van training A op het scherm staan boven training B, en
 * bevestigt één klik dan het overschrijven van de verkeerde briefing.
 */

export interface UseGenerate {
  readonly state: GenerateState;
  generate(): void;
  confirm(): void;
  cancel(): void;
}

const IDLE: GenerateState = { kind: 'idle' };

export function useGenerate(
  api: BriefingApi,
  itemId: string | null,
  /** Legt het concept vast en zegt of het veilig staat; zie `UseBriefingView.flush`. */
  flush: () => Promise<boolean>,
  /** Haalt de training en de opgeslagen antwoorden opnieuw op; zie `UseBriefingView.refresh`. */
  herlaad: () => void
): UseGenerate {
  /**
   * De toestand PER training, niet één toestand met een etiket erop.
   *
   * Een bevestigde generatie is onomkeerbaar: hij loopt op de server door en zet bestanden
   * in de klantmap, ook als de adviseur intussen doorklikt. Bij één gedeelde toestand was
   * dat resultaat weg — terugkomen op die training liet een lege knop zien terwijl de
   * documenten er wél stonden, zonder links en zonder een spoor dat er iets was gebeurd.
   *
   * Dezelfde opzet als de opslaghook, en om dezelfde reden: **de iframe wordt niet opnieuw
   * opgebouwd** bij het wisselen van item.
   */
  const [states, setStates] = useState<ReadonlyMap<string, GenerateState>>(new Map());

  const zet = useCallback((id: string, state: GenerateState) => {
    setStates((vorig) => new Map(vorig).set(id, state));
  }, []);

  /**
   * Welke aanroep de huidige is — een oplopend nummer, niet het item-id.
   *
   * Op het item-id vergelijken is niet genoeg. Ga van A naar B en terug naar A, start dan
   * opnieuw, en het trage antwoord van de eerste A-aanroep ziet nog steeds "A" staan; het
   * overschrijft dan de toestand van de tweede. Een nummer per aanroep kan dat niet: er is
   * er maar één de laatste.
   */
  const volgnummer = useRef(0);
  /** De nieuwste aanroep per training; een ouder nummer is verouderd en schrijft niets. */
  const lopend = useRef<Map<string, number>>(new Map());
  /**
   * De aanroepen die de server daadwerkelijk hebben bereikt.
   *
   * Precies hier ligt de grens tussen de twee dingen die we willen. Vóór dit punt is er
   * niets gebeurd en is afhaken gratis: wisselt de adviseur van training terwijl het concept
   * nog wordt opgeslagen, dan hoeft die generatie niet meer te beginnen. Ná dit punt is het
   * onomkeerbaar — er komen bestanden in de klantmap — en dan moet de uitkomst bewaard
   * blijven, ook al kijkt het scherm inmiddels ergens anders.
   */
  const gestart = useRef<Set<number>>(new Set());

  /**
   * Wisselen van training raakt de TOESTANDEN niet aan, en de lopende aanroepen maar half.
   *
   * Wat de server al heeft bereikt loopt door en mag zijn eigen vakje bijwerken — die
   * bestanden komen er hoe dan ook, en dan is de uitkomst wegdoen het slechtste antwoord.
   * Wat nog vastzit in het opslaan van het concept haakt af: daar is nog niets van gebeurd.
   */
  useEffect(() => {
    for (const [id, nummer] of lopend.current) {
      if (!gestart.current.has(nummer)) {
        lopend.current.delete(id);
      }
    }
  }, [itemId]);

  const roep = useCallback(
    (confirmExisting: boolean, planToken?: string) => {
      if (itemId === null) {
        return;
      }
      volgnummer.current += 1;
      const mijn = volgnummer.current;
      lopend.current.set(itemId, mijn);
      zet(itemId, { kind: 'bezig' });

      void (async () => {
        /**
         * Eerst het concept vastleggen, dan pas genereren.
         *
         * De server leest de opgeslagen checklist, niet het scherm. Zonder deze stap krijgt
         * wie een vinkje zet en meteen op Genereren drukt een document dat op de vórige
         * antwoorden is gebouwd — en niets aan het scherm verraadt dat.
         *
         * Mislukt het opslaan of botst het, dan gaat het genereren níet door: een briefing
         * maken van antwoorden waarvan we net hebben vastgesteld dat ze niet zijn bewaard is
         * erger dan even wachten.
         */
        if (!(await flush())) {
          if (lopend.current.get(itemId) === mijn) {
            zet(itemId, {
              kind: 'mislukt',
              message:
                'De checklist is niet opgeslagen, dus er is niet gegenereerd. Controleer de melding bovenaan en probeer het opnieuw.',
            });
          }
          return;
        }
        /**
         * Nogmaals kijken, want het opslaan kostte tijd.
         *
         * Wisselt de adviseur van training terwijl die schrijfactie loopt, dan is deze
         * aanroep verouderd — en dit is de laatste plek waar dat nog vrijblijvend is. Eén
         * regel verder begint er een échte generatie: bij een bevestigde druk komen er
         * bestanden in de klantmap te staan waarvan het antwoord daarna wordt weggegooid,
         * omdat het scherm allang bij een andere training is. Niemand ziet ze, en wie het
         * opnieuw probeert krijgt er een versie naast.
         */
        if (lopend.current.get(itemId) !== mijn) {
          return;
        }
        // Vanaf hier is het onomkeerbaar: de uitkomst blijft bewaard, ook na wegklikken.
        gestart.current.add(mijn);
        return await api.generate(itemId, { confirmExisting, planToken });
      })()
        .then((antwoord) => {
          if (lopend.current.get(itemId) !== mijn || antwoord === undefined) {
            return;
          }
          if (antwoord.stage === 'written') {
            zet(itemId, { kind: 'klaar', result: antwoord });
            return;
          }
          /**
           * Botst er niets, dan is er niets te bevestigen — maar er is ook nog niets
           * geschreven. `gepland` toont waar het heen gaat; de adviseur drukt nog een keer.
           *
           * Dat tweede zetje is met opzet niet weggeautomatiseerd: het plannen is goedkoop
           * en het schrijven niet, en de eerste druk is vaak "waar komt dit eigenlijk
           * terecht?" in plaats van "doe maar".
           */
          zet(
            itemId,
            antwoord.conflicts.length > 0
              ? { kind: 'bevestigen', plan: antwoord }
              : { kind: 'gepland', plan: antwoord }
          );
        })
        .catch((error: unknown) => {
          if (lopend.current.get(itemId) !== mijn) {
            return;
          }
          /**
           * Het plan is verschoven: geen mislukking, maar nieuw nieuws.
           *
           * De adviseur krijgt het bijgewerkte plan te zien en beslist opnieuw. Dit als rode
           * fout tonen zou hem terugsturen naar dezelfde knop zonder te laten zien wát er
           * veranderd is — en de tweede druk zou dan net zo goed mis kunnen zijn.
           */
          if (error instanceof BriefingPlanChanged) {
            /**
             * Is de CHECKLIST gewijzigd, dan klopt het formulier hierboven niet meer.
             *
             * Het scherm toont dan nog de antwoorden van deze adviseur terwijl de volgende
             * generatie op die van de collega gebouwd zou worden. Opnieuw laden is dan het
             * enige eerlijke: eerst zien wat er nu staat, dan pas beslissen.
             */
            if (error.plan.changed === 'input') {
              herlaad();
              zet(itemId, { kind: 'mislukt', message: error.message });
              return;
            }
            /**
             * Botst er niets, dan is er ook niets te bevestigen. De rode "er ligt al een
             * briefing"-waarschuwing tonen bij een schone map zou een keuze afdwingen die er
             * niet is.
             */
            zet(
              itemId,
              error.plan.conflicts.length > 0
                ? { kind: 'bevestigen', plan: error.plan }
                : { kind: 'gepland', plan: error.plan }
            );
            return;
          }
          const message =
            error instanceof BriefingApiError
              ? error.message
              : error instanceof Error
                ? error.message
                : 'genereren mislukt';
          zet(itemId, { kind: 'mislukt', message });
        });
    },
    [api, itemId, flush, herlaad, zet]
  );

  const huidig = itemId === null ? IDLE : (states.get(itemId) ?? IDLE);

  const generate = useCallback(() => {
    /**
     * Al gepland en niets botst? Dan is deze druk het "ja" op wat er getoond werd.
     *
     * Zonder dit zou de knop eeuwig hetzelfde plan blijven tonen en nooit iets schrijven.
     * `confirmExisting` is dan onschuldig: er is niets om te bevestigen, en de server
     * gebruikt het vlaggetje alleen als er wél iets ligt.
     */
    const getoond = huidig.kind === 'gepland' ? huidig.plan : null;
    roep(getoond !== null, getoond?.planToken);
  }, [roep, huidig]);

  const confirm = useCallback(() => {
    const getoond = huidig.kind === 'bevestigen' ? huidig.plan : null;
    // Zonder token weigert de server; dat is beter dan bevestigen wat niemand heeft gezien.
    roep(true, getoond?.planToken);
  }, [roep, huidig]);

  const cancel = useCallback(() => {
    if (itemId === null) {
      return;
    }
    // Ook het lopende antwoord laten vallen: annuleren betekent annuleren.
    lopend.current.delete(itemId);
    zet(itemId, IDLE);
  }, [itemId, zet]);

  return { state: huidig, generate, confirm, cancel };
}

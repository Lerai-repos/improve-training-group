'use client';

import { useEffect, useState } from 'react';

import { Button } from '@components/ui/button';
import { Checkbox } from '@components/ui/checkbox';
import { formatDutchDate } from '@lib/briefing/deadline';
import { cn } from '@lib/utils';

import type { CyclusOptie, CyclusKeuze } from '@lib/briefing/types';

/**
 * De vraag of deze sessies samen één briefing krijgen.
 *
 * Tim, 18-Sep-2026: de regel zoekt de sessies onder dezelfde opdracht op en zet de vinkjes
 * voor, maar een mens bevestigt. Tot die bevestiging houdt elke sessie haar eigen briefing —
 * er verandert dus niets zolang dit blok onbeantwoord blijft.
 *
 * Alles wat de adviseur nodig heeft om te beslissen staat per regel: datum, klanttitel en
 * trainers. Staat een sessie niet voorgesteld, dan staat erbij waarom, want dat is precies de
 * afweging ("andere trainers" is iets anders dan "een typfout in de klanttitel").
 */

export interface CyclusPanelProps {
  readonly keuze: CyclusKeuze;
  readonly bezig: boolean;
  readonly fout: string | null;
  /** De aangevinkte sessies, en alles wat er op het scherm stond — alleen dát is beoordeeld. */
  onBevestig(itemIds: readonly string[], getoond: readonly string[]): void;
}

const datumVan = (optie: CyclusOptie): string =>
  optie.datum === '' ? 'Zonder datum' : formatDutchDate(optie.datum);

interface SessieRijProps {
  readonly optie: CyclusOptie;
  readonly aangevinkt: boolean;
  onToggle(itemId: string, aan: boolean): void;
}

const SessieRij = ({ optie, aangevinkt, onToggle }: SessieRijProps) => {
  const handleChange = (waarde: boolean | 'indeterminate') => {
    onToggle(optie.itemId, waarde === true);
  };
  return (
    <li className="flex items-start gap-2.5">
      <Checkbox
        id={`cyclus-${optie.itemId}`}
        checked={aangevinkt}
        /** De training zelf hoort er per definitie bij; uitvinken zou nergens over gaan. */
        disabled={optie.huidig}
        onCheckedChange={handleChange}
        className="mt-0.5"
      />
      <label htmlFor={`cyclus-${optie.itemId}`} className="grid gap-0.5 text-sm leading-tight">
        <span className={cn(optie.huidig && 'font-medium')}>
          {datumVan(optie)}
          {optie.klanttitel.trim() === '' ? '' : ` · ${optie.klanttitel.trim()}`}
          {optie.huidig && ' · deze training'}
        </span>
        <span className="text-xs text-muted-foreground">
          {optie.trainers === '' ? 'Geen trainer gekoppeld' : optie.trainers}
          {optie.reden === null ? '' : ` — ${optie.reden}`}
        </span>
      </label>
    </li>
  );
};

export const CyclusPanel = ({ keuze, bezig, fout, onBevestig }: CyclusPanelProps) => {
  const [gekozen, setGekozen] = useState<readonly string[]>(() =>
    keuze.opties.filter((o) => o.aangevinkt).map((o) => o.itemId)
  );

  /**
   * Bij het wisselen van training — of nadat de server de bevestiging heeft teruggegeven —
   * opnieuw beginnen bij wat er nu geldt. Zonder dit blijven de vinkjes van de vorige training
   * staan, en die zeggen iets over andere sessies.
   */
  const sleutel = keuze.opties.map((o) => `${o.itemId}:${o.aangevinkt ? 1 : 0}`).join('|');
  useEffect(() => {
    setGekozen(keuze.opties.filter((o) => o.aangevinkt).map((o) => o.itemId));
    // De sleutel vat precies die opties samen; `keuze` is bij elke render een nieuw object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sleutel]);

  const handleToggle = (itemId: string, aan: boolean) => {
    setGekozen((vorige) =>
      aan ? [...new Set([...vorige, itemId])] : vorige.filter((id) => id !== itemId)
    );
  };

  const handleBevestig = () => {
    /** Alleen deze training aangevinkt betekent: dit is geen cyclus. Dat is ook een antwoord. */
    onBevestig(
      gekozen.length <= 1 ? [] : gekozen,
      keuze.opties.map((o) => o.itemId)
    );
  };

  const aantal = gekozen.length;
  return (
    <section className="grid gap-3 rounded-md border border-border bg-card p-4">
      <div className="grid gap-1">
        <h2 className="text-sm font-semibold">
          {keuze.openstaand ? 'Hoort deze training bij een trainingscyclus?' : 'Trainingscyclus'}
        </h2>
        <p className="text-xs text-muted-foreground">
          {keuze.openstaand
            ? 'Deze sessies staan onder dezelfde opdracht. Vink aan welke sessies bij elkaar ' +
              'horen; de keuzes en teksten in deze tab gelden dan voor alle aangevinkte sessies.'
            : 'Deze sessies horen bij elkaar: de keuzes en teksten in deze tab gelden voor alle ' +
              'sessies. Pas het aan en bevestig opnieuw als het niet klopt.'}
        </p>
      </div>

      <ul className="grid gap-2">
        {keuze.opties.map((optie) => (
          <SessieRij
            key={optie.itemId}
            optie={optie}
            aangevinkt={gekozen.includes(optie.itemId)}
            onToggle={handleToggle}
          />
        ))}
      </ul>

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={handleBevestig} disabled={bezig}>
          {bezig ? 'Bezig…' : 'Bevestigen'}
        </Button>
        <span className="text-xs text-muted-foreground">
          {aantal <= 1 ? 'Geen cyclus: alleen deze training.' : `Eén cyclus van ${aantal} sessies.`}
        </span>
      </div>
      {fout !== null && <p className="text-xs text-destructive">{fout}</p>}
    </section>
  );
};

'use client';

import { useEffect, useRef, useState } from 'react';

import { Button } from '@components/ui/button';
import { Textarea } from '@components/ui/textarea';

/**
 * De achtergrondinformatie ("de aanleidingtekst"), aan te vullen in de tab.
 *
 * Dirkje, 17-Sep-2026: de tekst hoort op de Opportunity te staan, maar trainingen worden naar
 * de agenda gekopieerd zonder dat iemand hem aanvult. Dit vak begint met wat er op de
 * Opportunity staat, of leeg.
 *
 * Zelfde regel als de concept-inhoud: **pas opslaan als er echt getypt is.** Gelijk aan de
 * Opportunity-tekst stuurt `undefined`, zodat een tekst die daar later wordt aangevuld deze
 * training nog bereikt.
 */

export interface AchtergrondPanelProps {
  /** De tekst op de gekoppelde Opportunity; leeg als daar niets staat. */
  readonly bron: string;
  /** Wat de adviseur heeft getypt, of `null` als hij het niet heeft aangeraakt. */
  readonly eigen: string | null;
  onChange(next: string | undefined): void;
}

export const AchtergrondPanel = ({ bron, eigen, onChange }: AchtergrondPanelProps) => {
  const [tekst, setTekst] = useState(eigen ?? bron);

  /** Bij het wisselen van training: anders slaat de eerste toetsaanslag de vorige tekst op. */
  const vorige = useRef<string | null>(null);
  const sleutel = `${eigen ?? ''}|${bron}`;
  useEffect(() => {
    if (vorige.current !== sleutel) {
      vorige.current = sleutel;
      setTekst(eigen ?? bron);
    }
  }, [eigen, bron, sleutel]);

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const volgende = event.target.value;
    setTekst(volgende);
    onChange(volgende.trim() === bron.trim() ? undefined : volgende);
  };

  const herstel = () => {
    setTekst(bron);
    onChange(undefined);
  };

  const aangepast = eigen !== null;
  const uitleg = aangepast
    ? 'Aangepast voor deze training. Herstellen zet de tekst van de Opportunity terug.'
    : bron.trim() === ''
      ? 'Er staat nog niets op de Opportunity. Wat je hier typt geldt alleen voor deze training.'
      : 'Dit staat op de Opportunity. Pas je het aan, dan geldt jouw versie alleen voor deze training.';

  return (
    <section className="grid gap-2 rounded-md border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold">Achtergrondinformatie</h2>
        {aangepast && (
          <Button variant="ghost" size="sm" onClick={herstel}>
            Herstel de Opportunity-tekst
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{uitleg}</p>
      <Textarea
        value={tekst}
        onChange={handleChange}
        rows={8}
        spellCheck
        className="font-normal"
        aria-label="Achtergrondinformatie"
        placeholder="Over de organisatie en de aanleiding van de training. Meerdere alinea's mag."
      />
    </section>
  );
};

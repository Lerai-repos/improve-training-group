'use client';

import { useEffect, useRef, useState } from 'react';

import { Button } from '@components/ui/button';
import { Textarea } from '@components/ui/textarea';

/**
 * De concept-inhoud: het enige veld van de briefing dat vrije tekst is.
 *
 * Alles wat verder per training verschilt komt uit een Monday-kolom, en dat pas je daar aan.
 * Dit niet: het programma dat met de klant is besproken staat nergens anders.
 *
 * ## Onaangeraakt is niet hetzelfde als leeg
 *
 * Het vak begint gevuld met het skelet van het thema, maar dat wordt **niet** opgeslagen tot
 * de adviseur er iets aan verandert. Zouden we de voorvulling meteen wegschrijven, dan
 * bevriest elke training een kopie van het skelet op de dag dat iemand de tab toevallig
 * opendeed — en bereikt een verbeterd skelet die training nooit meer.
 *
 * Daarom stuurt dit paneel `null` zodra de tekst weer gelijk is aan het skelet: dat is de
 * expliciete "gebruik het skelet"-toestand, en de knop Herstellen zet hem terug.
 */

export interface ConceptPanelProps {
  /** Het skelet van het thema, zoals het in Monday staat. */
  readonly skelet: readonly string[];
  /** Wat de adviseur heeft getypt, of `null` als hij het niet heeft aangeraakt. */
  readonly eigen: string | null;
  /** Hoe het in het document komt te staan, met de klantnaam ingevuld. */
  readonly resultaat: readonly string[];
  onChange(next: string | undefined): void;
}

export const ConceptPanel = ({ skelet, eigen, resultaat, onChange }: ConceptPanelProps) => {
  const skeletTekst = skelet.join('\n');
  const [tekst, setTekst] = useState(eigen ?? skeletTekst);

  /**
   * Bij het wisselen van training komt er ander skelet en andere eigen tekst binnen. Zonder
   * dit blijft het tekstvak op de vorige training staan — en slaat de eerste toetsaanslag die
   * tekst op bij de nieuwe.
   */
  const vorige = useRef<string | null>(null);
  const sleutel = `${eigen ?? ''}|${skeletTekst}`;
  useEffect(() => {
    if (vorige.current !== sleutel) {
      vorige.current = sleutel;
      setTekst(eigen ?? skeletTekst);
    }
  }, [eigen, skeletTekst, sleutel]);

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const volgende = event.target.value;
    setTekst(volgende);
    // Gelijk aan het skelet betekent "niet aangeraakt", ook als de adviseur het handmatig
    // terugtypt. Anders zou een training die toevallig identiek is tóch bevriezen.
    onChange(volgende.trim() === skeletTekst.trim() ? undefined : volgende);
  };

  const herstel = () => {
    setTekst(skeletTekst);
    onChange(undefined);
  };

  const aangepast = eigen !== null;
  return (
    <section className="grid gap-2 rounded-md border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold">Concept inhoud</h2>
        {aangepast && (
          <Button variant="ghost" size="sm" onClick={herstel}>
            Herstel het skelet
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {aangepast
          ? 'Aangepast voor deze training. Herstellen zet het thema-skelet terug.'
          : 'Dit is het skelet van het thema. Pas je het aan, dan geldt jouw versie alleen voor deze training.'}
      </p>
      <Textarea
        value={tekst}
        onChange={handleChange}
        rows={12}
        spellCheck
        className="font-normal"
        aria-label="Concept inhoud"
      />
      {resultaat.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {resultaat.length} regel{resultaat.length === 1 ? '' : 's'} in het document, elk als
          opsommingsteken.
        </p>
      )}
    </section>
  );
};

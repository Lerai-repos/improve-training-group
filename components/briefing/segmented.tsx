'use client';

import { cn } from '@lib/utils';

/**
 * Eén keuze uit twee of drie, als aaneengesloten knoppenrij.
 *
 * Vervangt de kale `<input type="radio">` die het scherm eerst gebruikte. Die kregen de
 * standaardopmaak van de browser — olijfgroene bolletjes op Monday's donkerblauw, naast de
 * blauwe shadcn-vinkjes eronder — waardoor drie verschillende stijlen boven elkaar stonden
 * voor vragen die hetzelfde doen.
 *
 * Het onderscheid dat overblijft is er wél een: hierboven kies je er precies één, hieronder
 * vink je er nul of meer aan. Dat verschil hoort te zien te zijn.
 */

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

interface SegmentedProps<T extends string> {
  /** Uniek binnen het formulier: bindt de radioknoppen aan elkaar. */
  readonly name: string;
  readonly value: T;
  readonly options: ReadonlyArray<SegmentedOption<T>>;
  onChange(next: T): void;
}

export const Segmented = <T extends string>({
  name,
  value,
  options,
  onChange,
}: SegmentedProps<T>) => {
  /**
   * `onClick` ALLEEN op de al gekozen knop, en dat onderscheid is het hele punt.
   *
   * De acteurvraag staat voorgezet op wat Monday suggereert, dus wie dat antwoord bevestigt
   * klikt op een knop die al gekozen is. Dat levert geen `change` op, en zonder de klik zou
   * bevestigen niets doen — precies de handeling waar het scherm om vraagt.
   *
   * Op een knop die nog níet gekozen is vuren `click` én `change` allebei, dus daar zou
   * dezelfde keuze twee keer verstuurd worden: twee toestandswijzigingen en twee opslagen
   * voor één muisklik.
   */
  const kies = (next: T) => () => {
    onChange(next);
  };

  return (
    <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5">
      {options.map((optie) => {
        const actief = optie.value === value;
        return (
          <label
            key={optie.value}
            className={cn(
              'relative cursor-pointer rounded-[5px] px-3 py-1 text-sm transition-colors',
              // De focusring hangt aan de verborgen radio, niet aan het label: anders is er
              // met het toetsenbord niet te zien waar je bent.
              'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
              actief
                ? 'bg-background font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={actief}
              onChange={kies(optie.value)}
              onClick={actief ? kies(optie.value) : undefined}
            />
            {optie.label}
          </label>
        );
      })}
    </div>
  );
};

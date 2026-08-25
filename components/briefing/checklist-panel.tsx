'use client';

import { Checkbox } from '@components/ui/checkbox';
import { Label } from '@components/ui/label';
import { cn } from '@lib/utils';

import { Segmented } from './segmented';

import type { BriefingChecklist } from '@lib/briefing/blocks';
import type { TabPerson } from '@lib/briefing/tab';

/**
 * De vragen die bepalen welke blokken in de briefing komen.
 *
 * Elk vinkje zet een stuk tekst van ITG aan of uit. Daarom staat er bij elke vraag wat het
 * dóét en niet alleen hoe hij heet: "cyclus" zegt een adviseur niets, "voegt het blok over de
 * trainingscyclus toe, met het schema" wel.
 */

interface VraagProps {
  readonly id: string;
  readonly label: string;
  readonly uitleg: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  onChange(next: boolean): void;
}

const Vraag = ({ id, label, uitleg, checked, disabled, onChange }: VraagProps) => {
  const handle = (next: boolean | 'indeterminate') => {
    onChange(next === true);
  };
  return (
    <div className="flex items-start gap-3">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={handle} />
      <div className="grid gap-0.5 leading-tight">
        <Label htmlFor={id} className={cn('font-medium', disabled && 'opacity-60')}>
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{uitleg}</p>
      </div>
    </div>
  );
};

interface KeuzeVraagProps {
  readonly label: string;
  readonly uitleg?: string;
  readonly children: React.ReactNode;
}

/**
 * De vorm die élke vraag hier heeft: kop, één grijze regel, dan de bediening.
 *
 * Eerst had elke vraag zijn eigen indeling — de ene een legend zonder uitleg, de andere
 * legend-uitleg-opties, de vinkjes weer label-onder-uitleg — en dan leest een lijst van zes
 * vragen als zes losse dingen in plaats van als één formulier.
 */
const KeuzeVraag = ({ label, uitleg, children }: KeuzeVraagProps) => (
  <fieldset className="grid gap-1.5">
    <legend className="text-sm font-medium">{label}</legend>
    {uitleg !== undefined && <p className="text-xs text-muted-foreground">{uitleg}</p>}
    <div className="mt-0.5">{children}</div>
  </fieldset>
);

interface GroepKeuzeProps {
  readonly checklist: BriefingChecklist;
  onChange(next: Partial<BriefingChecklist>): void;
}

/**
 * Eén keuze uit drie, geen twee losse vinkjes.
 *
 * "Ieder een eigen groep" en "samen op één groep" zijn de twee antwoorden op dezelfde vraag;
 * `selectBlocks` wérpt als ze allebei aanstaan. Als radiogroep kán die toestand niet ontstaan,
 * en dat is beter dan hem achteraf afkeuren.
 */
const GroepKeuze = ({ checklist, onChange }: GroepKeuzeProps) => {
  const kies = (waarde: 'geen' | 'eigen' | 'samen') => {
    onChange({ ownGroup: waarde === 'eigen', sameGroup: waarde === 'samen' });
  };
  const huidig = checklist.ownGroup ? 'eigen' : checklist.sameGroup ? 'samen' : 'geen';
  return (
    <KeuzeVraag
      label="Meerdere trainers op deze sessie"
      uitleg="Alleen invullen als er meer dan één trainer meedoet; het voegt het bijbehorende blok toe."
    >
      <Segmented
        name="groepkeuze"
        value={huidig}
        onChange={kies}
        options={[
          { value: 'geen', label: 'Niet van toepassing' },
          { value: 'eigen', label: 'Ieder een eigen groep' },
          { value: 'samen', label: 'Samen op één groep' },
        ]}
      />
    </KeuzeVraag>
  );
};

interface ActeurVraagProps {
  readonly checklist: BriefingChecklist;
  readonly beantwoord: boolean;
  readonly voorstel: boolean;
  readonly personen: readonly TabPerson[];
  readonly actorItemIds: readonly string[];
  onActors(next: readonly string[]): void;
  onAnswerActor(werktMee: boolean): void;
}

/**
 * De acteurvraag, en wie de acteur dan is.
 *
 * Monday doet een voorstel op basis van `Acteuraantal` en de groep `Acteurs`, maar beide
 * signalen zijn gemeten onvolledig: samen missen ze soms een acteur, en dan verdwijnt het
 * acteurblok uit élk document zonder dat iemand een vraag oversloeg. Daarom staat het voorstel
 * er zichtbaar bij, en beantwoordt de adviseur hem zelf.
 */
const ActeurVraag = ({
  checklist,
  beantwoord,
  voorstel,
  personen,
  actorItemIds,
  onActors,
  onAnswerActor,
}: ActeurVraagProps) => {
  /**
   * Eén zetter voor het antwoord én voor "er ís geantwoord", in één wijziging.
   *
   * Het voorstel van Monday staat al aangevinkt, dus wie het bevestigt levert geen
   * `change`-gebeurtenis op — vandaar `onClick` en niet `onChange`. En het opruimen van de
   * aangewezen acteurs hoort in dezelfde wijziging te zitten: als twee losse aanroepen las de
   * tweede nog het concept van vóór de eerste, en draaide hem terug.
   */
  const zet = (waarde: 'ja' | 'nee') => {
    onAnswerActor(waarde === 'ja');
  };
  const wissel = (itemId: string) => () => {
    const gekozen = new Set(actorItemIds);
    if (gekozen.has(itemId)) {
      gekozen.delete(itemId);
    } else {
      gekozen.add(itemId);
    }
    onActors([...gekozen]);
  };

  return (
    <KeuzeVraag label="Werkt er een trainingsacteur mee?">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          name="acteur"
          value={checklist.trainingActor ? 'ja' : 'nee'}
          onChange={zet}
          options={[
            { value: 'ja', label: 'Ja' },
            { value: 'nee', label: 'Nee' },
          ]}
        />
        {/*
          Een eigen chip in plaats van kale rode tekst: `text-destructive` op Monday's donkere
          ondergrond is donkerrood op donkerblauw en nauwelijks te lezen — precies de regel die
          de adviseur juist moet zien.
        */}
        {!beantwoord && (
          <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-foreground">
            Monday stelt {voorstel ? 'ja' : 'nee'} voor — bevestig of wijzig het
          </span>
        )}
      </div>

      {/*
        Ja aanvinken terwijl er niemand aan de training hangt deed zichtbaar niets: de kiezer
        hieronder rendert alleen mét mensen, dus het scherm bleef staan zoals het stond. Een
        antwoord dat geen reactie oplevert leest als een kapotte knop, dus staat er nu wat er
        aan de hand is — en waar het opgelost wordt, want dat is op het bord en niet hier.
      */}
      {checklist.trainingActor && personen.length === 0 && (
        <p className="mt-1 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          Er hangt nog niemand aan deze training, dus er is niemand om als acteur aan te wijzen.
          Koppel eerst de trainers op het agendabord.
        </p>
      )}

      {checklist.trainingActor && personen.length > 0 && (
        <div className="mt-1 grid gap-1 rounded-md border border-border bg-muted/40 p-3">
          <p className="text-xs text-muted-foreground">
            Wie is de acteur? De groep <span className="font-medium">Acteurs</span> zegt wat iemand
            meestal doet, niet welke rol hij in déze sessie heeft.
          </p>
          {personen.map((persoon) => (
            <label key={persoon.itemId} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={actorItemIds.includes(persoon.itemId)}
                onChange={wissel(persoon.itemId)}
              />
              {persoon.naam}
              {persoon.inActeursGroep && (
                <span className="text-xs text-muted-foreground">(staat in Acteurs)</span>
              )}
            </label>
          ))}
        </div>
      )}
    </KeuzeVraag>
  );
};

export interface ChecklistPanelProps {
  readonly checklist: BriefingChecklist;
  readonly acteurBeantwoord: boolean;
  readonly acteurVoorstel: boolean;
  readonly personen: readonly TabPerson[];
  readonly actorItemIds: readonly string[];
  readonly mondayChallenge: boolean;
  onChecklist(next: Partial<BriefingChecklist>): void;
  onActors(next: readonly string[]): void;
  onMondayChallenge(next: boolean): void;
  onAnswerActor(werktMee: boolean): void;
}

export const ChecklistPanel = ({
  checklist,
  acteurBeantwoord,
  acteurVoorstel,
  personen,
  actorItemIds,
  mondayChallenge,
  onChecklist,
  onActors,
  onMondayChallenge,
  onAnswerActor,
}: ChecklistPanelProps) => {
  const zetCyclus = (next: boolean) => {
    onChecklist({ trainingCycle: next });
  };
  const zetHuiswerk = (next: boolean) => {
    onChecklist({ homework: next });
  };
  const zetVoorbereidend = (next: boolean) => {
    onChecklist({ preparatoryAssignment: next });
  };

  return (
    <section className="grid gap-5 rounded-md border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">Checklist</h2>

      <ActeurVraag
        checklist={checklist}
        beantwoord={acteurBeantwoord}
        voorstel={acteurVoorstel}
        personen={personen}
        actorItemIds={actorItemIds}
        onActors={onActors}
        onAnswerActor={onAnswerActor}
      />

      <GroepKeuze checklist={checklist} onChange={onChecklist} />

      <div className="grid gap-3">
        <Vraag
          id="cyclus"
          label="Trainingscyclus"
          uitleg="Meerdere sessies die op elkaar voortbouwen; voegt het cyclusblok met het schema toe."
          checked={checklist.trainingCycle}
          onChange={zetCyclus}
        />
        <Vraag
          id="huiswerk"
          label="Huiswerkopdracht"
          uitleg="De trainer geeft deelnemers een opdracht mee; voegt de afspraken daarover toe."
          checked={checklist.homework}
          onChange={zetHuiswerk}
        />
        <Vraag
          id="voorbereidend"
          label="Voorbereidende opdracht"
          uitleg="Deelnemers krijgen vooraf een reflectieopdracht."
          checked={checklist.preparatoryAssignment}
          onChange={zetVoorbereidend}
        />
        <Vraag
          id="challenge"
          label="Monday Challenge"
          uitleg="Zet de harde regel onder de achtergrondinformatie: vergeet de Challenges niet."
          checked={mondayChallenge}
          onChange={onMondayChallenge}
        />
      </div>
    </section>
  );
};

'use client';

import { AlertTriangle, ExternalLink, FileText, Loader2 } from 'lucide-react';

import { Button } from '@components/ui/button';

import type { BriefingPlan, BriefingWritten } from './api';

/**
 * Genereren: de knop, de bevestiging, en wat eruit kwam.
 *
 * De bevestiging is er om één reden. ITG bewerkt het gegenereerde Word-bestand met de
 * hand — extra tekst, en soms een plaatje van hoe een traject in de offerte stond — en dat
 * bestand ís het bestand dat wij schrijven. Opnieuw genereren mag dat werk dus niet kunnen
 * wissen zonder dat iemand het heeft gezien.
 *
 * Eén bevestiging voor álle documenten. Een training met een acteur levert er tot acht op, en
 * acht popups voor één knopdruk is geen ontwerp.
 */

const ROL_LABEL: Record<'lead' | 'co' | 'acteur', string> = {
  lead: 'Leadtrainer',
  co: 'Co-trainer',
  acteur: 'Trainingsacteur',
};

export type GenerateState =
  | { readonly kind: 'idle' }
  /**
   * `schrijft` onderscheidt de twee dingen die allebei "bezig" heten.
   *
   * Zonder dat verschil valt de knoptekst tijdens het schrijven terug op de tekst van de
   * planstap, en meldt het scherm een controle terwijl er documenten de deur uit gaan.
   */
  | { readonly kind: 'bezig'; readonly schrijft: boolean }
  /** Gepland zonder botsingen: er kan gewoon geschreven worden. */
  | { readonly kind: 'gepland'; readonly plan: BriefingPlan }
  /** Gepland mét botsingen: hier hangt de bevestiging aan. */
  | { readonly kind: 'bevestigen'; readonly plan: BriefingPlan }
  | { readonly kind: 'klaar'; readonly result: BriefingWritten }
  | { readonly kind: 'mislukt'; readonly message: string };

interface GeneratePanelProps {
  readonly state: GenerateState;
  readonly kanGenereren: boolean;
  onGenerate(): void;
  onConfirm(): void;
  onCancel(): void;
}

/** Een lijstje bestandsnamen, met de map erboven zodat duidelijk is wáár het staat. */
const Bestanden = ({ namen }: { namen: readonly string[] }) => (
  <ul className="grid gap-0.5">
    {namen.map((naam) => (
      <li key={naam} className="flex items-start gap-2 text-xs">
        <FileText className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
        <span className="break-all">{naam}</span>
      </li>
    ))}
  </ul>
);

export const GeneratePanel = ({
  state,
  kanGenereren,
  onGenerate,
  onConfirm,
  onCancel,
}: GeneratePanelProps) => {
  const bezig = state.kind === 'bezig';

  /**
   * De knop heet naar wat de VOLGENDE druk doet, niet naar de sectie.
   *
   * De eerste druk plant: hij zoekt de klantmap op en kijkt wat er al ligt, en schrijft
   * niets. Stond er "Genereren" op, dan drukte de adviseur op genereren, verscheen er een
   * regel tekst, en bleef de map leeg — waarna de logische conclusie is dat het stuk is. Dat
   * is precies hoe de eerste echte generatie op het bord verliep.
   *
   * De planstap zelf blijft bestaan, want die is het enige moment waarop iemand ziet wáár
   * het document terechtkomt voordat het er staat.
   */
  const knopTekst =
    state.kind === 'bezig'
      ? state.schrijft
        ? 'Genereren…'
        : 'Controleren…'
      : state.kind === 'gepland'
        ? 'Ja, genereren'
        : 'Plan controleren';

  return (
    <section className="grid gap-3 rounded-md border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold">Genereren</h2>
        <Button size="sm" disabled={!kanGenereren || bezig} onClick={onGenerate}>
          {bezig && <Loader2 className="mr-2 size-3.5 animate-spin" />}
          {knopTekst}
        </Button>
      </div>

      {!kanGenereren && state.kind === 'idle' && (
        <p className="text-xs text-muted-foreground">
          Los eerst op wat hierboven rood staat; dan kan de briefing gemaakt worden.
        </p>
      )}

      {/*
        Geen botsing: gewoon zeggen waar het heen gaat en doorschrijven. De adviseur hoeft
        niets te bevestigen wat niets overschrijft.
      */}
      {state.kind === 'gepland' && (
        <div className="grid gap-2 text-xs">
          <p className="text-muted-foreground">
            Komt in <span className="text-foreground">{state.plan.folderPath}</span>
            {!state.plan.folderExists && ' (map wordt aangemaakt)'}
          </p>
          <Bestanden namen={state.plan.filenames} />
          <p className="text-muted-foreground">
            Er is nog niets geschreven. Druk op{' '}
            <span className="text-foreground">Ja, genereren</span> om door te gaan.
          </p>
        </div>
      )}

      {state.kind === 'bevestigen' && (
        <div className="grid gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="grid gap-2">
              <p>
                Er {state.plan.conflicts.length === 1 ? 'ligt' : 'liggen'} al{' '}
                {state.plan.conflicts.length} van de {state.plan.filenames.length} briefing
                {state.plan.filenames.length === 1 ? '' : 's'} in deze map. Opnieuw genereren zet er
                een nieuwe versie <span className="font-medium">naast</span>; wat er staat blijft
                ongemoeid.
              </p>
              <Bestanden namen={state.plan.conflicts} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={onConfirm}>
              Toch genereren
            </Button>
            <Button size="sm" variant="outline" onClick={onCancel}>
              Annuleren
            </Button>
          </div>
        </div>
      )}

      {/*
        Eerdere briefings van dezelfde sessie, ook als er niets botst.

        Dit vangt het geval dat de bevestiging niet kán vangen: verschuift de datum, dan
        verandert de bestandsnaam en botst er niets — terwijl de bewerkte briefing van de
        oude datum blijft liggen. Niet tegenhouden, wel laten zien.
      */}
      {(state.kind === 'gepland' || state.kind === 'bevestigen') &&
        state.plan.related.length > 0 && (
          <div className="grid gap-1 rounded-md border border-border bg-muted/40 p-3">
            <p className="text-xs text-muted-foreground">
              Van deze sessie staat er al eerder werk in de map. Staat daar een verzette datum
              tussen, dan is die versie waarschijnlijk verouderd.
            </p>
            <Bestanden namen={state.plan.related} />
          </div>
        )}

      {state.kind === 'klaar' && (
        <div className="grid gap-2">
          <p className="text-sm">
            {state.result.documents.length} briefing
            {state.result.documents.length === 1 ? '' : 's'} klaargezet.
          </p>

          {/*
            Een halve generatie. De documenten hieronder stáán er en zijn vastgelegd; de rest
            niet. Dat als gewone fout tonen zou de adviseur laten denken dat er niets is
            gebeurd — waarna hij opnieuw drukt en er versies naast de bestaande komen.
          */}
          {state.result.partial === true && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <p>
                Niet alles is gelukt. Wat hieronder staat is klaar en vastgelegd; de rest niet.
                {state.result.failure !== undefined && (
                  <>
                    {' '}
                    Het ging mis bij{' '}
                    <span className="font-medium">{state.result.failure.filename}</span>:{' '}
                    {state.result.failure.reason}
                  </>
                )}
              </p>
            </div>
          )}
          <ul className="grid gap-1">
            {state.result.documents.map((doc) => (
              <li key={doc.file.webUrl} className="flex items-start gap-2 text-sm">
                <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="grid gap-0.5">
                  <a
                    href={doc.file.webUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
                  >
                    {doc.trainerNaam}
                    <ExternalLink className="size-3" />
                  </a>
                  <span className="text-xs text-muted-foreground">
                    {ROL_LABEL[doc.role]}
                    {doc.versioned && ' · als nieuwe versie naast de bestaande'}
                  </span>
                  {doc.open.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      Nog leeg in dit document: {doc.open.join(', ')}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>

          {/*
            De documenten staan er; dit ging alleen mis in de administratie. Dat verdient een
            melding, maar niet de rode "mislukt" — de trainer kan zijn briefing gewoon openen,
            en wie dat als mislukking leest drukt nog een keer en krijgt een overbodige (v2).
          */}
          {state.result.administratie.length > 0 && (
            <div className="grid gap-1 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">
                De documenten staan klaar, maar Monday is niet helemaal bijgewerkt:
              </p>
              {state.result.administratie.map((probleem) => (
                <p key={probleem}>{probleem}</p>
              ))}
            </div>
          )}

          {state.result.notes.length > 0 && (
            <div className="grid gap-1 text-xs text-muted-foreground">
              {state.result.notes.map((note) => (
                <p key={note.tekst}>{note.tekst}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {state.kind === 'mislukt' && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p>{state.message}</p>
        </div>
      )}
    </section>
  );
};

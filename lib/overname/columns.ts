import { HUISWERK_WEL, VOORBEREIDEND_WEL } from '@lib/briefing/columns';

/**
 * De drie vragen die Dirkje op 17-Sep-2026 op het Opportunitybord heeft gezet, met de
 * label-indexen zoals de API ze teruggeeft (gemeten 18-Sep-2026 met `pnpm columns:list`).
 *
 * Let op: `Voorbereidende reflectieopdracht?` heeft Wel op 0 en Geen op 1, maar
 * `Huiswerkopdracht?` heeft het andersom (Geen op 0, Wel op 1). Op index, niet op tekst, zodat
 * ITG de labels mag hernoemen — en dus staan beide hier apart uitgeschreven.
 *
 * `Trainingscyclus?` is geen ja/nee maar een keuze uit varianten (8+4u, 2x4u, 4+8u, 2x8u,
 * 3x4u) plus `Nee`. Op de agenda staat maar één label, `trainingscyclus (2x4/2x7)`. Dirkje,
 * 18-Sep-2026: *"laten we dat als start doen, anders misschien te foutgevoelig"* — elke
 * variant wordt dus dat ene label. Daarom is hier alleen vastgelegd wat GÉÉN cyclus is: `Nee`
 * en het naamloze label op 5; elke andere gezette index is een cyclus, ook een variant die
 * ITG er later bij zet.
 */
export const OPPORTUNITY_OVERNAME_COLUMNS = {
  voorbereidend: 'color_mm72ca6d',
  huiswerk: 'color_mm72tjmz',
  cyclus: 'color_mm724vqh',
} as const;

export const OPPORTUNITY_LABELS = {
  voorbereidend: { wel: 0, geen: 1 },
  huiswerk: { geen: 0, wel: 1 },
  cyclus: { leeg: 5, nee: 6 },
} as const;

/**
 * De doelen op de agenda.
 *
 * `Voorb. opdr.` is van ITG: Wel = 0, Geen (deze sessie) = 2, en 5 is het grijze `Voorb.
 * opdr.?` dat een nieuwe rij standaard krijgt — dat is "nog niet ingevuld" en mag dus gevuld
 * worden. `Huisw. opdr.` is van ons (`pnpm agenda:huiswerk`): Wel = 9, Geen = 6, geen grijs
 * standaardlabel. De "ja"-lijsten zijn dezelfde als die de briefing leest, zodat wat hier
 * "al ingevuld" heet ook is wat de briefing als ja leest.
 */
export const AGENDA_LABELS = {
  voorbereidend: { wel: 0, geen: 2, onbeantwoord: 5, welLijst: VOORBEREIDEND_WEL },
  huiswerk: { wel: 9, geen: 6, welLijst: HUISWERK_WEL },
} as const;

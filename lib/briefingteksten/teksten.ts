import { beoordeelAlle } from './beoordeel';
import { SECTIES } from './catalog';
import { parseKop, parseRegels } from './regels';

import type { TekstRij } from './beoordeel';
import type { BriefingTeksten, SectieStaat, TekstSleutel } from './types';

/**
 * De teksten voor één briefing, uit de items van het bord.
 *
 * Een sectie waarvoor geen item bestaat is `leeg`: iemand heeft het item verwijderd, en dat
 * betekent hetzelfde als de tekst leegmaken. De dagelijkse controle meldt het, maar de
 * briefing valt níét terug op de oude tekst — wat ITG weghaalt, blijft weg.
 */
export function tekstenUit(
  rijen: readonly TekstRij[],
  label: { readonly merk: string; readonly term: string }
): BriefingTeksten {
  const staten = new Map<string, SectieStaat>();
  for (const { oordeel } of beoordeelAlle(rijen)) {
    if (oordeel.definitie !== null) {
      staten.set(oordeel.definitie.sleutel, oordeel.staat);
    }
  }
  return {
    secties: perSleutel((sleutel) => staten.get(sleutel) ?? { kind: 'leeg' }),
    ...merkEnTerm(label),
  };
}

/**
 * De teksten zoals ze op 30-Sep-2026 in de briefing stonden: de beginwaarden van het bord.
 *
 * Voor wat een briefing wel samenstelt maar niet verstuurt — de voorvertoning in de tab en
 * de tests. Een document dat naar een trainer gaat leest altijd het bord.
 */
export function standaardTeksten(label: {
  readonly merk: string;
  readonly term: string;
}): BriefingTeksten {
  const perDefinitie = new Map(SECTIES.map((s) => [s.sleutel, s]));
  return {
    secties: perSleutel((sleutel): SectieStaat => {
      const definitie = perDefinitie.get(sleutel);
      if (definitie === undefined) {
        return { kind: 'leeg' };
      }
      return {
        kind: 'tekst',
        kop: parseKop(definitie.kop),
        regels: parseRegels(definitie.tekst),
      };
    }),
    ...merkEnTerm(label),
  };
}

function perSleutel(
  staat: (sleutel: TekstSleutel) => SectieStaat
): Readonly<Record<TekstSleutel, SectieStaat>> {
  return {
    'algemeen.inleiding': staat('algemeen.inleiding'),
    'algemeen.vlag': staat('algemeen.vlag'),
    'algemeen.vervolg': staat('algemeen.vervolg'),
    'algemeen.materialen': staat('algemeen.materialen'),
    'algemeen.inhoud': staat('algemeen.inhoud'),
    'algemeen.afsluiting': staat('algemeen.afsluiting'),
    'algemeen.monday-challenges': staat('algemeen.monday-challenges'),
    'rol.leadtrainer': staat('rol.leadtrainer'),
    'rol.co-trainer': staat('rol.co-trainer'),
    'rol.met-acteur': staat('rol.met-acteur'),
    'rol.als-acteur': staat('rol.als-acteur'),
    'concept.inleiding': staat('concept.inleiding'),
    'groep.eigen': staat('groep.eigen'),
    'groep.samen': staat('groep.samen'),
    'vaste-klant': staat('vaste-klant'),
    'cyclus.inleiding': staat('cyclus.inleiding'),
    'cyclus.huiswerk': staat('cyclus.huiswerk'),
    'cyclus.voorbereiding': staat('cyclus.voorbereiding'),
    'cyclus.afsluiting': staat('cyclus.afsluiting'),
    'opdracht.huiswerk': staat('opdracht.huiswerk'),
    'opdracht.voorbereidend': staat('opdracht.voorbereidend'),
    'inventarisatie.inleiding': staat('inventarisatie.inleiding'),
    'inventarisatie.leeg': staat('inventarisatie.leeg'),
  };
}

/**
 * `{term}` staat midden in een zin ("een training bij een van onze klanten"), dus in kleine
 * letters. Het Labels-bord schrijft hem met een hoofdletter omdat hij daar ook als kop dient.
 */
function merkEnTerm(label: { readonly merk: string; readonly term: string }): {
  readonly merk: string;
  readonly term: string;
} {
  return { merk: label.merk.trim(), term: label.term.trim().toLocaleLowerCase('nl-NL') };
}

import { describe, expect, it } from 'vitest';

import { parseKop, parseRegels } from '../regels';

describe('parseRegels', () => {
  it('maakt van elke regel een alinea en laat lege regels weg', () => {
    expect(parseRegels('Eerste zin.\n\n\nTweede zin.\n')).toEqual([
      { tekst: 'Eerste zin.', bullet: false, niveau: 0 },
      { tekst: 'Tweede zin.', bullet: false, niveau: 0 },
    ]);
  });

  it('herkent een streepje als opsomming en twee streepjes als subregel', () => {
    expect(parseRegels('- Taak\n-- Uitleg\n-Zonder spatie')).toEqual([
      { tekst: 'Taak', bullet: true, niveau: 0 },
      { tekst: 'Uitleg', bullet: true, niveau: 1 },
      { tekst: 'Zonder spatie', bullet: true, niveau: 0 },
    ]);
  });

  /** Wat er binnenkomt als iemand een lijst uit Word of Google Docs plakt. */
  it('neemt geplakte opsommingstekens over', () => {
    expect(parseRegels('• Een\n* Twee\n– Drie\n\t• Dieper\n   o Ook dieper')).toEqual([
      { tekst: 'Een', bullet: true, niveau: 0 },
      { tekst: 'Twee', bullet: true, niveau: 0 },
      { tekst: 'Drie', bullet: true, niveau: 0 },
      { tekst: 'Dieper', bullet: true, niveau: 1 },
      { tekst: 'Ook dieper', bullet: true, niveau: 1 },
    ]);
  });

  it('ruimt dubbele spaties, harde spaties en tabs op', () => {
    expect(parseRegels('  Veel   ruimte hier\t\ten daar  ')).toEqual([
      { tekst: 'Veel ruimte hier en daar', bullet: false, niveau: 0 },
    ]);
  });

  it('leest Windows-regeleinden', () => {
    expect(parseRegels('Een\r\nTwee')).toHaveLength(2);
  });

  it('laat een regel met alleen een opsommingsteken weg', () => {
    expect(parseRegels('-\n--\n•\nTekst')).toEqual([
      { tekst: 'Tekst', bullet: false, niveau: 0 },
    ]);
  });

  it('geeft niets terug voor een lege tekst', () => {
    expect(parseRegels('  \n \n')).toEqual([]);
  });
});

describe('parseKop', () => {
  it('maakt er één opgeschoonde regel van', () => {
    expect(parseKop('  Onder de\nvlag   van {merk} ')).toBe('Onder de vlag van {merk}');
  });
});

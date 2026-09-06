import { describe, expect, it } from 'vitest';

import { TRAINER_COLUMNS } from '@lib/monday/board-config';

import { readTrainerEmails } from '../trainer-emails';

interface Cel {
  id: string;
  text?: string | null;
  email?: string | null;
}

const reader = (items: Array<{ id: string; column_values: Cel[] }>) => ({
  query: async () => ({ items }),
});

/**
 * `TrainerColumnMap` heeft optionele velden, want niet elk trainersbord kent ze allemaal.
 * Hier controleren in plaats van een uitroepteken: valt de kolom ooit weg, dan zegt de test
 * dát in plaats van stilletjes op `undefined` te matchen.
 */
function kolom(id: string | undefined, naam: string): string {
  if (id === undefined) {
    throw new Error(`TRAINER_COLUMNS mist ${naam}`);
  }
  return id;
}

const EMAIL = kolom(TRAINER_COLUMNS.email, 'email');
const ITG_EMAIL = kolom(TRAINER_COLUMNS.itgEmail, 'itgEmail');

const persoonlijk = (adres: string): Cel => ({ id: EMAIL, email: adres });
const itgAdres = (adres: string): Cel => ({ id: ITG_EMAIL, email: adres });

describe('readTrainerEmails', () => {
  it('vraagt niets op als er geen trainers zijn', async () => {
    let aangeroepen = false;
    const client = {
      query: async () => {
        aangeroepen = true;
        return {};
      },
    };
    expect(await readTrainerEmails(client, [])).toEqual([]);
    expect(aangeroepen).toBe(false);
  });

  it('geeft het persoonlijke adres voorrang op het ITG-adres', async () => {
    const client = reader([
      { id: 't1', column_values: [itgAdres('itg@itg.nl'), persoonlijk('jan@prive.nl')] },
    ]);
    expect(await readTrainerEmails(client, ['t1'])).toEqual(['jan@prive.nl']);
  });

  it('valt terug op het ITG-adres', async () => {
    const client = reader([{ id: 't1', column_values: [itgAdres('itg@itg.nl')] }]);
    expect(await readTrainerEmails(client, ['t1'])).toEqual(['itg@itg.nl']);
  });

  it('slaat een lege cel over in plaats van een lege string te leveren', async () => {
    const client = reader([
      { id: 't1', column_values: [persoonlijk('  '), itgAdres('itg@itg.nl')] },
    ]);
    expect(await readTrainerEmails(client, ['t1'])).toEqual(['itg@itg.nl']);
  });

  /**
   * De leadtrainer staat als eerste in de mail en hoort ook als eerste in de CC-regel. Monday
   * belooft geen volgorde, dus die komt uit `itemIds` en niet uit het antwoord.
   */
  it('houdt de volgorde van de gevraagde trainers aan', async () => {
    const client = reader([
      { id: 't2', column_values: [persoonlijk('piet@prive.nl')] },
      { id: 't1', column_values: [persoonlijk('jan@prive.nl')] },
    ]);
    expect(await readTrainerEmails(client, ['t1', 't2'])).toEqual([
      'jan@prive.nl',
      'piet@prive.nl',
    ]);
  });

  it('slaat een trainer zonder adres over zonder de rest te verliezen', async () => {
    const client = reader([
      { id: 't1', column_values: [] },
      { id: 't2', column_values: [persoonlijk('piet@prive.nl')] },
    ]);
    expect(await readTrainerEmails(client, ['t1', 't2'])).toEqual(['piet@prive.nl']);
  });

  it('weigert meer trainers dan `items(ids:)` stil teruggeeft', async () => {
    const ids = Array.from({ length: 26 }, (_, i) => `t${i}`);
    await expect(readTrainerEmails(reader([]), ids)).rejects.toThrow(/stil hoogstens/);
  });
});

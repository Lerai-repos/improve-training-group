/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

// tsx does not auto-load .env.local.
loadEnv({ path: '.env.local' });

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

const PAT = process.env.AIRTABLE_PAT;
const BASE_ID = process.env.AIRTABLE_BASE_ID ?? 'app7FDRFiMrLYP2jp';

// The 8 fase-1 tables, by Airtable table id (from platform-structures/airtable.md).
const TABLES: Record<string, string> = {
  trainingen: 'tblUgIOpS1hl3sjve',
  trainers: 'tbl2d860wqzpZPRYM',
  themas: 'tblp9MD8P9CJ6HqeT',
  trainer_thema_stats: 'tblyWL2S9ZndEkpKU',
  aanbevelingen: 'tbllrfai1QPaDMa81',
  configuratie: 'tblehCborYNwAWqID',
  klanten: 'tblEN3D6EZNogxshq',
  label_configuratie: 'tblS0cSwU6sffKXZM',
};

const OUT_DIR = join(process.cwd(), 'snapshots', 'airtable');
const RATE_LIMIT_DELAY_MS = 220; // Airtable allows ~5 req/s per base.

const pageSchema = z.object({
  records: z.array(
    z.object({
      id: z.string(),
      createdTime: z.string(),
      fields: z.record(z.unknown()),
    })
  ),
  offset: z.string().optional(),
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchTable(tableId: string): Promise<z.infer<typeof pageSchema>['records']> {
  const records: z.infer<typeof pageSchema>['records'] = [];
  let offset: string | undefined;

  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${tableId}`);
    url.searchParams.set('pageSize', '100');
    if (offset) {
      url.searchParams.set('offset', offset);
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${PAT}` },
    });
    if (!res.ok) {
      throw new Error(`${tableId}: ${res.status} ${await res.text()}`);
    }

    const page = pageSchema.parse(await res.json());
    records.push(...page.records);
    offset = page.offset;
    await sleep(RATE_LIMIT_DELAY_MS);
  } while (offset);

  return records;
}

async function main(): Promise<void> {
  if (!PAT) {
    throw new Error('Missing AIRTABLE_PAT in .env.local');
  }
  mkdirSync(OUT_DIR, { recursive: true });

  for (const [name, tableId] of Object.entries(TABLES)) {
    const records = await fetchTable(tableId);
    const path = join(OUT_DIR, `${name}.json`);
    writeFileSync(path, JSON.stringify(records, null, 2));
    console.log(`${name}: ${records.length} records → snapshots/airtable/${name}.json`);
  }
  console.log('Airtable snapshot complete.');
}

main().catch((error) => {
  console.error('Snapshot failed:', error);
  process.exit(1);
});

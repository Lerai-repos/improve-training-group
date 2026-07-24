/* eslint-disable no-console */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { findAliasCandidates, klantIdentityKey } from '../lib/monday/klant-key';

/**
 * Reproducible Monday↔Airtable mapping audit. Reads the local raw dump
 * (`snapshots/monday/`) and the Airtable snapshot (`snapshots/airtable/`), and
 * writes a SANITIZED aggregate report to committed `docs/m2a/audit-report.md`
 * (counts, comparison rules, anomaly ids, input hashes — no trainer/personal PII;
 * company names are business identifiers, included in the worklist per plan).
 *
 * This replaces the ad-hoc `node -e` analysis so the findings are re-runnable and
 * reviewable, and survive the snapshot purge.
 */

const MONDAY_DIR = join(process.cwd(), 'snapshots', 'monday');
const AIRTABLE_DIR = join(process.cwd(), 'snapshots', 'airtable');
const OUT_DIR = join(process.cwd(), 'docs', 'm2a');
const OUT_FILE = join(OUT_DIR, 'audit-report.md');

// Agenda 2026 column ids (from the live schema).
const COL = {
  bedrijf: 'lookup_mkszzfvr',
  trainerRel: 'board_relation_mkz4y7tb',
  themaRel: 'board_relation_mkz4920y',
  datum: 'datum_1',
  duur: 'nummers_mkmvc0rk',
  omzet: 'nummers',
} as const;
const TRAINER_COL = { adres: 'adres__1', email: 'e_mail__1', itgEmail: 'itg_mail__1' } as const;
const THEMA_COLOURS: Record<string, string> = {
  board_relation_mky0qxcw: 'groen',
  board_relation_mky0ftmb: 'oranje',
  board_relation_mky02vvy: 'rood',
  board_relation_mky0vkax: 'grijs',
};
const TRAINER_COLOURS: Record<string, string> = {
  board_relation_mkz4nf13: 'groen',
  board_relation_mkz4y8xr: 'oranje',
  board_relation_mkz4s1k3: 'rood',
};

interface RawColumn {
  id: string;
  text: string | null;
  display_value?: string | null;
  linked_item_ids?: string[] | null;
}
interface RawItem {
  id: string;
  name: string;
  group: { id: string; title: string } | null;
  column_values: RawColumn[];
}
interface BoardMeta {
  id: string;
  name: string;
  groups: Array<{ id: string; title: string }>;
}

function readDump<T>(dir: string, name: string): T {
  const raw = readFileSync(join(dir, `${name}.json`), 'utf8');
  const parsed: T = JSON.parse(raw);
  return parsed;
}

function sha256(dir: string, name: string): string {
  return createHash('sha256')
    .update(readFileSync(join(dir, `${name}.json`)))
    .digest('hex');
}

const col = (it: RawItem, id: string): RawColumn | undefined =>
  it.column_values.find((c) => c.id === id);
const text = (it: RawItem, id: string): string | null => {
  const t = col(it, id)?.text;
  return t !== null && t !== undefined && t !== '' ? t : null;
};
const mirror = (it: RawItem, id: string): string | null => {
  const v = col(it, id)?.display_value;
  return v !== null && v !== undefined && v !== '' ? v : null;
};
/** Klant name resolution: Bedrijf mirror, falling back to the item name (18 cases). */
const klantName = (it: RawItem): string => mirror(it, COL.bedrijf) ?? it.name;
const links = (it: RawItem, id: string): string[] => col(it, id)?.linked_item_ids ?? [];

function auditAgenda(items: RawItem[]): string[] {
  const lines: string[] = ['## Agenda 2026 (trainings)', '', `- rows: **${items.length}**`];
  let noBedrijf = 0;
  let eq = 0;
  let ne = 0;
  let noTrainer = 0;
  let multiTrainer = 0;
  let noThema = 0;
  let noDatum = 0;
  let noDuur = 0;
  let badDuur = 0;
  let noOmzet = 0;
  let badOmzet = 0;
  const noBedrijfRows: string[] = [];

  for (const it of items) {
    const name = klantIdentityKey(it.name);
    const bedrijf = klantIdentityKey(mirror(it, COL.bedrijf));
    if (!bedrijf) {
      noBedrijf += 1;
      noBedrijfRows.push(`  - \`${it.id}\` — item name: "${it.name}"`);
    } else if (name === bedrijf) {
      eq += 1;
    } else {
      ne += 1;
    }
    const trs = links(it, COL.trainerRel);
    if (trs.length === 0) noTrainer += 1;
    if (trs.length > 1) multiTrainer += 1;
    if (links(it, COL.themaRel).length === 0) noThema += 1;
    if (!text(it, COL.datum)) noDatum += 1;
    const duur = text(it, COL.duur);
    if (!duur) noDuur += 1;
    else if (Number.isNaN(Number(duur))) badDuur += 1;
    const omzet = text(it, COL.omzet);
    if (!omzet) noOmzet += 1;
    else if (Number.isNaN(Number(omzet))) badOmzet += 1;
  }

  lines.push(
    `- klant (item-name vs Bedrijf mirror): equal **${eq}**, differ **${ne}**, no-Bedrijf **${noBedrijf}**`,
    `- relations: no-trainer **${noTrainer}**, multi-trainer **${multiTrainer}**, no-thema **${noThema}**`,
    `- fields: no-datum **${noDatum}**, no-duur **${noDuur}** (malformed ${badDuur}), no-omzet **${noOmzet}** (malformed ${badOmzet})`,
    ''
  );

  // Klant alias candidates (fingerprint collisions across Bedrijf + item-name fallback).
  const candidates = findAliasCandidates(items.map(klantName));
  lines.push(`### Klant alias candidates (fatal until decided): **${candidates.length}**`, '');
  for (const c of candidates.slice(0, 40)) {
    lines.push(`- \`${c.fingerprint}\` → ${c.keys.map((k) => `"${k}"`).join(' | ')}`);
  }
  if (candidates.length > 40) lines.push(`- …and ${candidates.length - 40} more`);
  lines.push('');

  lines.push(`### No-Bedrijf items needing an acknowledged klant mapping: **${noBedrijf}**`, '');
  lines.push(...noBedrijfRows);
  lines.push('');
  return lines;
}

function auditTrainers(items: RawItem[], meta: BoardMeta | undefined): string[] {
  const titleById = new Map((meta?.groups ?? []).map((g) => [g.id, g.title]));
  const byGroup = new Map<string, number>();
  let noAddr = 0;
  let noEmail = 0;
  for (const t of items) {
    const g = t.group?.id ?? '?';
    byGroup.set(g, (byGroup.get(g) ?? 0) + 1);
    if (!text(t, TRAINER_COL.adres)) noAddr += 1;
    if (!text(t, TRAINER_COL.email) && !text(t, TRAINER_COL.itgEmail)) noEmail += 1;
  }
  const lines = [
    '## Trainers',
    '',
    `- rows: **${items.length}**`,
    `- no-address **${noAddr}**, no-email **${noEmail}**`,
    '',
    '### Groups (drives rate/eligibility policy)',
    '',
  ];
  for (const [g, c] of [...byGroup.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`- **${c}** — \`${g}\` :: ${titleById.get(g) ?? '?'}`);
  }
  lines.push('');
  return lines;
}

function auditQualifications(trainers: RawItem[], themas: RawItem[]): string[] {
  const byColour: Record<string, number> = { groen: 0, oranje: 0, rood: 0, grijs: 0 };
  const colourSet = new Map<string, Set<string>>();
  for (const th of themas) {
    for (const [cid, colour] of Object.entries(THEMA_COLOURS)) {
      for (const trId of links(th, cid)) {
        byColour[colour] += 1;
        const key = `${trId}::${th.id}`;
        const set = colourSet.get(key) ?? new Set<string>();
        set.add(colour);
        colourSet.set(key, set);
      }
    }
  }
  const trainerPairs = new Set<string>();
  for (const t of trainers) {
    for (const [cid] of Object.entries(TRAINER_COLOURS)) {
      for (const thId of links(t, cid)) trainerPairs.add(`${t.id}::${thId}`);
    }
  }
  // Non-grijs membership from the COMPLETE colour set — a green+grijs pair is
  // non-grijs (grijs must not overwrite it and cause a false discrepancy).
  const themaNonGrijs = new Set(
    [...colourSet.entries()].filter(([, s]) => [...s].some((c) => c !== 'grijs')).map(([k]) => k)
  );
  const conflictPairs = [...colourSet.entries()].filter(([, s]) => s.size > 1);

  // Real SET diff (not just equal counts): a pair present on one board but not the
  // other is a genuine discrepancy even when the totals happen to match.
  const onlyThema = [...themaNonGrijs].filter((k) => !trainerPairs.has(k));
  const onlyTrainer = [...trainerPairs].filter((k) => !themaNonGrijs.has(k));

  return [
    '## Qualifications',
    '',
    `- Themas board pairs by colour: groen ${byColour.groen}, oranje ${byColour.oranje}, rood ${byColour.rood}, grijs ${byColour.grijs}`,
    `- Non-grijs pairs — Themas board **${themaNonGrijs.size}** vs Trainers board **${trainerPairs.size}**; ` +
      `only-Themas **${onlyThema.length}**, only-Trainers **${onlyTrainer.length}** (0/0 = true agreement)`,
    ...(onlyThema.length > 0 ? [`  - only-Themas: ${onlyThema.slice(0, 20).join(', ')}`] : []),
    ...(onlyTrainer.length > 0
      ? [`  - only-Trainers: ${onlyTrainer.slice(0, 20).join(', ')}`]
      : []),
    `- **Colour conflicts (fatal until allowlisted): ${conflictPairs.length}**`,
    '',
    ...conflictPairs.map(([k, s]) => `  - \`${k}\` → ${[...s].join(', ')}`),
    '',
  ];
}

interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

function pulseIdOf(r: AirtableRecord): string {
  const p = r.fields['Monday Pulse ID'];
  return typeof p === 'number' ? String(p) : typeof p === 'string' ? p : '';
}

/** Set of Monday Pulse IDs (the join key) from an Airtable table. */
function pulseIds(records: AirtableRecord[]): Set<string> {
  const out = new Set<string>();
  for (const r of records) {
    const id = pulseIdOf(r);
    if (id) {
      out.add(id);
    }
  }
  return out;
}

/** Monday Pulse IDs appearing on >1 Airtable record (join ambiguity — reported, not silently collapsed). */
function duplicatePulseIds(records: AirtableRecord[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const r of records) {
    const id = pulseIdOf(r);
    if (!id) {
      continue;
    }
    if (seen.has(id)) {
      dupes.add(id);
    }
    seen.add(id);
  }
  return [...dupes];
}

/** Compare Monday item ids to Airtable Monday-Pulse-IDs; report the set diff. */
function crossDiff(label: string, monday: Set<string>, airtable: Set<string>): string[] {
  const onlyMonday = [...monday].filter((id) => !airtable.has(id));
  const onlyAirtable = [...airtable].filter((id) => !monday.has(id));
  const matched = [...monday].filter((id) => airtable.has(id)).length;
  const lines = [
    `- **${label}**: Monday ${monday.size}, Airtable ${airtable.size}, matched ${matched}, ` +
      `only-Monday ${onlyMonday.length}, only-Airtable ${onlyAirtable.length}`,
  ];
  if (onlyMonday.length > 0) {
    lines.push(
      `  - only-Monday ids: ${onlyMonday.slice(0, 25).join(', ')}${onlyMonday.length > 25 ? ' …' : ''}`
    );
  }
  if (onlyAirtable.length > 0) {
    lines.push(
      `  - only-Airtable ids: ${onlyAirtable.slice(0, 25).join(', ')}${onlyAirtable.length > 25 ? ' …' : ''}`
    );
  }
  return lines;
}

const numStr = (v: unknown): string => {
  // Blank/null/undefined must be '' — Number(null) and Number('') are 0, which
  // would wrongly report a missing duration/revenue as "0".
  if (v === null || v === undefined || v === '') {
    return '';
  }
  const n = Number(typeof v === 'string' ? v.replace(',', '.') : v);
  return Number.isNaN(n) ? '' : String(n);
};
const atStr = (v: unknown): string => {
  if (Array.isArray(v)) {
    return atStr(v[0]);
  }
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
};

// The optional 4th element marks a PERSONAL field: its mismatch samples show only
// the record id (never the raw name/email/address/phone value) — no PII in the report.
type FieldSpec = [string, (m: RawItem) => string, (f: Record<string, unknown>) => string, boolean?];

function byPulseId(records: AirtableRecord[]): Map<string, AirtableRecord> {
  const map = new Map<string, AirtableRecord>();
  for (const r of records) {
    const id = pulseIdOf(r);
    if (id) {
      map.set(id, r);
    }
  }
  return map;
}

/** Field-level comparison of MATCHED records (set overlap is not agreement). */
function compareFields(
  label: string,
  mondayItems: RawItem[],
  atById: Map<string, AirtableRecord>,
  fields: FieldSpec[]
): string[] {
  const stats = new Map<
    string,
    { both: number; agree: number; differ: number; samples: string[] }
  >();
  for (const [name] of fields) {
    stats.set(name, { both: 0, agree: 0, differ: 0, samples: [] });
  }
  for (const m of mondayItems) {
    const r = atById.get(m.id);
    if (!r) {
      continue;
    }
    for (const [name, mf, af, personal] of fields) {
      const mv = mf(m);
      const av = af(r.fields);
      if (mv === '' && av === '') {
        continue;
      }
      const s = stats.get(name);
      if (!s) {
        continue;
      }
      s.both += 1;
      if (mv === av) {
        s.agree += 1;
      } else {
        s.differ += 1;
        if (s.samples.length < 5) {
          // Personal fields: record id only (no PII values in the committed report).
          s.samples.push(personal ? m.id : `${m.id}: M="${mv}" A="${av}"`);
        }
      }
    }
  }
  const lines = ['', `### Field-level comparison — ${label} (Monday vs Airtable snapshot)`, ''];
  for (const [name] of fields) {
    const s = stats.get(name);
    if (!s) {
      continue;
    }
    lines.push(`- **${name}**: compared ${s.both}, agree ${s.agree}, differ ${s.differ}`);
    if (s.differ > 0) {
      lines.push(`  - e.g. ${s.samples.join(' | ')}`);
    }
  }
  return lines;
}

const TRAINING_FIELDS: FieldSpec[] = [
  ['datum', (m) => text(m, COL.datum) ?? '', (f) => atStr(f['Datum'])],
  ['duur', (m) => numStr(text(m, COL.duur)), (f) => numStr(f['Duur training'])],
  ['omzet', (m) => numStr(text(m, COL.omzet)), (f) => numStr(f['Omzet'])],
  ['taal', (m) => text(m, 'dup__of_trainers') ?? '', (f) => atStr(f['Taal'])],
  ['tijd', (m) => text(m, 'dup__of_workshop') ?? '', (f) => atStr(f['Tijd'])],
  ['locatie', (m) => text(m, 'tekst7') ?? '', (f) => atStr(f['Locatie'])],
  ['bedrijf', (m) => (mirror(m, COL.bedrijf) ?? '').trim(), (f) => atStr(f['Bedrijfsnaam'])],
];
const TRAINER_FIELDS: FieldSpec[] = [
  ['naam', (m) => m.name.trim(), (f) => atStr(f['Naam']), true],
  ['adres', (m) => text(m, 'adres__1') ?? '', (f) => atStr(f['Adres']), true],
  [
    'email',
    (m) => (text(m, 'e_mail__1') ?? text(m, 'itg_mail__1') ?? '').toLowerCase(),
    (f) => atStr(f['Email']).toLowerCase(),
    true,
  ],
  ['telefoon', (m) => text(m, 'telefoon_mkn1hbyh') ?? '', (f) => atStr(f['Telefoonnummer']), true],
];
const THEMA_FIELDS: FieldSpec[] = [['thema', (m) => m.name.trim(), (f) => atStr(f['Thema'])]];

function airtableCrossDiff(agenda: RawItem[], trainers: RawItem[], themas: RawItem[]): string[] {
  if (!existsSync(join(AIRTABLE_DIR, 'trainingen.json'))) {
    return ['## Monday↔Airtable cross-diff', '', 'Airtable snapshot absent — skipped.', ''];
  }
  const atTrainingen = readDump<AirtableRecord[]>(AIRTABLE_DIR, 'trainingen').filter(
    (r) => r.fields['Board ID'] === '5087396949' || String(r.fields['Year']) === '2026'
  );
  const atTrainers = readDump<AirtableRecord[]>(AIRTABLE_DIR, 'trainers');
  const atThemas = readDump<AirtableRecord[]>(AIRTABLE_DIR, 'themas');

  // Duplicate join ids would make the map/set silently pick an arbitrary record — report them.
  const dupLines: string[] = [];
  for (const [label, recs] of [
    ['trainingen', atTrainingen],
    ['trainers', atTrainers],
    ['themas', atThemas],
  ] as const) {
    const dupes = duplicatePulseIds(recs);
    if (dupes.length > 0) {
      dupLines.push(
        `- **${label}**: ${dupes.length} duplicate Monday Pulse ID(s): ${dupes.slice(0, 20).join(', ')}`
      );
    }
  }

  return [
    '## Monday↔Airtable cross-diff (join on Monday Pulse ID)',
    '',
    'Airtable inputs (sha256):',
    `- \`trainingen.json\` \`${sha256(AIRTABLE_DIR, 'trainingen')}\``,
    `- \`trainers.json\` \`${sha256(AIRTABLE_DIR, 'trainers')}\``,
    `- \`themas.json\` \`${sha256(AIRTABLE_DIR, 'themas')}\``,
    '',
    ...(dupLines.length > 0
      ? [
          '**Duplicate join ids (ambiguous — resolve before trusting field diffs):**',
          ...dupLines,
          '',
        ]
      : ['Duplicate join ids: none.', '']),
    '> The Airtable snapshot is fase-1 processed output (possibly stale vs the live board) —',
    '> field diffs are expected drift, reported for review, not a pass/fail gate.',
    '',
    ...crossDiff('trainings (2026)', new Set(agenda.map((i) => i.id)), pulseIds(atTrainingen)),
    ...crossDiff('trainers', new Set(trainers.map((i) => i.id)), pulseIds(atTrainers)),
    ...crossDiff('themas', new Set(themas.map((i) => i.id)), pulseIds(atThemas)),
    ...compareFields('trainings', agenda, byPulseId(atTrainingen), TRAINING_FIELDS),
    ...compareFields('trainers', trainers, byPulseId(atTrainers), TRAINER_FIELDS),
    ...compareFields('themas', themas, byPulseId(atThemas), THEMA_FIELDS),
    '',
    '### Not compared (deliberate omissions)',
    '',
    '- training→trainer/thema relation membership: Airtable trainingen carries no Monday trainer',
    '  link and its Thema links use Airtable record ids (not Monday ids), so per-pair membership',
    '  is not comparable here — it IS validated at sync time (unresolved refs are fatal).',
    '- ie_code / label / status: derived or not present in the Airtable snapshot.',
    '- evaluation snapshots (avg_*): owned by M3 (Google Sheets), out of M2a scope.',
    '',
  ];
}

/** Reject a partial/stale snapshot: meta.json's file-hash manifest must match on disk. */
function verifySnapshotManifest(): void {
  if (!existsSync(join(MONDAY_DIR, 'meta.json'))) {
    throw new Error(
      'snapshot meta.json missing — run `pnpm snapshot:monday` (incomplete snapshot).'
    );
  }
  const meta = readDump<{ files?: Record<string, string> }>(MONDAY_DIR, 'meta');
  if (!meta.files || Object.keys(meta.files).length === 0) {
    throw new Error('snapshot meta.json has no file manifest — re-run `pnpm snapshot:monday`.');
  }
  for (const [name, expected] of Object.entries(meta.files)) {
    if (sha256(MONDAY_DIR, name) !== expected) {
      throw new Error(
        `snapshot ${name}.json hash mismatch (partial/stale) — re-run \`pnpm snapshot:monday\`.`
      );
    }
  }
}

function main(): void {
  if (!existsSync(join(MONDAY_DIR, 'agenda-2026.json'))) {
    throw new Error('No Monday snapshot found — run `pnpm snapshot:monday` first.');
  }
  verifySnapshotManifest();
  const agenda = readDump<RawItem[]>(MONDAY_DIR, 'agenda-2026');
  const trainers = readDump<RawItem[]>(MONDAY_DIR, 'trainers');
  const themas = readDump<RawItem[]>(MONDAY_DIR, 'themas');
  const schema = readDump<BoardMeta[]>(MONDAY_DIR, 'schema');
  const trainerMeta = schema.find((b) => b.id === '1661151090');

  const hashes = ['agenda-2026', 'trainers', 'themas', 'schema'].map(
    (n) => `- \`${n}.json\`: sha256 \`${sha256(MONDAY_DIR, n)}\``
  );

  const report = [
    '# M2a — Monday mapping audit (sanitized)',
    '',
    '> Reproducible via `pnpm audit:mapping`. Aggregate counts + anomaly ids + input hashes.',
    '> Raw PII dumps stay under gitignored `snapshots/`; this report is committed evidence.',
    '',
    '## Comparison rules',
    '',
    '- Klant identity key: NFC + trim + collapse whitespace (no `(copy)`/case merge).',
    '- Alias fingerprint (diagnostic only): + lowercase + strip trailing `(copy)`.',
    '- Empty relation = OK; unresolved ref = fatal. Numeric non-parse = fatal.',
    '- Qualification source = Themas board (4 colours); Trainers board = cross-check.',
    '',
    '## Input hashes',
    '',
    ...hashes,
    '',
    ...airtableCrossDiff(agenda, trainers, themas),
    ...auditAgenda(agenda),
    ...auditTrainers(trainers, trainerMeta),
    ...auditQualifications(trainers, themas),
  ].join('\n');

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, `${report}\n`);
  console.log(`Audit report → docs/m2a/audit-report.md`);
}

main();

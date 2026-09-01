/**
 * Kopieer Chromium's brotli-pakketjes naar een echte map in het project.
 *
 * WAAROM DIT BESTAAT. pnpm zet `node_modules/@sparticuz/chromium` neer als symlink naar
 * de store. Laat je Next die 70 MB tráceren via dat pad, dan bouwt hij wel maar weigert
 * Vercel het resultaat: *"The framework produced an invalid deployment package for a
 * Serverless Function. Typically this means that the framework produces files in
 * symlinked directories."* De build slaagt, de deploy niet — een half uur zoeken waard.
 *
 * Dus: één kopie van echte bestanden op een gewoon pad, dat pad tracen, en
 * `executablePath()` daarheen wijzen. Het pakket ondersteunt dat expliciet ("A custom
 * location is needed for workflows that using custom packaging").
 *
 * Draait als `prebuild`, dus vóór elke `next build` en zonder dat iemand eraan hoeft te
 * denken.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Los het pakket op via require, niet via een hardgecodeerd pad in `.pnpm`.
 *
 * Via de hoofdingang en dan omhoog: `./package.json` staat niet in de `exports` van dit
 * pakket, dus dat pad laat zich niet resolven.
 */
const entry = require.resolve('@sparticuz/chromium'); // .../<pkg>/build/index.js
const source = join(dirname(entry), '..', 'bin');
if (!existsSync(source)) {
  throw new Error(`Chromium-binaries niet gevonden op ${source}`);
}
const target = join(process.cwd(), '.chromium-bin');

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
// `dereference` is het hele punt: er mag geen symlink in de uitvoer overblijven.
await cp(source, target, { recursive: true, dereference: true });

const files = await readdir(target);
let bytes = 0;
for (const file of files) {
  bytes += (await stat(join(target, file))).size;
}
// eslint-disable-next-line no-console
console.log(
  `chromium-bin: ${files.length} bestanden, ${(bytes / 1e6).toFixed(1)} MB → ${target}`
);

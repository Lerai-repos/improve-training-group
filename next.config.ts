import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        hostname: 'avatar.vercel.sh',
      },
    ],
  },
  /**
   * De briefingsjablonen en -afbeeldingen zijn gewone bestanden die pas tijdens het draaien
   * worden gelezen. Next volgt alleen imports, ziet ze dus niet, en laat ze buiten de
   * serverless-bundel — waarna de route in productie faalt op een ENOENT terwijl lokaal
   * alles werkt. Dit zet ze erbij, met hun pad vanaf de projectwortel.
   */
  outputFileTracingIncludes: {
    '/api/briefing/[itemId]/generate': ['./lib/briefing/templates/**', './lib/briefing/assets/**'],
    /**
     * Chromium zit niet in de imports.
     *
     * `@sparticuz/chromium` levert de browser als brotli-pakketjes en pakt ze tijdens het
     * draaien uit naar `/tmp`. Next volgt alleen imports, ziet die bestanden dus niet, en
     * laat ze buiten de bundel — waarna de route in productie faalt op een ontbrekend
     * binair bestand terwijl lokaal alles werkt. Zelfde val als bij de briefingsjablonen
     * hierboven, alleen 70 MB groter.
     *
     * En niet vanuit `node_modules`: pnpm zet dat pakket neer als **symlink** naar de
     * store, en tracen daardoorheen levert een pakket op dat wél bouwt maar dat Vercel
     * weigert uit te rollen ("files in symlinked directories"). `prebuild` zet daarom
     * echte kopieën in `.chromium-bin/`, en dat pad wordt getraceerd.
     */
    '/api/report/[itemId]': ['./.chromium-bin/**'],
  },
};

export default nextConfig;

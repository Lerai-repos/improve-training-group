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
     * `@sparticuz/chromium` levert de browser als brotli-pakketjes in zijn `bin/`-map en
     * pakt ze tijdens het draaien uit naar `/tmp`. Next volgt alleen imports, ziet die
     * bestanden dus niet, en laat ze buiten de bundel — waarna de route in productie
     * faalt op een ontbrekend binair bestand terwijl lokaal alles werkt. Zelfde val als
     * bij de briefingsjablonen hierboven, alleen 70 MB groter.
     */
    '/api/report/spike': ['./node_modules/@sparticuz/chromium/bin/**'],
  },
};

export default nextConfig;

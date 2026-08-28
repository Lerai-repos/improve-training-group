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
  },
};

export default nextConfig;

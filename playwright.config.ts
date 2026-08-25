import { defineConfig, devices } from '@playwright/test';

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
import { config } from 'dotenv';

config({
  path: '.env.local',
});

/**
 * Its own port, deliberately not 3000: the dev server normally runs there in tmux, and
 * reusing it would test whatever environment that process happens to have — including
 * the real `MONDAY_APP_CLIENT_SECRET` once it exists, which no test can sign against.
 */
const PORT = process.env.PORT || 3111;

/**
 * Set webServer.url and use.baseURL with the location
 * of the WebServer respecting the correct set port
 */
const baseURL = `http://localhost:${PORT}`;

/**
 * Session-token configuration the route tests can actually sign for.
 *
 * These are TEST credentials injected into the server this config starts — never
 * anything real. `tests/routes/recommendations.test.ts` signs its own tokens with the
 * same secret, which is the only way to exercise the authorization matrix over HTTP
 * before the Monday app exists.
 */
/**
 * The bearer the cron routes expect. Pinned here for the same reason as the caps map: a
 * developer's real `CRON_SECRET` in `.env.local` would otherwise decide whether the
 * unauthorized cases pass, and "refuses the wrong secret" would be testing their machine.
 */
export const TEST_CRON_SECRET = 'playwright-cron-secret-not-a-real-one';

export const TEST_AUTH = {
  clientSecret: 'playwright-session-secret-not-a-real-one',
  accountId: '12345678',
  viewerId: '111',
  plannerId: '222',
  financeId: '333',
  strangerId: '999',
};

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './tests/test-results',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 2 : 8,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL,

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'retain-on-failure',
  },

  /* Configure global timeout for each test */
  timeout: 240 * 1000, // 120 seconds
  expect: {
    timeout: 240 * 1000,
  },

  /* Configure projects */
  projects: [
    {
      name: 'e2e',
      testMatch: /e2e\/.*.test.ts/,
      use: {
        ...devices['Desktop Chrome'],
      },
    },
    {
      name: 'routes',
      testMatch: /routes\/.*.test.ts/,
      use: {
        ...devices['Desktop Chrome'],
      },
    },

    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },

    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /**
   * Start the app for the tests.
   *
   * Three deliberate changes from the scaffold's default, each of which was silently
   * stopping route tests from running at all:
   *
   * - `dev:local`, not `dev`. The latter wraps the server in `doppler run`, which fails
   *   outright without a Doppler login and cannot be given the env below.
   * - `/api/ping`, not `/ping`. Nothing ever served the latter, and the app has no root
   *   page either, so the readiness probe 404'd until it timed out and the route tests
   *   never ran at all.
   * - never reused. A fresh process is the only way to be sure of the auth environment
   *   here; reusing a developer's tmux server would make the result depend on their
   *   `.env.local` — including the real client secret once it exists, which no test can
   *   sign against.
   *
   * Redis and Monday credentials still come from `.env.local`, loaded at the top. The
   * route tests only read Redis for a synthetic item id and only ask Monday whether that
   * id exists (it does not), so nothing is written to either.
   */
  webServer: {
    command: 'pnpm dev:local',
    url: `${baseURL}/api/ping`,
    timeout: 120 * 1000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      // The recalculate route builds a QStash publisher, which needs a callback base
      // URL. No test gets far enough to publish — the board check refuses first — but
      // the dependency has to be satisfiable for the route to run at all.
      PUBLIC_BASE_URL: baseURL,
      /**
       * A dummy, because `createQStashClient()` throws without one — and the recalculate
       * route builds the publisher BEFORE the board check refuses it. The suite passed
       * only because `.env.local` happened to supply a real token, which is the same
       * ambient-environment trap that let the capability default leak in.
       *
       * Nothing is ever published: every mutating test stops at `MONDAY_AGENDA_BOARD_ID=0`.
       */
      QSTASH_TOKEN: 'route-tests-never-publish',
      /**
       * A board id nothing can be on, so the mutating routes are refused STRUCTURALLY
       * rather than because the synthetic item id happens not to exist.
       *
       * Without it, the suite's safety rests on `9900000001` never becoming a real
       * Agenda item — and if it ever did, a passing test would start queueing real work
       * against real Monday data. `0` cannot match any board, so that outcome is
       * unreachable no matter what the item id turns out to be.
       */
      MONDAY_AGENDA_BOARD_ID: '0',
      MONDAY_APP_CLIENT_SECRET: TEST_AUTH.clientSecret,
      MONDAY_ACCOUNT_ID: TEST_AUTH.accountId,
      CRON_SECRET: TEST_CRON_SECRET,
      /**
       * Pinned EMPTY, and this is load-bearing rather than tidy.
       *
       * Next loads `.env.local` itself, so anything set there arrives in the server
       * regardless of what this block says — and a developer running the real
       * `MONDAY_RECOMMENDATION_DEFAULT_CAPS=view,plan,full` locally would hand every test
       * user every capability. The authorization suite would then pass by accident while
       * asserting nothing, which is worse than failing. Values set here win, so the
       * default is explicitly nothing.
       */
      MONDAY_RECOMMENDATION_DEFAULT_CAPS: '',
      // A map rather than production's account-wide default, so the route tests can
      // exercise the full matrix — including a user who is refused everything, which an
      // open default makes untestable.
      MONDAY_RECOMMENDATION_CAPS: [
        `${TEST_AUTH.viewerId}:view`,
        `${TEST_AUTH.plannerId}:view,plan`,
        `${TEST_AUTH.financeId}:view,full`,
      ].join(';'),
    },
  },
});

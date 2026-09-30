import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';

import type { MondayGraphQLClient } from '@lib/monday/graphql-client';
import type { MondayMutationClient } from '@lib/monday/mutate';

/** De Monday-clients voor de webhook en het inrichtingsscript. */
export function buildTekstenClients(): {
  readonly read: MondayGraphQLClient;
  readonly write: MondayMutationClient;
} {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('MONDAY_API_TOKEN is not configured');
  }
  return {
    read: createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION }),
    write: createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION }),
  };
}

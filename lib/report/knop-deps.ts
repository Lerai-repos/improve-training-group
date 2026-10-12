import { amsterdamToday } from '@lib/evaluations';
import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayMutationClient } from '@lib/monday/mutate';
import { createRedisClient, createUpstashKvStore } from '@lib/recommend/kv';

import { buildDailyReportDeps } from './deps';
import { createKnopProbleemStore } from './knop-store';
import { EVAL_STATUS_COLUMN, EVAL_STATUS_INDEX, EVAL_STATUS_ZIE_SYSTEEMBORD } from './knop';

import type { EvalKnopDeps, EvalStatusWaarde } from './knop';

/** De waarde voor `change_column_value`, per toestand van `Eval Status`. */
export function statusWaarde(waarde: EvalStatusWaarde): Record<string, unknown> {
  switch (waarde) {
    case 'leeg':
      return {};
    case 'geen-ie-code':
      return { index: EVAL_STATUS_INDEX.geenIeCode };
    case 'zie-systeembord':
      return { label: EVAL_STATUS_ZIE_SYSTEEMBORD };
  }
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

/** Een update-body is HTML: tekst ontsnappen en regels als `<br>`. */
export function updateHtml(tekst: string): string {
  return tekst.replace(/[&<>"]/g, (teken) => ESCAPES[teken] ?? teken).replace(/\n/g, '<br>');
}

/**
 * De echte aansluitingen voor de knop: alles van de dagjob, mét mail, plus de drie dingen die
 * alleen de knop doet — `Eval Status` zetten, een update plaatsen en een probleem achterlaten.
 */
export function buildEvalKnopDeps(deadlineMs?: () => number | null): EvalKnopDeps {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('MONDAY_API_TOKEN is not configured');
  }
  const vandaag = (): string => amsterdamToday(new Date());
  const { deps } = buildDailyReportDeps({ date: vandaag(), deadlineMs, mail: true });
  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION, deadlineMs });

  return {
    ...deps,
    setEvalStatus: async (itemId, boardId, waarde) => {
      await write.mutate(
        `mutation ($board: ID!, $item: ID!, $column: String!, $value: JSON!) {
           change_column_value(board_id: $board, item_id: $item, column_id: $column,
                               value: $value, create_labels_if_missing: true) { id }
         }`,
        {
          board: boardId,
          item: itemId,
          column: EVAL_STATUS_COLUMN,
          value: JSON.stringify(statusWaarde(waarde)),
        }
      );
    },
    postUpdate: async (itemId, tekst) => {
      await write.mutate(
        `mutation ($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }`,
        { item: itemId, body: updateHtml(tekst) }
      );
    },
    problemen: createKnopProbleemStore(createUpstashKvStore(createRedisClient())),
    vandaag,
    nowMs: () => Date.now(),
  };
}

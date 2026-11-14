import { REPORT_REASONS, type ReportReason } from '@cojiro/shared';
import { z } from 'zod';

export const AUTO_HIDE_DISTINCT_REPORTERS = 3;

export const ReportInput = z.object({
  questionId: z.number().int().positive(),
  reason: z.enum(REPORT_REASONS),
  note: z.string().trim().max(500).nullish(),
});
export type ReportInput = z.infer<typeof ReportInput>;

/**
 * What a new report does to its question. `unresolvedReporterHashes` are the
 * ip hashes of all unresolved reports for the question, including the new one.
 * Returns only the flags to switch ON; a report never un-hides or un-disputes.
 */
export function reportEffects(
  reason: ReportReason,
  unresolvedReporterHashes: Iterable<string>,
): { hide: boolean; dispute: boolean } {
  const distinct = new Set(unresolvedReporterHashes).size;
  return { hide: distinct >= AUTO_HIDE_DISTINCT_REPORTERS, dispute: reason === 'wrong_answer' };
}

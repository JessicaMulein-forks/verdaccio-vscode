import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

vi.mock('vscode', () => ({}));

import { shouldDisplayLogEntry, logLevelRank } from '../logManager';

/**
 * Validates: Requirements 5.4
 *
 * Property 5: Log level filtering
 * For any log entry with a given severity level and any configured log level threshold,
 * the entry should be displayed if and only if its severity is at or above the configured
 * threshold (using the ordering: trace < debug < info < warn < error < fatal).
 */

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

const logLevelArb = fc.constantFrom(...LOG_LEVELS);

describe('Property 5: Log level filtering', () => {
  it('shouldDisplayLogEntry returns true iff logLevelRank(severity) >= logLevelRank(threshold)', () => {
    fc.assert(
      fc.property(
        logLevelArb,
        logLevelArb,
        (severity, threshold) => {
          const result = shouldDisplayLogEntry(severity, threshold);
          const expected = logLevelRank(severity) >= logLevelRank(threshold);

          expect(result).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});

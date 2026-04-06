import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

/**
 * Validates: Requirements 3.3
 *
 * Property 2: Uptime formatting correctness
 * For any start time and current time where current time >= start time,
 * the formatted uptime string should represent a non-negative duration
 * and correctly reflect the difference between the two times in hours,
 * minutes, and seconds.
 */

vi.mock('vscode', () => ({
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class {
    fire = vi.fn();
    dispose = vi.fn();
    event = vi.fn();
  },
}));

import { formatUptime } from '../statusViewProvider';

describe('Property 2: Uptime formatting correctness', () => {
  it('formatted uptime correctly reflects the time difference in hours, minutes, and seconds', () => {
    fc.assert(
      fc.property(
        // Generate a start time within a reasonable range
        fc.date({ min: new Date('2000-01-01'), max: new Date('2030-01-01') }),
        // Generate a non-negative offset in milliseconds (up to ~365 days)
        fc.nat({ max: 365 * 24 * 3600 * 1000 }),
        (startTime, offsetMs) => {
          const now = new Date(startTime.getTime() + offsetMs);

          const result = formatUptime(startTime, now);

          // Parse the result string "Xh Ym Zs"
          const match = result.match(/^(\d+)h (\d+)m (\d+)s$/);
          expect(match).not.toBeNull();

          const hours = parseInt(match![1], 10);
          const minutes = parseInt(match![2], 10);
          const seconds = parseInt(match![3], 10);

          // All components must be non-negative
          expect(hours).toBeGreaterThanOrEqual(0);
          expect(minutes).toBeGreaterThanOrEqual(0);
          expect(seconds).toBeGreaterThanOrEqual(0);

          // Minutes and seconds must be within valid range
          expect(minutes).toBeLessThan(60);
          expect(seconds).toBeLessThan(60);

          // Total seconds from parsed values must equal the actual difference
          const expectedTotalSeconds = Math.floor(offsetMs / 1000);
          const parsedTotalSeconds = hours * 3600 + minutes * 60 + seconds;
          expect(parsedTotalSeconds).toBe(expectedTotalSeconds);
        },
      ),
      { numRuns: 100 },
    );
  });
});

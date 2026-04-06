import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

/**
 * Validates: Requirements 4.7
 *
 * Property 4: Storage size aggregation
 * For any list of packages with known tarball sizes, the total storage size
 * displayed by the Cache View should equal the sum of all individual tarball sizes.
 */

vi.mock('vscode', () => ({
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class {
    fire = vi.fn();
    dispose = vi.fn();
    event = vi.fn();
  },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  RelativePattern: class {
    constructor(public base: string, public pattern: string) {}
  },
  workspace: {
    createFileSystemWatcher: () => ({
      onDidCreate: vi.fn(),
      onDidDelete: vi.fn(),
      dispose: vi.fn(),
    }),
  },
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
}));

import { computeTotalStorageSize } from '../cacheViewProvider';

// Arbitrary for an entry with a non-negative integer tarballSize
const tarballEntryArb = fc.record({
  tarballSize: fc.nat({ max: 1_000_000_000 }),
});

describe('Property 4: Storage size aggregation', () => {
  it('computed total equals the sum of all individual tarball sizes', () => {
    fc.assert(
      fc.property(
        fc.array(tarballEntryArb, { minLength: 0, maxLength: 100 }),
        (entries) => {
          const result = computeTotalStorageSize(entries);
          const expected = entries.reduce((sum, e) => sum + e.tarballSize, 0);
          expect(result).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});

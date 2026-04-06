import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

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
  workspace: { getConfiguration: vi.fn() },
  window: {},
}));

import {
  shouldTriggerStorageWarning,
  selectVersionsToKeep,
  isStalePackage,
  computeStorageAnalytics,
  PackageAnalyticsInput,
} from '../storageAnalyticsProvider';

/**
 * Property 13: Storage threshold warning trigger
 * Generate random usage values (bytes) and threshold values (MB),
 * verify warning triggers iff usage exceeds threshold.
 *
 * **Validates: Requirements 11.3**
 */
describe('Property 13: Storage threshold warning trigger', () => {
  it('shouldTriggerStorageWarning returns true iff usageBytes > thresholdMb * 1024 * 1024', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 2_000_000_000 }), // usageBytes
        fc.nat({ max: 2000 }),            // thresholdMb
        (usageBytes, thresholdMb) => {
          const result = shouldTriggerStorageWarning(usageBytes, thresholdMb);
          const expected = usageBytes > thresholdMb * 1024 * 1024;
          expect(result).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 14: Version pruning retains most recent N
 * Generate random version lists with publish dates and a positive keep count N,
 * verify exactly the N most recent are retained; if N >= versions.length, none are deleted.
 *
 * **Validates: Requirements 11.4**
 */
describe('Property 14: Version pruning retains most recent N', () => {
  const versionEntryArb = fc.record({
    version: fc.stringOf(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.'), { minLength: 1, maxLength: 10 }),
    publishDate: fc.date({ min: new Date('2020-01-01'), max: new Date('2025-01-01') }),
  });

  it('keeps exactly min(N, total) versions and they are the most recent by publishDate', () => {
    fc.assert(
      fc.property(
        fc.array(versionEntryArb, { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 1, max: 25 }),
        (versions, keepCount) => {
          const { keep, prune } = selectVersionsToKeep(versions, keepCount);

          // Total count preserved
          expect(keep.length + prune.length).toBe(versions.length);

          if (keepCount >= versions.length) {
            // Nothing pruned
            expect(prune.length).toBe(0);
            expect(keep.length).toBe(versions.length);
          } else {
            expect(keep.length).toBe(keepCount);
            expect(prune.length).toBe(versions.length - keepCount);

            // All kept versions should have publishDate >= all pruned versions
            const sorted = [...versions].sort(
              (a, b) => b.publishDate.getTime() - a.publishDate.getTime(),
            );
            const expectedKeep = new Set(sorted.slice(0, keepCount).map((v) => v.version));
            for (const k of keep) {
              expect(expectedKeep.has(k)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Property 15: Stale package detection
 * Generate random dates and threshold days,
 * verify stale iff elapsed > threshold.
 *
 * **Validates: Requirements 11.5**
 */
describe('Property 15: Stale package detection', () => {
  it('isStalePackage returns true iff elapsed time exceeds threshold in days', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2025-06-01') }),
        fc.integer({ min: 1, max: 365 }),
        fc.date({ min: new Date('2024-01-01'), max: new Date('2026-01-01') }),
        (lastAccessDate, thresholdDays, now) => {
          // Only test when now >= lastAccessDate to avoid negative elapsed
          if (now.getTime() < lastAccessDate.getTime()) { return; }

          const result = isStalePackage(lastAccessDate, thresholdDays, now);
          const elapsed = now.getTime() - lastAccessDate.getTime();
          const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
          const expected = elapsed > thresholdMs;
          expect(result).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 16: Storage analytics computation
 * Generate random package data, verify all metrics correct.
 *
 * **Validates: Requirements 11.7**
 */
describe('Property 16: Storage analytics computation', () => {
  const versionArb = fc.record({
    version: fc.stringOf(fc.constantFrom('0', '1', '2', '3', '.'), { minLength: 1, maxLength: 8 }),
    sizeBytes: fc.nat({ max: 10_000_000 }),
    lastAccessDate: fc.date({ min: new Date('2020-01-01'), max: new Date('2025-06-01') }),
  });

  const packageArb: fc.Arbitrary<PackageAnalyticsInput> = fc.record({
    name: fc.stringOf(fc.constantFrom('a', 'b', 'c', '-', '@', '/'), { minLength: 1, maxLength: 12 }),
    versions: fc.array(versionArb, { minLength: 1, maxLength: 5 }),
  });

  it('totalDiskUsageBytes equals sum of all version sizes', () => {
    fc.assert(
      fc.property(
        fc.array(packageArb, { minLength: 0, maxLength: 10 }),
        fc.integer({ min: 1, max: 365 }),
        (packages, stalenessThresholdDays) => {
          const now = new Date('2025-06-15');
          const analytics = computeStorageAnalytics(packages, stalenessThresholdDays, now);

          // totalDiskUsageBytes = sum of all version sizes
          const expectedTotal = packages.reduce(
            (sum, pkg) => sum + pkg.versions.reduce((s, v) => s + v.sizeBytes, 0),
            0,
          );
          expect(analytics.totalDiskUsageBytes).toBe(expectedTotal);

          // packageCount = number of packages
          expect(analytics.packageCount).toBe(packages.length);

          // versionCount = total versions across all packages
          const expectedVersionCount = packages.reduce((sum, pkg) => sum + pkg.versions.length, 0);
          expect(analytics.versionCount).toBe(expectedVersionCount);

          // largestPackages has at most 5 entries, sorted descending by size
          expect(analytics.largestPackages.length).toBeLessThanOrEqual(5);
          for (let i = 1; i < analytics.largestPackages.length; i++) {
            expect(analytics.largestPackages[i - 1].sizeBytes).toBeGreaterThanOrEqual(
              analytics.largestPackages[i].sizeBytes,
            );
          }

          // stalePackageCount: a package is stale if its most recent version access exceeds threshold
          const thresholdMs = stalenessThresholdDays * 24 * 60 * 60 * 1000;
          let expectedStale = 0;
          for (const pkg of packages) {
            if (pkg.versions.length > 0) {
              const latestAccess = Math.max(...pkg.versions.map((v) => v.lastAccessDate.getTime()));
              if (now.getTime() - latestAccess > thresholdMs) {
                expectedStale++;
              }
            }
          }
          expect(analytics.stalePackageCount).toBe(expectedStale);
        },
      ),
      { numRuns: 100 },
    );
  });
});

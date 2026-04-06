import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    getConfiguration: () => ({ get: (_k: string, d: any) => d }),
    createFileSystemWatcher: () => ({
      onDidCreate: vi.fn(),
      onDidDelete: vi.fn(),
      dispose: vi.fn(),
    }),
  },
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  EventEmitter: class {
    fire = vi.fn();
    dispose = vi.fn();
    event = vi.fn();
  },
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(public id: string) {} },
  RelativePattern: class { constructor(public base: string, public pattern: string) {} },
}));

import {
  filterPackagesByPattern,
  wrapSuccess,
  wrapError,
  walkCache,
  checkCachedPackages,
  computeCacheDiff,
  buildDepTree,
} from '../mcpServer';
import type { McpPackageEntry, CacheWalkerPackage, LockfileDependency } from '../types';

// ─── Arbitraries ───

const packageNameArb = fc.stringOf(
  fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', '-'),
  { minLength: 1, maxLength: 12 },
).filter((s) => /^[a-m]/.test(s) && !s.endsWith('-'));

const scopeArb = fc.stringOf(
  fc.constantFrom('a', 'b', 'c', 'd', 'e'),
  { minLength: 1, maxLength: 6 },
).map((s) => `@${s}`);

const versionArb = fc.tuple(fc.nat({ max: 20 }), fc.nat({ max: 20 }), fc.nat({ max: 20 }))
  .map(([a, b, c]) => `${a}.${b}.${c}`);

const mcpPackageEntryArb: fc.Arbitrary<McpPackageEntry> = fc.record({
  name: fc.oneof(
    packageNameArb,
    fc.tuple(scopeArb, packageNameArb).map(([s, n]) => `${s}/${n}`),
  ),
  versions: fc.array(versionArb, { minLength: 0, maxLength: 5 }),
  totalSizeBytes: fc.nat({ max: 10_000_000 }),
});

const isoDateArb = fc.date({
  min: new Date('2020-01-01'),
  max: new Date('2025-01-01'),
}).map((d) => d.toISOString());

const cacheWalkerPackageArb: fc.Arbitrary<CacheWalkerPackage> = fc.record({
  name: fc.oneof(
    packageNameArb,
    fc.tuple(scopeArb, packageNameArb).map(([s, n]) => `${s}/${n}`),
  ),
  scope: fc.option(scopeArb, { nil: undefined }),
  versionCount: fc.nat({ max: 20 }),
  totalSizeBytes: fc.nat({ max: 10_000_000 }),
  lastAccessDate: fc.option(isoDateArb, { nil: undefined }),
  origin: fc.constantFrom('uplink' as const, 'published' as const, 'unknown' as const),
  versions: fc.constant(undefined),
});

// ─── Property 18: MCP search returns only matching packages ───

describe('Property 18: MCP search returns only matching packages', () => {
  /**
   * Validates: Requirements 15.9
   *
   * For any list of packages and any name pattern string,
   * the search function should return exactly those packages whose names
   * match the provided pattern, with no false positives or false negatives.
   */
  it('should return exactly matching packages for any pattern', () => {
    fc.assert(
      fc.property(
        fc.array(mcpPackageEntryArb, { minLength: 0, maxLength: 20 }),
        fc.stringOf(fc.constantFrom('a', 'b', 'c', 'd', 'e'), { minLength: 1, maxLength: 4 }),
        (packages, pattern) => {
          const result = filterPackagesByPattern(packages, pattern);
          const lowerPattern = pattern.toLowerCase();

          // No false positives: every result matches
          for (const pkg of result) {
            expect(pkg.name.toLowerCase()).toContain(lowerPattern);
          }

          // No false negatives: every matching input is in result
          const matchingInputs = packages.filter((p) =>
            p.name.toLowerCase().includes(lowerPattern),
          );
          expect(result.length).toBe(matchingInputs.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 19: MCP response format consistency ───

describe('Property 19: MCP response format consistency', () => {
  /**
   * Validates: Requirements 15.18
   *
   * For any MCP tool invocation (success or failure), the response should
   * always contain a `success` boolean, `data` when success is true,
   * and `error` when success is false.
   */
  it('wrapSuccess always produces success=true with data field', () => {
    fc.assert(
      fc.property(
        fc.anything(),
        (data) => {
          const response = wrapSuccess(data);
          expect(response.success).toBe(true);
          expect(response).toHaveProperty('data');
          expect(response.data).toBe(data);
          expect(response.error).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('wrapError always produces success=false with error field', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        (errorMsg) => {
          const response = wrapError(errorMsg);
          expect(response.success).toBe(false);
          expect(response).toHaveProperty('error');
          expect(response.error).toBe(errorMsg);
          expect(response.data).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 26: Cache walker filtering and pagination ───

describe('Property 26: Cache walker filtering and pagination', () => {
  /**
   * Validates: Requirements 15.26, 15.27, 15.28
   */
  it('scope filter returns only packages matching the given scope', () => {
    fc.assert(
      fc.property(
        fc.array(cacheWalkerPackageArb, { minLength: 0, maxLength: 20 }),
        scopeArb,
        (packages, scope) => {
          const result = walkCache(packages, { scope });
          for (const pkg of result.packages) {
            expect(pkg.scope?.toLowerCase()).toBe(scope.toLowerCase());
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('pattern filter returns only packages whose names match', () => {
    fc.assert(
      fc.property(
        fc.array(cacheWalkerPackageArb, { minLength: 0, maxLength: 20 }),
        fc.stringOf(fc.constantFrom('a', 'b', 'c'), { minLength: 1, maxLength: 3 }),
        (packages, pattern) => {
          const result = walkCache(packages, { pattern });
          const lowerPattern = pattern.toLowerCase();
          for (const pkg of result.packages) {
            expect(pkg.name.toLowerCase()).toContain(lowerPattern);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('summary totals reflect pre-pagination counts', () => {
    fc.assert(
      fc.property(
        fc.array(cacheWalkerPackageArb, { minLength: 0, maxLength: 20 }),
        fc.nat({ max: 10 }),
        fc.integer({ min: 1, max: 5 }),
        (packages, offset, limit) => {
          const result = walkCache(packages, { offset, limit });

          // Summary should reflect ALL packages (no filter applied), not just paginated
          expect(result.summary.totalPackages).toBe(packages.length);
          expect(result.summary.totalVersions).toBe(
            packages.reduce((s, p) => s + p.versionCount, 0),
          );
          expect(result.summary.totalSizeBytes).toBe(
            packages.reduce((s, p) => s + p.totalSizeBytes, 0),
          );

          // Paginated result should have at most `limit` entries
          expect(result.packages.length).toBeLessThanOrEqual(limit);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('sortBy=name produces alphabetically sorted results', () => {
    fc.assert(
      fc.property(
        fc.array(cacheWalkerPackageArb, { minLength: 2, maxLength: 15 }),
        (packages) => {
          const result = walkCache(packages, { sortBy: 'name' });
          for (let i = 1; i < result.packages.length; i++) {
            expect(
              result.packages[i - 1].name.localeCompare(result.packages[i].name),
            ).toBeLessThanOrEqual(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('sortBy=size produces descending size order', () => {
    fc.assert(
      fc.property(
        fc.array(cacheWalkerPackageArb, { minLength: 2, maxLength: 15 }),
        (packages) => {
          const result = walkCache(packages, { sortBy: 'size' });
          for (let i = 1; i < result.packages.length; i++) {
            expect(result.packages[i - 1].totalSizeBytes).toBeGreaterThanOrEqual(
              result.packages[i].totalSizeBytes,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 27: Cache diff correctness ───

describe('Property 27: Cache diff correctness', () => {
  /**
   * Validates: Requirements 15.32
   *
   * For any lockfile dependency list and any cache state, the cache diff
   * should classify every dependency into exactly one of upToDate, outdated,
   * or missing, and the total count should equal the lockfile dependency count.
   */
  it('every dependency is classified into exactly one bucket', () => {
    const lockfileDepArb: fc.Arbitrary<LockfileDependency> = fc.record({
      name: packageNameArb,
      version: versionArb,
    });

    // Generate a cache state: map of name -> set of versions
    const cacheStateArb = fc.array(
      fc.tuple(packageNameArb, fc.array(versionArb, { minLength: 0, maxLength: 3 })),
      { minLength: 0, maxLength: 10 },
    ).map((entries) => {
      const map = new Map<string, Set<string>>();
      for (const [name, versions] of entries) {
        map.set(name, new Set(versions));
      }
      return map;
    });

    fc.assert(
      fc.property(
        fc.array(lockfileDepArb, { minLength: 0, maxLength: 15 }),
        cacheStateArb,
        (deps, cacheState) => {
          const result = computeCacheDiff(deps, cacheState);

          // Total count must match
          const totalClassified =
            result.upToDate.length + result.outdated.length + result.missing.length;
          expect(totalClassified).toBe(deps.length);

          // Each dep appears in exactly one bucket
          const allNames = [
            ...result.upToDate.map((e) => `${e.name}@${e.requiredVersion}`),
            ...result.outdated.map((e) => `${e.name}@${e.requiredVersion}`),
            ...result.missing.map((e) => `${e.name}@${e.requiredVersion}`),
          ];
          // No duplicates (within the classified results)
          expect(new Set(allNames).size).toBe(allNames.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 28: Dependency tree cached flag accuracy ───

describe('Property 28: Dependency tree cached flag accuracy', () => {
  /**
   * Validates: Requirements 15.34
   *
   * For any package@version and any cache state, every node in the returned
   * dependency tree should have cached=true iff the corresponding
   * package@version exists in the storage directory.
   */
  it('cached flag matches storage presence for all nodes', () => {
    const cacheStateArb = fc.array(
      fc.tuple(packageNameArb, fc.array(versionArb, { minLength: 1, maxLength: 3 })),
      { minLength: 1, maxLength: 8 },
    ).map((entries) => {
      const map = new Map<string, Set<string>>();
      for (const [name, versions] of entries) {
        map.set(name, new Set(versions));
      }
      return map;
    });

    // Simple dep map: each package has 0-2 deps pointing to other packages in cache
    const depMapArb = cacheStateArb.chain((cacheState) => {
      const allEntries: [string, string][] = [];
      for (const [name, versions] of cacheState) {
        for (const ver of versions) {
          allEntries.push([name, ver]);
        }
      }
      return fc.constant({ cacheState, allEntries });
    });

    fc.assert(
      fc.property(depMapArb, ({ cacheState, allEntries }) => {
        if (allEntries.length === 0) { return; }

        const depMap = new Map<string, Record<string, string>>();
        // Create simple dep relationships
        for (let i = 0; i < allEntries.length; i++) {
          const [name, ver] = allEntries[i];
          const deps: Record<string, string> = {};
          // Each package depends on the next one (if exists)
          if (i + 1 < allEntries.length) {
            deps[allEntries[i + 1][0]] = allEntries[i + 1][1];
          }
          depMap.set(`${name}@${ver}`, deps);
        }

        const [rootName, rootVer] = allEntries[0];
        const tree = buildDepTree(rootName, rootVer, cacheState, depMap, 3);

        // Verify cached flag for all nodes
        function verifyNode(node: { name: string; version: string; cached: boolean; dependencies: any[] }) {
          const isCached = cacheState.get(node.name)?.has(node.version) ?? false;
          expect(node.cached).toBe(isCached);
          for (const child of node.dependencies) {
            verifyNode(child);
          }
        }

        verifyNode(tree);
      }),
      { numRuns: 100 },
    );
  });
});

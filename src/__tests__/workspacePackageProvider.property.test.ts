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
  workspace: { workspaceFolders: [] },
  window: {
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    withProgress: vi.fn(),
  },
  ProgressLocation: { Notification: 15 },
}));

import { topologicalSort } from '../workspacePackageProvider';

/**
 * Property 17: Dependency-order publish
 * Generate random sets of workspace packages with inter-dependencies forming a DAG using fast-check.
 * Verify the publish order is a valid topological sort: for every package P depending on Q,
 * Q appears before P in the order.
 *
 * **Validates: Requirements 13.3**
 */
describe('Property 17: Dependency-order publish', () => {
  /**
   * Arbitrary that generates a random DAG of workspace packages.
   * Each package has a unique name and dependencies that only reference
   * packages earlier in the generation order (ensuring no cycles).
   */
  const dagArb = fc
    .integer({ min: 1, max: 20 })
    .chain((n) => {
      // Generate n unique package names
      return fc.uniqueArray(
        fc.stringOf(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), { minLength: 1, maxLength: 6 }),
        { minLength: n, maxLength: n },
      ).chain((names) => {
        // For each package, dependencies can only be packages with a lower index (ensures DAG)
        const depArbs = names.map((name, idx) => {
          if (idx === 0) {
            return fc.constant({ name, dependencies: [] as string[] });
          }
          const possibleDeps = names.slice(0, idx);
          return fc.subarray(possibleDeps).map((deps) => ({ name, dependencies: deps }));
        });
        return fc.tuple(...depArbs);
      });
    });

  it('produces a valid topological sort for any DAG: dependencies appear before dependents', () => {
    fc.assert(
      fc.property(dagArb, (packages) => {
        const sorted = topologicalSort(packages);

        // All packages should be present
        expect(sorted).toHaveLength(packages.length);
        expect(new Set(sorted).size).toBe(packages.length);

        // Build position map
        const position = new Map<string, number>();
        sorted.forEach((name, idx) => position.set(name, idx));

        // For every package P that depends on Q, Q must appear before P
        for (const pkg of packages) {
          for (const dep of pkg.dependencies) {
            // Only check workspace-internal deps
            if (position.has(dep)) {
              expect(position.get(dep)!).toBeLessThan(position.get(pkg.name)!);
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('handles packages with no dependencies', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.stringOf(fc.constantFrom('a', 'b', 'c', 'd'), { minLength: 1, maxLength: 4 }),
          { minLength: 1, maxLength: 10 },
        ),
        (names) => {
          const packages = names.map((name) => ({ name, dependencies: [] }));
          const sorted = topologicalSort(packages);
          expect(sorted).toHaveLength(names.length);
          expect(new Set(sorted).size).toBe(names.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

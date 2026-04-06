import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

/**
 * Validates: Requirements 4.1
 *
 * Property 3: Package tree grouping preserves all packages
 * For any list of package entries (some scoped, some unscoped),
 * building the cache tree grouped by scope should produce a tree where
 * every input package appears exactly once under its correct scope node
 * (or at root if unscoped), and the total number of packages in the tree
 * equals the input count.
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

import { buildPackageTree, PackageEntry } from '../cacheViewProvider';
import type { ScopeNode, PackageNode } from '../types';

// Arbitrary for a package name (simple alphanumeric with hyphens)
const packageNameArb = fc.stringOf(
  fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', '-'),
  { minLength: 1, maxLength: 12 },
).filter((s) => /^[a-m]/.test(s) && !s.endsWith('-'));

// Arbitrary for a scope name (starts with @)
const scopeArb = fc.stringOf(
  fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'),
  { minLength: 1, maxLength: 8 },
).map((s) => `@${s}`);

// Arbitrary for a version entry
const versionEntryArb = fc.record({
  version: fc.tuple(fc.nat({ max: 20 }), fc.nat({ max: 20 }), fc.nat({ max: 20 }))
    .map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
  description: fc.string({ minLength: 0, maxLength: 30 }),
  tarballSize: fc.nat({ max: 10_000_000 }),
});

// Arbitrary for a PackageEntry (scoped or unscoped)
const packageEntryArb: fc.Arbitrary<PackageEntry> = fc.record({
  name: packageNameArb,
  scope: fc.option(scopeArb, { nil: undefined }),
  versions: fc.array(versionEntryArb, { minLength: 1, maxLength: 5 }),
});

/**
 * Generate a list of PackageEntry with unique name+scope combinations.
 * Uses uniqueArray with a key function to ensure no duplicates.
 */
const uniquePackageEntriesArb = fc.uniqueArray(packageEntryArb, {
  minLength: 0,
  maxLength: 30,
  selector: (entry) => `${entry.scope ?? ''}/${entry.name}`,
});

/**
 * Flatten the CacheItem[] tree to extract all PackageNodes.
 */
function flattenPackageNodes(tree: ReturnType<typeof buildPackageTree>): PackageNode[] {
  const result: PackageNode[] = [];
  for (const item of tree) {
    if (item.type === 'scope') {
      result.push(...(item as ScopeNode).children);
    } else if (item.type === 'package') {
      result.push(item as PackageNode);
    }
  }
  return result;
}

describe('Property 3: Package tree grouping preserves all packages', () => {
  it('every input package appears exactly once and total count matches', () => {
    fc.assert(
      fc.property(uniquePackageEntriesArb, (entries) => {
        const tree = buildPackageTree(entries);
        const allPackageNodes = flattenPackageNodes(tree);

        // Total count of packages in tree must equal input count
        expect(allPackageNodes.length).toBe(entries.length);

        // Build a lookup of input entries by key
        const inputKeys = new Set(
          entries.map((e) => `${e.scope ?? ''}/${e.name}`),
        );

        // Every package node in the tree must correspond to an input entry
        const treeKeys = new Set(
          allPackageNodes.map((p) => `${p.scope ?? ''}/${p.name}`),
        );
        expect(treeKeys).toEqual(inputKeys);

        // Verify each package is under its correct scope node (or at root if unscoped)
        for (const item of tree) {
          if (item.type === 'scope') {
            const scopeNode = item as ScopeNode;
            for (const child of scopeNode.children) {
              expect(child.scope).toBe(scopeNode.name);
            }
          } else if (item.type === 'package') {
            // Top-level packages must be unscoped
            expect((item as PackageNode).scope).toBeUndefined();
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

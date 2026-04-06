import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

vi.mock('vscode', () => ({
  window: {},
  workspace: { workspaceFolders: [] },
  ProgressLocation: { Notification: 15 },
}));

import { parseLockfileDeps, classifyDependencies } from '../dependencyMirrorManager';
import { LockfileDependency } from '../types';

/**
 * Property 20: Lockfile dependency extraction completeness
 * Generate random valid lockfile content (both package-lock.json and yarn.lock formats),
 * verify every dependency entry is extracted with correct name and version, and count matches.
 *
 * **Validates: Requirements 17.1, 17.6**
 */
describe('Property 20: Lockfile dependency extraction completeness', () => {
  // Generator for valid package names (simple alphanumeric with hyphens)
  const packageNameArb = fc.stringOf(
    fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', '-'),
    { minLength: 1, maxLength: 10 },
  ).filter((s) => /^[a-m]/.test(s) && !s.endsWith('-') && !s.startsWith('-'));

  const versionArb = fc.tuple(
    fc.nat({ max: 20 }),
    fc.nat({ max: 20 }),
    fc.nat({ max: 20 }),
  ).map(([a, b, c]) => `${a}.${b}.${c}`);

  const depEntryArb = fc.record({
    name: packageNameArb,
    version: versionArb,
  });

  it('extracts all dependencies from package-lock.json format (lockfileVersion 1)', () => {
    fc.assert(
      fc.property(
        fc.array(depEntryArb, { minLength: 0, maxLength: 15 }),
        (deps) => {
          // Deduplicate by name to avoid overwriting in JSON
          const uniqueDeps = [...new Map(deps.map((d) => [d.name, d])).values()];

          // Build package-lock.json content (lockfileVersion 1 format)
          const dependencies: Record<string, { version: string }> = {};
          for (const dep of uniqueDeps) {
            dependencies[dep.name] = { version: dep.version };
          }
          const lockfile = JSON.stringify({ lockfileVersion: 1, dependencies });

          const result = parseLockfileDeps(lockfile, 'package-lock');

          // Count should match
          expect(result.length).toBe(uniqueDeps.length);

          // Every dep should be present with correct version
          for (const dep of uniqueDeps) {
            const found = result.find((r) => r.name === dep.name);
            expect(found).toBeDefined();
            expect(found!.version).toBe(dep.version);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('extracts all dependencies from package-lock.json format (lockfileVersion 2/3)', () => {
    fc.assert(
      fc.property(
        fc.array(depEntryArb, { minLength: 0, maxLength: 15 }),
        (deps) => {
          const uniqueDeps = [...new Map(deps.map((d) => [d.name, d])).values()];

          // Build package-lock.json content (lockfileVersion 2/3 format with packages)
          const packages: Record<string, { version: string }> = { '': { version: '1.0.0' } as any };
          for (const dep of uniqueDeps) {
            packages[`node_modules/${dep.name}`] = { version: dep.version };
          }
          const lockfile = JSON.stringify({ lockfileVersion: 3, packages });

          const result = parseLockfileDeps(lockfile, 'package-lock');

          expect(result.length).toBe(uniqueDeps.length);

          for (const dep of uniqueDeps) {
            const found = result.find((r) => r.name === dep.name);
            expect(found).toBeDefined();
            expect(found!.version).toBe(dep.version);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('extracts all dependencies from yarn.lock format', () => {
    fc.assert(
      fc.property(
        fc.array(depEntryArb, { minLength: 0, maxLength: 15 }),
        (deps) => {
          const uniqueDeps = [...new Map(deps.map((d) => [d.name, d])).values()];

          // Build yarn.lock content
          const lines: string[] = ['# yarn lockfile v1', ''];
          for (const dep of uniqueDeps) {
            lines.push(`${dep.name}@^${dep.version}:`);
            lines.push(`  version "${dep.version}"`);
            lines.push(`  resolved "https://registry.npmjs.org/${dep.name}/-/${dep.name}-${dep.version}.tgz"`);
            lines.push('');
          }
          const lockfile = lines.join('\n');

          const result = parseLockfileDeps(lockfile, 'yarn-lock');

          expect(result.length).toBe(uniqueDeps.length);

          for (const dep of uniqueDeps) {
            const found = result.find((r) => r.name === dep.name);
            expect(found).toBeDefined();
            expect(found!.version).toBe(dep.version);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 21: Mirror classification and summary consistency
 * Generate random dependency sets and pre-existing cache states,
 * verify each dependency is classified as "newly cached" iff not in cache,
 * and newlyCached.length + alreadyAvailable.length equals total count.
 *
 * **Validates: Requirements 17.3, 17.4**
 */
describe('Property 21: Mirror classification and summary consistency', () => {
  const depArb = fc.record({
    name: fc.stringOf(fc.constantFrom('a', 'b', 'c', 'd', 'e'), { minLength: 1, maxLength: 5 }),
    version: fc.tuple(
      fc.nat({ max: 10 }),
      fc.nat({ max: 10 }),
      fc.nat({ max: 10 }),
    ).map(([a, b, c]) => `${a}.${b}.${c}`),
  });

  it('classifies each dep correctly and counts sum to total', () => {
    fc.assert(
      fc.property(
        fc.array(depArb, { minLength: 0, maxLength: 20 }),
        fc.array(fc.stringOf(fc.constantFrom('a', 'b', 'c', 'd', 'e', '@', '.', '0', '1', '2'), { minLength: 3, maxLength: 15 }), { minLength: 0, maxLength: 10 }),
        (deps, cachedKeys) => {
          const cachedSet = new Set(cachedKeys);
          const lockfileDeps: LockfileDependency[] = deps.map((d) => ({
            name: d.name,
            version: d.version,
          }));

          const { newlyCached, alreadyAvailable } = classifyDependencies(lockfileDeps, cachedSet);

          // Total count preserved
          expect(newlyCached.length + alreadyAvailable.length).toBe(lockfileDeps.length);

          // Each newly cached dep should NOT be in the cached set
          for (const dep of newlyCached) {
            expect(cachedSet.has(`${dep.name}@${dep.version}`)).toBe(false);
          }

          // Each already available dep SHOULD be in the cached set
          for (const dep of alreadyAvailable) {
            expect(cachedSet.has(`${dep.name}@${dep.version}`)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

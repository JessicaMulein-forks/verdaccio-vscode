import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { setRegistryInContent, removeRegistryFromContent } from '../npmrcManager';

// Minimal vscode mock
vi.mock('vscode', () => ({
  window: { showWarningMessage: vi.fn() },
  workspace: { workspaceFolders: undefined },
}));

/**
 * Validates: Requirements 6.1, 6.2
 *
 * Property 6: Npmrc registry round-trip
 * For any valid .npmrc file content (lines that do NOT start with `registry=`),
 * setting the registry to a Verdaccio address and then resetting it should produce
 * .npmrc content equivalent to the original with no residual registry entry,
 * preserving all other configuration lines.
 */

/**
 * Arbitrary for a single .npmrc line that is NOT a registry= line.
 * Generates realistic npmrc-style entries like key=value, comments, scoped registries, etc.
 */
const npmrcLineArb = fc.oneof(
  // key=value style (not registry=)
  fc.tuple(
    fc.constantFrom('always-auth', 'save-exact', 'strict-ssl', 'fetch-retries', 'loglevel', '@myorg:registry', '//npm.pkg.github.com/:_authToken'),
    fc.stringOf(fc.constantFrom('a', 'b', 'c', '1', '2', '/', ':', '.', '-', '_', 'h', 't', 'p', 's'), { minLength: 1, maxLength: 30 }),
  ).map(([key, val]) => `${key}=${val}`),
  // comment lines
  fc.stringOf(fc.constantFrom(' ', 'a', 'b', 'c', '1', '#', '='), { minLength: 0, maxLength: 30 }).map((s) => `; ${s}`),
  fc.stringOf(fc.constantFrom(' ', 'a', 'b', 'c', '1', '#', '='), { minLength: 0, maxLength: 30 }).map((s) => `# ${s}`),
  // blank lines
  fc.constant(''),
);

/**
 * Arbitrary for .npmrc file content: multiple lines joined by newlines,
 * none of which start with `registry=`.
 */
const npmrcContentArb = fc.array(npmrcLineArb, { minLength: 0, maxLength: 10 }).map((lines) => lines.join('\n'));

/**
 * Arbitrary for a registry URL.
 */
const registryUrlArb = fc.tuple(
  fc.constantFrom('http', 'https'),
  fc.constantFrom('localhost', '127.0.0.1', '0.0.0.0', 'registry.example.com'),
  fc.nat({ max: 65535 }),
).map(([scheme, host, port]) => `${scheme}://${host}:${port}/`);

describe('Property 6: Npmrc registry round-trip', () => {
  it('setting then removing registry produces content equivalent to the original', () => {
    fc.assert(
      fc.property(
        npmrcContentArb,
        registryUrlArb,
        (originalContent, registryUrl) => {
          // Set the registry
          const withRegistry = setRegistryInContent(originalContent, registryUrl);

          // The registry line should be present
          const registryLines = withRegistry.split('\n').filter((l) => l.trimStart().startsWith('registry='));
          expect(registryLines.length).toBe(1);
          expect(registryLines[0]).toBe(`registry=${registryUrl}`);

          // Remove the registry
          const restored = removeRegistryFromContent(withRegistry);

          // No residual registry= line should remain
          const residualRegistryLines = restored.split('\n').filter((l) => l.trimStart().startsWith('registry='));
          expect(residualRegistryLines.length).toBe(0);

          // All original non-registry lines should be preserved
          const originalLines = originalContent.split('\n').filter((l) => !l.trimStart().startsWith('registry='));
          const restoredLines = restored.split('\n').filter((l) => l.trim() !== '' || originalLines.includes(l));

          // The restored content should contain all original lines in order
          const restoredAllLines = restored.split('\n');
          let oi = 0;
          for (const line of restoredAllLines) {
            if (oi < originalLines.length && line === originalLines[oi]) {
              oi++;
            }
          }
          expect(oi).toBe(originalLines.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});

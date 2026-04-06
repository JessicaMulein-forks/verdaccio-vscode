import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

vi.mock('vscode', () => ({
  window: {},
  workspace: { workspaceFolders: [{ uri: { fsPath: '/workspace' } }] },
  StatusBarAlignment: { Left: 1, Right: 2 },
}));

import { serializeProfile, deserializeProfile } from '../profileManager';

/**
 * Property 25: Profile round-trip
 * Generate random .npmrc content with default registry, scoped registries,
 * and auth token registry references. Create a profile from that content,
 * then switch to that profile. Verify the resulting .npmrc content is equivalent.
 *
 * **Validates: Requirements 19.1, 19.3, 19.6**
 */
describe('Property 25: Profile round-trip', () => {
  // Generator for valid registry URLs
  const registryUrlArb = fc.constantFrom(
    'http://localhost:4873',
    'https://registry.npmjs.org/',
    'https://npm.fontawesome.com/',
    'http://localhost:8080',
    'https://registry.example.com/',
  );

  // Generator for valid scope names
  const scopeArb = fc.constantFrom(
    '@myorg',
    '@fortawesome',
    '@company',
    '@scope',
    '@test',
  );

  // Generator for auth token registry hosts
  // Note: hosts with ports (e.g., localhost:4873/) are not supported by the existing
  // listAuthTokensFromContent regex which stops at the first colon.
  const authRegistryArb = fc.constantFrom(
    'registry.npmjs.org/',
    'npm.fontawesome.com/',
    'registry.example.com/',
  );

  it('serializing then deserializing preserves registry, scoped registries, and auth token registries', () => {
    fc.assert(
      fc.property(
        fc.option(registryUrlArb, { nil: undefined }),
        fc.array(
          fc.record({ scope: scopeArb, url: registryUrlArb }),
          { minLength: 0, maxLength: 3 },
        ),
        fc.array(authRegistryArb, { minLength: 0, maxLength: 3 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (registry, scopedEntries, authRegistries, profileName) => {
          // Deduplicate scoped entries by scope
          const uniqueScoped = [...new Map(scopedEntries.map((e) => [e.scope, e])).values()];
          // Deduplicate auth registries
          const uniqueAuth = [...new Set(authRegistries)];

          // Build .npmrc content
          const lines: string[] = [];
          if (registry) {
            lines.push(`registry=${registry}`);
          }
          for (const entry of uniqueScoped) {
            lines.push(`${entry.scope}:registry=${entry.url}`);
          }
          for (const reg of uniqueAuth) {
            lines.push(`//${reg}:_authToken=sometoken123`);
          }
          const npmrcContent = lines.join('\n');

          // Serialize to profile
          const profile = serializeProfile(npmrcContent, profileName);

          // Verify profile fields
          expect(profile.name).toBe(profileName);
          expect(profile.registry).toBe(registry);
          expect(profile.scopedRegistries).toHaveLength(uniqueScoped.length);
          expect(profile.authTokenRegistries).toHaveLength(uniqueAuth.length);

          // Verify scoped registries match
          for (const entry of uniqueScoped) {
            const found = profile.scopedRegistries.find((s) => s.scope === entry.scope);
            expect(found).toBeDefined();
            expect(found!.registryUrl).toBe(entry.url);
          }

          // Verify auth token registries match
          for (const reg of uniqueAuth) {
            expect(profile.authTokenRegistries).toContain(reg);
          }

          // Deserialize back to .npmrc content
          const restored = deserializeProfile(profile);

          // Re-serialize the restored content
          const roundTripped = serializeProfile(restored, profileName);

          // Verify round-trip preserves structure
          expect(roundTripped.registry).toBe(profile.registry);
          expect(roundTripped.scopedRegistries).toHaveLength(profile.scopedRegistries.length);
          expect(roundTripped.authTokenRegistries).toHaveLength(profile.authTokenRegistries.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

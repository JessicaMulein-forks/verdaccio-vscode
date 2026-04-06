import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import {
  addScopedRegistryInContent,
  removeScopedRegistryFromContent,
  addAuthTokenInContent,
  removeAuthTokenFromContent,
} from '../npmrcManager';
import {
  isValidScope,
  isValidRegistryUrl,
  isValidToken,
  maskToken,
} from '../types';

// Minimal vscode mock
vi.mock('vscode', () => ({
  window: { showWarningMessage: vi.fn(), showErrorMessage: vi.fn(), showInformationMessage: vi.fn() },
  workspace: { workspaceFolders: undefined },
}));

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/**
 * Arbitrary for a single .npmrc line that is NOT a scoped registry line and NOT an auth token line.
 */
const npmrcSafeLineArb = fc.oneof(
  // key=value style (not @scope:registry= and not //:_authToken=)
  fc.tuple(
    fc.constantFrom('always-auth', 'save-exact', 'strict-ssl', 'fetch-retries', 'loglevel'),
    fc.stringOf(fc.constantFrom('a', 'b', 'c', '1', '2', '.', '-', '_', 't', 'r', 'u', 'e'), { minLength: 1, maxLength: 20 }),
  ).map(([key, val]) => `${key}=${val}`),
  // comment lines
  fc.stringOf(fc.constantFrom(' ', 'a', 'b', 'c', '1', '#', '='), { minLength: 0, maxLength: 20 }).map((s) => `# ${s}`),
  // blank lines
  fc.constant(''),
);

/** Arbitrary for .npmrc content with no scoped registry or auth token lines. */
const npmrcContentArb = fc
  .array(npmrcSafeLineArb, { minLength: 0, maxLength: 8 })
  .map((lines) => lines.join('\n'));

/** Arbitrary for a valid npm scope (starts with @, no whitespace). */
const validScopeArb = fc
  .stringOf(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'x', 'y', 'z', '-', '_', '1', '2'), { minLength: 1, maxLength: 12 })
  .map((s) => `@${s}`);

/** Arbitrary for a valid registry URL. */
const validRegistryUrlArb = fc
  .tuple(
    fc.constantFrom('http', 'https'),
    fc.constantFrom('localhost', '127.0.0.1', 'registry.example.com', 'npm.pkg.github.com'),
    fc.nat({ max: 65535 }),
  )
  .map(([scheme, host, port]) => `${scheme}://${host}:${port}/`);

/** Arbitrary for a non-empty token string (no newlines). */
const validTokenArb = fc.stringOf(
  fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'X', 'Y', 'Z', '-', '_'),
  { minLength: 1, maxLength: 40 },
);

// ---------------------------------------------------------------------------
// Property 7: Scoped registry .npmrc round-trip
// ---------------------------------------------------------------------------

/**
 * Validates: Requirements 8.4, 8.7
 *
 * Property 7: Scoped registry .npmrc round-trip
 * For any valid .npmrc content (no scoped registry lines for the test scope) and any valid
 * scope/URL pair, adding a scoped registry entry and then removing the same scope should
 * produce .npmrc content equivalent to the original, preserving all other lines.
 */
describe('Property 7: Scoped registry .npmrc round-trip', () => {
  it('adding then removing a scoped registry produces content equivalent to the original', () => {
    fc.assert(
      fc.property(
        npmrcContentArb,
        validScopeArb,
        validRegistryUrlArb,
        (originalContent, scope, url) => {
          // Add the scoped registry
          const withScoped = addScopedRegistryInContent(originalContent, scope, url);

          // The scoped registry line should be present
          const scopedLines = withScoped.split('\n').filter((l) => l.trimStart().startsWith(`${scope}:registry=`));
          expect(scopedLines.length).toBe(1);
          expect(scopedLines[0]).toBe(`${scope}:registry=${url}`);

          // Remove the scoped registry
          const restored = removeScopedRegistryFromContent(withScoped, scope);

          // No residual scoped registry line for this scope should remain
          const residualLines = restored.split('\n').filter((l) => l.trimStart().startsWith(`${scope}:registry=`));
          expect(residualLines.length).toBe(0);

          // All original lines should be preserved in order
          const originalLines = originalContent.split('\n');
          const restoredLines = restored.split('\n');
          let oi = 0;
          for (const line of restoredLines) {
            if (oi < originalLines.length && line === originalLines[oi]) {
              oi++;
            }
          }
          expect(oi).toBe(originalLines.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8: Scope and URL validation
// ---------------------------------------------------------------------------

/**
 * Validates: Requirements 8.5, 14.7
 *
 * Property 8: Scope and URL validation
 * For any string, isValidScope accepts iff it starts with '@' and contains no whitespace.
 * For any string, isValidRegistryUrl accepts iff it is a valid http:// or https:// URL.
 */
describe('Property 8: Scope and URL validation', () => {
  it('isValidScope accepts iff starts with @ and no whitespace', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 30 }),
        (s) => {
          const result = isValidScope(s);
          const expected = s.startsWith('@') && !/\s/.test(s);
          expect(result).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('isValidRegistryUrl accepts iff valid http:// or https:// URL', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }),
        (s) => {
          const result = isValidRegistryUrl(s);
          // Verify against the same logic: try URL constructor, check protocol
          let expected = false;
          try {
            const parsed = new URL(s);
            expected = parsed.protocol === 'http:' || parsed.protocol === 'https:';
          } catch {
            expected = false;
          }
          expect(result).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('known valid URLs are accepted', () => {
    fc.assert(
      fc.property(
        validRegistryUrlArb,
        (url) => {
          expect(isValidRegistryUrl(url)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('known valid scopes are accepted', () => {
    fc.assert(
      fc.property(
        validScopeArb,
        (scope) => {
          expect(isValidScope(scope)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: Auth token masking
// ---------------------------------------------------------------------------

/**
 * Validates: Requirements 9.3
 *
 * Property 9: Auth token masking
 * For any non-empty token string, maskToken(token) starts with '****',
 * ends with the last 4 chars (or fewer if token < 4), and never equals the full token.
 */
describe('Property 9: Auth token masking', () => {
  it('masked token starts with ****, ends with last 4 chars, and never equals full token', () => {
    fc.assert(
      fc.property(
        validTokenArb,
        (token) => {
          const masked = maskToken(token);

          // Always starts with ****
          expect(masked.startsWith('****')).toBe(true);

          if (token.length >= 4) {
            // Ends with last 4 chars
            expect(masked).toBe('****' + token.slice(-4));
          } else {
            // Token shorter than 4 chars: just '****'
            expect(masked).toBe('****');
          }

          // Never equals the full original token
          expect(masked).not.toBe(token);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10: Auth token .npmrc round-trip
// ---------------------------------------------------------------------------

/**
 * Validates: Requirements 9.5, 9.8
 *
 * Property 10: Auth token .npmrc round-trip
 * For any valid .npmrc content (no auth token lines for the test registry) and any valid
 * registry/token pair, adding an auth token entry and then removing the same registry's
 * token should produce .npmrc content equivalent to the original, preserving all other lines.
 */
describe('Property 10: Auth token .npmrc round-trip', () => {
  it('adding then removing an auth token produces content equivalent to the original', () => {
    fc.assert(
      fc.property(
        npmrcContentArb,
        validRegistryUrlArb,
        validTokenArb,
        (originalContent, registryUrl, token) => {
          // Add the auth token
          const withToken = addAuthTokenInContent(originalContent, registryUrl, token);

          // The auth token line should be present
          const hostKey = registryUrl.replace(/^https?:/, '').replace(/^\/\//, '');
          const prefix = `//${hostKey}:_authToken=`;
          const tokenLines = withToken.split('\n').filter((l) => l.trimStart().startsWith(prefix));
          expect(tokenLines.length).toBe(1);

          // Remove the auth token
          const restored = removeAuthTokenFromContent(withToken, registryUrl);

          // No residual auth token line for this registry should remain
          const residualLines = restored.split('\n').filter((l) => l.trimStart().startsWith(prefix));
          expect(residualLines.length).toBe(0);

          // All original lines should be preserved in order
          const originalLines = originalContent.split('\n');
          const restoredLines = restored.split('\n');
          let oi = 0;
          for (const line of restoredLines) {
            if (oi < originalLines.length && line === originalLines[oi]) {
              oi++;
            }
          }
          expect(oi).toBe(originalLines.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11: Whitespace-only token rejection
// ---------------------------------------------------------------------------

/**
 * Validates: Requirements 9.7
 *
 * Property 11: Whitespace-only token rejection
 * For any string composed entirely of whitespace characters (including empty string),
 * isValidToken should return false.
 * For any string containing at least one non-whitespace character, isValidToken should return true.
 */
describe('Property 11: Whitespace-only token rejection', () => {
  it('rejects whitespace-only strings', () => {
    fc.assert(
      fc.property(
        fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 0, maxLength: 20 }),
        (whitespaceStr) => {
          expect(isValidToken(whitespaceStr)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('accepts strings with at least one non-whitespace character', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 0, maxLength: 10 }),
          fc.stringOf(fc.constantFrom('a', 'b', 'c', '1', '2', '3', 'X', 'Y', 'Z', '-', '_'), { minLength: 1, maxLength: 10 }),
          fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 0, maxLength: 10 }),
        ).map(([pre, mid, post]) => pre + mid + post),
        (nonWhitespaceStr) => {
          expect(isValidToken(nonWhitespaceStr)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

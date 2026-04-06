import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import type { VerdaccioConfig, UplinkConfig } from '../types';

// Minimal vscode mock — configManager.ts imports vscode at module level
vi.mock('vscode', () => ({
  workspace: { getConfiguration: vi.fn(() => ({ get: vi.fn() })), workspaceFolders: undefined },
  window: { showTextDocument: vi.fn(), showWarningMessage: vi.fn() },
  Uri: { file: vi.fn() },
}));

import { enableOfflineModeInConfig, disableOfflineModeInConfig } from '../configManager';

/**
 * Validates: Requirements 10.4, 10.5
 *
 * Property 12: Offline mode round-trip
 * For any valid VerdaccioConfig with one or more uplinks, enabling offline mode
 * should set all uplinks to max_fails: 0 and fail_timeout: "0", and subsequently
 * disabling offline mode should restore each uplink's max_fails and fail_timeout
 * to their original values.
 */

const uplinkConfigArb: fc.Arbitrary<UplinkConfig> = fc.record({
  url: fc.webUrl(),
  timeout: fc.nat({ max: 120 }).map((n) => `${n}s`),
  maxage: fc.nat({ max: 60 }).map((n) => `${n}m`),
  max_fails: fc.nat({ max: 50 }),
  fail_timeout: fc.nat({ max: 60 }).map((n) => `${n}m`),
});

const uplinksArb = fc.dictionary(
  fc.stringOf(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g'), { minLength: 1, maxLength: 6 }),
  uplinkConfigArb,
  { minKeys: 1, maxKeys: 3 },
);

const verdaccioConfigArb: fc.Arbitrary<VerdaccioConfig> = fc.record({
  storage: fc.constant('./storage'),
  listen: fc.constant('0.0.0.0:4873'),
  max_body_size: fc.constant('10mb'),
  log: fc.record({ level: fc.constantFrom('fatal' as const, 'error' as const, 'warn' as const, 'info' as const, 'debug' as const, 'trace' as const) }),
  uplinks: uplinksArb,
  packages: fc.constant({ '**': { access: '$all', publish: '$authenticated', proxy: ['npmjs'] } }),
});

describe('Property 12: Offline mode round-trip', () => {
  it('enabling offline mode zeros out all uplinks, disabling restores originals', () => {
    fc.assert(
      fc.property(verdaccioConfigArb, (config) => {
        const uplinkNames = Object.keys(config.uplinks);
        // Guard: must have at least 1 uplink
        fc.pre(uplinkNames.length >= 1);

        // Enable offline mode
        const { config: offlineConfig, snapshot } = enableOfflineModeInConfig(config);

        // Verify all uplinks have max_fails: 0 and fail_timeout: "0"
        for (const name of uplinkNames) {
          expect(offlineConfig.uplinks[name].max_fails).toBe(0);
          expect(offlineConfig.uplinks[name].fail_timeout).toBe('0');
        }

        // Disable offline mode using the snapshot
        const restoredConfig = disableOfflineModeInConfig(offlineConfig, snapshot);

        // Verify each uplink's max_fails and fail_timeout restored to original
        for (const name of uplinkNames) {
          expect(restoredConfig.uplinks[name].max_fails).toBe(config.uplinks[name].max_fails);
          expect(restoredConfig.uplinks[name].fail_timeout).toBe(config.uplinks[name].fail_timeout);
        }
      }),
      { numRuns: 100 },
    );
  });
});

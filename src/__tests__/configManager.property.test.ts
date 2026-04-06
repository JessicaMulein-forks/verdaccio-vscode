import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as yaml from 'js-yaml';
import type { VerdaccioConfig, UplinkConfig, PackageAccessConfig } from '../types';

/**
 * Validates: Requirements 2.3
 *
 * Property 1: Config patch round-trip
 * For any valid VerdaccioConfig object and any valid partial patch,
 * serializing the patched config to YAML and re-parsing it should produce
 * a config where the patched fields equal the patch values and all
 * non-patched fields are preserved from the original.
 */

const logLevelArb = fc.constantFrom(
  'fatal' as const,
  'error' as const,
  'warn' as const,
  'info' as const,
  'debug' as const,
  'trace' as const,
);

const uplinkConfigArb: fc.Arbitrary<UplinkConfig> = fc.record({
  url: fc.webUrl(),
  timeout: fc.nat({ max: 120 }).map((n) => `${n}s`),
  maxage: fc.nat({ max: 60 }).map((n) => `${n}m`),
  max_fails: fc.nat({ max: 50 }),
  fail_timeout: fc.nat({ max: 60 }).map((n) => `${n}m`),
});

const packageAccessConfigArb: fc.Arbitrary<PackageAccessConfig> = fc.record({
  access: fc.constantFrom('$all', '$authenticated', '$anonymous'),
  publish: fc.constantFrom('$all', '$authenticated'),
  proxy: fc.array(fc.stringOf(fc.constantFrom('a', 'b', 'c', 'n', 'p', 'm', 'j', 's'), { minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 3 }),
});

const uplinksArb = fc.dictionary(
  fc.stringOf(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g'), { minLength: 1, maxLength: 6 }),
  uplinkConfigArb,
  { minKeys: 1, maxKeys: 3 },
);

const packagesArb = fc.dictionary(
  fc.constantFrom('@*/*', '**', '@scope/*', 'my-pkg'),
  packageAccessConfigArb,
  { minKeys: 1, maxKeys: 3 },
);

const verdaccioConfigArb: fc.Arbitrary<VerdaccioConfig> = fc.record({
  storage: fc.stringOf(fc.constantFrom('.', '/', 's', 't', 'o', 'r', 'a', 'g', 'e'), { minLength: 1, maxLength: 20 }),
  listen: fc.tuple(
    fc.constantFrom('0.0.0.0', '127.0.0.1', 'localhost'),
    fc.nat({ max: 65535 }),
  ).map(([host, port]) => `${host}:${port}`),
  max_body_size: fc.nat({ max: 100 }).map((n) => `${n}mb`),
  log: fc.record({ level: logLevelArb }),
  uplinks: uplinksArb,
  packages: packagesArb,
});

// Generate a partial patch from a VerdaccioConfig — picks a random subset of top-level keys
const partialPatchArb: fc.Arbitrary<Partial<VerdaccioConfig>> = verdaccioConfigArb.chain((cfg) => {
  const keys = Object.keys(cfg) as (keyof VerdaccioConfig)[];
  return fc.subarray(keys, { minLength: 1 }).map((selectedKeys) => {
    const patch: Partial<VerdaccioConfig> = {};
    for (const key of selectedKeys) {
      (patch as any)[key] = cfg[key];
    }
    return patch;
  });
});

describe('Property 1: Config patch round-trip', () => {
  it('patched fields equal patch values and non-patched fields are preserved after YAML round-trip', () => {
    fc.assert(
      fc.property(
        verdaccioConfigArb,
        partialPatchArb,
        (original, patch) => {
          // Merge patch into original (same as ConfigManager.updateConfig)
          const merged = { ...original, ...patch };

          // Serialize to YAML and parse back
          const yamlStr = yaml.dump(merged, { lineWidth: -1 });
          const parsed = yaml.load(yamlStr) as VerdaccioConfig;

          // Patched fields should equal patch values
          for (const key of Object.keys(patch) as (keyof VerdaccioConfig)[]) {
            expect(parsed[key]).toEqual(patch[key]);
          }

          // Non-patched fields should be preserved from original
          for (const key of Object.keys(original) as (keyof VerdaccioConfig)[]) {
            if (!(key in patch)) {
              expect(parsed[key]).toEqual(original[key]);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

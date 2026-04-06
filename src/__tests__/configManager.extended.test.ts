import { describe, it, expect, vi } from 'vitest';
import type { VerdaccioConfig } from '../types';

// Minimal vscode mock — configManager.ts imports vscode at module level
vi.mock('vscode', () => ({
  workspace: { getConfiguration: vi.fn(() => ({ get: vi.fn() })), workspaceFolders: undefined },
  window: { showTextDocument: vi.fn(), showWarningMessage: vi.fn() },
  Uri: { file: vi.fn() },
}));

import {
  setCacheStrategy,
  enableOfflineModeInConfig,
  disableOfflineModeInConfig,
  setGlobalProxy,
  setUplinkProxy,
} from '../configManager';

/** Helper: creates a minimal VerdaccioConfig for testing */
function makeConfig(overrides?: Partial<VerdaccioConfig>): VerdaccioConfig {
  return {
    storage: './storage',
    listen: '0.0.0.0:4873',
    max_body_size: '10mb',
    log: { level: 'warn' },
    uplinks: {
      npmjs: {
        url: 'https://registry.npmjs.org/',
        timeout: '30s',
        maxage: '2m',
        max_fails: 5,
        fail_timeout: '5m',
      },
    },
    packages: {
      '**': { access: '$all', publish: '$authenticated', proxy: ['npmjs'] },
    },
    ...overrides,
  };
}

/**
 * Validates: Requirement 10.7
 * cache-first sets maxage to '9999d'
 */
describe('setCacheStrategy', () => {
  it('cache-first sets maxage to 9999d', () => {
    const config = makeConfig();
    const result = setCacheStrategy(config, 'npmjs', 'cache-first');
    expect(result.uplinks.npmjs.maxage).toBe('9999d');
  });

  /**
   * Validates: Requirement 10.8
   * proxy-first sets maxage to '0'
   */
  it('proxy-first sets maxage to 0', () => {
    const config = makeConfig();
    const result = setCacheStrategy(config, 'npmjs', 'proxy-first');
    expect(result.uplinks.npmjs.maxage).toBe('0');
  });

  it('throws when uplink does not exist', () => {
    const config = makeConfig();
    expect(() => setCacheStrategy(config, 'nonexistent', 'cache-first')).toThrow(
      'Uplink "nonexistent" not found in config',
    );
  });
});

/**
 * Validates: Requirements 10.4, 10.5
 * Offline mode enable/disable round-trip
 */
describe('enableOfflineModeInConfig / disableOfflineModeInConfig', () => {
  it('enable sets all uplinks to max_fails: 0 and fail_timeout: "0"', () => {
    const config = makeConfig({
      uplinks: {
        npmjs: { url: 'https://registry.npmjs.org/', timeout: '30s', maxage: '2m', max_fails: 5, fail_timeout: '5m' },
        github: { url: 'https://npm.pkg.github.com/', timeout: '15s', maxage: '10m', max_fails: 3, fail_timeout: '2m' },
      },
    });

    const { config: offlineConfig, snapshot } = enableOfflineModeInConfig(config);

    expect(offlineConfig.uplinks.npmjs.max_fails).toBe(0);
    expect(offlineConfig.uplinks.npmjs.fail_timeout).toBe('0');
    expect(offlineConfig.uplinks.github.max_fails).toBe(0);
    expect(offlineConfig.uplinks.github.fail_timeout).toBe('0');

    // Snapshot should preserve originals
    expect(snapshot.uplinks.npmjs.max_fails).toBe(5);
    expect(snapshot.uplinks.npmjs.fail_timeout).toBe('5m');
    expect(snapshot.uplinks.github.max_fails).toBe(3);
    expect(snapshot.uplinks.github.fail_timeout).toBe('2m');
  });

  it('disable restores original uplink settings from snapshot', () => {
    const config = makeConfig({
      uplinks: {
        npmjs: { url: 'https://registry.npmjs.org/', timeout: '30s', maxage: '2m', max_fails: 5, fail_timeout: '5m' },
        github: { url: 'https://npm.pkg.github.com/', timeout: '15s', maxage: '10m', max_fails: 3, fail_timeout: '2m' },
      },
    });

    const { config: offlineConfig, snapshot } = enableOfflineModeInConfig(config);
    const restored = disableOfflineModeInConfig(offlineConfig, snapshot);

    expect(restored.uplinks.npmjs.max_fails).toBe(5);
    expect(restored.uplinks.npmjs.fail_timeout).toBe('5m');
    expect(restored.uplinks.github.max_fails).toBe(3);
    expect(restored.uplinks.github.fail_timeout).toBe('2m');
  });
});

/**
 * Validates: Requirement 14.3
 * Global proxy URL write to config
 */
describe('setGlobalProxy', () => {
  it('writes http_proxy and https_proxy to root config', () => {
    const config = makeConfig();
    const result = setGlobalProxy(config, 'http://proxy.corp.com:8080', 'https://proxy.corp.com:8443');

    expect(result.http_proxy).toBe('http://proxy.corp.com:8080');
    expect(result.https_proxy).toBe('https://proxy.corp.com:8443');
  });

  it('writes no_proxy to root config', () => {
    const config = makeConfig();
    const result = setGlobalProxy(config, undefined, undefined, 'localhost,127.0.0.1');

    expect(result.no_proxy).toBe('localhost,127.0.0.1');
  });

  it('clears proxy fields when set to empty string', () => {
    const config = makeConfig({ http_proxy: 'http://old.proxy:8080' });
    const result = setGlobalProxy(config, '');

    expect(result.http_proxy).toBeUndefined();
  });

  /**
   * Validates: Requirement 14.7
   * Invalid proxy URL throws error
   */
  it('throws on invalid HTTP proxy URL', () => {
    const config = makeConfig();
    expect(() => setGlobalProxy(config, 'not-a-url')).toThrow('Invalid HTTP proxy URL');
  });

  it('throws on invalid HTTPS proxy URL', () => {
    const config = makeConfig();
    expect(() => setGlobalProxy(config, undefined, 'ftp://bad.proxy')).toThrow('Invalid HTTPS proxy URL');
  });
});

/**
 * Validates: Requirement 14.4
 * Per-uplink proxy override write
 */
describe('setUplinkProxy', () => {
  it('writes http_proxy and https_proxy to a specific uplink', () => {
    const config = makeConfig();
    const result = setUplinkProxy(config, 'npmjs', 'http://uplink-proxy.corp.com:3128', 'https://uplink-proxy.corp.com:3129');

    expect(result.uplinks.npmjs.http_proxy).toBe('http://uplink-proxy.corp.com:3128');
    expect(result.uplinks.npmjs.https_proxy).toBe('https://uplink-proxy.corp.com:3129');
  });

  it('throws when uplink does not exist', () => {
    const config = makeConfig();
    expect(() => setUplinkProxy(config, 'nonexistent', 'http://proxy:8080')).toThrow(
      'Uplink "nonexistent" not found in config',
    );
  });

  it('throws on invalid proxy URL for uplink', () => {
    const config = makeConfig();
    expect(() => setUplinkProxy(config, 'npmjs', 'bad-url')).toThrow('Invalid HTTP proxy URL');
  });
});

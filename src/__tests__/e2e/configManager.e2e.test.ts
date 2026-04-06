/**
 * E2E tests for ConfigManager — real file system, real YAML parsing.
 * No mocks. Uses temp directories.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as yaml from 'js-yaml';

// Minimal vscode mock — only what ConfigManager needs
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, def: any) => {
        if (key === 'configPath') return 'config.yaml';
        return def;
      },
    }),
    workspaceFolders: undefined as any,
  },
  window: { showTextDocument: vi.fn() },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

import * as vscode from 'vscode';
import { ConfigManager } from '../../configManager';
import type { VerdaccioConfig } from '../../types';

describe('ConfigManager E2E', () => {
  let tmpDir: string;
  let configManager: ConfigManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verdaccio-e2e-config-'));
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    configManager = new ConfigManager();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('generates default config, reads it back, and verifies all defaults', async () => {
    expect(await configManager.configExists()).toBe(false);

    await configManager.generateDefaultConfig();

    expect(await configManager.configExists()).toBe(true);

    const config = await configManager.readConfig();
    expect(config.storage).toBe('./storage');
    expect(config.listen).toBe('0.0.0.0:4873');
    expect(config.max_body_size).toBe('10mb');
    expect(config.log.level).toBe('warn');
    expect(config.uplinks.npmjs).toBeDefined();
    expect(config.uplinks.npmjs.url).toBe('https://registry.npmjs.org/');
    expect(config.packages).toBeDefined();
  });

  it('updateConfig merges patches and preserves unpatched fields', async () => {
    await configManager.generateDefaultConfig();
    const original = await configManager.readConfig();

    await configManager.updateConfig({ listen: '127.0.0.1:5000', max_body_size: '50mb' });

    const updated = await configManager.readConfig();
    expect(updated.listen).toBe('127.0.0.1:5000');
    expect(updated.max_body_size).toBe('50mb');
    // Unpatched fields preserved
    expect(updated.storage).toBe(original.storage);
    expect(updated.log.level).toBe(original.log.level);
    expect(updated.uplinks.npmjs.url).toBe(original.uplinks.npmjs.url);
  });

  it('updateConfig round-trips through YAML without data loss', async () => {
    await configManager.generateDefaultConfig();

    // Apply multiple patches sequentially
    await configManager.updateConfig({ listen: '0.0.0.0:9999' });
    await configManager.updateConfig({ log: { level: 'debug' } });
    await configManager.updateConfig({ max_body_size: '100mb' });

    const final = await configManager.readConfig();
    expect(final.listen).toBe('0.0.0.0:9999');
    expect(final.log.level).toBe('debug');
    expect(final.max_body_size).toBe('100mb');
    expect(final.storage).toBe('./storage');
  });

  it('raw config file is valid YAML after multiple updates', async () => {
    await configManager.generateDefaultConfig();
    await configManager.updateConfig({ listen: '0.0.0.0:8080' });

    const configPath = configManager.getConfigPath();
    const rawContent = await fs.readFile(configPath, 'utf-8');
    const parsed = yaml.load(rawContent) as VerdaccioConfig;

    expect(parsed.listen).toBe('0.0.0.0:8080');
    expect(parsed.storage).toBe('./storage');
  });

  it('configExists returns false for missing file', async () => {
    expect(await configManager.configExists()).toBe(false);
  });

  it('readConfig throws when config file does not exist', async () => {
    await expect(configManager.readConfig()).rejects.toThrow();
  });

  it('updateConfig throws when config file does not exist', async () => {
    await expect(configManager.updateConfig({ storage: './new' })).rejects.toThrow();
  });
});

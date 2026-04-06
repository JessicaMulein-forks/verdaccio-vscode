/**
 * E2E tests for StorageAnalyticsProvider — real storage directory scanning,
 * analytics computation, and pruning on real files.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined as any,
    getConfiguration: () => ({
      get: (key: string, def: any) => {
        if (key === 'configPath') return 'config.yaml';
        if (key === 'storageWarningThresholdMb') return 500;
        if (key === 'stalenessThresholdDays') return 90;
        return def;
      },
    }),
  },
  window: {
    showWarningMessage: vi.fn().mockResolvedValue('Delete'),
    showInformationMessage: vi.fn(),
  },
  EventEmitter: class {
    fire = vi.fn(); dispose = vi.fn(); event = vi.fn();
  },
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0 },
  ThemeIcon: class { constructor(public id: string) {} },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import { StorageAnalyticsProvider } from '../../storageAnalyticsProvider';
import { ConfigManager } from '../../configManager';

async function createFakeStorage(storagePath: string, packages: Record<string, Record<string, { size: number; time?: string }>>) {
  for (const [name, versions] of Object.entries(packages)) {
    const pkgDir = name.startsWith('@')
      ? path.join(storagePath, ...name.split('/'))
      : path.join(storagePath, name);
    await fs.mkdir(pkgDir, { recursive: true });

    const versionEntries: Record<string, any> = {};
    for (const [ver, meta] of Object.entries(versions)) {
      versionEntries[ver] = { _size: meta.size, description: `${name}@${ver}`, time: meta.time };
      // Create a fake tarball
      const tarballName = `${name.replace(/^@[^/]+\//, '')}-${ver}.tgz`;
      const tarballContent = Buffer.alloc(meta.size, 'x');
      await fs.writeFile(path.join(pkgDir, tarballName), tarballContent);
    }
    await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ versions: versionEntries }), 'utf-8');
  }
}

describe('StorageAnalyticsProvider E2E', () => {
  let tmpDir: string;
  let storagePath: string;
  let configManager: ConfigManager;
  let provider: StorageAnalyticsProvider;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verdaccio-e2e-analytics-'));
    storagePath = path.join(tmpDir, 'storage');
    await fs.mkdir(storagePath, { recursive: true });

    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir } }];

    // Write config
    const configPath = path.join(tmpDir, 'config.yaml');
    await fs.writeFile(configPath, yaml.dump({
      storage: './storage',
      listen: '0.0.0.0:4873',
      max_body_size: '10mb',
      log: { level: 'warn' },
      uplinks: {},
      packages: {},
    }), 'utf-8');

    configManager = new ConfigManager();
    provider = new StorageAnalyticsProvider(configManager);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('computes correct analytics for a populated storage directory', async () => {
    await createFakeStorage(storagePath, {
      'lodash': { '4.17.21': { size: 1024 }, '4.17.20': { size: 900 } },
      'express': { '4.18.0': { size: 2048 } },
      '@myorg/utils': { '1.0.0': { size: 512 } },
    });

    const analytics = await provider.computeAnalytics();

    expect(analytics.packageCount).toBe(3);
    expect(analytics.versionCount).toBe(4);
    expect(analytics.totalDiskUsageBytes).toBeGreaterThan(0);
    expect(analytics.largestPackages.length).toBeLessThanOrEqual(5);
    // Largest should be express at 2048
    expect(analytics.largestPackages[0].sizeBytes).toBeGreaterThanOrEqual(2048);
  });

  it('returns empty analytics for empty storage', async () => {
    const analytics = await provider.computeAnalytics();
    expect(analytics.packageCount).toBe(0);
    expect(analytics.versionCount).toBe(0);
    expect(analytics.totalDiskUsageBytes).toBe(0);
  });

  it('handles scoped packages correctly in analytics', async () => {
    await createFakeStorage(storagePath, {
      '@fortawesome/fontawesome-free': { '6.0.0': { size: 4096 }, '5.15.4': { size: 3072 } },
      '@fortawesome/fontawesome-svg-core': { '6.0.0': { size: 1024 } },
    });

    const analytics = await provider.computeAnalytics();
    expect(analytics.packageCount).toBe(2);
    expect(analytics.versionCount).toBe(3);
  });

  it('tree view renders correct metric items', async () => {
    await createFakeStorage(storagePath, {
      'lodash': { '4.17.21': { size: 1024 } },
    });

    // Trigger refresh to populate analytics
    const analytics = await provider.computeAnalytics();
    (provider as any)._analytics = analytics;

    const children = provider.getChildren();
    expect(children.length).toBeGreaterThanOrEqual(4); // 4 metrics + largest packages

    const labels = children.map((c: any) => c.type === 'metric' ? c.label : c.name);
    expect(labels).toContain('Total Disk Usage');
    expect(labels).toContain('Packages');
    expect(labels).toContain('Versions');
    expect(labels).toContain('Stale Packages');
  });
});

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  StorageAnalytics,
  PackageSizeInfo,
  StalePackageInfo,
  PruneResult,
  AnalyticsItem,
  AnalyticsMetricNode,
  AnalyticsPackageNode,
  ExtensionSettings,
} from './types';
import { IConfigManager } from './configManager';

// ---------------------------------------------------------------------------
// Pure helper types
// ---------------------------------------------------------------------------

export interface PackageAnalyticsInput {
  name: string;
  versions: {
    version: string;
    sizeBytes: number;
    lastAccessDate: Date;
  }[];
}

// ---------------------------------------------------------------------------
// Pure functions (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Returns true when the total usage (in bytes) exceeds the threshold (in MB).
 */
export function shouldTriggerStorageWarning(
  usageBytes: number,
  thresholdMb: number,
): boolean {
  return usageBytes > thresholdMb * 1024 * 1024;
}

/**
 * Returns true iff the last access date exceeds the staleness threshold in days.
 */
export function isStalePackage(
  lastAccessDate: Date,
  thresholdDays: number,
  now: Date = new Date(),
): boolean {
  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
  const elapsed = now.getTime() - lastAccessDate.getTime();
  return elapsed > thresholdMs;
}

/**
 * Selects the N most recently published versions to keep; the rest are pruned.
 * Returns arrays of version strings. If keepCount >= versions.length, nothing is pruned.
 */
export function selectVersionsToKeep(
  versions: { version: string; publishDate: Date }[],
  keepCount: number,
): { keep: string[]; prune: string[] } {
  if (keepCount <= 0) {
    return { keep: [], prune: versions.map((v) => v.version) };
  }
  if (keepCount >= versions.length) {
    return { keep: versions.map((v) => v.version), prune: [] };
  }
  // Sort descending by publishDate (most recent first)
  const sorted = [...versions].sort(
    (a, b) => b.publishDate.getTime() - a.publishDate.getTime(),
  );
  return {
    keep: sorted.slice(0, keepCount).map((v) => v.version),
    prune: sorted.slice(keepCount).map((v) => v.version),
  };
}

/**
 * Computes aggregate storage analytics from a list of packages.
 */
export function computeStorageAnalytics(
  packages: PackageAnalyticsInput[],
  stalenessThresholdDays: number,
  now: Date = new Date(),
): StorageAnalytics {
  let totalDiskUsageBytes = 0;
  let versionCount = 0;
  const thresholdMs = stalenessThresholdDays * 24 * 60 * 60 * 1000;

  // Collect all version-level size info for "largest packages"
  const allVersionSizes: PackageSizeInfo[] = [];

  // Track stale packages: a package is stale if ALL its versions are stale
  // (i.e. the most recent access across all versions still exceeds threshold)
  let stalePackageCount = 0;

  for (const pkg of packages) {
    let latestAccess = 0;

    for (const v of pkg.versions) {
      totalDiskUsageBytes += v.sizeBytes;
      versionCount += 1;
      if (v.lastAccessDate.getTime() > latestAccess) {
        latestAccess = v.lastAccessDate.getTime();
      }
      allVersionSizes.push({
        name: pkg.name,
        version: v.version,
        sizeBytes: v.sizeBytes,
      });
    }

    // A package is stale if its most recent version access exceeds the threshold
    if (pkg.versions.length > 0 && now.getTime() - latestAccess > thresholdMs) {
      stalePackageCount += 1;
    }
  }

  // Top 5 largest by sizeBytes descending
  const largestPackages = [...allVersionSizes]
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 5);

  return {
    totalDiskUsageBytes,
    packageCount: packages.length,
    versionCount,
    largestPackages,
    stalePackageCount,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
  if (bytes < 1024 * 1024 * 1024) { return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IStorageAnalyticsProvider extends vscode.TreeDataProvider<AnalyticsItem> {
  refresh(): void;
  computeAnalytics(): Promise<StorageAnalytics>;
  checkThreshold(): Promise<void>;
  pruneOldVersionsWithConfirmation(packageName: string, keepCount: number): Promise<PruneResult>;
  bulkCleanupWithConfirmation(packages: StalePackageInfo[]): Promise<PruneResult>;
  pruneOldVersions(packageName: string, keepCount: number): Promise<PruneResult>;
  bulkCleanup(packages: StalePackageInfo[]): Promise<PruneResult>;
  getStalePackages(): Promise<StalePackageInfo[]>;
}

// ---------------------------------------------------------------------------
// StorageAnalyticsProvider class
// ---------------------------------------------------------------------------

export class StorageAnalyticsProvider implements IStorageAnalyticsProvider {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;

  private readonly _configManager: IConfigManager;
  private _analytics: StorageAnalytics | undefined;

  constructor(configManager: IConfigManager) {
    this._configManager = configManager;
  }

  // ---- TreeDataProvider ----

  getTreeItem(element: AnalyticsItem): vscode.TreeItem {
    if (element.type === 'metric') {
      const item = new vscode.TreeItem(
        `${element.label}: ${element.value}`,
        vscode.TreeItemCollapsibleState.None,
      );
      item.contextValue = 'metric';
      item.iconPath = new vscode.ThemeIcon('graph');
      return item;
    }
    // largestPackage
    const item = new vscode.TreeItem(
      `${element.name} — ${formatBytes(element.sizeBytes)}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.contextValue = 'largestPackage';
    item.iconPath = new vscode.ThemeIcon('package');
    return item;
  }

  getChildren(element?: AnalyticsItem): AnalyticsItem[] {
    if (element) {
      return [];
    }
    if (!this._analytics) {
      return [];
    }
    const a = this._analytics;
    const items: AnalyticsItem[] = [
      { type: 'metric', label: 'Total Disk Usage', value: formatBytes(a.totalDiskUsageBytes) },
      { type: 'metric', label: 'Packages', value: String(a.packageCount) },
      { type: 'metric', label: 'Versions', value: String(a.versionCount) },
      { type: 'metric', label: 'Stale Packages', value: String(a.stalePackageCount) },
    ];
    for (const lp of a.largestPackages) {
      items.push({ type: 'largestPackage', name: `${lp.name}@${lp.version}`, sizeBytes: lp.sizeBytes });
    }
    return items;
  }

  // ---- Public API ----

  refresh(): void {
    this.computeAnalytics()
      .then((analytics) => {
        this._analytics = analytics;
        this._onDidChangeTreeData.fire();
      })
      .catch(() => {
        this._analytics = undefined;
        this._onDidChangeTreeData.fire();
      });
  }

  async computeAnalytics(): Promise<StorageAnalytics> {
    const storagePath = await this._getStoragePath();
    const packages = await this._scanPackages(storagePath);
    const settings = this._getSettings();
    return computeStorageAnalytics(packages, settings.stalenessThresholdDays);
  }

  async checkThreshold(): Promise<void> {
    const analytics = await this.computeAnalytics();
    const settings = this._getSettings();
    if (shouldTriggerStorageWarning(analytics.totalDiskUsageBytes, settings.storageWarningThresholdMb)) {
      const usageStr = formatBytes(analytics.totalDiskUsageBytes);
      vscode.window.showWarningMessage(
        `Storage usage (${usageStr}) exceeds the configured threshold of ${settings.storageWarningThresholdMb} MB.`,
      );
    }
  }

  async pruneOldVersionsWithConfirmation(packageName: string, keepCount: number): Promise<PruneResult> {
    // Compute size to be freed before prompting
    const storagePath = await this._getStoragePath();
    const packages = await this._scanPackages(storagePath);
    const pkg = packages.find((p) => p.name === packageName);
    if (!pkg) {
      return { deletedCount: 0, freedBytes: 0 };
    }

    const versionsWithDates = pkg.versions.map((v) => ({
      version: v.version,
      publishDate: v.lastAccessDate,
      sizeBytes: v.sizeBytes,
    }));
    const { prune } = selectVersionsToKeep(versionsWithDates, keepCount);
    if (prune.length === 0) {
      return { deletedCount: 0, freedBytes: 0 };
    }

    const totalToFree = prune.reduce((sum, ver) => {
      const info = pkg.versions.find((v) => v.version === ver);
      return sum + (info?.sizeBytes ?? 0);
    }, 0);

    const confirm = await vscode.window.showWarningMessage(
      `This will delete ${prune.length} version(s) of "${packageName}", freeing ${formatBytes(totalToFree)}. Continue?`,
      { modal: true },
      'Delete',
    );
    if (confirm !== 'Delete') {
      return { deletedCount: 0, freedBytes: 0 };
    }

    const result = await this.pruneOldVersions(packageName, keepCount);
    this.refresh();
    vscode.window.showInformationMessage(`Cleanup complete: freed ${formatBytes(result.freedBytes)}.`);
    return result;
  }

  async bulkCleanupWithConfirmation(packages: StalePackageInfo[]): Promise<PruneResult> {
    if (packages.length === 0) {
      return { deletedCount: 0, freedBytes: 0 };
    }

    const totalToFree = packages.reduce((sum, p) => sum + p.sizeBytes, 0);

    const confirm = await vscode.window.showWarningMessage(
      `This will delete ${packages.length} stale package version(s), freeing ${formatBytes(totalToFree)}. Continue?`,
      { modal: true },
      'Delete',
    );
    if (confirm !== 'Delete') {
      return { deletedCount: 0, freedBytes: 0 };
    }

    const result = await this.bulkCleanup(packages);
    this.refresh();
    vscode.window.showInformationMessage(`Cleanup complete: freed ${formatBytes(result.freedBytes)}.`);
    return result;
  }

  async getStalePackages(): Promise<StalePackageInfo[]> {
    const storagePath = await this._getStoragePath();
    const packages = await this._scanPackages(storagePath);
    const settings = this._getSettings();
    const now = new Date();
    const result: StalePackageInfo[] = [];

    for (const pkg of packages) {
      for (const v of pkg.versions) {
        if (isStalePackage(v.lastAccessDate, settings.stalenessThresholdDays, now)) {
          result.push({
            name: pkg.name,
            version: v.version,
            lastAccessDate: v.lastAccessDate,
            sizeBytes: v.sizeBytes,
          });
        }
      }
    }

    return result;
  }

  async pruneOldVersions(packageName: string, keepCount: number): Promise<PruneResult> {
    const storagePath = await this._getStoragePath();
    const packages = await this._scanPackages(storagePath);
    const pkg = packages.find((p) => p.name === packageName);
    if (!pkg) {
      return { deletedCount: 0, freedBytes: 0 };
    }

    const versionsWithDates = pkg.versions.map((v) => ({
      version: v.version,
      publishDate: v.lastAccessDate, // use lastAccessDate as proxy for publishDate
      sizeBytes: v.sizeBytes,
    }));

    const { prune } = selectVersionsToKeep(versionsWithDates, keepCount);
    if (prune.length === 0) {
      return { deletedCount: 0, freedBytes: 0 };
    }

    let freedBytes = 0;
    let deletedCount = 0;

    for (const version of prune) {
      const versionInfo = pkg.versions.find((v) => v.version === version);
      if (versionInfo) {
        freedBytes += versionInfo.sizeBytes;
        deletedCount += 1;
      }
      // Remove tarball file
      await this._removeTarball(storagePath, packageName, version);
    }

    // Update package.json to remove pruned versions
    await this._removeVersionsFromMetadata(storagePath, packageName, prune);

    return { deletedCount, freedBytes };
  }

  async bulkCleanup(packages: StalePackageInfo[]): Promise<PruneResult> {
    const storagePath = await this._getStoragePath();
    let freedBytes = 0;
    let deletedCount = 0;

    for (const pkg of packages) {
      try {
        await this._removeTarball(storagePath, pkg.name, pkg.version);
        await this._removeVersionsFromMetadata(storagePath, pkg.name, [pkg.version]);
        freedBytes += pkg.sizeBytes;
        deletedCount += 1;
      } catch {
        // Continue on failure
      }
    }

    return { deletedCount, freedBytes };
  }

  // ---- Private helpers ----

  private _getSettings(): ExtensionSettings {
    const config = vscode.workspace.getConfiguration('verdaccio');
    return {
      configPath: config.get<string>('configPath', '.verdaccio/config.yaml'),
      autoSetRegistry: config.get<boolean>('autoSetRegistry', false),
      storageWarningThresholdMb: config.get<number>('storageWarningThresholdMb', 500),
      stalenessThresholdDays: config.get<number>('stalenessThresholdDays', 90),
      mcpAutoStart: config.get<boolean>('mcp.autoStart', false),
      healthPingIntervalMs: config.get<number>('healthPingIntervalMs', 30000),
    };
  }

  private async _getStoragePath(): Promise<string> {
    const config = await this._configManager.readConfig();
    const configDir = path.dirname(this._configManager.getConfigPath());
    return path.isAbsolute(config.storage)
      ? config.storage
      : path.join(configDir, config.storage);
  }

  private async _scanPackages(storagePath: string): Promise<PackageAnalyticsInput[]> {
    const packages: PackageAnalyticsInput[] = [];

    try {
      const topLevelItems = await fs.readdir(storagePath, { withFileTypes: true });

      for (const item of topLevelItems) {
        if (!item.isDirectory()) { continue; }

        if (item.name.startsWith('@')) {
          // Scoped packages
          const scopeDir = path.join(storagePath, item.name);
          const scopeItems = await fs.readdir(scopeDir, { withFileTypes: true });
          for (const scopeItem of scopeItems) {
            if (!scopeItem.isDirectory()) { continue; }
            const fullName = `${item.name}/${scopeItem.name}`;
            const pkgDir = path.join(scopeDir, scopeItem.name);
            const entry = await this._readPackageAnalytics(pkgDir, fullName);
            if (entry) { packages.push(entry); }
          }
        } else {
          // Unscoped packages
          const pkgDir = path.join(storagePath, item.name);
          const entry = await this._readPackageAnalytics(pkgDir, item.name);
          if (entry) { packages.push(entry); }
        }
      }
    } catch {
      // Storage directory doesn't exist or is inaccessible
    }

    return packages;
  }

  private async _readPackageAnalytics(
    pkgDir: string,
    name: string,
  ): Promise<PackageAnalyticsInput | undefined> {
    try {
      const pkgJsonPath = path.join(pkgDir, 'package.json');
      const content = await fs.readFile(pkgJsonPath, 'utf-8');
      const pkgJson = JSON.parse(content);

      const versions: PackageAnalyticsInput['versions'] = [];

      if (pkgJson.versions && typeof pkgJson.versions === 'object') {
        for (const [ver, meta] of Object.entries<any>(pkgJson.versions)) {
          const tarballSize = await this._getTarballSize(pkgDir, ver);
          const lastAccess = meta?.time
            ? new Date(meta.time)
            : await this._getFileModifiedDate(pkgDir, ver);

          versions.push({
            version: ver,
            sizeBytes: tarballSize || (meta?._size ?? 0),
            lastAccessDate: lastAccess,
          });
        }
      }

      return { name, versions };
    } catch {
      return undefined;
    }
  }

  private async _getTarballSize(pkgDir: string, version: string): Promise<number> {
    try {
      const files = await fs.readdir(pkgDir);
      const tarball = files.find((f) => f.endsWith(`${version}.tgz`));
      if (tarball) {
        const stat = await fs.stat(path.join(pkgDir, tarball));
        return stat.size;
      }
    } catch {
      // ignore
    }
    return 0;
  }

  private async _getFileModifiedDate(pkgDir: string, version: string): Promise<Date> {
    try {
      const files = await fs.readdir(pkgDir);
      const tarball = files.find((f) => f.endsWith(`${version}.tgz`));
      if (tarball) {
        const stat = await fs.stat(path.join(pkgDir, tarball));
        return stat.mtime;
      }
    } catch {
      // ignore
    }
    return new Date(0);
  }

  private async _removeTarball(storagePath: string, packageName: string, version: string): Promise<void> {
    const pkgDir = this._getPackageDir(storagePath, packageName);
    try {
      const files = await fs.readdir(pkgDir);
      const tarball = files.find((f) => f.endsWith(`${version}.tgz`));
      if (tarball) {
        await fs.unlink(path.join(pkgDir, tarball));
      }
    } catch {
      // ignore
    }
  }

  private async _removeVersionsFromMetadata(
    storagePath: string,
    packageName: string,
    versions: string[],
  ): Promise<void> {
    const pkgDir = this._getPackageDir(storagePath, packageName);
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    try {
      const content = await fs.readFile(pkgJsonPath, 'utf-8');
      const pkgJson = JSON.parse(content);
      if (pkgJson.versions && typeof pkgJson.versions === 'object') {
        for (const ver of versions) {
          delete pkgJson.versions[ver];
        }
      }
      await fs.writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2), 'utf-8');
    } catch {
      // ignore
    }
  }

  private _getPackageDir(storagePath: string, packageName: string): string {
    // Handle scoped packages: @scope/name -> storagePath/@scope/name
    if (packageName.startsWith('@')) {
      const parts = packageName.split('/');
      return path.join(storagePath, parts[0], parts[1]);
    }
    return path.join(storagePath, packageName);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

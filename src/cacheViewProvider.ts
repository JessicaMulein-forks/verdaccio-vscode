import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { CacheItem, ScopeNode, PackageNode, VersionNode } from './types';
import { IConfigManager } from './configManager';

/**
 * Flat input representing a single package with its versions.
 */
export interface PackageEntry {
  name: string;
  scope?: string;
  versions: { version: string; description: string; tarballSize: number }[];
}

/**
 * Pure function: groups PackageEntry[] into a CacheItem[] tree by scope.
 * Scoped packages are grouped under ScopeNode parents.
 * Unscoped packages appear as top-level PackageNode items.
 * Exported for testability (Property 3).
 */
export function buildPackageTree(entries: PackageEntry[]): CacheItem[] {
  const scopeMap = new Map<string, PackageNode[]>();
  const unscopedPackages: PackageNode[] = [];

  for (const entry of entries) {
    const versionNodes: VersionNode[] = entry.versions.map((v) => ({
      type: 'version' as const,
      version: v.version,
      description: v.description,
      tarballSize: v.tarballSize,
      packageName: entry.scope ? `${entry.scope}/${entry.name}` : entry.name,
    }));

    const packageNode: PackageNode = {
      type: 'package' as const,
      name: entry.name,
      scope: entry.scope,
      path: '',
      versions: versionNodes,
    };

    if (entry.scope) {
      const existing = scopeMap.get(entry.scope) ?? [];
      existing.push(packageNode);
      scopeMap.set(entry.scope, existing);
    } else {
      unscopedPackages.push(packageNode);
    }
  }

  const result: CacheItem[] = [];

  // Add scope nodes sorted alphabetically
  const sortedScopes = Array.from(scopeMap.keys()).sort();
  for (const scopeName of sortedScopes) {
    const children = scopeMap.get(scopeName)!;
    children.sort((a, b) => a.name.localeCompare(b.name));
    result.push({
      type: 'scope' as const,
      name: scopeName,
      children,
    });
  }

  // Add unscoped packages sorted alphabetically
  unscopedPackages.sort((a, b) => a.name.localeCompare(b.name));
  result.push(...unscopedPackages);

  return result;
}

/**
 * Pure function: sums all tarball sizes from a list of entries.
 * Exported for testability (Property 4).
 */
export function computeTotalStorageSize(entries: { tarballSize: number }[]): number {
  return entries.reduce((sum, e) => sum + e.tarballSize, 0);
}

/**
 * Formats a byte count into a human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
  if (bytes < 1024 * 1024 * 1024) { return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export interface ICacheViewProvider extends vscode.TreeDataProvider<CacheItem> {
  refresh(): void;
  deletePackage(item: CacheItem): Promise<void>;
}

export class CacheViewProvider implements ICacheViewProvider {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;

  private readonly _configManager: IConfigManager;
  private _tree: CacheItem[] = [];
  private _totalSize: number = 0;
  private _watcher: vscode.FileSystemWatcher | undefined;
  private _refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(configManager: IConfigManager) {
    this._configManager = configManager;
    this._setupWatcher();
  }

  refresh(): void {
    this._scanStorage().then(() => {
      this._onDidChangeTreeData.fire();
    }).catch(() => {
      this._tree = [];
      this._totalSize = 0;
      this._onDidChangeTreeData.fire();
    });
  }

  async deletePackage(item: CacheItem): Promise<void> {
    if (item.type !== 'package') {
      return;
    }

    const fullName = item.scope ? `${item.scope}/${item.name}` : item.name;
    const answer = await vscode.window.showWarningMessage(
      `Are you sure you want to delete "${fullName}"?`,
      { modal: true },
      'Delete'
    );

    if (answer !== 'Delete') {
      return;
    }

    try {
      await fs.rm(item.path, { recursive: true, force: true });
      this.refresh();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to delete package: ${err.message}`);
    }
  }

  getTreeItem(element: CacheItem): vscode.TreeItem {
    switch (element.type) {
      case 'scope': {
        const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = 'scope';
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        return item;
      }
      case 'package': {
        const fullName = element.scope ? `${element.scope}/${element.name}` : element.name;
        const item = new vscode.TreeItem(fullName, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = 'package';
        item.iconPath = new vscode.ThemeIcon('package');
        item.description = `${element.versions.length} version(s)`;
        return item;
      }
      case 'version': {
        const item = new vscode.TreeItem(element.version, vscode.TreeItemCollapsibleState.None);
        item.contextValue = 'version';
        item.iconPath = new vscode.ThemeIcon('tag');
        item.description = formatBytes(element.tarballSize);
        item.tooltip = new vscode.MarkdownString(
          `**${element.packageName}@${element.version}**\n\n` +
          `${element.description || 'No description'}\n\n` +
          `Tarball size: ${formatBytes(element.tarballSize)}`
        );
        return item;
      }
    }
  }

  getChildren(element?: CacheItem): CacheItem[] {
    if (!element) {
      // Root level: show total storage size as a label, then the tree
      return this._tree;
    }

    switch (element.type) {
      case 'scope':
        return element.children;
      case 'package':
        return element.versions;
      case 'version':
        return [];
    }
  }

  /**
   * Returns the total storage size in bytes (for display in the root).
   */
  get totalSize(): number {
    return this._totalSize;
  }

  /**
   * Returns a formatted total storage size string.
   */
  get totalSizeFormatted(): string {
    return formatBytes(this._totalSize);
  }

  private async _scanStorage(): Promise<void> {
    let storagePath: string;
    try {
      const config = await this._configManager.readConfig();
      const configDir = path.dirname(this._configManager.getConfigPath());
      storagePath = path.isAbsolute(config.storage)
        ? config.storage
        : path.join(configDir, config.storage);
    } catch {
      this._tree = [];
      this._totalSize = 0;
      return;
    }

    const entries: PackageEntry[] = [];

    try {
      const topLevelItems = await fs.readdir(storagePath, { withFileTypes: true });

      for (const item of topLevelItems) {
        if (!item.isDirectory()) { continue; }

        if (item.name.startsWith('@')) {
          // Scoped packages: @scope/package-name
          const scopeDir = path.join(storagePath, item.name);
          const scopeItems = await fs.readdir(scopeDir, { withFileTypes: true });
          for (const scopeItem of scopeItems) {
            if (!scopeItem.isDirectory()) { continue; }
            const pkgEntry = await this._readPackageDir(
              path.join(scopeDir, scopeItem.name),
              scopeItem.name,
              item.name
            );
            if (pkgEntry) { entries.push(pkgEntry); }
          }
        } else {
          // Unscoped packages
          const pkgEntry = await this._readPackageDir(
            path.join(storagePath, item.name),
            item.name
          );
          if (pkgEntry) { entries.push(pkgEntry); }
        }
      }
    } catch {
      // Storage directory doesn't exist or is inaccessible
      this._tree = [];
      this._totalSize = 0;
      return;
    }

    // Build tree and compute total size
    this._tree = buildPackageTree(entries);

    // Set paths on package nodes for deletion support
    const entryPathMap = new Map<string, string>();
    for (const entry of entries) {
      const key = entry.scope ? `${entry.scope}/${entry.name}` : entry.name;
      const entryPath = entry.scope
        ? path.join(storagePath, entry.scope, entry.name)
        : path.join(storagePath, entry.name);
      entryPathMap.set(key, entryPath);
    }
    for (const node of this._tree) {
      if (node.type === 'package') {
        const key = node.scope ? `${node.scope}/${node.name}` : node.name;
        node.path = entryPathMap.get(key) ?? '';
      } else if (node.type === 'scope') {
        for (const child of node.children) {
          const key = `${node.name}/${child.name}`;
          child.path = entryPathMap.get(key) ?? '';
        }
      }
    }

    const allVersions = entries.flatMap((e) => e.versions);
    this._totalSize = computeTotalStorageSize(allVersions);
  }

  private async _readPackageDir(
    dirPath: string,
    name: string,
    scope?: string
  ): Promise<PackageEntry | undefined> {
    try {
      const pkgJsonPath = path.join(dirPath, 'package.json');
      const content = await fs.readFile(pkgJsonPath, 'utf-8');
      const pkgJson = JSON.parse(content);

      const versions: PackageEntry['versions'] = [];

      if (pkgJson.versions && typeof pkgJson.versions === 'object') {
        for (const [ver, meta] of Object.entries<any>(pkgJson.versions)) {
          versions.push({
            version: ver,
            description: meta?.description ?? '',
            tarballSize: meta?.dist?.tarball
              ? await this._getTarballSize(dirPath, ver)
              : (meta?._size ?? 0),
          });
        }
      }

      return { name, scope, versions };
    } catch {
      return undefined;
    }
  }

  private async _getTarballSize(pkgDir: string, version: string): Promise<number> {
    try {
      const tarballPattern = `${version}.tgz`;
      const files = await fs.readdir(pkgDir);
      const tarball = files.find((f) => f.endsWith(tarballPattern));
      if (tarball) {
        const stat = await fs.stat(path.join(pkgDir, tarball));
        return stat.size;
      }
    } catch {
      // ignore
    }
    return 0;
  }

  private _setupWatcher(): void {
    try {
      const configPath = this._configManager.getConfigPath();
      const configDir = path.dirname(configPath);
      // Watch the storage directory relative to config
      const storagePattern = new vscode.RelativePattern(configDir, 'storage/**');
      this._watcher = vscode.workspace.createFileSystemWatcher(storagePattern);

      const debouncedRefresh = () => {
        if (this._refreshTimer) {
          clearTimeout(this._refreshTimer);
        }
        this._refreshTimer = setTimeout(() => {
          this.refresh();
        }, 5000);
      };

      this._watcher.onDidCreate(debouncedRefresh);
      this._watcher.onDidDelete(debouncedRefresh);
    } catch {
      // Config path may not be available yet
    }
  }

  dispose(): void {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
    }
    this._watcher?.dispose();
    this._onDidChangeTreeData.dispose();
  }
}

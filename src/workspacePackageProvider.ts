import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { WorkspacePackageInfo, BulkPublishResult, PublishResult } from './types';
import { IServerManager } from './serverManager';
import { IPublishManager } from './publishManager';
import { IConfigManager } from './configManager';

export interface IWorkspacePackageProvider extends vscode.TreeDataProvider<WorkspacePackageItem> {
  refresh(): void;
  detectPackages(): Promise<WorkspacePackageInfo[]>;
  getPackagesInDependencyOrder(): Promise<WorkspacePackageInfo[]>;
  publishAll(): Promise<BulkPublishResult>;
  unpublishAll(): Promise<void>;
}

export class WorkspacePackageItem extends vscode.TreeItem {
  constructor(public readonly packageInfo: WorkspacePackageInfo) {
    super(`${packageInfo.name} (${packageInfo.version})`, vscode.TreeItemCollapsibleState.None);
    this.description = packageInfo.directory;
    this.tooltip = `${packageInfo.name}@${packageInfo.version}\n${packageInfo.directory}`;
  }
}

/**
 * Pure function: topological sort on a list of packages with named dependencies.
 * Returns package names in dependency order (dependencies before dependents).
 * Throws if a cycle is detected.
 */
export function topologicalSort(packages: { name: string; dependencies: string[] }[]): string[] {
  // Check for duplicate package names up front
  const seen = new Set<string>();
  for (const pkg of packages) {
    if (seen.has(pkg.name)) {
      throw new Error(`Duplicate package name detected: "${pkg.name}". Ensure workspace globs do not overlap.`);
    }
    seen.add(pkg.name);
  }

  const nameSet = new Set(packages.map((p) => p.name));
  const adjList = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const pkg of packages) {
    adjList.set(pkg.name, []);
    inDegree.set(pkg.name, 0);
  }

  for (const pkg of packages) {
    for (const dep of pkg.dependencies) {
      if (nameSet.has(dep)) {
        adjList.get(dep)!.push(pkg.name);
        inDegree.set(pkg.name, (inDegree.get(pkg.name) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) {
      queue.push(name);
    }
  }

  // Sort the initial queue for deterministic output
  queue.sort();

  const result: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    const neighbors = adjList.get(current) ?? [];
    // Sort neighbors for deterministic output
    neighbors.sort();
    for (const neighbor of neighbors) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
        queue.sort();
      }
    }
  }

  if (result.length !== packages.length) {
    throw new Error('Circular dependency detected among workspace packages');
  }

  return result;
}


/**
 * Pure function: resolves simple glob patterns from the workspaces field.
 * Supports patterns like "packages/*" by listing directories.
 */
export async function resolveWorkspaceGlobs(rootDir: string, patterns: string[]): Promise<string[]> {
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      // Simple glob: "packages/*" → list directories under "packages/"
      const base = pattern.replace(/\/?\*.*$/, '');
      const baseDir = path.join(rootDir, base);
      try {
        const entries = await fs.readdir(baseDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            dirs.push(path.join(baseDir, entry.name));
          }
        }
      } catch {
        // Directory doesn't exist, skip
      }
    } else {
      dirs.push(path.join(rootDir, pattern));
    }
  }
  return dirs;
}

export class WorkspacePackageProvider implements IWorkspacePackageProvider {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<WorkspacePackageItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _packages: WorkspacePackageInfo[] = [];
  private readonly _serverManager: IServerManager;
  private readonly _publishManager: IPublishManager;
  private readonly _configManager: IConfigManager;

  constructor(serverManager: IServerManager, publishManager: IPublishManager, configManager: IConfigManager) {
    this._serverManager = serverManager;
    this._publishManager = publishManager;
    this._configManager = configManager;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: WorkspacePackageItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<WorkspacePackageItem[]> {
    this._packages = await this.detectPackages();
    return this._packages.map((pkg) => new WorkspacePackageItem(pkg));
  }

  async detectPackages(): Promise<WorkspacePackageInfo[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return [];
    }

    const rootDir = workspaceFolders[0].uri.fsPath;
    const rootPkgPath = path.join(rootDir, 'package.json');

    let rootPkg: { workspaces?: string[] | { packages?: string[] } };
    try {
      const content = await fs.readFile(rootPkgPath, 'utf-8');
      rootPkg = JSON.parse(content);
    } catch {
      return [];
    }

    // Extract workspace patterns (support both array and object forms)
    let patterns: string[];
    if (Array.isArray(rootPkg.workspaces)) {
      patterns = rootPkg.workspaces;
    } else if (rootPkg.workspaces && Array.isArray(rootPkg.workspaces.packages)) {
      patterns = rootPkg.workspaces.packages;
    } else {
      return [];
    }

    const packageDirs = await resolveWorkspaceGlobs(rootDir, patterns);
    const packages: WorkspacePackageInfo[] = [];

    for (const dir of packageDirs) {
      try {
        const pkgJsonPath = path.join(dir, 'package.json');
        const content = await fs.readFile(pkgJsonPath, 'utf-8');
        const pkgJson = JSON.parse(content);
        if (!pkgJson.name) { continue; }

        const allDeps = {
          ...pkgJson.dependencies,
          ...pkgJson.devDependencies,
          ...pkgJson.peerDependencies,
        };

        packages.push({
          name: pkgJson.name,
          version: pkgJson.version ?? '0.0.0',
          directory: dir,
          dependencies: Object.keys(allDeps),
        });
      } catch {
        // Skip directories without valid package.json
      }
    }

    return packages;
  }

  async getPackagesInDependencyOrder(): Promise<WorkspacePackageInfo[]> {
    const packages = await this.detectPackages();
    const nameToPackage = new Map(packages.map((p) => [p.name, p]));
    const sortedNames = topologicalSort(
      packages.map((p) => ({
        name: p.name,
        // Filter dependencies to only workspace-internal ones
        dependencies: p.dependencies.filter((d) => nameToPackage.has(d)),
      })),
    );
    return sortedNames.map((name) => nameToPackage.get(name)!);
  }

  async publishAll(): Promise<BulkPublishResult> {
    // Guard: server must be running
    if (this._serverManager.state !== 'running') {
      const action = await vscode.window.showWarningMessage(
        'Verdaccio server is not running. Start the server first?',
        'Start Server',
        'Cancel',
      );
      if (action === 'Start Server') {
        await this._serverManager.start();
      }
      return { successes: [], failures: [] };
    }

    const ordered = await this.getPackagesInDependencyOrder();
    const successes: PublishResult[] = [];
    const failures: PublishResult[] = [];

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Publishing workspace packages',
        cancellable: false,
      },
      async (progress) => {
        for (let i = 0; i < ordered.length; i++) {
          const pkg = ordered[i];
          progress.report({
            message: `Publishing ${pkg.name} (${i + 1} of ${ordered.length})`,
            increment: (1 / ordered.length) * 100,
          });

          try {
            const result = await this._publishManager.publishToVerdaccio(pkg.directory);
            if (result.success) {
              successes.push(result);
            } else {
              failures.push(result);
            }
          } catch (err: any) {
            failures.push({
              success: false,
              packageName: pkg.name,
              version: pkg.version,
              error: err.message,
            });
          }
        }
      },
    );

    // Show summary
    if (failures.length === 0) {
      vscode.window.showInformationMessage(
        `Successfully published all ${successes.length} workspace packages.`,
      );
    } else {
      vscode.window.showWarningMessage(
        `Published ${successes.length} packages, ${failures.length} failed: ${failures.map((f) => f.packageName).join(', ')}`,
      );
    }

    return { successes, failures };
  }

  async unpublishAll(): Promise<void> {
    // Guard: server must be running
    if (this._serverManager.state !== 'running') {
      const action = await vscode.window.showWarningMessage(
        'Verdaccio server is not running. Start the server first?',
        'Start Server',
        'Cancel',
      );
      if (action === 'Start Server') {
        await this._serverManager.start();
      }
      return;
    }

    const packages = await this.detectPackages();
    if (packages.length === 0) {
      vscode.window.showInformationMessage('No workspace packages detected.');
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Remove all ${packages.length} workspace packages from Verdaccio storage?`,
      { modal: true },
      'Remove All',
    );

    if (confirm !== 'Remove All') {
      return;
    }

    // Resolve storage path from config
    let storagePath: string;
    try {
      const config = await this._configManager.readConfig();
      const configDir = path.dirname(this._configManager.getConfigPath());
      storagePath = path.isAbsolute(config.storage)
        ? config.storage
        : path.join(configDir, config.storage);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to read Verdaccio config: ${err.message}`);
      return;
    }

    let removed = 0;
    let failed = 0;

    for (const pkg of packages) {
      // Resolve package directory in storage (handle scoped packages)
      const packageDir = pkg.name.startsWith('@')
        ? path.join(storagePath, ...pkg.name.split('/'))
        : path.join(storagePath, pkg.name);

      try {
        await fs.rm(packageDir, { recursive: true, force: true });
        removed++;
      } catch {
        failed++;
      }
    }

    if (failed === 0) {
      vscode.window.showInformationMessage(
        `Removed all ${removed} workspace packages from Verdaccio storage.`,
      );
    } else {
      vscode.window.showWarningMessage(
        `Removed ${removed} packages, ${failed} failed to remove.`,
      );
    }
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

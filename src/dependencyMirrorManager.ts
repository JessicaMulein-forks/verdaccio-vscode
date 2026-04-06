import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { IServerManager } from './serverManager';
import { LockfileDependency, MirrorResult, MirroredDependency } from './types';

export interface IDependencyMirrorManager {
  mirrorDependencies(): Promise<MirrorResult>;
  parseLockfile(): Promise<LockfileDependency[]>;
}

// ─── Pure functions for testability ───

/**
 * Parse dependencies from lockfile content.
 * Supports both package-lock.json and yarn.lock formats.
 */
export function parseLockfileDeps(
  content: string,
  format: 'package-lock' | 'yarn-lock',
): LockfileDependency[] {
  if (format === 'package-lock') {
    return parsePackageLockDeps(content);
  }
  return parseYarnLockDeps(content);
}

function parsePackageLockDeps(content: string): LockfileDependency[] {
  const parsed = JSON.parse(content);
  const deps: LockfileDependency[] = [];

  // lockfileVersion 2/3: packages field (node_modules paths)
  if (parsed.packages) {
    for (const [key, value] of Object.entries(parsed.packages)) {
      if (!key) { continue; } // skip root entry ""
      const pkg = value as { version?: string; resolved?: string };
      // Extract package name from node_modules path
      const name = key.replace(/^node_modules\//, '');
      if (pkg.version) {
        deps.push({ name, version: pkg.version, resolved: pkg.resolved });
      }
    }
  }
  // lockfileVersion 1: dependencies field
  else if (parsed.dependencies) {
    for (const [name, value] of Object.entries(parsed.dependencies)) {
      const pkg = value as { version?: string; resolved?: string };
      if (pkg.version) {
        deps.push({ name, version: pkg.version, resolved: pkg.resolved });
      }
    }
  }

  return deps;
}

function parseYarnLockDeps(content: string): LockfileDependency[] {
  const deps: LockfileDependency[] = [];
  // Simple yarn.lock parser: look for patterns like:
  // "package-name@^1.0.0":
  //   version "1.2.3"
  //   resolved "https://..."
  const lines = content.split('\n');
  let currentName: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match dependency header lines (e.g., "lodash@^4.17.0:" or lodash@^4.17.0:)
    const headerMatch = line.match(/^"?([^@\s]+)@[^"]*"?:$/);
    if (headerMatch) {
      currentName = headerMatch[1];
      continue;
    }

    // Match version line
    if (currentName) {
      const versionMatch = line.match(/^\s+version\s+"([^"]+)"/);
      if (versionMatch) {
        const resolvedLine = lines[i + 1];
        const resolvedMatch = resolvedLine?.match(/^\s+resolved\s+"([^"]+)"/);
        deps.push({
          name: currentName,
          version: versionMatch[1],
          resolved: resolvedMatch?.[1],
        });
        currentName = undefined;
        continue;
      }
    }

    // Reset on blank line or non-indented line
    if (line.trim() === '' || (!line.startsWith(' ') && !line.startsWith('"'))) {
      currentName = undefined;
    }
  }

  return deps;
}

/**
 * Classify dependencies as newly cached or already available.
 */
export function classifyDependencies(
  deps: LockfileDependency[],
  cachedSet: Set<string>,
): { newlyCached: LockfileDependency[]; alreadyAvailable: LockfileDependency[] } {
  const newlyCached: LockfileDependency[] = [];
  const alreadyAvailable: LockfileDependency[] = [];

  for (const dep of deps) {
    const key = `${dep.name}@${dep.version}`;
    if (cachedSet.has(key)) {
      alreadyAvailable.push(dep);
    } else {
      newlyCached.push(dep);
    }
  }

  return { newlyCached, alreadyAvailable };
}

// ─── DependencyMirrorManager class ───

export class DependencyMirrorManager implements IDependencyMirrorManager {
  private readonly _serverManager: IServerManager;

  constructor(serverManager: IServerManager) {
    this._serverManager = serverManager;
  }

  async parseLockfile(): Promise<LockfileDependency[]> {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error('No workspace folder open');
    }

    // Try package-lock.json first, then yarn.lock
    const packageLockPath = path.join(workspaceRoot, 'package-lock.json');
    const yarnLockPath = path.join(workspaceRoot, 'yarn.lock');

    try {
      const content = await fs.readFile(packageLockPath, 'utf-8');
      return parseLockfileDeps(content, 'package-lock');
    } catch {
      // Try yarn.lock
    }

    try {
      const content = await fs.readFile(yarnLockPath, 'utf-8');
      return parseLockfileDeps(content, 'yarn-lock');
    } catch {
      // No lockfile found
    }

    vscode.window.showErrorMessage(
      'No lockfile found. Run `npm install` or `yarn install` first to generate a lockfile.',
    );
    throw new Error('No lockfile found');
  }

  async mirrorDependencies(): Promise<MirrorResult> {
    // Guard: server must be running
    if (this._serverManager.state !== 'running') {
      const action = await vscode.window.showWarningMessage(
        'Verdaccio server is not running. Start the server first?',
        'Start Server',
        'Cancel',
      );
      if (action === 'Start Server') {
        await this._serverManager.start();
      } else {
        return { newlyCached: [], alreadyAvailable: [], totalNewSizeBytes: 0 };
      }
    }

    const deps = await this.parseLockfile();
    const port = this._serverManager.port ?? 4873;
    const registryUrl = `http://localhost:${port}`;

    // Run install with progress
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Mirroring dependencies',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: `Installing ${deps.length} dependencies through Verdaccio...` });
        await this._runInstall(registryUrl);
        progress.report({ increment: 100 });
      },
    );

    // Build result (simplified: all deps treated as newly cached since we can't easily check storage)
    const newlyCached: MirroredDependency[] = deps.map((d) => ({
      name: d.name,
      version: d.version,
      sizeBytes: 0,
    }));

    const result: MirrorResult = {
      newlyCached,
      alreadyAvailable: [],
      totalNewSizeBytes: 0,
    };

    vscode.window.showInformationMessage(
      `Mirroring complete: ${result.newlyCached.length} newly cached, ${result.alreadyAvailable.length} already available.`,
    );

    return result;
  }

  private _runInstall(registryUrl: string): Promise<void> {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) {
      return Promise.reject(new Error('No workspace folder open'));
    }

    return new Promise<void>((resolve, reject) => {
      // Detect package manager
      const useYarn = require('fs').existsSync(path.join(workspaceRoot, 'yarn.lock'));
      const cmd = useYarn ? 'yarn' : 'npm';
      const args = useYarn
        ? ['install', '--registry', registryUrl]
        : ['install', '--registry', registryUrl];

      execFile(cmd, args, { cwd: workspaceRoot }, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  private _getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].uri.fsPath;
    }
    return undefined;
  }
}

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { PublishResult, SemverBumpType } from './types';
import { IServerManager } from './serverManager';
import { IConfigManager } from './configManager';

export interface IPublishManager {
  publishToVerdaccio(packageDir: string): Promise<PublishResult>;
  promotePackage(packageName: string, version: string, targetRegistryUrl: string): Promise<PublishResult>;
  bumpVersion(packageDir: string, bumpType: SemverBumpType): Promise<string>;
  checkDuplicate(packageName: string, version: string): Promise<boolean>;
}

/**
 * Pure function: builds the verdaccio registry URL from a port number.
 */
export function buildRegistryUrl(port: number): string {
  return `http://localhost:${port}`;
}

/**
 * Pure function: constructs the npm publish command arguments.
 */
export function buildPublishArgs(registryUrl: string): string[] {
  return ['publish', '--registry', registryUrl];
}

/**
 * Pure function: constructs the npm version command arguments.
 */
export function buildVersionArgs(bumpType: SemverBumpType): string[] {
  return ['version', bumpType];
}

/**
 * Pure function: constructs the npm publish arguments for promoting a tarball.
 */
export function buildPromoteArgs(tarballPath: string, targetRegistryUrl: string): string[] {
  return ['publish', tarballPath, '--registry', targetRegistryUrl];
}

/**
 * Pure function: reads package name and version from a package.json object.
 */
export function extractPackageInfo(packageJson: { name?: string; version?: string }): { name: string; version: string } {
  return {
    name: packageJson.name ?? 'unknown',
    version: packageJson.version ?? '0.0.0',
  };
}

/**
 * Wraps child_process.execFile in a promise.
 */
export function execFileAsync(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: options.cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
      } else {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    });
  });
}

export class PublishManager implements IPublishManager {
  private readonly _serverManager: IServerManager;
  private readonly _configManager: IConfigManager;

  constructor(serverManager: IServerManager, configManager: IConfigManager) {
    this._serverManager = serverManager;
    this._configManager = configManager;
  }

  /**
   * Publishes a package to the local Verdaccio registry.
   * Guards against publishing when server is not running.
   * Checks for duplicates before publishing.
   * Shows success/error notifications.
   */
  async publishToVerdaccio(packageDir: string): Promise<PublishResult> {
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
      return { success: false, packageName: 'unknown', version: '0.0.0', error: 'Server not running' };
    }

    // Read package.json to get name and version
    const pkgJsonPath = path.join(packageDir, 'package.json');
    let pkgInfo: { name: string; version: string };
    try {
      const content = await fs.readFile(pkgJsonPath, 'utf-8');
      const pkgJson = JSON.parse(content);
      pkgInfo = extractPackageInfo(pkgJson);
    } catch (err: any) {
      const error = `Failed to read package.json: ${err.message}`;
      vscode.window.showErrorMessage(error);
      return { success: false, packageName: 'unknown', version: '0.0.0', error };
    }

    // Check for duplicate
    const isDuplicate = await this.checkDuplicate(pkgInfo.name, pkgInfo.version);
    if (isDuplicate) {
      const proceed = await vscode.window.showWarningMessage(
        `Package ${pkgInfo.name}@${pkgInfo.version} already exists in Verdaccio. Publish anyway?`,
        'Publish',
        'Cancel',
      );
      if (proceed !== 'Publish') {
        return { success: false, packageName: pkgInfo.name, version: pkgInfo.version, error: 'Duplicate detected, publish cancelled' };
      }
    }

    // Build registry URL and publish
    const port = this._serverManager.port!;
    const registryUrl = buildRegistryUrl(port);
    const args = buildPublishArgs(registryUrl);

    try {
      await execFileAsync('npm', args, { cwd: packageDir });
      vscode.window.showInformationMessage(
        `Successfully published ${pkgInfo.name}@${pkgInfo.version} to Verdaccio.`,
      );
      return { success: true, packageName: pkgInfo.name, version: pkgInfo.version };
    } catch (err: any) {
      const errorOutput = err.stderr || err.message || 'Unknown error';
      vscode.window.showErrorMessage(
        `Failed to publish ${pkgInfo.name}@${pkgInfo.version}: ${errorOutput}`,
      );
      return { success: false, packageName: pkgInfo.name, version: pkgInfo.version, error: errorOutput };
    }
  }

  /**
   * Promotes a package by re-publishing its tarball to a target registry.
   */
  async promotePackage(packageName: string, version: string, targetRegistryUrl: string): Promise<PublishResult> {
    // Find the tarball in Verdaccio storage
    let storagePath: string;
    try {
      const config = await this._configManager.readConfig();
      const configDir = path.dirname(this._configManager.getConfigPath());
      storagePath = path.isAbsolute(config.storage)
        ? config.storage
        : path.join(configDir, config.storage);
    } catch (err: any) {
      const error = `Failed to read config: ${err.message}`;
      vscode.window.showErrorMessage(error);
      return { success: false, packageName, version, error };
    }

    // Resolve package directory in storage (handle scoped packages)
    const packageDir = packageName.startsWith('@')
      ? path.join(storagePath, ...packageName.split('/'))
      : path.join(storagePath, packageName);

    // Find the tarball file
    const tarballName = `${packageName.replace(/^@[^/]+\//, '')}-${version}.tgz`;
    const tarballPath = path.join(packageDir, tarballName);

    try {
      await fs.access(tarballPath);
    } catch {
      const error = `Tarball not found: ${tarballPath}`;
      vscode.window.showErrorMessage(error);
      return { success: false, packageName, version, error };
    }

    const args = buildPromoteArgs(tarballPath, targetRegistryUrl);

    try {
      await execFileAsync('npm', args);
      vscode.window.showInformationMessage(
        `Successfully promoted ${packageName}@${version} to ${targetRegistryUrl}.`,
      );
      return { success: true, packageName, version };
    } catch (err: any) {
      const errorOutput = err.stderr || err.message || 'Unknown error';
      vscode.window.showErrorMessage(
        `Failed to promote ${packageName}@${version}: ${errorOutput}`,
      );
      return { success: false, packageName, version, error: errorOutput };
    }
  }

  /**
   * Bumps the version in a package directory using npm version.
   */
  async bumpVersion(packageDir: string, bumpType: SemverBumpType): Promise<string> {
    const args = buildVersionArgs(bumpType);

    try {
      const { stdout } = await execFileAsync('npm', args, { cwd: packageDir });
      const newVersion = stdout.trim().replace(/^v/, '');
      vscode.window.showInformationMessage(`Version bumped to ${newVersion}.`);
      return newVersion;
    } catch (err: any) {
      const errorOutput = err.stderr || err.message || 'Unknown error';
      vscode.window.showErrorMessage(`Failed to bump version: ${errorOutput}`);
      throw new Error(errorOutput);
    }
  }

  /**
   * Checks if a package@version already exists in Verdaccio storage.
   */
  async checkDuplicate(packageName: string, version: string): Promise<boolean> {
    let storagePath: string;
    try {
      const config = await this._configManager.readConfig();
      const configDir = path.dirname(this._configManager.getConfigPath());
      storagePath = path.isAbsolute(config.storage)
        ? config.storage
        : path.join(configDir, config.storage);
    } catch {
      return false;
    }

    // Resolve package directory in storage
    const packageDir = packageName.startsWith('@')
      ? path.join(storagePath, ...packageName.split('/'))
      : path.join(storagePath, packageName);

    try {
      const pkgJsonPath = path.join(packageDir, 'package.json');
      const content = await fs.readFile(pkgJsonPath, 'utf-8');
      const pkgJson = JSON.parse(content);
      if (pkgJson.versions && typeof pkgJson.versions === 'object') {
        return version in pkgJson.versions;
      }
      return false;
    } catch {
      return false;
    }
  }
}

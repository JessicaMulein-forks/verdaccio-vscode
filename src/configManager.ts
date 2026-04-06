import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as yaml from 'js-yaml';
import { VerdaccioConfig, UplinkSnapshot, isValidRegistryUrl } from './types';

export interface IConfigManager extends vscode.Disposable {
  getConfigPath(): string;
  readConfig(): Promise<VerdaccioConfig>;
  updateConfig(patch: Partial<VerdaccioConfig>): Promise<void>;
  generateDefaultConfig(): Promise<void>;
  configExists(): Promise<boolean>;
  openRawConfig(): Promise<void>;
  setCacheStrategy(uplinkName: string, strategy: 'cache-first' | 'proxy-first'): Promise<void>;
  setUplinkCacheSettings(uplinkName: string, settings: { maxage?: string; cache_ttl?: string; timeout?: string }): Promise<void>;
  enableOfflineMode(): Promise<void>;
  disableOfflineMode(): Promise<void>;
  setGlobalProxy(httpProxy?: string, httpsProxy?: string, noProxy?: string): Promise<void>;
  setUplinkProxy(uplinkName: string, httpProxy?: string, httpsProxy?: string): Promise<void>;
}

// --- Pure functions for testability ---

/**
 * Sets cache strategy on a specific uplink in the config.
 * cache-first: maxage = '9999d' (prefer cached packages)
 * proxy-first: maxage = '0' (always check upstream)
 */
export function setCacheStrategy(
  config: VerdaccioConfig,
  uplinkName: string,
  strategy: 'cache-first' | 'proxy-first',
): VerdaccioConfig {
  const uplink = config.uplinks[uplinkName];
  if (!uplink) {
    throw new Error(`Uplink "${uplinkName}" not found in config`);
  }
  const newMaxage = strategy === 'cache-first' ? '9999d' : '0';
  return {
    ...config,
    uplinks: {
      ...config.uplinks,
      [uplinkName]: { ...uplink, maxage: newMaxage },
    },
  };
}

/**
 * Snapshots current uplink max_fails/fail_timeout, then zeros them out for offline mode.
 */
export function enableOfflineModeInConfig(
  config: VerdaccioConfig,
): { config: VerdaccioConfig; snapshot: UplinkSnapshot } {
  const snapshot: UplinkSnapshot = { uplinks: {} };
  const newUplinks: Record<string, typeof config.uplinks[string]> = {};

  for (const [name, uplink] of Object.entries(config.uplinks)) {
    snapshot.uplinks[name] = {
      max_fails: uplink.max_fails,
      fail_timeout: uplink.fail_timeout,
    };
    newUplinks[name] = {
      ...uplink,
      max_fails: 0,
      fail_timeout: '0',
    };
  }

  return {
    config: { ...config, uplinks: newUplinks },
    snapshot,
  };
}

/**
 * Restores uplink settings from a previously saved snapshot.
 */
export function disableOfflineModeInConfig(
  config: VerdaccioConfig,
  snapshot: UplinkSnapshot,
): VerdaccioConfig {
  const newUplinks: Record<string, typeof config.uplinks[string]> = {};

  for (const [name, uplink] of Object.entries(config.uplinks)) {
    const saved = snapshot.uplinks[name];
    if (saved) {
      newUplinks[name] = {
        ...uplink,
        max_fails: saved.max_fails,
        fail_timeout: saved.fail_timeout,
      };
    } else {
      newUplinks[name] = { ...uplink };
    }
  }

  return { ...config, uplinks: newUplinks };
}

/**
 * Sets global proxy fields on the root config.
 */
export function setGlobalProxy(
  config: VerdaccioConfig,
  httpProxy?: string,
  httpsProxy?: string,
  noProxy?: string,
): VerdaccioConfig {
  if (httpProxy !== undefined && httpProxy !== '' && !isValidRegistryUrl(httpProxy)) {
    throw new Error(`Invalid HTTP proxy URL: ${httpProxy}`);
  }
  if (httpsProxy !== undefined && httpsProxy !== '' && !isValidRegistryUrl(httpsProxy)) {
    throw new Error(`Invalid HTTPS proxy URL: ${httpsProxy}`);
  }

  const result = { ...config };
  if (httpProxy !== undefined) {
    result.http_proxy = httpProxy || undefined;
  }
  if (httpsProxy !== undefined) {
    result.https_proxy = httpsProxy || undefined;
  }
  if (noProxy !== undefined) {
    result.no_proxy = noProxy || undefined;
  }
  return result;
}

/**
 * Sets proxy fields on a specific uplink section.
 */
export function setUplinkProxy(
  config: VerdaccioConfig,
  uplinkName: string,
  httpProxy?: string,
  httpsProxy?: string,
): VerdaccioConfig {
  const uplink = config.uplinks[uplinkName];
  if (!uplink) {
    throw new Error(`Uplink "${uplinkName}" not found in config`);
  }
  if (httpProxy !== undefined && httpProxy !== '' && !isValidRegistryUrl(httpProxy)) {
    throw new Error(`Invalid HTTP proxy URL: ${httpProxy}`);
  }
  if (httpsProxy !== undefined && httpsProxy !== '' && !isValidRegistryUrl(httpsProxy)) {
    throw new Error(`Invalid HTTPS proxy URL: ${httpsProxy}`);
  }

  const updatedUplink = { ...uplink };
  if (httpProxy !== undefined) {
    updatedUplink.http_proxy = httpProxy || undefined;
  }
  if (httpsProxy !== undefined) {
    updatedUplink.https_proxy = httpsProxy || undefined;
  }

  return {
    ...config,
    uplinks: {
      ...config.uplinks,
      [uplinkName]: updatedUplink,
    },
  };
}

// --- ConfigManager class ---

export class ConfigManager implements IConfigManager {
  private readonly _workspaceState?: vscode.Memento;

  constructor(workspaceState?: vscode.Memento) {
    this._workspaceState = workspaceState;
  }

  getConfigPath(): string {
    const config = vscode.workspace.getConfiguration('verdaccio');
    const configPath = config.get<string>('configPath', '.verdaccio/config.yaml');
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return configPath;
    }
    return path.join(workspaceFolder.uri.fsPath, configPath);
  }

  async readConfig(): Promise<VerdaccioConfig> {
    const configPath = this.getConfigPath();
    const content = await fs.readFile(configPath, 'utf-8');
    const parsed = yaml.load(content) as VerdaccioConfig;
    return parsed;
  }

  async updateConfig(patch: Partial<VerdaccioConfig>): Promise<void> {
    const configPath = this.getConfigPath();
    const existing = await this.readConfig();
    const merged = { ...existing, ...patch };
    const yamlContent = yaml.dump(merged, { lineWidth: -1 });
    await fs.writeFile(configPath, yamlContent, 'utf-8');
  }

  async generateDefaultConfig(): Promise<void> {
    const configPath = this.getConfigPath();
    const dir = path.dirname(configPath);
    await fs.mkdir(dir, { recursive: true });

    const defaultConfig: VerdaccioConfig = {
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
        '@*/*': {
          access: '$all',
          publish: '$authenticated',
          proxy: ['npmjs'],
        },
        '**': {
          access: '$all',
          publish: '$authenticated',
          proxy: ['npmjs'],
        },
      },
    };

    const yamlContent = yaml.dump(defaultConfig, { lineWidth: -1 });
    await fs.writeFile(configPath, yamlContent, 'utf-8');
  }

  async configExists(): Promise<boolean> {
    const configPath = this.getConfigPath();
    try {
      await fs.access(configPath);
      return true;
    } catch {
      return false;
    }
  }

  async openRawConfig(): Promise<void> {
    const configPath = this.getConfigPath();
    const uri = vscode.Uri.file(configPath);
    await vscode.window.showTextDocument(uri);
  }

  async setCacheStrategy(uplinkName: string, strategy: 'cache-first' | 'proxy-first'): Promise<void> {
    const config = await this.readConfig();
    const updated = setCacheStrategy(config, uplinkName, strategy);
    await this._writeFullConfig(updated);
  }

  async setUplinkCacheSettings(
    uplinkName: string,
    settings: { maxage?: string; cache_ttl?: string; timeout?: string },
  ): Promise<void> {
    const config = await this.readConfig();
    const uplink = config.uplinks[uplinkName];
    if (!uplink) {
      throw new Error(`Uplink "${uplinkName}" not found in config`);
    }
    const updatedUplink = { ...uplink };
    if (settings.maxage !== undefined) { updatedUplink.maxage = settings.maxage; }
    if (settings.cache_ttl !== undefined) { updatedUplink.cache_ttl = settings.cache_ttl; }
    if (settings.timeout !== undefined) { updatedUplink.timeout = settings.timeout; }

    const updated: VerdaccioConfig = {
      ...config,
      uplinks: { ...config.uplinks, [uplinkName]: updatedUplink },
    };
    await this._writeFullConfig(updated);
  }

  async enableOfflineMode(): Promise<void> {
    const config = await this.readConfig();
    const { config: updated, snapshot } = enableOfflineModeInConfig(config);
    if (this._workspaceState) {
      await this._workspaceState.update('verdaccio.offlineSnapshot', snapshot);
    }
    await this._writeFullConfig(updated);
  }

  async disableOfflineMode(): Promise<void> {
    const config = await this.readConfig();
    const snapshot = this._workspaceState?.get<UplinkSnapshot>('verdaccio.offlineSnapshot');
    if (!snapshot) {
      vscode.window.showWarningMessage('No offline mode snapshot found. Uplink settings were not restored.');
      return;
    }
    const updated = disableOfflineModeInConfig(config, snapshot);
    await this._workspaceState!.update('verdaccio.offlineSnapshot', undefined);
    await this._writeFullConfig(updated);
  }

  async setGlobalProxy(httpProxy?: string, httpsProxy?: string, noProxy?: string): Promise<void> {
    const config = await this.readConfig();
    const updated = setGlobalProxy(config, httpProxy, httpsProxy, noProxy);
    await this._writeFullConfig(updated);
  }

  async setUplinkProxy(uplinkName: string, httpProxy?: string, httpsProxy?: string): Promise<void> {
    const config = await this.readConfig();
    const updated = setUplinkProxy(config, uplinkName, httpProxy, httpsProxy);
    await this._writeFullConfig(updated);
  }

  dispose(): void {
    // No resources to dispose
  }

  private async _writeFullConfig(config: VerdaccioConfig): Promise<void> {
    const configPath = this.getConfigPath();
    const yamlContent = yaml.dump(config, { lineWidth: -1 });
    await fs.writeFile(configPath, yamlContent, 'utf-8');
  }
}

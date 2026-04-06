import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  McpToolResponse,
  McpStartResponse,
  McpStatusResponse,
  McpPackageListResponse,
  McpPackageEntry,
  McpCleanupResponse,
  McpPackageDetailResponse,
  McpVersionDetail,
  McpVersionMetadataResponse,
  McpCheckCachedResponse,
  McpCacheDiffResponse,
  CacheDiffEntry,
  McpCacheStatsResponse,
  McpDepTreeNode,
  CacheWalkerResponse,
  CacheWalkerPackage,
  CacheWalkerVersion,
  LockfileDependency,
  VerdaccioConfig,
} from './types';
import { IServerManager } from './serverManager';
import { IConfigManager } from './configManager';
import { INpmrcManager } from './npmrcManager';
import { IPublishManager } from './publishManager';
import { IWorkspacePackageProvider } from './workspacePackageProvider';
import { IStorageAnalyticsProvider } from './storageAnalyticsProvider';
import { ICacheViewProvider } from './cacheViewProvider';

// ─── IMcpServer interface ───

export interface IMcpServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly isRunning: boolean;
}

// ─── MCP Tool definitions ───

export const MCP_TOOL_NAMES = [
  'verdaccio_start',
  'verdaccio_stop',
  'verdaccio_status',
  'verdaccio_publish',
  'verdaccio_publish_all',
  'verdaccio_list_packages',
  'verdaccio_search',
  'verdaccio_set_registry',
  'verdaccio_reset_registry',
  'verdaccio_add_scoped_registry',
  'verdaccio_set_offline_mode',
  'verdaccio_get_config',
  'verdaccio_update_config',
  'verdaccio_storage_analytics',
  'verdaccio_cleanup',
  'verdaccio_walk_cache',
  'verdaccio_get_package',
  'verdaccio_get_version',
  'verdaccio_check_cached',
  'verdaccio_cache_diff',
  'verdaccio_cache_stats',
  'verdaccio_package_deps',
] as const;

export type McpToolName = typeof MCP_TOOL_NAMES[number];

// ─── Pure helper: wrap response in McpToolResponse envelope ───

export function wrapSuccess<T>(data: T): McpToolResponse<T> {
  return { success: true, data };
}

export function wrapError(error: string): McpToolResponse<never> {
  return { success: false, error };
}

// ─── Pure helper: search filter ───

/**
 * Filters packages by a name pattern (case-insensitive substring match).
 * Returns only packages whose names contain the pattern.
 */
export function filterPackagesByPattern(
  packages: McpPackageEntry[],
  pattern: string,
): McpPackageEntry[] {
  const lowerPattern = pattern.toLowerCase();
  return packages.filter((p) => p.name.toLowerCase().includes(lowerPattern));
}

// ─── Pure helper: walkCache ───

export interface WalkCacheParams {
  scope?: string;
  pattern?: string;
  includeMetadata?: boolean;
  sortBy?: 'name' | 'size' | 'lastAccess' | 'versionCount';
  offset?: number;
  limit?: number;
}

/**
 * Pure function: filters, sorts, paginates cached packages and computes summary.
 * The summary reflects pre-pagination totals.
 */
export function walkCache(
  packages: CacheWalkerPackage[],
  params: WalkCacheParams,
): CacheWalkerResponse {
  let filtered = [...packages];

  // Filter by scope
  if (params.scope) {
    const scopeLower = params.scope.toLowerCase();
    filtered = filtered.filter((p) => p.scope?.toLowerCase() === scopeLower);
  }

  // Filter by pattern (case-insensitive substring)
  if (params.pattern) {
    const patternLower = params.pattern.toLowerCase();
    filtered = filtered.filter((p) => p.name.toLowerCase().includes(patternLower));
  }

  // Compute summary before pagination
  const summary = {
    totalPackages: filtered.length,
    totalVersions: filtered.reduce((sum, p) => sum + p.versionCount, 0),
    totalSizeBytes: filtered.reduce((sum, p) => sum + p.totalSizeBytes, 0),
  };

  // Sort
  if (params.sortBy) {
    filtered.sort((a, b) => {
      switch (params.sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'size':
          return b.totalSizeBytes - a.totalSizeBytes;
        case 'lastAccess': {
          const dateA = a.lastAccessDate ? new Date(a.lastAccessDate).getTime() : 0;
          const dateB = b.lastAccessDate ? new Date(b.lastAccessDate).getTime() : 0;
          return dateB - dateA;
        }
        case 'versionCount':
          return b.versionCount - a.versionCount;
        default:
          return 0;
      }
    });
  }

  // Paginate
  const offset = params.offset ?? 0;
  if (params.limit !== undefined) {
    filtered = filtered.slice(offset, offset + params.limit);
  } else if (offset > 0) {
    filtered = filtered.slice(offset);
  }

  // Strip metadata if not requested
  if (!params.includeMetadata) {
    filtered = filtered.map((p) => ({ ...p, versions: undefined }));
  }

  return { packages: filtered, summary };
}

// ─── Pure helper: checkCachedPackages ───

/**
 * Checks which package names (or name@version pairs) are cached in storage.
 * storagePackages is a map of package name -> set of cached versions.
 */
export function checkCachedPackages(
  packageNames: string[],
  storagePackages: Map<string, Set<string>>,
): McpCheckCachedResponse {
  const cached: string[] = [];
  const notCached: string[] = [];

  for (const entry of packageNames) {
    const atIdx = entry.lastIndexOf('@');
    if (atIdx > 0) {
      // name@version format
      const name = entry.substring(0, atIdx);
      const version = entry.substring(atIdx + 1);
      const versions = storagePackages.get(name);
      if (versions && versions.has(version)) {
        cached.push(entry);
      } else {
        notCached.push(entry);
      }
    } else {
      // Just a package name — cached if any version exists
      if (storagePackages.has(entry) && (storagePackages.get(entry)?.size ?? 0) > 0) {
        cached.push(entry);
      } else {
        notCached.push(entry);
      }
    }
  }

  return { cached, notCached };
}

// ─── Pure helper: computeCacheDiff ───

/**
 * Compares lockfile dependencies against cached storage packages.
 * Returns upToDate, outdated, and missing arrays.
 */
export function computeCacheDiff(
  lockfileDeps: LockfileDependency[],
  storagePackages: Map<string, Set<string>>,
): McpCacheDiffResponse {
  const upToDate: CacheDiffEntry[] = [];
  const outdated: CacheDiffEntry[] = [];
  const missing: CacheDiffEntry[] = [];

  for (const dep of lockfileDeps) {
    const cachedVersions = storagePackages.get(dep.name);
    if (!cachedVersions || cachedVersions.size === 0) {
      missing.push({ name: dep.name, requiredVersion: dep.version });
    } else if (cachedVersions.has(dep.version)) {
      upToDate.push({ name: dep.name, requiredVersion: dep.version, cachedVersion: dep.version });
    } else {
      // Has some version cached but not the required one
      const firstCached = Array.from(cachedVersions)[0];
      outdated.push({ name: dep.name, requiredVersion: dep.version, cachedVersion: firstCached });
    }
  }

  return { upToDate, outdated, missing };
}

// ─── Pure helper: buildDepTree ───

/**
 * Recursively builds a dependency tree with cached flags.
 * storagePackages: map of name -> set of versions
 * depMap: map of "name@version" -> Record<string, string> (dependency name -> version)
 * depth: max recursion depth (default 3)
 */
export function buildDepTree(
  packageName: string,
  version: string,
  storagePackages: Map<string, Set<string>>,
  depMap: Map<string, Record<string, string>>,
  depth: number = 3,
  visited: Set<string> = new Set(),
): McpDepTreeNode {
  const key = `${packageName}@${version}`;
  const cached = storagePackages.get(packageName)?.has(version) ?? false;

  if (depth <= 0 || visited.has(key)) {
    return { name: packageName, version, cached, dependencies: [] };
  }

  visited.add(key);
  const deps = depMap.get(key) ?? {};
  const children: McpDepTreeNode[] = [];

  for (const [depName, depVersion] of Object.entries(deps)) {
    children.push(
      buildDepTree(depName, depVersion, storagePackages, depMap, depth - 1, new Set(visited)),
    );
  }

  return { name: packageName, version, cached, dependencies: children };
}


// ─── McpServer class ───

export interface McpServerDeps {
  serverManager: IServerManager;
  configManager: IConfigManager;
  npmrcManager: INpmrcManager;
  publishManager: IPublishManager;
  workspacePackageProvider: IWorkspacePackageProvider;
  storageAnalyticsProvider: IStorageAnalyticsProvider;
  cacheViewProvider: ICacheViewProvider;
}

export class McpServer implements IMcpServer, vscode.Disposable {
  private _running = false;
  private readonly _deps: McpServerDeps;
  private readonly _toolHandlers: Map<string, (params: Record<string, unknown>) => Promise<McpToolResponse>>;

  constructor(deps: McpServerDeps) {
    this._deps = deps;
    this._toolHandlers = new Map();
    this._registerTools();
  }

  get isRunning(): boolean {
    return this._running;
  }

  async start(): Promise<void> {
    this._running = true;
  }

  async stop(): Promise<void> {
    this._running = false;
  }

  /**
   * Returns the list of registered tool names.
   */
  getRegisteredTools(): string[] {
    return Array.from(this._toolHandlers.keys());
  }

  /**
   * Invokes a registered MCP tool by name.
   */
  async callTool(name: string, params: Record<string, unknown> = {}): Promise<McpToolResponse> {
    const handler = this._toolHandlers.get(name);
    if (!handler) {
      return wrapError(`Unknown tool: ${name}`);
    }
    try {
      return await handler(params);
    } catch (err: any) {
      return wrapError(err.message ?? String(err));
    }
  }

  /**
   * Returns the command to spawn the MCP server process (ACS lifecycle).
   */
  getServerCommand(): { command: string; args: string[] } {
    return { command: 'node', args: [path.join(__dirname, 'mcpServer.js')] };
  }

  /**
   * Returns environment variables for the MCP server process (ACS lifecycle).
   */
  getServerEnv(): Record<string, string> {
    return { NODE_ENV: 'production' };
  }

  /**
   * Called after the MCP connection is established (ACS lifecycle).
   */
  async onServerReady(): Promise<void> {
    // Tools are already registered in constructor
  }

  /**
   * Generates the .kiro/settings/mcp.json discovery file.
   */
  async generateMcpJson(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) { return; }

    const kiroDir = path.join(workspaceFolder.uri.fsPath, '.kiro', 'settings');
    const mcpJsonPath = path.join(kiroDir, 'mcp.json');

    try {
      await fs.mkdir(kiroDir, { recursive: true });
      const mcpConfig = {
        name: 'verdaccio-mcp',
        description: 'Verdaccio local npm registry management',
        transport: 'stdio',
        tools: MCP_TOOL_NAMES,
      };
      await fs.writeFile(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');
    } catch {
      // Log warning but don't fail — MCP server still functions
    }
  }

  dispose(): void {
    this._running = false;
  }

  // ─── Tool registration ───

  private _registerTools(): void {
    const d = this._deps;

    this._toolHandlers.set('verdaccio_start', async () => {
      await d.serverManager.start();
      const data: McpStartResponse = {
        port: d.serverManager.port ?? 4873,
        pid: (d.serverManager as any).pid ?? 0,
      };
      return wrapSuccess(data);
    });

    this._toolHandlers.set('verdaccio_stop', async () => {
      await d.serverManager.stop();
      return wrapSuccess({ stopped: true });
    });

    this._toolHandlers.set('verdaccio_status', async () => {
      const uptimeSeconds = d.serverManager.startTime
        ? Math.floor((Date.now() - d.serverManager.startTime.getTime()) / 1000)
        : undefined;
      const data: McpStatusResponse = {
        state: d.serverManager.state,
        port: d.serverManager.port,
        uptimeSeconds,
        packageCount: 0, // Will be populated from cache view
      };
      return wrapSuccess(data);
    });

    this._toolHandlers.set('verdaccio_publish', async (params) => {
      const directory = params.directory as string;
      if (!directory) { return wrapError('Missing required parameter: directory'); }
      const result = await d.publishManager.publishToVerdaccio(directory);
      if (result.success) {
        return wrapSuccess({ packageName: result.packageName, version: result.version });
      }
      return wrapError(result.error ?? 'Publish failed');
    });

    this._toolHandlers.set('verdaccio_publish_all', async () => {
      const result = await d.workspacePackageProvider.publishAll();
      return wrapSuccess({ successes: result.successes, failures: result.failures });
    });

    this._toolHandlers.set('verdaccio_list_packages', async () => {
      const packages = await this._getStoragePackageEntries();
      return wrapSuccess<McpPackageListResponse>({ packages });
    });

    this._toolHandlers.set('verdaccio_search', async (params) => {
      const pattern = params.pattern as string;
      if (!pattern) { return wrapError('Missing required parameter: pattern'); }
      const allPackages = await this._getStoragePackageEntries();
      const filtered = filterPackagesByPattern(allPackages, pattern);
      return wrapSuccess<McpPackageListResponse>({ packages: filtered });
    });

    this._toolHandlers.set('verdaccio_set_registry', async () => {
      const port = d.serverManager.port ?? 4873;
      await d.npmrcManager.setRegistry(`http://localhost:${port}`);
      return wrapSuccess({ registry: `http://localhost:${port}` });
    });

    this._toolHandlers.set('verdaccio_reset_registry', async () => {
      await d.npmrcManager.resetRegistry();
      return wrapSuccess({ reset: true });
    });

    this._toolHandlers.set('verdaccio_add_scoped_registry', async (params) => {
      const scope = params.scope as string;
      const url = params.url as string;
      if (!scope || !url) { return wrapError('Missing required parameters: scope, url'); }
      await d.npmrcManager.addScopedRegistry(scope, url);
      return wrapSuccess({ scope, url });
    });

    this._toolHandlers.set('verdaccio_set_offline_mode', async (params) => {
      const enable = params.enable as boolean;
      if (enable) {
        await d.configManager.enableOfflineMode();
      } else {
        await d.configManager.disableOfflineMode();
      }
      return wrapSuccess({ offlineMode: enable });
    });

    this._toolHandlers.set('verdaccio_get_config', async () => {
      const config = await d.configManager.readConfig();
      return wrapSuccess({ config });
    });

    this._toolHandlers.set('verdaccio_update_config', async (params) => {
      const patch = params.patch as Partial<VerdaccioConfig>;
      if (!patch) { return wrapError('Missing required parameter: patch'); }
      await d.configManager.updateConfig(patch);
      return wrapSuccess({ updated: true });
    });

    this._toolHandlers.set('verdaccio_storage_analytics', async () => {
      const analytics = await d.storageAnalyticsProvider.computeAnalytics();
      return wrapSuccess(analytics);
    });

    this._toolHandlers.set('verdaccio_cleanup', async (params) => {
      const packageNames = params.packageNames as string[] | undefined;
      const stalenessThresholdDays = params.stalenessThresholdDays as number | undefined;

      if (packageNames && packageNames.length > 0) {
        let totalDeleted = 0;
        let totalFreed = 0;
        for (const name of packageNames) {
          const result = await d.storageAnalyticsProvider.pruneOldVersions(name, 0);
          totalDeleted += result.deletedCount;
          totalFreed += result.freedBytes;
        }
        return wrapSuccess<McpCleanupResponse>({ deletedCount: totalDeleted, freedBytes: totalFreed });
      }

      const stalePackages = await d.storageAnalyticsProvider.getStalePackages();
      const result = await d.storageAnalyticsProvider.bulkCleanup(stalePackages);
      return wrapSuccess<McpCleanupResponse>({ deletedCount: result.deletedCount, freedBytes: result.freedBytes });
    });

    this._toolHandlers.set('verdaccio_walk_cache', async (params) => {
      const walkerPackages = await this._getWalkerPackages();
      const result = walkCache(walkerPackages, params as WalkCacheParams);
      return wrapSuccess(result);
    });

    this._toolHandlers.set('verdaccio_get_package', async (params) => {
      const packageName = params.packageName as string;
      if (!packageName) { return wrapError('Missing required parameter: packageName'); }
      const detail = await this._getPackageDetail(packageName);
      if (!detail) { return wrapError(`Package not found: ${packageName}`); }
      return wrapSuccess(detail);
    });

    this._toolHandlers.set('verdaccio_get_version', async (params) => {
      const packageName = params.packageName as string;
      const version = params.version as string;
      if (!packageName || !version) { return wrapError('Missing required parameters: packageName, version'); }
      const metadata = await this._getVersionMetadata(packageName, version);
      if (!metadata) { return wrapError(`Version not found: ${packageName}@${version}`); }
      return wrapSuccess(metadata);
    });

    this._toolHandlers.set('verdaccio_check_cached', async (params) => {
      const packages = params.packages as string[];
      if (!packages) { return wrapError('Missing required parameter: packages'); }
      const storageMap = await this._getStoragePackageMap();
      return wrapSuccess(checkCachedPackages(packages, storageMap));
    });

    this._toolHandlers.set('verdaccio_cache_diff', async (params) => {
      const lockfilePath = params.lockfilePath as string | undefined;
      const deps = await this._parseLockfileDeps(lockfilePath);
      const storageMap = await this._getStoragePackageMap();
      return wrapSuccess(computeCacheDiff(deps, storageMap));
    });

    this._toolHandlers.set('verdaccio_cache_stats', async () => {
      const analytics = await d.storageAnalyticsProvider.computeAnalytics();
      const stats: McpCacheStatsResponse = {
        totalPackages: analytics.packageCount,
        totalVersions: analytics.versionCount,
        totalSizeBytes: analytics.totalDiskUsageBytes,
      };
      return wrapSuccess(stats);
    });

    this._toolHandlers.set('verdaccio_package_deps', async (params) => {
      const packageName = params.packageName as string;
      const version = params.version as string;
      const depth = (params.depth as number) ?? 3;
      if (!packageName || !version) { return wrapError('Missing required parameters: packageName, version'); }
      const storageMap = await this._getStoragePackageMap();
      const depMap = await this._buildDepMap();
      const tree = buildDepTree(packageName, version, storageMap, depMap, depth);
      return wrapSuccess(tree);
    });
  }

  // ─── Private helpers for reading storage ───

  private async _getStoragePath(): Promise<string> {
    const config = await this._deps.configManager.readConfig();
    const configDir = path.dirname(this._deps.configManager.getConfigPath());
    return path.isAbsolute(config.storage)
      ? config.storage
      : path.join(configDir, config.storage);
  }

  private async _getStoragePackageEntries(): Promise<McpPackageEntry[]> {
    const storagePath = await this._getStoragePath();
    const entries: McpPackageEntry[] = [];

    try {
      const topLevel = await fs.readdir(storagePath, { withFileTypes: true });
      for (const item of topLevel) {
        if (!item.isDirectory()) { continue; }
        if (item.name.startsWith('@')) {
          const scopeDir = path.join(storagePath, item.name);
          const scopeItems = await fs.readdir(scopeDir, { withFileTypes: true });
          for (const si of scopeItems) {
            if (!si.isDirectory()) { continue; }
            const fullName = `${item.name}/${si.name}`;
            const entry = await this._readPackageEntry(path.join(scopeDir, si.name), fullName);
            if (entry) { entries.push(entry); }
          }
        } else {
          const entry = await this._readPackageEntry(path.join(storagePath, item.name), item.name);
          if (entry) { entries.push(entry); }
        }
      }
    } catch {
      // Storage not accessible
    }

    return entries;
  }

  private async _readPackageEntry(pkgDir: string, name: string): Promise<McpPackageEntry | undefined> {
    try {
      const content = await fs.readFile(path.join(pkgDir, 'package.json'), 'utf-8');
      const pkgJson = JSON.parse(content);
      const versions = pkgJson.versions ? Object.keys(pkgJson.versions) : [];
      let totalSize = 0;
      for (const ver of versions) {
        totalSize += pkgJson.versions[ver]?._size ?? 0;
      }
      return { name, versions, totalSizeBytes: totalSize };
    } catch {
      return undefined;
    }
  }

  private async _getStoragePackageMap(): Promise<Map<string, Set<string>>> {
    const entries = await this._getStoragePackageEntries();
    const map = new Map<string, Set<string>>();
    for (const entry of entries) {
      map.set(entry.name, new Set(entry.versions));
    }
    return map;
  }

  private async _getWalkerPackages(): Promise<CacheWalkerPackage[]> {
    const storagePath = await this._getStoragePath();
    const packages: CacheWalkerPackage[] = [];

    try {
      const topLevel = await fs.readdir(storagePath, { withFileTypes: true });
      for (const item of topLevel) {
        if (!item.isDirectory()) { continue; }
        if (item.name.startsWith('@')) {
          const scopeDir = path.join(storagePath, item.name);
          const scopeItems = await fs.readdir(scopeDir, { withFileTypes: true });
          for (const si of scopeItems) {
            if (!si.isDirectory()) { continue; }
            const fullName = `${item.name}/${si.name}`;
            const wp = await this._readWalkerPackage(path.join(scopeDir, si.name), fullName, item.name);
            if (wp) { packages.push(wp); }
          }
        } else {
          const wp = await this._readWalkerPackage(path.join(storagePath, item.name), item.name);
          if (wp) { packages.push(wp); }
        }
      }
    } catch {
      // Storage not accessible
    }

    return packages;
  }

  private async _readWalkerPackage(
    pkgDir: string,
    name: string,
    scope?: string,
  ): Promise<CacheWalkerPackage | undefined> {
    try {
      const content = await fs.readFile(path.join(pkgDir, 'package.json'), 'utf-8');
      const pkgJson = JSON.parse(content);
      const versionEntries = pkgJson.versions ? Object.entries<any>(pkgJson.versions) : [];
      let totalSize = 0;
      let latestAccess = '';
      const versions: CacheWalkerVersion[] = [];

      for (const [ver, meta] of versionEntries) {
        const size = meta?._size ?? 0;
        totalSize += size;
        const publishDate = meta?.time ?? meta?.dist?.publishDate;
        if (publishDate && publishDate > latestAccess) { latestAccess = publishDate; }
        versions.push({
          version: ver,
          sizeBytes: size,
          description: meta?.description,
          publishDate,
        });
      }

      return {
        name,
        scope,
        versionCount: versionEntries.length,
        totalSizeBytes: totalSize,
        lastAccessDate: latestAccess || undefined,
        origin: pkgJson._origin ?? 'unknown',
        versions,
      };
    } catch {
      return undefined;
    }
  }

  private async _getPackageDetail(packageName: string): Promise<McpPackageDetailResponse | undefined> {
    const storagePath = await this._getStoragePath();
    const pkgDir = packageName.startsWith('@')
      ? path.join(storagePath, ...packageName.split('/'))
      : path.join(storagePath, packageName);

    try {
      const content = await fs.readFile(path.join(pkgDir, 'package.json'), 'utf-8');
      const pkgJson = JSON.parse(content);
      const versions: McpVersionDetail[] = [];

      if (pkgJson.versions) {
        for (const [ver, meta] of Object.entries<any>(pkgJson.versions)) {
          versions.push({
            version: ver,
            sizeBytes: meta?._size ?? 0,
            description: meta?.description ?? '',
            publishDate: meta?.time,
            downloadCount: meta?._downloadCount,
          });
        }
      }

      return { name: packageName, versions };
    } catch {
      return undefined;
    }
  }

  private async _getVersionMetadata(
    packageName: string,
    version: string,
  ): Promise<McpVersionMetadataResponse | undefined> {
    const storagePath = await this._getStoragePath();
    const pkgDir = packageName.startsWith('@')
      ? path.join(storagePath, ...packageName.split('/'))
      : path.join(storagePath, packageName);

    try {
      const content = await fs.readFile(path.join(pkgDir, 'package.json'), 'utf-8');
      const pkgJson = JSON.parse(content);
      const meta = pkgJson.versions?.[version];
      if (!meta) { return undefined; }

      return {
        description: meta.description ?? '',
        dependencies: meta.dependencies ?? {},
        devDependencies: meta.devDependencies ?? {},
        tarballSize: meta._size ?? 0,
        publishDate: meta.time,
      };
    } catch {
      return undefined;
    }
  }

  private async _parseLockfileDeps(lockfilePath?: string): Promise<LockfileDependency[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) { return []; }

    const rootDir = workspaceFolder.uri.fsPath;
    const filePath = lockfilePath
      ? path.isAbsolute(lockfilePath) ? lockfilePath : path.join(rootDir, lockfilePath)
      : undefined;

    // Try package-lock.json first, then yarn.lock
    const candidates = filePath
      ? [filePath]
      : [path.join(rootDir, 'package-lock.json'), path.join(rootDir, 'yarn.lock')];

    for (const candidate of candidates) {
      try {
        const content = await fs.readFile(candidate, 'utf-8');
        if (candidate.endsWith('package-lock.json')) {
          return this._parsePackageLockDeps(content);
        }
        return this._parseYarnLockDeps(content);
      } catch {
        continue;
      }
    }

    return [];
  }

  private _parsePackageLockDeps(content: string): LockfileDependency[] {
    const lockfile = JSON.parse(content);
    const deps: LockfileDependency[] = [];

    // v2/v3 format with packages
    if (lockfile.packages) {
      for (const [key, meta] of Object.entries<any>(lockfile.packages)) {
        if (!key || key === '') { continue; } // skip root
        const name = key.replace(/^node_modules\//, '');
        if (name && meta?.version) {
          deps.push({ name, version: meta.version, resolved: meta.resolved });
        }
      }
    }
    // v1 format with dependencies
    else if (lockfile.dependencies) {
      for (const [name, meta] of Object.entries<any>(lockfile.dependencies)) {
        if (meta?.version) {
          deps.push({ name, version: meta.version, resolved: meta.resolved });
        }
      }
    }

    return deps;
  }

  private _parseYarnLockDeps(content: string): LockfileDependency[] {
    const deps: LockfileDependency[] = [];
    const lines = content.split('\n');
    let currentName = '';

    for (const line of lines) {
      if (!line.startsWith(' ') && !line.startsWith('#') && line.includes('@')) {
        // Package header line like: "lodash@^4.17.21:"
        const match = line.match(/^"?(.+?)@/);
        if (match) { currentName = match[1]; }
      } else if (line.trim().startsWith('version ')) {
        const versionMatch = line.trim().match(/^version "?([^"]+)"?/);
        if (versionMatch && currentName) {
          deps.push({ name: currentName, version: versionMatch[1] });
          currentName = '';
        }
      }
    }

    return deps;
  }

  private async _buildDepMap(): Promise<Map<string, Record<string, string>>> {
    const storagePath = await this._getStoragePath();
    const depMap = new Map<string, Record<string, string>>();

    try {
      const entries = await this._getStoragePackageEntries();
      for (const entry of entries) {
        const pkgDir = entry.name.startsWith('@')
          ? path.join(storagePath, ...entry.name.split('/'))
          : path.join(storagePath, entry.name);

        try {
          const content = await fs.readFile(path.join(pkgDir, 'package.json'), 'utf-8');
          const pkgJson = JSON.parse(content);
          if (pkgJson.versions) {
            for (const [ver, meta] of Object.entries<any>(pkgJson.versions)) {
              depMap.set(`${entry.name}@${ver}`, meta?.dependencies ?? {});
            }
          }
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }

    return depMap;
  }
}

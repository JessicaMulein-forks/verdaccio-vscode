export type ServerState = "stopped" | "starting" | "running" | "error";

export interface ServerInfo {
  state: ServerState;
  port: number | undefined;
  startTime: Date | undefined;
  pid: number | undefined;
  lastError: string | undefined;
}

export interface VerdaccioConfig {
  storage: string;
  listen: string;
  max_body_size: string;
  log: { level: "fatal" | "error" | "warn" | "info" | "debug" | "trace" };
  uplinks: Record<string, UplinkConfig>;
  packages: Record<string, PackageAccessConfig>;
  http_proxy?: string;
  https_proxy?: string;
  no_proxy?: string;
}

export interface UplinkConfig {
  url: string;
  timeout: string;
  maxage: string;
  max_fails: number;
  fail_timeout: string;
  cache_ttl?: string;
  http_proxy?: string;
  https_proxy?: string;
}

export interface PackageAccessConfig {
  access: string;
  publish: string;
  proxy: string[];
}

export interface ScopeNode {
  type: "scope";
  name: string;
  children: PackageNode[];
}

export interface PackageNode {
  type: "package";
  name: string;
  scope: string | undefined;
  path: string;
  versions: VersionNode[];
}

export interface VersionNode {
  type: "version";
  version: string;
  description: string;
  tarballSize: number;
  packageName: string;
}

export type CacheItem = ScopeNode | PackageNode | VersionNode;

export interface ExtensionSettings {
  configPath: string;
  autoSetRegistry: boolean;
  storageWarningThresholdMb: number;
  stalenessThresholdDays: number;
  mcpAutoStart: boolean;
  healthPingIntervalMs: number;
}

export interface ScopedRegistryEntry {
  scope: string;
  registryUrl: string;
}

export interface AuthTokenEntry {
  registryUrl: string;
  maskedToken: string;
}

export interface UplinkSnapshot {
  uplinks: Record<string, Pick<UplinkConfig, 'max_fails' | 'fail_timeout'>>;
}

export interface StorageAnalytics {
  totalDiskUsageBytes: number;
  packageCount: number;
  versionCount: number;
  largestPackages: PackageSizeInfo[];
  stalePackageCount: number;
}

export interface PackageSizeInfo {
  name: string;
  version: string;
  sizeBytes: number;
}

export interface StalePackageInfo {
  name: string;
  version: string;
  lastAccessDate: Date;
  sizeBytes: number;
}

export interface PruneResult {
  deletedCount: number;
  freedBytes: number;
}

export interface AnalyticsMetricNode {
  type: 'metric';
  label: string;
  value: string;
}

export interface AnalyticsPackageNode {
  type: 'largestPackage';
  name: string;
  sizeBytes: number;
}

export type AnalyticsItem = AnalyticsMetricNode | AnalyticsPackageNode;

export interface WorkspacePackageInfo {
  name: string;
  version: string;
  directory: string;
  dependencies: string[];
}

export interface PublishResult {
  success: boolean;
  packageName: string;
  version: string;
  error?: string;
}

export interface BulkPublishResult {
  successes: PublishResult[];
  failures: PublishResult[];
}

export type SemverBumpType = 'patch' | 'minor' | 'major' | 'prerelease';

/** Returns true if scope starts with '@' and contains no whitespace */
export function isValidScope(scope: string): boolean {
  return scope.startsWith('@') && !/\s/.test(scope);
}

/** Returns true if url is a valid http:// or https:// URL */
export function isValidRegistryUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Returns true if token is non-empty and not whitespace-only */
export function isValidToken(token: string): boolean {
  return token.trim().length > 0;
}

/** Masks a token to "****<last4>" format, or "****" if shorter than 4 chars */
export function maskToken(token: string): string {
  if (token.length < 4) {
    return '****';
  }
  return '****' + token.slice(-4);
}

// ─── Task 26.1: MCP Response Model Interfaces ───

export interface McpToolResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface McpStartResponse {
  port: number;
  pid: number;
}

export interface McpStatusResponse {
  state: ServerState;
  port: number | undefined;
  uptimeSeconds: number | undefined;
  packageCount: number;
}

export interface McpPackageListResponse {
  packages: McpPackageEntry[];
}

export interface McpPackageEntry {
  name: string;
  versions: string[];
  totalSizeBytes: number;
}

export interface McpCleanupResponse {
  deletedCount: number;
  freedBytes: number;
}

export interface McpPackageDetailResponse {
  name: string;
  versions: McpVersionDetail[];
}

export interface McpVersionDetail {
  version: string;
  sizeBytes: number;
  description: string;
  publishDate?: string;
  downloadCount?: number;
}

export interface McpVersionMetadataResponse {
  description: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  tarballSize: number;
  publishDate?: string;
}

export interface McpCheckCachedResponse {
  cached: string[];
  notCached: string[];
}

export interface CacheDiffEntry {
  name: string;
  requiredVersion: string;
  cachedVersion?: string;
}

export interface McpCacheDiffResponse {
  upToDate: CacheDiffEntry[];
  outdated: CacheDiffEntry[];
  missing: CacheDiffEntry[];
}

export interface McpCacheStatsResponse {
  totalPackages: number;
  totalVersions: number;
  totalSizeBytes: number;
  cacheHitRate?: number;
  mostRecentlyCached?: { name: string; version: string; date: string };
  oldestCached?: { name: string; version: string; date: string };
}

export interface McpDepTreeNode {
  name: string;
  version: string;
  cached: boolean;
  dependencies: McpDepTreeNode[];
}

// ─── Task 26.2: Mirror / Lockfile Interfaces ───

export interface MirrorResult {
  newlyCached: MirroredDependency[];
  alreadyAvailable: MirroredDependency[];
  totalNewSizeBytes: number;
}

export interface MirroredDependency {
  name: string;
  version: string;
  sizeBytes: number;
}

export interface LockfileDependency {
  name: string;
  version: string;
  resolved?: string;
}

// ─── Task 26.3: Health Interfaces ───

export interface UplinkHealthStatus {
  uplinkName: string;
  url: string;
  latencyMs: number | undefined;
  cacheHitRate: number;
  failedRequestCount: number;
  state: HealthState;
}

export type HealthState = 'healthy' | 'degraded' | 'unreachable';

export interface UplinkHealthNode {
  type: 'uplinkHealth';
  uplinkName: string;
  state: HealthState;
}

export interface HealthMetricNode {
  type: 'healthMetric';
  label: string;
  value: string;
}

export type HealthItem = UplinkHealthNode | HealthMetricNode;

// ─── Task 26.4: Profile Interface ───

export interface NpmrcProfile {
  name: string;
  registry: string | undefined;
  scopedRegistries: ScopedRegistryEntry[];
  authTokenRegistries: string[];
}

// ─── Task 26.5: CacheWalker Response Models ───

export interface CacheWalkerResponse {
  packages: CacheWalkerPackage[];
  summary: {
    totalPackages: number;
    totalVersions: number;
    totalSizeBytes: number;
  };
}

export interface CacheWalkerPackage {
  name: string;
  scope?: string;
  versionCount: number;
  totalSizeBytes: number;
  lastAccessDate?: string;
  origin: 'uplink' | 'published' | 'unknown';
  versions?: CacheWalkerVersion[];
}

export interface CacheWalkerVersion {
  version: string;
  sizeBytes: number;
  description?: string;
  publishDate?: string;
}

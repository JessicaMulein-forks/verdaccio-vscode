import * as vscode from 'vscode';
import { IServerManager } from './serverManager';
import { IConfigManager } from './configManager';
import {
  HealthState,
  HealthItem,
  UplinkHealthNode,
  HealthMetricNode,
  UplinkHealthStatus,
} from './types';

export interface IRegistryHealthProvider extends vscode.TreeDataProvider<HealthItem> {
  refresh(): void;
  startMonitoring(): void;
  stopMonitoring(): void;
  getHealthStatus(uplinkName: string): UplinkHealthStatus | undefined;
}

// ─── Pure functions for testability ───

/**
 * Compute health state from latency, failure count, and timeout flag.
 * - "unreachable" when timed out
 * - "degraded" when latency >= 500ms or failures > 3
 * - "healthy" otherwise
 */
export function computeHealthState(
  latencyMs: number,
  failedCount: number,
  timedOut: boolean,
): HealthState {
  if (timedOut) { return 'unreachable'; }
  if (latencyMs >= 500 || failedCount > 3) { return 'degraded'; }
  return 'healthy';
}

/**
 * Compute cache hit rate as a percentage.
 * Returns 0 when there are no requests (hits + misses === 0).
 * Result is always between 0 and 100 inclusive.
 */
export function computeCacheHitRate(hits: number, misses: number): number {
  const total = hits + misses;
  if (total === 0) { return 0; }
  return (hits / total) * 100;
}

/**
 * Count the number of failure events in a sequence of success/failure booleans.
 * true = success, false = failure
 */
export function countFailures(events: boolean[]): number {
  return events.filter((e) => !e).length;
}

// ─── RegistryHealthProvider class ───

export class RegistryHealthProvider implements IRegistryHealthProvider {
  private readonly _serverManager: IServerManager;
  private readonly _configManager: IConfigManager;
  private _healthStatuses: Map<string, UplinkHealthStatus> = new Map();
  private _monitoringInterval: ReturnType<typeof setInterval> | undefined;
  private _pingInFlight = false;
  private _allUnreachableWarningShown = false;
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<HealthItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(serverManager: IServerManager, configManager: IConfigManager) {
    this._serverManager = serverManager;
    this._configManager = configManager;
    // Refresh tree whenever server state changes so "Server not running" updates
    this._serverManager.onDidChangeState(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  startMonitoring(): void {
    if (this._monitoringInterval) { return; }

    const intervalMs = 60000; // ping every 60s to avoid thrashing
    this._monitoringInterval = setInterval(async () => {
      if (this._pingInFlight) { return; }
      this._pingInFlight = true;
      try {
        const changed = await this._pingUplinks();
        if (changed) { this.refresh(); }
      } finally {
        this._pingInFlight = false;
      }
    }, intervalMs);

    // Initial ping after a short delay to let the UI settle
    setTimeout(() => {
      this._pingInFlight = true;
      this._pingUplinks().then((changed) => { if (changed) { this.refresh(); } }).finally(() => { this._pingInFlight = false; });
    }, 3000);
  }

  stopMonitoring(): void {
    if (this._monitoringInterval) {
      clearInterval(this._monitoringInterval);
      this._monitoringInterval = undefined;
    }
    this._healthStatuses.clear();
    this.refresh();
  }

  getHealthStatus(uplinkName: string): UplinkHealthStatus | undefined {
    return this._healthStatuses.get(uplinkName);
  }

  getTreeItem(element: HealthItem): vscode.TreeItem {
    if (element.type === 'uplinkHealth') {
      const status = this._healthStatuses.get(element.uplinkName);
      const item = new vscode.TreeItem(
        `${element.uplinkName}: ${element.state}`,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = status?.latencyMs !== undefined ? `${status.latencyMs}ms` : 'N/A';
      return item;
    }

    // HealthMetricNode
    const item = new vscode.TreeItem(
      `${element.label}: ${element.value}`,
      vscode.TreeItemCollapsibleState.None,
    );
    return item;
  }

  async getChildren(element?: HealthItem): Promise<HealthItem[]> {
    if (this._serverManager.state !== 'running') {
      if (!element) {
        return [{
          type: 'healthMetric',
          label: 'Status',
          value: 'Server not running',
        }];
      }
      return [];
    }

    if (!element) {
      // Root: show uplink entries
      const items: HealthItem[] = [];
      for (const [name, status] of this._healthStatuses) {
        items.push({
          type: 'uplinkHealth',
          uplinkName: name,
          state: status.state,
        });
      }
      if (items.length === 0) {
        items.push({
          type: 'healthMetric',
          label: 'Status',
          value: 'No uplinks configured',
        });
      }
      return items;
    }

    // Children of an uplink node: show metrics
    if (element.type === 'uplinkHealth') {
      const status = this._healthStatuses.get(element.uplinkName);
      if (!status) { return []; }
      return [
        { type: 'healthMetric', label: 'Latency', value: status.latencyMs !== undefined ? `${status.latencyMs}ms` : 'N/A' },
        { type: 'healthMetric', label: 'Cache Hit Rate', value: `${status.cacheHitRate.toFixed(1)}%` },
        { type: 'healthMetric', label: 'Failed Requests', value: `${status.failedRequestCount}` },
        { type: 'healthMetric', label: 'State', value: status.state },
      ];
    }

    return [];
  }

  private async _pingUplinks(): Promise<boolean> {
    let changed = false;
    try {
      const config = await this._configManager.readConfig();
      const uplinks = config.uplinks || {};

      for (const [name, uplink] of Object.entries(uplinks)) {
        const existing = this._healthStatuses.get(name);
        const failedCount = existing?.failedRequestCount ?? 0;
        const cacheHitRate = existing?.cacheHitRate ?? 0;
        const oldState = existing?.state;

        try {
          const start = Date.now();
          await this._httpPing(uplink.url);
          const latencyMs = Date.now() - start;

          const state = computeHealthState(latencyMs, failedCount, false);
          this._healthStatuses.set(name, {
            uplinkName: name,
            url: uplink.url,
            latencyMs,
            cacheHitRate,
            failedRequestCount: failedCount,
            state,
          });
          if (state !== oldState) { changed = true; }
        } catch {
          const state = computeHealthState(0, failedCount + 1, true);
          this._healthStatuses.set(name, {
            uplinkName: name,
            url: uplink.url,
            latencyMs: undefined,
            cacheHitRate,
            failedRequestCount: failedCount + 1,
            state,
          });
          if (state !== oldState) { changed = true; }
        }
      }

      // Show "all unreachable" warning only once
      const allUnreachable = this._healthStatuses.size > 0 &&
        [...this._healthStatuses.values()].every((s) => s.state === 'unreachable');
      if (allUnreachable && !this._allUnreachableWarningShown) {
        this._allUnreachableWarningShown = true;
        const action = await vscode.window.showWarningMessage(
          'All registry uplinks are unreachable. Consider enabling offline mode.',
          'Enable Offline Mode',
        );
        if (action === 'Enable Offline Mode') {
          await this._configManager.enableOfflineMode();
          vscode.window.showInformationMessage('Offline mode enabled.');
        }
      } else if (!allUnreachable) {
        this._allUnreachableWarningShown = false;
      }
    } catch {
      // Config read failed — skip this ping cycle
    }
    return changed;
  }

  private _httpPing(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const http = url.startsWith('https') ? require('https') : require('http');
      const req = http.get(url, { timeout: 5000 }, (res: any) => {
        res.resume();
        resolve();
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
    });
  }
}

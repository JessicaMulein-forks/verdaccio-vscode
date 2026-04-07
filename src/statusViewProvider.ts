import * as vscode from 'vscode';
import { ServerState } from './types';
import { IServerManager } from './serverManager';

/**
 * Formats the uptime duration between a start time and now as "Xh Ym Zs".
 * Exported as a pure function for testability (Property 2).
 */
export function formatUptime(startTime: Date, now: Date = new Date()): string {
  const diffMs = Math.max(0, now.getTime() - startTime.getTime());
  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

export class StatusItem extends vscode.TreeItem {
  constructor(label: string, description?: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    if (description !== undefined) {
      this.description = description;
    }
    if (command) {
      this.command = command;
    }
  }
}

export interface IStatusViewProvider extends vscode.TreeDataProvider<StatusItem> {
  refresh(): void;
}

export class StatusViewProvider implements IStatusViewProvider {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;

  private readonly _serverManager: IServerManager;
  private readonly _stateSubscription: vscode.Disposable;
  private _packageCount: number = 0;

  constructor(serverManager: IServerManager) {
    this._serverManager = serverManager;
    this._stateSubscription = this._serverManager.onDidChangeState(() => {
      this.refresh();
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setPackageCount(count: number): void {
    this._packageCount = count;
  }

  getTreeItem(element: StatusItem): vscode.TreeItem {
    return element;
  }

  getChildren(): StatusItem[] {
    const state = this._serverManager.state;
    console.log('[Verdaccio] StatusViewProvider.getChildren called, state:', state);

    switch (state) {
      case 'stopped':
        return [
          new StatusItem('Status', 'Stopped'),
          new StatusItem('Start Verdaccio', undefined, { command: 'verdaccio.start', title: 'Start' }),
        ];

      case 'starting':
        return [new StatusItem('Status', 'Starting...')];

      case 'running': {
        const items: StatusItem[] = [new StatusItem('Status', 'Running')];

        const port = this._serverManager.port;
        if (port !== undefined) {
          items.push(new StatusItem('Address', `0.0.0.0:${port}`));
        }

        const startTime = this._serverManager.startTime;
        if (startTime) {
          items.push(new StatusItem('Uptime', formatUptime(startTime)));
        }

        items.push(new StatusItem('Packages', String(this._packageCount)));
        items.push(new StatusItem('Stop Verdaccio', undefined, { command: 'verdaccio.stop', title: 'Stop' }));
        items.push(new StatusItem('Restart Verdaccio', undefined, { command: 'verdaccio.restart', title: 'Restart' }));
        return items;
      }

      case 'error':
        return [
          new StatusItem('Status', 'Error'),
          new StatusItem('Start Verdaccio', undefined, { command: 'verdaccio.start', title: 'Start' }),
        ];

      default:
        return [new StatusItem('Status', 'Unknown')];
    }
  }

  dispose(): void {
    this._stateSubscription.dispose();
    this._onDidChangeTreeData.dispose();
  }
}

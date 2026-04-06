import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { IServerManager } from './serverManager';
import { INpmrcManager } from './npmrcManager';

export interface IDependencyMirrorManagerMinimal {
  mirrorDependencies(): Promise<unknown>;
}

export interface IOnboardingManager extends vscode.Disposable {
  checkAndPrompt(): Promise<void>;
  runOnboarding(): Promise<void>;
}

const ONBOARDING_STATE_KEY = 'verdaccio.onboardingComplete';

export class OnboardingManager implements IOnboardingManager {
  private readonly _serverManager: IServerManager;
  private readonly _npmrcManager: INpmrcManager;
  private readonly _mirrorManager: IDependencyMirrorManagerMinimal | undefined;
  private readonly _workspaceState: vscode.Memento;

  constructor(
    serverManager: IServerManager,
    npmrcManager: INpmrcManager,
    workspaceState: vscode.Memento,
    mirrorManager?: IDependencyMirrorManagerMinimal,
  ) {
    this._serverManager = serverManager;
    this._npmrcManager = npmrcManager;
    this._workspaceState = workspaceState;
    this._mirrorManager = mirrorManager;
  }

  async checkAndPrompt(): Promise<void> {
    // Check if config exists
    const configPath = this._getConfigPath();
    if (!configPath) { return; }

    try {
      await fs.access(configPath);
    } catch {
      // No config file — skip silently
      return;
    }

    // Check if already onboarded
    const alreadyOnboarded = this._workspaceState.get<boolean>(ONBOARDING_STATE_KEY, false);
    if (alreadyOnboarded) { return; }

    // Show onboarding notification
    const action = await vscode.window.showInformationMessage(
      'Verdaccio configuration detected. Would you like to bootstrap your local registry environment?',
      'Yes, set up',
      'No thanks',
    );

    if (action === 'Yes, set up') {
      await this.runOnboarding();
    }
  }

  async runOnboarding(): Promise<void> {
    // Start server — resolves once the server is confirmed running and port is known
    await this._serverManager.start();

    const port = this._serverManager.port;
    if (!port) {
      vscode.window.showErrorMessage('Verdaccio server started but port could not be determined.');
      return;
    }
    await this._npmrcManager.setRegistry(`http://localhost:${port}`);

    // Offer to mirror dependencies
    if (this._mirrorManager) {
      const mirrorAction = await vscode.window.showInformationMessage(
        'Would you like to cache all project dependencies for offline use?',
        'Yes, mirror',
        'Skip',
      );

      if (mirrorAction === 'Yes, mirror') {
        await this._mirrorManager.mirrorDependencies();
      }
    }

    // Persist onboarding state
    await this._workspaceState.update(ONBOARDING_STATE_KEY, true);
  }

  dispose(): void {
    // No resources to dispose
  }

  private _getConfigPath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return undefined; }
    return path.join(folders[0].uri.fsPath, '.verdaccio', 'config.yaml');
  }
}

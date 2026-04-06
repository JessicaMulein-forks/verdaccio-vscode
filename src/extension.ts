import * as vscode from 'vscode';
import { ConfigManager } from './configManager';
import { ServerManager, IServerManager } from './serverManager';
import { LogManager } from './logManager';
import { StatusViewProvider } from './statusViewProvider';
import { CacheViewProvider } from './cacheViewProvider';
import { NpmrcManager } from './npmrcManager';
import { ConfigurationPanel } from './configurationPanel';
import { StorageAnalyticsProvider } from './storageAnalyticsProvider';
import { PublishManager } from './publishManager';
import { WorkspacePackageProvider } from './workspacePackageProvider';
import { McpServer } from './mcpServer';
import { OnboardingManager } from './onboardingManager';
import { DependencyMirrorManager } from './dependencyMirrorManager';
import { RegistryHealthProvider } from './registryHealthProvider';
import { ProfileManager } from './profileManager';
import { ServerState } from './types';
import { registerExtension, unregisterExtension, setOutputChannel } from '@ai-capabilities-suite/vscode-shared-status-bar';
import { diagnosticCommands } from '@ai-capabilities-suite/mcp-client-base';

let serverManager: IServerManager | undefined;

/**
 * Called when the extension is activated.
 * Activation occurs on-demand when the user invokes any Verdaccio command
 * or opens a Verdaccio view (Req 7.2).
 */
export function activate(context: vscode.ExtensionContext): void {
  // --- Instantiate managers ---
  const configManager = new ConfigManager();
  const sm = new ServerManager(configManager);
  serverManager = sm;
  const logManager = new LogManager();
  const statusViewProvider = new StatusViewProvider(sm);
  const cacheViewProvider = new CacheViewProvider(configManager);
  // Pass SecretStorage from ExtensionContext to NpmrcManager (Req 9.2)
  const npmrcManager = new NpmrcManager(sm, context.secrets);
  // Instantiate new providers (Req 11, 12, 13)
  const storageAnalyticsProvider = new StorageAnalyticsProvider(configManager);
  const publishManager = new PublishManager(sm, configManager);
  const workspacePackageProvider = new WorkspacePackageProvider(sm, publishManager);

  // --- Instantiate new managers for Req 15-19 ---
  const mcpServer = new McpServer({
    serverManager: sm,
    configManager,
    npmrcManager,
    publishManager,
    workspacePackageProvider,
    storageAnalyticsProvider,
    cacheViewProvider,
  });
  const dependencyMirrorManager = new DependencyMirrorManager(sm);
  const onboardingManager = new OnboardingManager(sm, npmrcManager, context.workspaceState, dependencyMirrorManager);
  const registryHealthProvider = new RegistryHealthProvider(sm, configManager);
  const profileManager = new ProfileManager(npmrcManager);

  // --- ACS Integration (Req 15.22, 15.24, 20.2, 20.4, 20.5) ---
  registerExtension('verdaccio-mcp', {
    displayName: 'Verdaccio Registry',
    status: 'ok',
    settingsQuery: 'verdaccio',
    actions: [
      { label: '$(play) Start Server', command: 'verdaccio.start', description: 'Start the Verdaccio server' },
      { label: '$(debug-stop) Stop Server', command: 'verdaccio.stop', description: 'Stop the Verdaccio server' },
      { label: '$(debug-restart) Restart Server', command: 'verdaccio.restart', description: 'Restart the Verdaccio server' },
      { label: '$(output) Show Logs', command: 'verdaccio.showLogs', description: 'Show Verdaccio output channel' },
      { label: '$(edit) Open Config Panel', command: 'verdaccio.openConfigPanel', description: 'Open the configuration webview' },
      { label: '$(file-code) Open Raw Config', command: 'verdaccio.openRawConfig', description: 'Open config.yaml in editor' },
      { label: '$(plug) Set Registry', command: 'verdaccio.setRegistry', description: 'Point .npmrc to Verdaccio' },
      { label: '$(close) Reset Registry', command: 'verdaccio.resetRegistry', description: 'Remove Verdaccio from .npmrc' },
      { label: '$(cloud-download) Mirror Dependencies', command: 'verdaccio.mirrorDependencies', description: 'Cache all project deps locally' },
      { label: '$(package) Publish to Verdaccio', command: 'verdaccio.publishToVerdaccio', description: 'Publish current package' },
      { label: '$(rocket) Publish All Workspace', command: 'verdaccio.publishAllWorkspacePackages', description: 'Publish all workspace packages' },
      { label: '$(globe) Enable Offline Mode', command: 'verdaccio.enableOfflineMode', description: 'Serve only from cache' },
      { label: '$(trash) Bulk Cleanup', command: 'verdaccio.bulkCleanup', description: 'Remove stale packages' },
      { label: '$(key) Add Auth Token', command: 'verdaccio.addAuthToken', description: 'Add registry auth token' },
      { label: '$(list-tree) Add Scoped Registry', command: 'verdaccio.addScopedRegistry', description: 'Route a scope to a registry' },
      { label: '$(bookmark) Create Profile', command: 'verdaccio.createProfile', description: 'Save current .npmrc as a profile' },
      { label: '$(arrow-swap) Switch Profile', command: 'verdaccio.switchProfile', description: 'Switch .npmrc profile' },
    ],
  });
  setOutputChannel(logManager.getOutputChannel());
  diagnosticCommands.registerExtension({
    name: 'verdaccio-mcp',
    displayName: 'Verdaccio MCP',
    client: mcpServer as any,
  });

  // --- Start MCP server if autoStart is enabled (Req 15.20) ---
  const mcpAutoStart = vscode.workspace.getConfiguration('verdaccio').get<boolean>('mcp.autoStart', true);
  if (mcpAutoStart) {
    mcpServer.start();
  }

  // --- Onboarding check (Req 16.1) ---
  onboardingManager.checkAndPrompt().catch(() => { /* silently skip if config detection fails */ });

  // --- Register tree data providers (Req 3.6) ---
  const statusTreeDisposable = vscode.window.registerTreeDataProvider('verdaccioStatus', statusViewProvider);
  const cacheTreeDisposable = vscode.window.registerTreeDataProvider('verdaccioCache', cacheViewProvider);
  // Register new tree views (Req 11.7, 13.2)
  const analyticsTreeDisposable = vscode.window.registerTreeDataProvider('verdaccioStorageAnalytics', storageAnalyticsProvider);
  const workspaceTreeDisposable = vscode.window.registerTreeDataProvider('verdaccioWorkspacePackages', workspacePackageProvider);
  // Register health tree view (Req 18.1)
  const healthTreeDisposable = vscode.window.registerTreeDataProvider('verdaccioRegistryHealth', registryHealthProvider);

  // --- Profile status bar item (Req 19.4) ---
  const profileStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  profileStatusBarItem.command = 'verdaccio.switchProfile';
  profileManager.setStatusBarItem(profileStatusBarItem);

  // --- Register existing commands ---

  // verdaccio.start (Req 1.1)
  const startCmd = vscode.commands.registerCommand('verdaccio.start', async () => {
    try {
      // Check if config exists first, offer to generate if not
      const exists = await configManager.configExists();
      if (!exists) {
        const action = await vscode.window.showWarningMessage(
          'Verdaccio configuration not found. Generate a default config first?',
          'Generate',
          'Cancel',
        );
        if (action === 'Generate') {
          await configManager.generateDefaultConfig();
        } else {
          return;
        }
      }
      await sm.start();
    } catch (err: any) {
      if (err.code === 'ENOENT' || (err.message && err.message.includes('ENOENT'))) {
        const action = await vscode.window.showErrorMessage(
          'Verdaccio is not installed. Would you like to install it globally?',
          'Install (npm)',
          'Cancel',
        );
        if (action === 'Install (npm)') {
          const terminal = vscode.window.createTerminal('Verdaccio Install');
          terminal.show();
          terminal.sendText('npm install -g verdaccio');
          vscode.window.showInformationMessage(
            'Installing Verdaccio... Run "Verdaccio: Start" again after installation completes.',
          );
        }
      } else {
        vscode.window.showErrorMessage(`Failed to start Verdaccio: ${err.message}`);
      }
    }
  });

  // verdaccio.stop (Req 1.2)
  const stopCmd = vscode.commands.registerCommand('verdaccio.stop', async () => {
    await sm.stop();
  });

  // verdaccio.restart (Req 1.5)
  const restartCmd = vscode.commands.registerCommand('verdaccio.restart', async () => {
    try {
      await sm.restart();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to restart Verdaccio: ${err.message}`);
    }
  });

  // verdaccio.showLogs (Req 5.3)
  const showLogsCmd = vscode.commands.registerCommand('verdaccio.showLogs', () => {
    logManager.show();
  });

  // verdaccio.openRawConfig (Req 2.6)
  const openRawConfigCmd = vscode.commands.registerCommand('verdaccio.openRawConfig', async () => {
    try {
      const exists = await configManager.configExists();
      if (!exists) {
        const action = await vscode.window.showWarningMessage(
          'Config file not found. Generate a default config?',
          'Generate',
          'Cancel',
        );
        if (action === 'Generate') {
          await configManager.generateDefaultConfig();
        } else {
          return;
        }
      }
      await configManager.openRawConfig();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to open config: ${err.message}`);
    }
  });

  // verdaccio.openConfigPanel (Req 2.4)
  const openConfigPanelCmd = vscode.commands.registerCommand('verdaccio.openConfigPanel', () => {
    ConfigurationPanel.createOrShow(context.extensionUri, configManager, sm);
  });

  // verdaccio.setRegistry (Req 6.1)
  const setRegistryCmd = vscode.commands.registerCommand('verdaccio.setRegistry', async () => {
    const port = sm.port ?? 4873;
    await npmrcManager.setRegistry(`http://localhost:${port}/`);
  });

  // verdaccio.resetRegistry (Req 6.2)
  const resetRegistryCmd = vscode.commands.registerCommand('verdaccio.resetRegistry', async () => {
    await npmrcManager.resetRegistry();
  });

  // verdaccio.deletePackage (Req 4.4, 4.5)
  const deletePackageCmd = vscode.commands.registerCommand('verdaccio.deletePackage', async (item) => {
    if (item) {
      await cacheViewProvider.deletePackage(item);
    }
  });

  // --- Register new commands for Req 8-14 ---

  // Scoped registry commands (Req 8.1, 8.3, 8.4)
  const addScopedRegistryCmd = vscode.commands.registerCommand('verdaccio.addScopedRegistry', async () => {
    const scope = await vscode.window.showInputBox({ prompt: 'Scope name (e.g. @myorg)', placeHolder: '@scope' });
    if (!scope) { return; }
    const url = await vscode.window.showInputBox({ prompt: 'Registry URL', placeHolder: 'https://registry.example.com/' });
    if (!url) { return; }
    await npmrcManager.addScopedRegistry(scope, url);
  });

  const editScopedRegistryCmd = vscode.commands.registerCommand('verdaccio.editScopedRegistry', async () => {
    const registries = await npmrcManager.listScopedRegistries();
    if (registries.length === 0) {
      vscode.window.showInformationMessage('No scoped registries configured.');
      return;
    }
    const items = registries.map((r) => ({ label: r.scope, description: r.registryUrl }));
    const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select scope to edit' });
    if (!selected) { return; }
    const newUrl = await vscode.window.showInputBox({ prompt: `New URL for ${selected.label}`, value: selected.description });
    if (!newUrl) { return; }
    await npmrcManager.editScopedRegistry(selected.label, newUrl);
  });

  const removeScopedRegistryCmd = vscode.commands.registerCommand('verdaccio.removeScopedRegistry', async () => {
    const registries = await npmrcManager.listScopedRegistries();
    if (registries.length === 0) {
      vscode.window.showInformationMessage('No scoped registries configured.');
      return;
    }
    const items = registries.map((r) => ({ label: r.scope, description: r.registryUrl }));
    const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select scope to remove' });
    if (!selected) { return; }
    await npmrcManager.removeScopedRegistry(selected.label);
  });

  // Auth token commands (Req 9.1, 9.4, 9.5, 9.6)
  const addAuthTokenCmd = vscode.commands.registerCommand('verdaccio.addAuthToken', async () => {
    const registryUrl = await vscode.window.showInputBox({ prompt: 'Registry URL', placeHolder: 'https://registry.example.com/' });
    if (!registryUrl) { return; }
    const token = await vscode.window.showInputBox({ prompt: 'Auth token', password: true });
    if (!token) { return; }
    await npmrcManager.addAuthToken(registryUrl, token);
  });

  const rotateAuthTokenCmd = vscode.commands.registerCommand('verdaccio.rotateAuthToken', async () => {
    const tokens = await npmrcManager.listAuthTokens();
    if (tokens.length === 0) {
      vscode.window.showInformationMessage('No auth tokens configured.');
      return;
    }
    const items = tokens.map((t) => ({ label: t.registryUrl, description: t.maskedToken }));
    const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select token to rotate' });
    if (!selected) { return; }
    const newToken = await vscode.window.showInputBox({ prompt: `New token for ${selected.label}`, password: true });
    if (!newToken) { return; }
    await npmrcManager.rotateAuthToken(selected.label, newToken);
  });

  const removeAuthTokenCmd = vscode.commands.registerCommand('verdaccio.removeAuthToken', async () => {
    const tokens = await npmrcManager.listAuthTokens();
    if (tokens.length === 0) {
      vscode.window.showInformationMessage('No auth tokens configured.');
      return;
    }
    const items = tokens.map((t) => ({ label: t.registryUrl, description: t.maskedToken }));
    const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select token to remove' });
    if (!selected) { return; }
    await npmrcManager.removeAuthToken(selected.label);
  });

  const revealTokenCmd = vscode.commands.registerCommand('verdaccio.revealToken', async () => {
    const tokens = await npmrcManager.listAuthTokens();
    if (tokens.length === 0) {
      vscode.window.showInformationMessage('No auth tokens configured.');
      return;
    }
    const items = tokens.map((t) => ({ label: t.registryUrl, description: t.maskedToken }));
    const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select token to reveal' });
    if (!selected) { return; }
    await npmrcManager.revealToken(selected.label);
  });

  // Offline mode commands (Req 10.3)
  const enableOfflineModeCmd = vscode.commands.registerCommand('verdaccio.enableOfflineMode', async () => {
    await configManager.enableOfflineMode();
    vscode.window.showInformationMessage('Offline mode enabled.');
  });

  const disableOfflineModeCmd = vscode.commands.registerCommand('verdaccio.disableOfflineMode', async () => {
    await configManager.disableOfflineMode();
    vscode.window.showInformationMessage('Offline mode disabled.');
  });

  // Storage analytics commands (Req 11.4, 11.5)
  const pruneOldVersionsCmd = vscode.commands.registerCommand('verdaccio.pruneOldVersions', async (item) => {
    const packageName = item?.packageName ?? item?.name;
    if (!packageName) {
      const input = await vscode.window.showInputBox({ prompt: 'Package name to prune' });
      if (!input) { return; }
      const keepStr = await vscode.window.showInputBox({ prompt: 'Number of recent versions to keep', value: '3' });
      if (!keepStr) { return; }
      await storageAnalyticsProvider.pruneOldVersionsWithConfirmation(input, parseInt(keepStr, 10));
      cacheViewProvider.refresh();
      return;
    }
    const keepStr = await vscode.window.showInputBox({ prompt: 'Number of recent versions to keep', value: '3' });
    if (!keepStr) { return; }
    await storageAnalyticsProvider.pruneOldVersionsWithConfirmation(packageName, parseInt(keepStr, 10));
    cacheViewProvider.refresh();
  });

  const bulkCleanupCmd = vscode.commands.registerCommand('verdaccio.bulkCleanup', async () => {
    const stalePackages = await storageAnalyticsProvider.getStalePackages();
    if (stalePackages.length === 0) {
      vscode.window.showInformationMessage('No stale packages found.');
      return;
    }
    await storageAnalyticsProvider.bulkCleanupWithConfirmation(stalePackages);
    cacheViewProvider.refresh();
  });

  // Publish commands (Req 12.1, 12.3, 12.4)
  const publishToVerdaccioCmd = vscode.commands.registerCommand('verdaccio.publishToVerdaccio', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showWarningMessage('No workspace folder open.');
      return;
    }
    await publishManager.publishToVerdaccio(workspaceFolders[0].uri.fsPath);
  });

  const promotePackageCmd = vscode.commands.registerCommand('verdaccio.promotePackage', async (item) => {
    const packageName = item?.packageName ?? item?.name;
    const version = item?.version;
    if (!packageName || !version) {
      vscode.window.showWarningMessage('Select a package version to promote.');
      return;
    }
    const targetUrl = await vscode.window.showInputBox({ prompt: 'Target registry URL', placeHolder: 'https://registry.npmjs.org/' });
    if (!targetUrl) { return; }
    await publishManager.promotePackage(packageName, version, targetUrl);
  });

  const bumpVersionCmd = vscode.commands.registerCommand('verdaccio.bumpVersion', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showWarningMessage('No workspace folder open.');
      return;
    }
    const bumpType = await vscode.window.showQuickPick(['patch', 'minor', 'major', 'prerelease'], { placeHolder: 'Select version bump type' });
    if (!bumpType) { return; }
    await publishManager.bumpVersion(workspaceFolders[0].uri.fsPath, bumpType as any);
  });

  // Workspace package commands (Req 13.3, 13.5)
  const publishAllCmd = vscode.commands.registerCommand('verdaccio.publishAllWorkspacePackages', async () => {
    await workspacePackageProvider.publishAll();
  });

  const unpublishAllCmd = vscode.commands.registerCommand('verdaccio.unpublishAllWorkspacePackages', async () => {
    await workspacePackageProvider.unpublishAll();
  });

  // --- Register new commands for Req 15-19 ---

  // Profile commands (Req 19.1, 19.3, 19.5)
  const createProfileCmd = vscode.commands.registerCommand('verdaccio.createProfile', async () => {
    const name = await vscode.window.showInputBox({ prompt: 'Profile name', placeHolder: 'my-profile' });
    if (!name) { return; }
    await profileManager.createProfile(name);
  });

  const switchProfileCmd = vscode.commands.registerCommand('verdaccio.switchProfile', async () => {
    const profiles = await profileManager.listProfiles();
    if (profiles.length === 0) {
      vscode.window.showInformationMessage('No profiles available. Create one first.');
      return;
    }
    const selected = await vscode.window.showQuickPick(profiles, { placeHolder: 'Select profile to switch to' });
    if (!selected) { return; }
    await profileManager.switchProfile(selected);
  });

  const deleteProfileCmd = vscode.commands.registerCommand('verdaccio.deleteProfile', async () => {
    const profiles = await profileManager.listProfiles();
    if (profiles.length === 0) {
      vscode.window.showInformationMessage('No profiles available.');
      return;
    }
    const selected = await vscode.window.showQuickPick(profiles, { placeHolder: 'Select profile to delete' });
    if (!selected) { return; }
    await profileManager.deleteProfile(selected);
  });

  // Dependency mirroring commands (Req 17.1)
  const mirrorDependenciesCmd = vscode.commands.registerCommand('verdaccio.mirrorDependencies', async () => {
    await dependencyMirrorManager.mirrorDependencies();
  });

  const cacheAllDependenciesCmd = vscode.commands.registerCommand('verdaccio.cacheAllDependencies', async () => {
    await dependencyMirrorManager.mirrorDependencies();
  });

  // Utility commands
  const openSettingsCmd = vscode.commands.registerCommand('verdaccio.openSettings', () => {
    vscode.commands.executeCommand('workbench.action.openSettings', 'verdaccio');
  });

  const refreshCacheCmd = vscode.commands.registerCommand('verdaccio.refreshCache', () => {
    cacheViewProvider.refresh();
  });

  const refreshAnalyticsCmd = vscode.commands.registerCommand('verdaccio.refreshAnalytics', () => {
    storageAnalyticsProvider.refresh();
  });

  const refreshHealthCmd = vscode.commands.registerCommand('verdaccio.refreshHealth', () => {
    registryHealthProvider.refresh();
  });

  // --- Status bar item (Req 1.3) ---
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusBarItem.command = 'verdaccio.showLogs';
  updateStatusBar(statusBarItem, sm.state, sm.port);
  statusBarItem.show();

  // --- Subscribe to server state changes ---
  const stateChangeDisposable = sm.onDidChangeState((state: ServerState) => {
    // Update status bar (Req 1.3)
    updateStatusBar(statusBarItem, state, sm.port);

    // Attach LogManager when server starts (Req 5.2)
    if ((state === 'starting' || state === 'running') && (sm as any)._process) {
      logManager.attach((sm as any)._process);
    }

    // Auto-set/reset registry (Req 6.4)
    const autoSet = vscode.workspace.getConfiguration('verdaccio').get<boolean>('autoSetRegistry', false);
    if (autoSet) {
      if (state === 'running') {
        const port = sm.port ?? 4873;
        npmrcManager.setRegistry(`http://localhost:${port}/`);
      } else if (state === 'stopped') {
        npmrcManager.resetRegistry();
      }
    }

    // Refresh storage analytics on state change
    if (state === 'running') {
      storageAnalyticsProvider.refresh();
    }

    // Health monitoring: start when server starts, stop when server stops (Req 18.1, 18.2, 18.7)
    if (state === 'running') {
      registryHealthProvider.startMonitoring();
    } else if (state === 'stopped' || state === 'error') {
      registryHealthProvider.stopMonitoring();
    }
  });

  // --- Check if config exists, offer to generate default (Req 2.6) ---
  configManager.configExists().then(async (exists) => {
    if (!exists) {
      const action = await vscode.window.showInformationMessage(
        'Verdaccio configuration file not found. Generate a default config?',
        'Generate',
        'Cancel'
      );
      if (action === 'Generate') {
        await configManager.generateDefaultConfig();
        vscode.window.showInformationMessage('Default Verdaccio configuration generated.');
      }
    }
  });

  // --- Initial cache refresh ---
  cacheViewProvider.refresh();

  // --- Push all disposables to context.subscriptions ---
  context.subscriptions.push(
    configManager,
    sm,
    logManager,
    mcpServer,
    onboardingManager,
    statusBarItem,
    profileStatusBarItem,
    statusTreeDisposable,
    cacheTreeDisposable,
    analyticsTreeDisposable,
    workspaceTreeDisposable,
    healthTreeDisposable,
    startCmd,
    stopCmd,
    restartCmd,
    showLogsCmd,
    openRawConfigCmd,
    openConfigPanelCmd,
    setRegistryCmd,
    resetRegistryCmd,
    deletePackageCmd,
    addScopedRegistryCmd,
    editScopedRegistryCmd,
    removeScopedRegistryCmd,
    addAuthTokenCmd,
    rotateAuthTokenCmd,
    removeAuthTokenCmd,
    revealTokenCmd,
    enableOfflineModeCmd,
    disableOfflineModeCmd,
    pruneOldVersionsCmd,
    bulkCleanupCmd,
    publishToVerdaccioCmd,
    promotePackageCmd,
    bumpVersionCmd,
    publishAllCmd,
    unpublishAllCmd,
    createProfileCmd,
    switchProfileCmd,
    deleteProfileCmd,
    mirrorDependenciesCmd,
    cacheAllDependenciesCmd,
    openSettingsCmd,
    refreshCacheCmd,
    refreshAnalyticsCmd,
    refreshHealthCmd,
    stateChangeDisposable,
  );
}

/**
 * Updates the status bar item text and tooltip based on server state.
 */
function updateStatusBar(
  item: vscode.StatusBarItem,
  state: ServerState,
  port: number | undefined,
): void {
  switch (state) {
    case 'running':
      item.text = `$(server-process) Verdaccio :${port ?? '?'}`;
      item.tooltip = `Verdaccio running on port ${port ?? 'unknown'}`;
      item.backgroundColor = undefined;
      break;
    case 'starting':
      item.text = '$(loading~spin) Verdaccio starting...';
      item.tooltip = 'Verdaccio server is starting';
      item.backgroundColor = undefined;
      break;
    case 'error':
      item.text = '$(error) Verdaccio error';
      item.tooltip = 'Verdaccio server encountered an error';
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      break;
    case 'stopped':
    default:
      item.text = '$(circle-slash) Verdaccio stopped';
      item.tooltip = 'Verdaccio server is stopped';
      item.backgroundColor = undefined;
      break;
  }
}

/**
 * Called when the extension is deactivated.
 * Cleans up resources including stopping any running Verdaccio server process.
 */
export async function deactivate(): Promise<void> {
  if (serverManager) {
    await serverManager.stop();
  }
  // Unregister from ACS shared status bar (Req 15.23, 20.3)
  unregisterExtension('verdaccio-mcp');
}

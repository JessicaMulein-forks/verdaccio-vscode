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

let registerExtension: Function | undefined;
let unregisterExtension: Function | undefined;
let setOutputChannel: Function | undefined;
let diagnosticCommands: any;

try {
  const statusBar = require('@ai-capabilities-suite/vscode-shared-status-bar');
  registerExtension = statusBar.registerExtension;
  unregisterExtension = statusBar.unregisterExtension;
  setOutputChannel = statusBar.setOutputChannel;
} catch {
  // ACS status bar not available — non-fatal
}

try {
  const clientBase = require('@ai-capabilities-suite/mcp-client-base');
  diagnosticCommands = clientBase.diagnosticCommands;
} catch {
  // ACS client base not available — non-fatal
}

let serverManager: IServerManager | undefined;

/**
 * Called when the extension is activated.
 * Core UI (tree views, commands, status bar) is registered first so the
 * extension is usable even if optional integrations (ACS, MCP) fail.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[Verdaccio] activate() called');

  // --- Instantiate core managers ---
  const configManager = new ConfigManager();
  const logManager = new LogManager();
  const sm = new ServerManager(configManager, (msg) => logManager.log(msg));
  serverManager = sm;
  const statusViewProvider = new StatusViewProvider(sm);
  const cacheViewProvider = new CacheViewProvider(configManager);
  const npmrcManager = new NpmrcManager(sm, context.secrets);
  const storageAnalyticsProvider = new StorageAnalyticsProvider(configManager);
  const publishManager = new PublishManager(sm, configManager);
  const workspacePackageProvider = new WorkspacePackageProvider(sm, publishManager, configManager);
  const dependencyMirrorManager = new DependencyMirrorManager(sm);
  const onboardingManager = new OnboardingManager(sm, npmrcManager, context.workspaceState, dependencyMirrorManager);
  const registryHealthProvider = new RegistryHealthProvider(sm, configManager);
  const profileManager = new ProfileManager(npmrcManager);

  // --- Register tree data providers FIRST (core UI) ---
  const statusTreeDisposable = vscode.window.registerTreeDataProvider('verdaccioStatus', statusViewProvider);
  const cacheTreeDisposable = vscode.window.registerTreeDataProvider('verdaccioCache', cacheViewProvider);
  const analyticsTreeDisposable = vscode.window.registerTreeDataProvider('verdaccioStorageAnalytics', storageAnalyticsProvider);
  const workspaceTreeDisposable = vscode.window.registerTreeDataProvider('verdaccioWorkspacePackages', workspacePackageProvider);
  const healthTreeDisposable = vscode.window.registerTreeDataProvider('verdaccioRegistryHealth', registryHealthProvider);

  // --- Status bar item (Req 1.3) ---
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusBarItem.command = 'verdaccio.showLogs';
  updateStatusBar(statusBarItem, sm.state, sm.port);
  statusBarItem.show();

  // --- Profile status bar item (Req 19.4) ---
  const profileStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  profileStatusBarItem.command = 'verdaccio.switchProfile';
  profileManager.setStatusBarItem(profileStatusBarItem);

  logManager.log(`Extension activated (v${context.extension?.packageJSON?.version ?? 'unknown'})`);

  // --- Register all commands ---
  const startCmd = vscode.commands.registerCommand('verdaccio.start', async () => {
    logManager.log('Start command invoked');
    try {
      const exists = await configManager.configExists();
      logManager.log(`Config exists: ${exists}`);
      if (!exists) {
        logManager.log('No config found, prompting to generate...');
        const action = await vscode.window.showWarningMessage(
          'Verdaccio configuration not found. Generate a default config first?',
          'Generate', 'Cancel',
        );
        if (action === 'Generate') {
          await configManager.generateDefaultConfig();
          logManager.log('Default config generated');
        } else {
          return;
        }
      }
      logManager.log('Starting Verdaccio server...');
      await sm.start();
      logManager.log(`Start returned, state: ${sm.state}, port: ${sm.port}`);
    } catch (err: any) {
      if (err.message && err.message.includes('not installed')) {
        const action = await vscode.window.showErrorMessage(
          'Verdaccio is not installed. Would you like to install it?',
          'Install (npm)', 'Cancel',
        );
        if (action === 'Install (npm)') {
          const terminal = vscode.window.createTerminal('Verdaccio Install');
          terminal.show();
          terminal.sendText('npm install -g verdaccio');
          logManager.log('Installing verdaccio globally via npm...');
        }
      } else {
        logManager.log(`Failed to start: ${err.message}`);
        vscode.window.showErrorMessage(`Failed to start Verdaccio: ${err.message}`);
      }
    }
  });
  logManager.log('Start command registered');
  const stopCmd = vscode.commands.registerCommand('verdaccio.stop', () => { logManager.log('Stopping server...'); return sm.stop(); });
  const restartCmd = vscode.commands.registerCommand('verdaccio.restart', async () => {
    try { logManager.log('Restarting server...'); await sm.restart(); } catch (err: any) { vscode.window.showErrorMessage(`Failed to restart Verdaccio: ${err.message}`); }
  });
  const showLogsCmd = vscode.commands.registerCommand('verdaccio.showLogs', () => logManager.show());
  const openRawConfigCmd = vscode.commands.registerCommand('verdaccio.openRawConfig', async () => {
    try {
      const exists = await configManager.configExists();
      if (!exists) {
        const action = await vscode.window.showWarningMessage('Config file not found. Generate a default config?', 'Generate', 'Cancel');
        if (action === 'Generate') { await configManager.generateDefaultConfig(); } else { return; }
      }
      await configManager.openRawConfig();
    } catch (err: any) { vscode.window.showErrorMessage(`Failed to open config: ${err.message}`); }
  });
  const openConfigPanelCmd = vscode.commands.registerCommand('verdaccio.openConfigPanel', () => {
    ConfigurationPanel.createOrShow(context.extensionUri, configManager, sm);
  });
  const setRegistryCmd = vscode.commands.registerCommand('verdaccio.setRegistry', async () => {
    const port = sm.port ?? 4873;
    await npmrcManager.setRegistry(`http://localhost:${port}/`);
  });
  const resetRegistryCmd = vscode.commands.registerCommand('verdaccio.resetRegistry', () => npmrcManager.resetRegistry());
  const deletePackageCmd = vscode.commands.registerCommand('verdaccio.deletePackage', async (item) => {
    if (item) { await cacheViewProvider.deletePackage(item); }
  });
  const addScopedRegistryCmd = vscode.commands.registerCommand('verdaccio.addScopedRegistry', async () => {
    const scope = await vscode.window.showInputBox({ prompt: 'Scope name (e.g. @myorg)', placeHolder: '@scope' });
    if (!scope) { return; }
    const url = await vscode.window.showInputBox({ prompt: 'Registry URL', placeHolder: 'https://registry.example.com/' });
    if (!url) { return; }
    await npmrcManager.addScopedRegistry(scope, url);
  });
  const editScopedRegistryCmd = vscode.commands.registerCommand('verdaccio.editScopedRegistry', async () => {
    const registries = await npmrcManager.listScopedRegistries();
    if (registries.length === 0) { vscode.window.showInformationMessage('No scoped registries configured.'); return; }
    const selected = await vscode.window.showQuickPick(registries.map((r) => ({ label: r.scope, description: r.registryUrl })), { placeHolder: 'Select scope to edit' });
    if (!selected) { return; }
    const newUrl = await vscode.window.showInputBox({ prompt: `New URL for ${selected.label}`, value: selected.description });
    if (!newUrl) { return; }
    await npmrcManager.editScopedRegistry(selected.label, newUrl);
  });
  const removeScopedRegistryCmd = vscode.commands.registerCommand('verdaccio.removeScopedRegistry', async () => {
    const registries = await npmrcManager.listScopedRegistries();
    if (registries.length === 0) { vscode.window.showInformationMessage('No scoped registries configured.'); return; }
    const selected = await vscode.window.showQuickPick(registries.map((r) => ({ label: r.scope, description: r.registryUrl })), { placeHolder: 'Select scope to remove' });
    if (!selected) { return; }
    await npmrcManager.removeScopedRegistry(selected.label);
  });
  const addAuthTokenCmd = vscode.commands.registerCommand('verdaccio.addAuthToken', async () => {
    const registryUrl = await vscode.window.showInputBox({ prompt: 'Registry URL', placeHolder: 'https://registry.example.com/' });
    if (!registryUrl) { return; }
    const token = await vscode.window.showInputBox({ prompt: 'Auth token', password: true });
    if (!token) { return; }
    await npmrcManager.addAuthToken(registryUrl, token);
  });
  const rotateAuthTokenCmd = vscode.commands.registerCommand('verdaccio.rotateAuthToken', async () => {
    const tokens = await npmrcManager.listAuthTokens();
    if (tokens.length === 0) { vscode.window.showInformationMessage('No auth tokens configured.'); return; }
    const selected = await vscode.window.showQuickPick(tokens.map((t) => ({ label: t.registryUrl, description: t.maskedToken })), { placeHolder: 'Select token to rotate' });
    if (!selected) { return; }
    const newToken = await vscode.window.showInputBox({ prompt: `New token for ${selected.label}`, password: true });
    if (!newToken) { return; }
    await npmrcManager.rotateAuthToken(selected.label, newToken);
  });
  const removeAuthTokenCmd = vscode.commands.registerCommand('verdaccio.removeAuthToken', async () => {
    const tokens = await npmrcManager.listAuthTokens();
    if (tokens.length === 0) { vscode.window.showInformationMessage('No auth tokens configured.'); return; }
    const selected = await vscode.window.showQuickPick(tokens.map((t) => ({ label: t.registryUrl, description: t.maskedToken })), { placeHolder: 'Select token to remove' });
    if (!selected) { return; }
    await npmrcManager.removeAuthToken(selected.label);
  });
  const revealTokenCmd = vscode.commands.registerCommand('verdaccio.revealToken', async () => {
    const tokens = await npmrcManager.listAuthTokens();
    if (tokens.length === 0) { vscode.window.showInformationMessage('No auth tokens configured.'); return; }
    const selected = await vscode.window.showQuickPick(tokens.map((t) => ({ label: t.registryUrl, description: t.maskedToken })), { placeHolder: 'Select token to reveal' });
    if (!selected) { return; }
    await npmrcManager.revealToken(selected.label);
  });
  const enableOfflineModeCmd = vscode.commands.registerCommand('verdaccio.enableOfflineMode', async () => {
    await configManager.enableOfflineMode();
    vscode.window.showInformationMessage('Offline mode enabled.');
  });
  const disableOfflineModeCmd = vscode.commands.registerCommand('verdaccio.disableOfflineMode', async () => {
    await configManager.disableOfflineMode();
    vscode.window.showInformationMessage('Offline mode disabled.');
  });
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
    if (stalePackages.length === 0) { vscode.window.showInformationMessage('No stale packages found.'); return; }
    await storageAnalyticsProvider.bulkCleanupWithConfirmation(stalePackages);
    cacheViewProvider.refresh();
  });
  const publishToVerdaccioCmd = vscode.commands.registerCommand('verdaccio.publishToVerdaccio', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) { vscode.window.showWarningMessage('No workspace folder open.'); return; }
    await publishManager.publishToVerdaccio(workspaceFolders[0].uri.fsPath);
  });
  const promotePackageCmd = vscode.commands.registerCommand('verdaccio.promotePackage', async (item) => {
    const packageName = item?.packageName ?? item?.name;
    const version = item?.version;
    if (!packageName || !version) { vscode.window.showWarningMessage('Select a package version to promote.'); return; }
    const targetUrl = await vscode.window.showInputBox({ prompt: 'Target registry URL', placeHolder: 'https://registry.npmjs.org/' });
    if (!targetUrl) { return; }
    await publishManager.promotePackage(packageName, version, targetUrl);
  });
  const bumpVersionCmd = vscode.commands.registerCommand('verdaccio.bumpVersion', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) { vscode.window.showWarningMessage('No workspace folder open.'); return; }
    const bumpType = await vscode.window.showQuickPick(['patch', 'minor', 'major', 'prerelease'], { placeHolder: 'Select version bump type' });
    if (!bumpType) { return; }
    await publishManager.bumpVersion(workspaceFolders[0].uri.fsPath, bumpType as any);
  });
  const publishAllCmd = vscode.commands.registerCommand('verdaccio.publishAllWorkspacePackages', () => workspacePackageProvider.publishAll());
  const unpublishAllCmd = vscode.commands.registerCommand('verdaccio.unpublishAllWorkspacePackages', () => workspacePackageProvider.unpublishAll());
  const createProfileCmd = vscode.commands.registerCommand('verdaccio.createProfile', async () => {
    const name = await vscode.window.showInputBox({ prompt: 'Profile name', placeHolder: 'my-profile' });
    if (!name) { return; }
    await profileManager.createProfile(name);
  });
  const switchProfileCmd = vscode.commands.registerCommand('verdaccio.switchProfile', async () => {
    const profiles = await profileManager.listProfiles();
    if (profiles.length === 0) { vscode.window.showInformationMessage('No profiles available. Create one first.'); return; }
    const selected = await vscode.window.showQuickPick(profiles, { placeHolder: 'Select profile to switch to' });
    if (!selected) { return; }
    await profileManager.switchProfile(selected);
  });
  const deleteProfileCmd = vscode.commands.registerCommand('verdaccio.deleteProfile', async () => {
    const profiles = await profileManager.listProfiles();
    if (profiles.length === 0) { vscode.window.showInformationMessage('No profiles available.'); return; }
    const selected = await vscode.window.showQuickPick(profiles, { placeHolder: 'Select profile to delete' });
    if (!selected) { return; }
    await profileManager.deleteProfile(selected);
  });
  const mirrorDependenciesCmd = vscode.commands.registerCommand('verdaccio.mirrorDependencies', () => dependencyMirrorManager.mirrorDependencies());
  const cacheAllDependenciesCmd = vscode.commands.registerCommand('verdaccio.cacheAllDependencies', () => dependencyMirrorManager.mirrorDependencies());
  const openSettingsCmd = vscode.commands.registerCommand('verdaccio.openSettings', () => {
    vscode.commands.executeCommand('workbench.action.openSettings', 'verdaccio');
  });
  const refreshCacheCmd = vscode.commands.registerCommand('verdaccio.refreshCache', () => cacheViewProvider.refresh());
  const refreshAnalyticsCmd = vscode.commands.registerCommand('verdaccio.refreshAnalytics', () => storageAnalyticsProvider.refresh());
  const refreshHealthCmd = vscode.commands.registerCommand('verdaccio.refreshHealth', () => registryHealthProvider.refresh());

  // --- Subscribe to server state changes ---
  const stateChangeDisposable = sm.onDidChangeState((state: ServerState) => {
    try {
      logManager.log(`Server state: ${state}${state === 'running' ? ` (port ${sm.port})` : ''}`);
      logManager.log(`sm.state=${sm.state} sm.port=${sm.port}`);
      updateStatusBar(statusBarItem, state, sm.port);
      statusViewProvider.refresh();
      const autoSet = vscode.workspace.getConfiguration('verdaccio').get<boolean>('autoSetRegistry', false);
      if (autoSet) {
        if (state === 'running') { npmrcManager.setRegistry(`http://localhost:${sm.port ?? 4873}/`); }
        else if (state === 'stopped') { npmrcManager.resetRegistry(); }
      }
      if (state === 'running') { storageAnalyticsProvider.refresh(); cacheViewProvider.refresh(); registryHealthProvider.startMonitoring(); }
      else if (state === 'stopped' || state === 'error') { registryHealthProvider.stopMonitoring(); storageAnalyticsProvider.refresh(); cacheViewProvider.refresh(); }
    } catch (err) {
      console.error('[Verdaccio] State change handler error:', err);
    }
  });

  console.log('[Verdaccio] Core UI registered');

  // --- Optional integrations (ACS, MCP, onboarding) — run async, never block activate ---
  (async () => {
    let mcpServer: McpServer | undefined;
    try {
      mcpServer = new McpServer({
        serverManager: sm, configManager, npmrcManager, publishManager,
        workspacePackageProvider, storageAnalyticsProvider, cacheViewProvider,
      });
    } catch (err) {
      console.error('[Verdaccio] Failed to create MCP server:', err);
    }

    try {
      if (registerExtension) {
        // Wrap in a timeout — registerExtension can hang in devcontainers
        const registrationPromise = registerExtension('verdaccio-mcp', {
          displayName: 'Verdaccio Registry', status: 'ok', settingsQuery: 'verdaccio',
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
        // Don't await — let it complete in background. Race with a 5s timeout.
        Promise.race([
          registrationPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('ACS registration timeout')), 5000)),
        ]).catch((err) => console.error('[Verdaccio] ACS registration:', err.message));
      }
    } catch (err) { console.error('[Verdaccio] ACS registration failed:', err); }

    try { if (setOutputChannel) { setOutputChannel(logManager.getOutputChannel()); } } catch (err) { console.error('[Verdaccio] setOutputChannel failed:', err); }
    try { if (diagnosticCommands) { diagnosticCommands.registerExtension({ name: 'verdaccio-mcp', displayName: 'Verdaccio MCP', client: mcpServer as any }); } } catch (err) { console.error('[Verdaccio] diagnosticCommands failed:', err); }

    if (mcpServer) {
      const mcpAutoStart = vscode.workspace.getConfiguration('verdaccio').get<boolean>('mcp.autoStart', true);
      if (mcpAutoStart) {
        try { await mcpServer.start(); } catch (err) { console.error('[Verdaccio] MCP auto-start failed:', err); }
      }
      context.subscriptions.push(mcpServer);
    }
    if (unregisterExtension) {
      const unreg = unregisterExtension;
      context.subscriptions.push({ dispose: () => unreg('verdaccio-mcp') });
    }

    onboardingManager.checkAndPrompt().catch(() => {});
  })().catch((err) => { console.error('[Verdaccio] Optional integrations failed:', err); });

  // --- Config existence check (fire-and-forget) ---
  configManager.configExists().then(async (exists) => {
    if (!exists) {
      const action = await vscode.window.showInformationMessage(
        'Verdaccio configuration file not found. Generate a default config?', 'Generate', 'Cancel');
      if (action === 'Generate') {
        await configManager.generateDefaultConfig();
        vscode.window.showInformationMessage('Default Verdaccio configuration generated.');
      }
    }
  }).catch((err) => { console.error('[Verdaccio] Config check failed:', err); });

  cacheViewProvider.refresh();

  // --- Push all disposables ---
  context.subscriptions.push(
    configManager, sm, logManager, onboardingManager,
    statusBarItem, profileStatusBarItem,
    statusTreeDisposable, cacheTreeDisposable, analyticsTreeDisposable,
    workspaceTreeDisposable, healthTreeDisposable,
    startCmd, stopCmd, restartCmd, showLogsCmd, openRawConfigCmd, openConfigPanelCmd,
    setRegistryCmd, resetRegistryCmd, deletePackageCmd,
    addScopedRegistryCmd, editScopedRegistryCmd, removeScopedRegistryCmd,
    addAuthTokenCmd, rotateAuthTokenCmd, removeAuthTokenCmd, revealTokenCmd,
    enableOfflineModeCmd, disableOfflineModeCmd,
    pruneOldVersionsCmd, bulkCleanupCmd,
    publishToVerdaccioCmd, promotePackageCmd, bumpVersionCmd,
    publishAllCmd, unpublishAllCmd,
    createProfileCmd, switchProfileCmd, deleteProfileCmd,
    mirrorDependenciesCmd, cacheAllDependenciesCmd,
    openSettingsCmd, refreshCacheCmd, refreshAnalyticsCmd, refreshHealthCmd,
    stateChangeDisposable,
  );

  logManager.log('Ready');

  // Auto-start verdaccio if config exists (default: true)
  const autoStart = vscode.workspace.getConfiguration('verdaccio').get<boolean>('server.autoStart', true);
  if (autoStart) {
    setTimeout(async () => {
      try {
        const exists = await configManager.configExists();
        if (exists) {
          logManager.log('Auto-starting server...');
          await vscode.commands.executeCommand('verdaccio.start');
        }
      } catch (err: any) {
        logManager.log(`Auto-start failed: ${err.message}`);
      }
    }, 3000);
  }

  console.log('[Verdaccio] activate() completed successfully');
}

function updateStatusBar(
  item: vscode.StatusBarItem,
  state: ServerState,
  port: number | undefined,
): void {
  console.log(`[Verdaccio] updateStatusBar called: state=${state} port=${port}`);
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

export async function deactivate(): Promise<void> {
  if (serverManager) {
    await serverManager.stop();
  }
  try { if (unregisterExtension) { unregisterExtension('verdaccio-mcp'); } } catch { /* ignore */ }
}

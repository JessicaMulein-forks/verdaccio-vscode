import * as vscode from 'vscode';
import { IConfigManager } from './configManager';
import { IServerManager } from './serverManager';
import { VerdaccioConfig, isValidRegistryUrl } from './types';

export class ConfigurationPanel {
  public static currentPanel: ConfigurationPanel | undefined;
  private static readonly viewType = 'verdaccioConfig';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _configManager: IConfigManager;
  private readonly _serverManager: IServerManager;
  private _disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    configManager: IConfigManager,
    serverManager: IServerManager,
  ) {
    this._panel = panel;
    this._configManager = configManager;
    this._serverManager = serverManager;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      null,
      this._disposables,
    );

    this._updateWebview();
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    configManager: IConfigManager,
    serverManager: IServerManager,
  ): ConfigurationPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (ConfigurationPanel.currentPanel) {
      ConfigurationPanel.currentPanel._panel.reveal(column);
      ConfigurationPanel.currentPanel._updateWebview();
      return ConfigurationPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      ConfigurationPanel.viewType,
      'Verdaccio Configuration',
      column,
      { enableScripts: true },
    );

    ConfigurationPanel.currentPanel = new ConfigurationPanel(panel, configManager, serverManager);
    return ConfigurationPanel.currentPanel;
  }

  public dispose(): void {
    ConfigurationPanel.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }

  private async _updateWebview(): Promise<void> {
    try {
      const config = await this._configManager.readConfig();
      this._panel.webview.html = this._getHtml(config);
    } catch {
      this._panel.webview.html = this._getErrorHtml();
    }
  }

  private async _handleMessage(message: { command: string; data?: any }): Promise<void> {
    if (message.command === 'save') {
      await this._onSave(message.data);
    } else if (message.command === 'toggleOfflineMode') {
      await this._onToggleOfflineMode(message.data);
    }
  }

  private async _onSave(data: {
    listen: string;
    storage: string;
    max_body_size: string;
    logLevel: string;
    uplinks: Record<string, {
      url: string;
      timeout: string;
      max_fails: number;
      cacheStrategy?: string;
      maxage?: string;
      cache_ttl?: string;
      http_proxy?: string;
      https_proxy?: string;
    }>;
    http_proxy?: string;
    https_proxy?: string;
    no_proxy?: string;
  }): Promise<void> {
    // Validate global proxy URLs before submission (Req 14.7)
    if (data.http_proxy && !isValidRegistryUrl(data.http_proxy)) {
      this._panel.webview.postMessage({ command: 'validationError', field: 'http_proxy', message: 'Invalid HTTP proxy URL. Must be a valid HTTP or HTTPS URL.' });
      return;
    }
    if (data.https_proxy && !isValidRegistryUrl(data.https_proxy)) {
      this._panel.webview.postMessage({ command: 'validationError', field: 'https_proxy', message: 'Invalid HTTPS proxy URL. Must be a valid HTTP or HTTPS URL.' });
      return;
    }

    // Validate per-uplink proxy URLs (Req 14.7)
    if (data.uplinks) {
      for (const [name, values] of Object.entries(data.uplinks)) {
        if (values.http_proxy && !isValidRegistryUrl(values.http_proxy)) {
          this._panel.webview.postMessage({ command: 'validationError', field: `uplink-http-proxy-${name}`, message: `Invalid HTTP proxy URL for uplink "${name}".` });
          return;
        }
        if (values.https_proxy && !isValidRegistryUrl(values.https_proxy)) {
          this._panel.webview.postMessage({ command: 'validationError', field: `uplink-https-proxy-${name}`, message: `Invalid HTTPS proxy URL for uplink "${name}".` });
          return;
        }
      }
    }

    // Build the general config patch
    const patch: Partial<VerdaccioConfig> = {
      listen: data.listen,
      storage: data.storage,
      max_body_size: data.max_body_size,
      log: { level: data.logLevel as VerdaccioConfig['log']['level'] },
    };

    if (data.uplinks) {
      const currentConfig = await this._configManager.readConfig();
      const updatedUplinks = { ...currentConfig.uplinks };
      for (const [name, values] of Object.entries(data.uplinks)) {
        if (updatedUplinks[name]) {
          updatedUplinks[name] = {
            ...updatedUplinks[name],
            url: values.url,
            timeout: values.timeout,
            max_fails: values.max_fails,
          };
        }
      }
      patch.uplinks = updatedUplinks;
    }

    await this._configManager.updateConfig(patch);

    // Apply per-uplink cache strategy and cache settings (Req 10.1, 10.6)
    if (data.uplinks) {
      for (const [name, values] of Object.entries(data.uplinks)) {
        if (values.cacheStrategy) {
          await this._configManager.setCacheStrategy(name, values.cacheStrategy as 'cache-first' | 'proxy-first');
        }
        const cacheSettings: { maxage?: string; cache_ttl?: string; timeout?: string } = {};
        if (values.maxage !== undefined && values.maxage !== '') { cacheSettings.maxage = values.maxage; }
        if (values.cache_ttl !== undefined && values.cache_ttl !== '') { cacheSettings.cache_ttl = values.cache_ttl; }
        if (Object.keys(cacheSettings).length > 0) {
          await this._configManager.setUplinkCacheSettings(name, cacheSettings);
        }

        // Per-uplink proxy override (Req 14.2, 14.4)
        if (values.http_proxy !== undefined || values.https_proxy !== undefined) {
          await this._configManager.setUplinkProxy(name, values.http_proxy || undefined, values.https_proxy || undefined);
        }
      }
    }

    // Apply global proxy settings (Req 14.1, 14.3, 14.5)
    if (data.http_proxy !== undefined || data.https_proxy !== undefined || data.no_proxy !== undefined) {
      await this._configManager.setGlobalProxy(
        data.http_proxy || undefined,
        data.https_proxy || undefined,
        data.no_proxy || undefined,
      );
    }

    // Prompt restart if server is running (Req 2.4, 10.9, 14.6)
    if (this._serverManager.state === 'running') {
      const restart = await vscode.window.showInformationMessage(
        'Verdaccio configuration updated. Restart the server for changes to take effect?',
        'Restart',
        'Later',
      );
      if (restart === 'Restart') {
        await this._serverManager.restart();
      }
    }

    this._panel.webview.postMessage({ command: 'saved' });
  }

  private async _onToggleOfflineMode(data: { enabled: boolean }): Promise<void> {
    if (data.enabled) {
      await this._configManager.enableOfflineMode();
    } else {
      await this._configManager.disableOfflineMode();
    }

    // Prompt restart if server is running
    if (this._serverManager.state === 'running') {
      const restart = await vscode.window.showInformationMessage(
        'Offline mode updated. Restart the server for changes to take effect?',
        'Restart',
        'Later',
      );
      if (restart === 'Restart') {
        await this._serverManager.restart();
      }
    }

    this._panel.webview.postMessage({ command: 'offlineModeToggled', enabled: data.enabled });
  }

  private _getErrorHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Verdaccio Configuration</title></head>
<body>
  <h2>Error</h2>
  <p>Could not read the Verdaccio configuration file. Please ensure the config file exists.</p>
</body>
</html>`;
  }

  private _getHtml(config: VerdaccioConfig): string {
    const logLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    const logOptions = logLevels
      .map((l) => `<option value="${l}"${config.log.level === l ? ' selected' : ''}>${l}</option>`)
      .join('');

    const uplinkRows = Object.entries(config.uplinks || {})
      .map(
        ([name, uplink]) => {
          const isCacheFirst = uplink.maxage === '9999d';
          const isProxyFirst = uplink.maxage === '0';
          const cacheFirstSelected = isCacheFirst ? ' selected' : '';
          const proxyFirstSelected = isProxyFirst ? ' selected' : '';
          const defaultSelected = (!isCacheFirst && !isProxyFirst) ? ' selected' : '';

          return `
        <fieldset class="uplink-fieldset" data-uplink-name="${name}">
          <legend>${name}</legend>
          <label>URL<input type="text" name="uplink-url-${name}" value="${uplink.url}" /></label>
          <label>Timeout<input type="text" name="uplink-timeout-${name}" value="${uplink.timeout}" /></label>
          <label>Max Retries<input type="number" name="uplink-max-fails-${name}" value="${uplink.max_fails}" min="0" /></label>
          <label>Cache Strategy
            <select name="uplink-cache-strategy-${name}">
              <option value=""${defaultSelected}>Default</option>
              <option value="cache-first"${cacheFirstSelected}>Cache First</option>
              <option value="proxy-first"${proxyFirstSelected}>Proxy First</option>
            </select>
          </label>
          <label>TTL (maxage)<input type="text" name="uplink-maxage-${name}" value="${uplink.maxage}" /></label>
          <label>Cache TTL<input type="text" name="uplink-cache-ttl-${name}" value="${uplink.cache_ttl || ''}" /></label>
          <label>Proxy Override (HTTP)<input type="text" name="uplink-http-proxy-${name}" value="${uplink.http_proxy || ''}" placeholder="http://proxy:port" /></label>
          <label>Proxy Override (HTTPS)<input type="text" name="uplink-https-proxy-${name}" value="${uplink.https_proxy || ''}" placeholder="https://proxy:port" /></label>
        </fieldset>`;
        },
      )
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verdaccio Configuration</title>
  <style>
    body { font-family: var(--vscode-font-family, sans-serif); padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    label { display: block; margin-bottom: 8px; }
    input, select { display: block; width: 100%; padding: 4px 6px; margin-top: 2px; box-sizing: border-box; }
    fieldset { margin-bottom: 12px; padding: 8px; }
    button { margin-top: 12px; padding: 6px 16px; cursor: pointer; }
    h2 { margin-top: 0; }
    .section { margin-bottom: 20px; }
    .toggle-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .toggle-row input[type="checkbox"] { width: auto; }
    .error-msg { color: var(--vscode-errorForeground, red); font-size: 0.9em; margin-top: 2px; }
  </style>
</head>
<body>
  <h2>Verdaccio Configuration</h2>
  <form id="configForm">
    <div class="section">
      <h3>General</h3>
      <label>Listen Address
        <input type="text" id="listen" value="${config.listen}" />
      </label>
      <label>Storage Directory
        <input type="text" id="storage" value="${config.storage}" />
      </label>
      <label>Max Body Size
        <input type="text" id="max_body_size" value="${config.max_body_size}" />
      </label>
      <label>Log Level
        <select id="logLevel">${logOptions}</select>
      </label>
    </div>
    <div class="section">
      <h3>Offline Mode</h3>
      <div class="toggle-row">
        <input type="checkbox" id="offlineMode" />
        <label for="offlineMode">Enable Offline Mode</label>
      </div>
    </div>
    <div class="section">
      <h3>Uplinks</h3>
      ${uplinkRows}
    </div>
    <div class="section">
      <h3>Proxy Settings</h3>
      <label>Global HTTP Proxy
        <input type="text" id="http_proxy" value="${config.http_proxy || ''}" placeholder="http://proxy:port" />
        <span id="http_proxy_error" class="error-msg"></span>
      </label>
      <label>Global HTTPS Proxy
        <input type="text" id="https_proxy" value="${config.https_proxy || ''}" placeholder="https://proxy:port" />
        <span id="https_proxy_error" class="error-msg"></span>
      </label>
      <label>No-Proxy List
        <input type="text" id="no_proxy" value="${config.no_proxy || ''}" placeholder="localhost,127.0.0.1,.internal" />
      </label>
    </div>
    <button type="submit">Save</button>
  </form>
  <script>
    const vscode = acquireVsCodeApi();

    document.getElementById('offlineMode').addEventListener('change', (e) => {
      vscode.postMessage({
        command: 'toggleOfflineMode',
        data: { enabled: e.target.checked },
      });
    });

    document.getElementById('configForm').addEventListener('submit', (e) => {
      e.preventDefault();
      // Clear previous errors
      document.querySelectorAll('.error-msg').forEach(el => el.textContent = '');

      const uplinks = {};
      document.querySelectorAll('.uplink-fieldset').forEach((fs) => {
        const name = fs.dataset.uplinkName;
        uplinks[name] = {
          url: fs.querySelector('input[name="uplink-url-' + name + '"]').value,
          timeout: fs.querySelector('input[name="uplink-timeout-' + name + '"]').value,
          max_fails: parseInt(fs.querySelector('input[name="uplink-max-fails-' + name + '"]').value, 10),
          cacheStrategy: fs.querySelector('select[name="uplink-cache-strategy-' + name + '"]').value,
          maxage: fs.querySelector('input[name="uplink-maxage-' + name + '"]').value,
          cache_ttl: fs.querySelector('input[name="uplink-cache-ttl-' + name + '"]').value,
          http_proxy: fs.querySelector('input[name="uplink-http-proxy-' + name + '"]').value,
          https_proxy: fs.querySelector('input[name="uplink-https-proxy-' + name + '"]').value,
        };
      });
      vscode.postMessage({
        command: 'save',
        data: {
          listen: document.getElementById('listen').value,
          storage: document.getElementById('storage').value,
          max_body_size: document.getElementById('max_body_size').value,
          logLevel: document.getElementById('logLevel').value,
          uplinks,
          http_proxy: document.getElementById('http_proxy').value,
          https_proxy: document.getElementById('https_proxy').value,
          no_proxy: document.getElementById('no_proxy').value,
        },
      });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command === 'saved') {
        // Brief confirmation
      } else if (msg.command === 'validationError') {
        const errorEl = document.getElementById(msg.field + '_error');
        if (errorEl) {
          errorEl.textContent = msg.message;
        }
      } else if (msg.command === 'offlineModeToggled') {
        // Update checkbox state
        document.getElementById('offlineMode').checked = msg.enabled;
      }
    });
  </script>
</body>
</html>`;
  }
}

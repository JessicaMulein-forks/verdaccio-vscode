import * as vscode from 'vscode';
import { ServerState, ServerInfo } from './types';
import { IConfigManager } from './configManager';

export type LogFn = (message: string) => void;

export interface IServerManager extends vscode.Disposable {
  readonly state: ServerState;
  readonly onDidChangeState: vscode.Event<ServerState>;
  readonly port: number | undefined;
  readonly startTime: Date | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
}

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5000;

export class ServerManager implements IServerManager {
  private _info: ServerInfo = {
    state: 'stopped', port: undefined, startTime: undefined,
    pid: undefined, lastError: undefined,
  };

  private _server: any; // http.Server from verdaccio
  private _outputBuffer: string[] = [];
  private readonly _stateEmitter = new vscode.EventEmitter<ServerState>();
  private readonly _configManager: IConfigManager;
  private readonly _log: LogFn;

  readonly onDidChangeState: vscode.Event<ServerState> = this._stateEmitter.event;

  constructor(configManager: IConfigManager, log?: LogFn) {
    this._configManager = configManager;
    this._log = log ?? (() => {});
  }

  get state(): ServerState { return this._info.state; }
  get port(): number | undefined { return this._info.port; }
  get startTime(): Date | undefined { return this._info.startTime; }
  get pid(): number | undefined { return this._info.pid; }
  get serverInfo(): ServerInfo { return { ...this._info }; }
  get outputBuffer(): readonly string[] { return [...this._outputBuffer]; }

  async start(): Promise<void> {
    // Reset stale state
    if (this._info.state === 'starting' && !this._server) {
      this._info.state = 'stopped';
      this._resetInfo();
    }

    if (this._info.state === 'running' || this._info.state === 'starting') {
      return;
    }

    const configPath = this._configManager.getConfigPath();
    const port = this._parsePortFromConfig();

    // Kill any existing process on the target port
    // Not needed for in-process mode — just retry if port is busy

    this._setState('starting');
    this._outputBuffer = [];

    try {
      this._log(`Starting verdaccio in-process from ${configPath}`);

      // Import verdaccio programmatically
      let runServer: any;
      try {
        // Try local require first, then resolve global install path
        let verdaccio: any;
        try {
          verdaccio = require('verdaccio');
        } catch {
          // Not found locally — try to find global install
          const { execSync } = require('child_process');
          try {
            const globalPath = execSync('npm root -g', { encoding: 'utf-8' }).trim();
            this._log(`Trying global path: ${globalPath}/verdaccio`);
            verdaccio = require(require('path').join(globalPath, 'verdaccio'));
          } catch {
            // Also try npx-style resolution
            const verdaccioPath = execSync('which verdaccio', { encoding: 'utf-8' }).trim();
            const resolved = require('fs').realpathSync(verdaccioPath);
            const pkgDir = require('path').resolve(require('path').dirname(resolved), '..');
            this._log(`Trying resolved path: ${pkgDir}`);
            verdaccio = require(pkgDir);
          }
        }
        runServer = verdaccio.runServer || verdaccio.default;
      } catch (err: any) {
        this._info.lastError = `Verdaccio not installed: ${err.message}`;
        this._log(this._info.lastError);
        this._setState('error');
        throw new Error('Verdaccio is not installed. Run: npm install -g verdaccio');
      }

      if (!runServer) {
        this._info.lastError = 'Verdaccio module does not export runServer';
        this._log(this._info.lastError);
        this._setState('error');
        throw new Error(this._info.lastError);
      }

      // runServer returns an Express app
      const app = await runServer(configPath);
      this._log('Verdaccio app created, starting listener...');

      // Start listening — retry if port is temporarily busy from a previous instance
      await new Promise<void>((resolve, reject) => {
        let attempts = 0;
        const maxAttempts = 3;

        const tryListen = () => {
          attempts++;
          this._log(`Listen attempt ${attempts} on port ${port}...`);

          this._server = app.listen(port, '0.0.0.0', () => {
            this._info.port = port;
            this._info.startTime = new Date();
            this._info.pid = process.pid;
            this._log(`Verdaccio listening on 0.0.0.0:${port}`);
            this._setState('running');
            resolve();
          });

          this._server.on('error', (err: any) => {
            this._server = undefined;
            if (err.code === 'EADDRINUSE' && attempts < maxAttempts) {
              this._log(`Port ${port} busy, retrying in 2s... (attempt ${attempts}/${maxAttempts})`);
              setTimeout(tryListen, 2000);
            } else {
              if (err.code === 'EADDRINUSE') {
                this._info.lastError = `Port ${port} is in use. Run: kill $(lsof -ti:${port})`;
                this._log(`Port ${port} still busy after ${maxAttempts} attempts`);
              } else {
                this._info.lastError = err.message;
                this._log(`Server error: ${err.message}`);
              }
              this._setState('error');
              reject(err);
            }
          });
        };

        tryListen();
      });
    } catch (err: any) {
      if (this._info.state !== 'error') {
        this._info.lastError = err.message;
        this._log(`Start failed: ${err.message}`);
        this._setState('error');
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this._info.state === 'stopped') { return; }

    const server = this._server;
    if (!server) {
      this._setState('stopped');
      this._resetInfo();
      return;
    }

    this._log('Stopping verdaccio...');

    return new Promise<void>((resolve) => {
      const forceTimeout = setTimeout(() => {
        this._log('Graceful shutdown timeout, forcing close');
        try { server.close(); } catch { /* ignore */ }
        this._server = undefined;
        this._resetInfo();
        this._setState('stopped');
        resolve();
      }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);

      server.close(() => {
        clearTimeout(forceTimeout);
        this._server = undefined;
        this._resetInfo();
        this._log('Verdaccio stopped');
        this._setState('stopped');
        resolve();
      });
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  dispose(): void {
    if (this._server) {
      try { this._server.close(); } catch { /* ignore */ }
      this._server = undefined;
    }
    this._stateEmitter.dispose();
  }

  private _setState(newState: ServerState): void {
    this._info.state = newState;
    try { this._stateEmitter.fire(newState); } catch { /* swallow listener errors */ }
  }

  private _resetInfo(): void {
    this._info.port = undefined;
    this._info.startTime = undefined;
    this._info.pid = undefined;
    this._info.lastError = undefined;
  }

  private _parsePortFromConfig(): number {
    try {
      const fs = require('fs');
      const content = fs.readFileSync(this._configManager.getConfigPath(), 'utf-8');
      const match = content.match(/listen[:\s]+['"]?[^'"\s]*?:(\d+)/);
      if (match) { return parseInt(match[1], 10); }
    } catch { /* use default */ }
    return 4873;
  }

}

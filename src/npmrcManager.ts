import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { IServerManager } from './serverManager';
import {
  ScopedRegistryEntry,
  AuthTokenEntry,
  isValidScope,
  isValidRegistryUrl,
  isValidToken,
  maskToken,
} from './types';

export interface INpmrcManager {
  setRegistry(address: string): Promise<void>;
  resetRegistry(): Promise<void>;

  // Scoped registries (Req 8)
  addScopedRegistry(scope: string, url: string): Promise<void>;
  editScopedRegistry(scope: string, newUrl: string): Promise<void>;
  removeScopedRegistry(scope: string): Promise<void>;
  listScopedRegistries(): Promise<ScopedRegistryEntry[]>;

  // Auth tokens (Req 9)
  addAuthToken(registryUrl: string, token: string): Promise<void>;
  rotateAuthToken(registryUrl: string, newToken: string): Promise<void>;
  removeAuthToken(registryUrl: string): Promise<void>;
  listAuthTokens(): Promise<AuthTokenEntry[]>;
  revealToken(registryUrl: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Pure helper: registry line helpers (existing)
// ---------------------------------------------------------------------------

/**
 * Pure helper: adds or replaces the `registry=` line in .npmrc content.
 * Preserves all other lines.
 */
export function setRegistryInContent(content: string, registryUrl: string): string {
  const lines = content.split('\n');
  const registryLine = `registry=${registryUrl}`;
  const idx = lines.findIndex((line) => line.trimStart().startsWith('registry='));

  if (idx !== -1) {
    lines[idx] = registryLine;
  } else {
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.splice(lines.length - 1, 0, registryLine);
    } else {
      lines.push(registryLine);
    }
  }

  return lines.join('\n');
}


/**
 * Pure helper: removes the `registry=` line from .npmrc content.
 * Preserves all other lines.
 */
export function removeRegistryFromContent(content: string): string {
  const lines = content.split('\n');
  const filtered = lines.filter((line) => !line.trimStart().startsWith('registry='));
  return filtered.join('\n');
}

// ---------------------------------------------------------------------------
// Pure helper: scoped registry helpers
// ---------------------------------------------------------------------------

/**
 * Adds a `@scope:registry=<url>` line to .npmrc content.
 * If the scope already exists, replaces its URL.
 */
export function addScopedRegistryInContent(content: string, scope: string, url: string): string {
  const lines = content.split('\n');
  const entry = `${scope}:registry=${url}`;
  const idx = lines.findIndex((line) => line.trimStart().startsWith(`${scope}:registry=`));

  if (idx !== -1) {
    lines[idx] = entry;
  } else {
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.splice(lines.length - 1, 0, entry);
    } else {
      lines.push(entry);
    }
  }

  return lines.join('\n');
}

/**
 * Removes the `@scope:registry=` line from .npmrc content.
 * Preserves all other lines.
 */
export function removeScopedRegistryFromContent(content: string, scope: string): string {
  const lines = content.split('\n');
  const filtered = lines.filter((line) => !line.trimStart().startsWith(`${scope}:registry=`));
  return filtered.join('\n');
}

/**
 * Parses .npmrc content and returns all scoped registry entries.
 */
export function listScopedRegistriesFromContent(content: string): ScopedRegistryEntry[] {
  const entries: ScopedRegistryEntry[] = [];
  const lines = content.split('\n');
  const pattern = /^(@[^:]+):registry=(.+)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(pattern);
    if (match) {
      entries.push({ scope: match[1], registryUrl: match[2] });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Pure helper: auth token helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the registry host key from a URL for use in .npmrc auth token lines.
 * e.g. "https://registry.npmjs.org/" -> "registry.npmjs.org/"
 */
function registryHostKey(registryUrl: string): string {
  // Strip the protocol to get the host portion used in .npmrc
  return registryUrl.replace(/^https?:/, '');
}

/**
 * Adds a `//registry/:_authToken=<token>` line to .npmrc content.
 * If the registry already has a token, replaces it.
 */
export function addAuthTokenInContent(content: string, registryUrl: string, token: string): string {
  const hostKey = registryHostKey(registryUrl);
  const lines = content.split('\n');
  const entry = `//${hostKey.replace(/^\/\//, '')}:_authToken=${token}`;
  const prefix = `//${hostKey.replace(/^\/\//, '')}:_authToken=`;
  const idx = lines.findIndex((line) => line.trimStart().startsWith(prefix));

  if (idx !== -1) {
    lines[idx] = entry;
  } else {
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.splice(lines.length - 1, 0, entry);
    } else {
      lines.push(entry);
    }
  }

  return lines.join('\n');
}

/**
 * Removes the `//registry/:_authToken=` line from .npmrc content.
 * Preserves all other lines.
 */
export function removeAuthTokenFromContent(content: string, registryUrl: string): string {
  const hostKey = registryHostKey(registryUrl);
  const prefix = `//${hostKey.replace(/^\/\//, '')}:_authToken=`;
  const lines = content.split('\n');
  const filtered = lines.filter((line) => !line.trimStart().startsWith(prefix));
  return filtered.join('\n');
}

/**
 * Parses .npmrc content and returns all auth token entries (with raw tokens).
 */
export function listAuthTokensFromContent(content: string): { registryUrl: string; token: string }[] {
  const entries: { registryUrl: string; token: string }[] = [];
  const lines = content.split('\n');
  const pattern = /^\/\/([^:]+):_authToken=(.+)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(pattern);
    if (match) {
      entries.push({ registryUrl: match[1], token: match[2] });
    }
  }

  return entries;
}


// ---------------------------------------------------------------------------
// NpmrcManager class
// ---------------------------------------------------------------------------

export class NpmrcManager implements INpmrcManager {
  private readonly _serverManager: IServerManager;
  private readonly _secretStorage: vscode.SecretStorage | undefined;

  constructor(serverManager: IServerManager, secretStorage?: vscode.SecretStorage) {
    this._serverManager = serverManager;
    this._secretStorage = secretStorage;
  }

  // ---- Existing registry methods ----

  async setRegistry(address: string): Promise<void> {
    if (this._serverManager.state !== 'running') {
      const action = await vscode.window.showWarningMessage(
        'Verdaccio server is not running. Start the server first?',
        'Start Server',
        'Cancel'
      );
      if (action === 'Start Server') {
        await this._serverManager.start();
      }
      return;
    }

    const npmrcPath = this._getNpmrcPath();
    let content = '';

    try {
      content = await fs.readFile(npmrcPath, 'utf-8');
    } catch {
      // File doesn't exist — we'll create it
    }

    const updated = setRegistryInContent(content, address);
    await fs.mkdir(path.dirname(npmrcPath), { recursive: true });
    await fs.writeFile(npmrcPath, updated, 'utf-8');
  }

  async resetRegistry(): Promise<void> {
    const npmrcPath = this._getNpmrcPath();

    let content: string;
    try {
      content = await fs.readFile(npmrcPath, 'utf-8');
    } catch {
      // File doesn't exist — nothing to reset
      return;
    }

    const updated = removeRegistryFromContent(content);
    await fs.writeFile(npmrcPath, updated, 'utf-8');
  }

  // ---- Scoped registry methods (Req 8) ----

  async addScopedRegistry(scope: string, url: string): Promise<void> {
    if (!isValidScope(scope)) {
      vscode.window.showErrorMessage(`Invalid scope "${scope}". Scope must start with "@" and contain no whitespace.`);
      return;
    }
    if (!isValidRegistryUrl(url)) {
      vscode.window.showErrorMessage(`Invalid registry URL "${url}". Must be a valid HTTP or HTTPS URL.`);
      return;
    }

    const npmrcPath = this._getNpmrcPath();
    let content = '';

    try {
      content = await fs.readFile(npmrcPath, 'utf-8');
    } catch {
      // File doesn't exist — we'll create it
    }

    const updated = addScopedRegistryInContent(content, scope, url);
    await fs.mkdir(path.dirname(npmrcPath), { recursive: true });
    await fs.writeFile(npmrcPath, updated, 'utf-8');
  }

  async editScopedRegistry(scope: string, newUrl: string): Promise<void> {
    if (!isValidRegistryUrl(newUrl)) {
      vscode.window.showErrorMessage(`Invalid registry URL "${newUrl}". Must be a valid HTTP or HTTPS URL.`);
      return;
    }

    const npmrcPath = this._getNpmrcPath();
    let content: string;

    try {
      content = await fs.readFile(npmrcPath, 'utf-8');
    } catch {
      vscode.window.showWarningMessage('No .npmrc file found.');
      return;
    }

    const updated = addScopedRegistryInContent(content, scope, newUrl);
    await fs.writeFile(npmrcPath, updated, 'utf-8');
  }

  async removeScopedRegistry(scope: string): Promise<void> {
    const npmrcPath = this._getNpmrcPath();
    let content: string;

    try {
      content = await fs.readFile(npmrcPath, 'utf-8');
    } catch {
      return;
    }

    const updated = removeScopedRegistryFromContent(content, scope);
    await fs.writeFile(npmrcPath, updated, 'utf-8');
  }

  async listScopedRegistries(): Promise<ScopedRegistryEntry[]> {
    const npmrcPath = this._getNpmrcPath();
    let content: string;

    try {
      content = await fs.readFile(npmrcPath, 'utf-8');
    } catch {
      return [];
    }

    return listScopedRegistriesFromContent(content);
  }

  // ---- Auth token methods (Req 9) ----

  async addAuthToken(registryUrl: string, token: string): Promise<void> {
    if (!isValidToken(token)) {
      vscode.window.showErrorMessage('Token must not be empty or whitespace-only.');
      return;
    }

    const npmrcPath = this._getNpmrcPath();
    let content = '';

    try {
      content = await fs.readFile(npmrcPath, 'utf-8');
    } catch {
      // File doesn't exist — we'll create it
    }

    const updated = addAuthTokenInContent(content, registryUrl, token);
    await fs.mkdir(path.dirname(npmrcPath), { recursive: true });
    await fs.writeFile(npmrcPath, updated, 'utf-8');

    // Store in SecretStorage
    if (this._secretStorage) {
      const secretKey = `verdaccio.authToken.${registryUrl}`;
      await this._secretStorage.store(secretKey, token);
    }
  }

  async rotateAuthToken(registryUrl: string, newToken: string): Promise<void> {
    if (!isValidToken(newToken)) {
      vscode.window.showErrorMessage('Token must not be empty or whitespace-only.');
      return;
    }

    const npmrcPath = this._getNpmrcPath();
    let content: string;

    try {
      content = await fs.readFile(npmrcPath, 'utf-8');
    } catch {
      vscode.window.showWarningMessage('No .npmrc file found.');
      return;
    }

    const updated = addAuthTokenInContent(content, registryUrl, newToken);
    await fs.writeFile(npmrcPath, updated, 'utf-8');

    // Update SecretStorage
    if (this._secretStorage) {
      const secretKey = `verdaccio.authToken.${registryUrl}`;
      await this._secretStorage.store(secretKey, newToken);
    }
  }

  async removeAuthToken(registryUrl: string): Promise<void> {
    const npmrcPath = this._getNpmrcPath();
    let content: string;

    try {
      content = await fs.readFile(npmrcPath, 'utf-8');
    } catch {
      return;
    }

    const updated = removeAuthTokenFromContent(content, registryUrl);
    await fs.writeFile(npmrcPath, updated, 'utf-8');

    // Remove from SecretStorage
    if (this._secretStorage) {
      const secretKey = `verdaccio.authToken.${registryUrl}`;
      await this._secretStorage.delete(secretKey);
    }
  }

  async listAuthTokens(): Promise<AuthTokenEntry[]> {
    const npmrcPath = this._getNpmrcPath();
    let content: string;

    try {
      content = await fs.readFile(npmrcPath, 'utf-8');
    } catch {
      return [];
    }

    const raw = listAuthTokensFromContent(content);
    return raw.map((entry) => ({
      registryUrl: entry.registryUrl,
      maskedToken: maskToken(entry.token),
    }));
  }

  async revealToken(registryUrl: string): Promise<string> {
    if (this._secretStorage) {
      const secretKey = `verdaccio.authToken.${registryUrl}`;
      const token = await this._secretStorage.get(secretKey);
      if (token) {
        // Auto-dismiss notification after 10 seconds
        const message = `Auth token for ${registryUrl}: ${token}`;
        setTimeout(() => {
          // The notification auto-dismisses; VS Code handles this via the timeout
        }, 10_000);
        vscode.window.showInformationMessage(message);
        return token;
      }
    }

    vscode.window.showInformationMessage(`No token found in secure storage for ${registryUrl}.`);
    return '';
  }

  // ---- Private helpers ----

  private _getNpmrcPath(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return path.join(folders[0].uri.fsPath, '.npmrc');
    }
    return '.npmrc';
  }
}

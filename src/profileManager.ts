import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { INpmrcManager, listScopedRegistriesFromContent, listAuthTokensFromContent } from './npmrcManager';
import { NpmrcProfile, ScopedRegistryEntry } from './types';

export interface IProfileManager {
  createProfile(name: string): Promise<void>;
  switchProfile(name: string): Promise<void>;
  deleteProfile(name: string): Promise<void>;
  listProfiles(): Promise<string[]>;
  getActiveProfile(): string | undefined;
}

// ─── Pure functions for testability ───

/**
 * Serialize .npmrc content into an NpmrcProfile object.
 * Extracts default registry, scoped registries, and auth token registry references.
 */
export function serializeProfile(npmrcContent: string, profileName: string): NpmrcProfile {
  // Extract default registry
  let registry: string | undefined;
  const lines = npmrcContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('registry=') && !trimmed.includes(':registry=')) {
      registry = trimmed.replace('registry=', '');
      break;
    }
  }

  // Extract scoped registries
  const scopedRegistries = listScopedRegistriesFromContent(npmrcContent);

  // Extract auth token registry references
  const authTokenEntries = listAuthTokensFromContent(npmrcContent);
  const authTokenRegistries = authTokenEntries.map((e) => e.registryUrl);

  return {
    name: profileName,
    registry,
    scopedRegistries,
    authTokenRegistries,
  };
}

/**
 * Deserialize an NpmrcProfile back into .npmrc content.
 */
export function deserializeProfile(profile: NpmrcProfile): string {
  const lines: string[] = [];

  if (profile.registry) {
    lines.push(`registry=${profile.registry}`);
  }

  for (const entry of profile.scopedRegistries) {
    lines.push(`${entry.scope}:registry=${entry.registryUrl}`);
  }

  for (const registryUrl of profile.authTokenRegistries) {
    // Write auth token placeholder — actual tokens are in SecretStorage
    lines.push(`//${registryUrl}:_authToken=PROFILE_TOKEN`);
  }

  return lines.join('\n');
}

// ─── ProfileManager class ───

export class ProfileManager implements IProfileManager {
  private readonly _npmrcManager: INpmrcManager;
  private _activeProfile: string | undefined;
  private _statusBarItem: vscode.StatusBarItem | undefined;

  constructor(npmrcManager: INpmrcManager) {
    this._npmrcManager = npmrcManager;
  }

  async createProfile(name: string): Promise<void> {
    const npmrcPath = this._getNpmrcPath();
    let content = '';

    try {
      content = await fs.readFile(npmrcPath, 'utf-8');
    } catch {
      // No .npmrc — create empty profile
    }

    const profile = serializeProfile(content, name);
    const profilesDir = this._getProfilesDir();
    await fs.mkdir(profilesDir, { recursive: true });

    const profilePath = path.join(profilesDir, `${name}.json`);
    await fs.writeFile(profilePath, JSON.stringify(profile, null, 2), 'utf-8');

    this._activeProfile = name;
    this._updateStatusBar();
  }

  async switchProfile(name: string): Promise<void> {
    const profilePath = path.join(this._getProfilesDir(), `${name}.json`);

    try {
      await fs.access(profilePath);
    } catch {
      // Profile doesn't exist
      const available = await this.listProfiles();
      const profileList = available.length > 0 ? available.join(', ') : 'none';
      vscode.window.showErrorMessage(
        `Profile "${name}" not found. Available profiles: ${profileList}`,
      );
      return;
    }

    const content = await fs.readFile(profilePath, 'utf-8');
    const profile: NpmrcProfile = JSON.parse(content);

    // Write .npmrc from profile
    const npmrcContent = deserializeProfile(profile);
    const npmrcPath = this._getNpmrcPath();
    await fs.mkdir(path.dirname(npmrcPath), { recursive: true });
    await fs.writeFile(npmrcPath, npmrcContent, 'utf-8');

    this._activeProfile = name;
    this._updateStatusBar();
  }

  async deleteProfile(name: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Delete profile "${name}"?`,
      'Delete',
      'Cancel',
    );
    if (confirm !== 'Delete') { return; }

    const profilePath = path.join(this._getProfilesDir(), `${name}.json`);
    try {
      await fs.unlink(profilePath);
    } catch {
      // File doesn't exist — ignore
    }

    if (this._activeProfile === name) {
      this._activeProfile = undefined;
      this._updateStatusBar();
    }
  }

  async listProfiles(): Promise<string[]> {
    const profilesDir = this._getProfilesDir();
    try {
      const files = await fs.readdir(profilesDir);
      return files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''));
    } catch {
      return [];
    }
  }

  getActiveProfile(): string | undefined {
    return this._activeProfile;
  }

  setStatusBarItem(item: vscode.StatusBarItem): void {
    this._statusBarItem = item;
    this._updateStatusBar();
  }

  private _updateStatusBar(): void {
    if (!this._statusBarItem) { return; }
    if (this._activeProfile) {
      this._statusBarItem.text = `$(gear) Profile: ${this._activeProfile}`;
      this._statusBarItem.show();
    } else {
      this._statusBarItem.hide();
    }
  }

  private _getNpmrcPath(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return path.join(folders[0].uri.fsPath, '.npmrc');
    }
    return '.npmrc';
  }

  private _getProfilesDir(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return path.join(folders[0].uri.fsPath, '.verdaccio', 'profiles');
    }
    return path.join('.verdaccio', 'profiles');
  }
}

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as yaml from 'js-yaml';

// Mock vscode module before importing ConfigManager
vi.mock('vscode', () => {
  const mockGet = vi.fn((key: string, defaultValue?: any) => defaultValue);
  const mockGetConfiguration = vi.fn(() => ({ get: mockGet }));
  const mockShowTextDocument = vi.fn().mockResolvedValue(undefined);
  const mockUriFile = vi.fn((fsPath: string) => ({ fsPath, scheme: 'file' }));

  return {
    workspace: {
      getConfiguration: mockGetConfiguration,
      workspaceFolders: [
        { uri: { fsPath: '/mock/workspace' }, name: 'workspace', index: 0 },
      ],
    },
    window: {
      showTextDocument: mockShowTextDocument,
    },
    Uri: {
      file: mockUriFile,
    },
  };
});

import * as vscode from 'vscode';
import { ConfigManager } from '../configManager';

describe('ConfigManager', () => {
  let configManager: ConfigManager;
  let tmpDir: string;

  beforeEach(async () => {
    configManager = new ConfigManager();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verdaccio-test-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Validates: Requirement 2.6
   * generateDefaultConfig() should produce valid YAML with expected defaults
   */
  describe('generateDefaultConfig', () => {
    it('produces valid YAML with port 4873, storage ./storage, log level warn, and npmjs uplink', async () => {
      const configPath = path.join(tmpDir, '.verdaccio', 'config.yaml');

      // Override getConfigPath to use our temp directory
      vi.spyOn(configManager, 'getConfigPath').mockReturnValue(configPath);

      await configManager.generateDefaultConfig();

      const content = await fs.readFile(configPath, 'utf-8');
      const parsed = yaml.load(content) as any;

      expect(parsed.storage).toBe('./storage');
      expect(parsed.listen).toBe('0.0.0.0:4873');
      expect(parsed.log.level).toBe('warn');
      expect(parsed.uplinks.npmjs).toBeDefined();
      expect(parsed.uplinks.npmjs.url).toBe('https://registry.npmjs.org/');
      expect(parsed.packages).toBeDefined();
    });
  });

  /**
   * Validates: Requirement 2.5
   * getConfigPath() should read from VS Code settings and join with workspace folder path
   */
  describe('getConfigPath', () => {
    it('returns workspace folder joined with default config path', () => {
      const result = configManager.getConfigPath();
      expect(result).toBe(path.join('/mock/workspace', '.verdaccio/config.yaml'));
    });

    it('returns workspace folder joined with custom config path from settings', () => {
      const mockGet = vi.fn((key: string, defaultValue?: any) => {
        if (key === 'configPath') return 'custom/verdaccio.yaml';
        return defaultValue;
      });
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: mockGet } as any);

      const result = configManager.getConfigPath();
      expect(result).toBe(path.join('/mock/workspace', 'custom/verdaccio.yaml'));
    });

    it('returns raw config path when no workspace folder is available', () => {
      const original = vscode.workspace.workspaceFolders;
      (vscode.workspace as any).workspaceFolders = undefined;

      // Reset getConfiguration to return default value
      const mockGet = vi.fn((_key: string, defaultValue?: any) => defaultValue);
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: mockGet } as any);

      const result = configManager.getConfigPath();
      expect(result).toBe('.verdaccio/config.yaml');

      (vscode.workspace as any).workspaceFolders = original;
    });
  });

  /**
   * Validates: Requirement 2.7
   * openRawConfig() should open the config file in VS Code editor
   */
  describe('openRawConfig', () => {
    it('calls vscode.window.showTextDocument with the correct URI', async () => {
      const configPath = path.join('/mock/workspace', '.verdaccio/config.yaml');
      vi.spyOn(configManager, 'getConfigPath').mockReturnValue(configPath);

      await configManager.openRawConfig();

      expect(vscode.Uri.file).toHaveBeenCalledWith(configPath);
      expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Validates: Requirement 2.6
   * configExists() should return false when the config file is missing
   */
  describe('configExists', () => {
    it('returns false when the config file does not exist', async () => {
      const nonExistentPath = path.join(tmpDir, 'does-not-exist', 'config.yaml');
      vi.spyOn(configManager, 'getConfigPath').mockReturnValue(nonExistentPath);

      const result = await configManager.configExists();
      expect(result).toBe(false);
    });

    it('returns true when the config file exists', async () => {
      const configPath = path.join(tmpDir, 'config.yaml');
      await fs.writeFile(configPath, 'storage: ./storage\n', 'utf-8');
      vi.spyOn(configManager, 'getConfigPath').mockReturnValue(configPath);

      const result = await configManager.configExists();
      expect(result).toBe(true);
    });
  });

  /**
   * Validates: Requirement 2.3
   * updateConfig() should handle invalid YAML in the existing config file
   */
  describe('updateConfig', () => {
    it('throws when the existing config file contains invalid YAML', async () => {
      const configPath = path.join(tmpDir, 'config.yaml');
      await fs.writeFile(configPath, '{{invalid: yaml: [broken', 'utf-8');
      vi.spyOn(configManager, 'getConfigPath').mockReturnValue(configPath);

      await expect(configManager.updateConfig({ storage: './new-storage' })).rejects.toThrow();
    });

    it('throws when the config file does not exist', async () => {
      const nonExistentPath = path.join(tmpDir, 'missing', 'config.yaml');
      vi.spyOn(configManager, 'getConfigPath').mockReturnValue(nonExistentPath);

      await expect(configManager.updateConfig({ storage: './new-storage' })).rejects.toThrow();
    });
  });
});

# Implementation Plan: Verdaccio VS Code Extension

## Overview

Incrementally build the VS Code extension by establishing the project scaffold and core interfaces first, then implementing each manager component with its associated tests, and finally wiring everything together through commands and activation/deactivation lifecycle hooks.

## Tasks

- [x] 1. Scaffold extension project and define core interfaces
  - [x] 1.1 Initialize VS Code extension project structure
    - Create `package.json` with extension metadata, activation events (`onCommand:verdaccio.*`, `onView:verdaccio.*`), and contribution points (commands, views, settings)
    - Create `tsconfig.json` with strict TypeScript configuration targeting ES2020
    - Create `src/extension.ts` with stub `activate` and `deactivate` functions
    - Install dependencies: `vscode`, `js-yaml`, `fast-check` (dev)
    - _Requirements: 7.2_

  - [x] 1.2 Define shared TypeScript interfaces and types
    - Create `src/types.ts` with `ServerState`, `ServerInfo`, `VerdaccioConfig`, `UplinkConfig`, `PackageAccessConfig`, `ScopeNode`, `PackageNode`, `VersionNode`, `CacheItem`, and `ExtensionSettings` interfaces as specified in the design
    - _Requirements: 2.1, 2.2, 3.1, 4.1_

- [x] 2. Implement ConfigManager
  - [x] 2.1 Create ConfigManager class
    - Create `src/configManager.ts` implementing `IConfigManager`
    - Implement `getConfigPath()` reading from VS Code settings with default `.verdaccio/config.yaml`
    - Implement `readConfig()` using `js-yaml` to parse the YAML file into `VerdaccioConfig`
    - Implement `updateConfig(patch)` that merges the patch into the existing config and writes back to YAML
    - Implement `generateDefaultConfig()` creating a config file with sensible defaults (port 4873, storage `./storage`, log level `warn`, npmjs uplink)
    - Implement `configExists()` checking the file system
    - Implement `openRawConfig()` opening the config file in VS Code editor
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 2.7_

  - [x] 2.2 Write property test: Config patch round-trip (Property 1)
    - **Property 1: Config patch round-trip**
    - Generate random `VerdaccioConfig` objects and random partial patches using fast-check
    - Verify that serializing the patched config to YAML and re-parsing produces a config where patched fields equal patch values and non-patched fields are preserved
    - **Validates: Requirements 2.3**

  - [x] 2.3 Write unit tests for ConfigManager
    - Test default config generation produces valid YAML with expected defaults
    - Test config path resolution from VS Code settings
    - Test `openRawConfig` opens the correct file
    - Test `configExists` returns false when file is missing
    - Test `updateConfig` with invalid YAML handling
    - _Requirements: 2.5, 2.6, 2.7_

- [x] 3. Implement ServerManager
  - [x] 3.1 Create ServerManager class
    - Create `src/serverManager.ts` implementing `IServerManager`
    - Implement `start()` that spawns `verdaccio --config <path>` via `child_process.spawn`, transitions state from `stopped` → `starting` → `running`, and emits state change events
    - Implement `stop()` that sends SIGTERM, waits 5 seconds, then SIGKILL if still alive, and transitions state to `stopped`
    - Implement `restart()` that calls `stop()` then `start()`
    - Buffer the last 20 lines of process output for error reporting
    - Guard against duplicate starts (warn if already running)
    - Track `port`, `startTime`, and `pid` on the `ServerInfo` model
    - Fire `onDidChangeState` event on every state transition
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 7.3_

  - [x] 3.2 Write unit tests for ServerManager
    - Test state transitions: stopped → starting → running → stopped
    - Test duplicate start guard shows warning
    - Test unexpected exit captures exit code and last 20 lines
    - Test graceful shutdown timeout escalates to SIGKILL
    - Test restart cycles through stop then start
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 7.3_

- [x] 4. Implement LogManager
  - [x] 4.1 Create LogManager class
    - Create `src/logManager.ts` implementing `ILogManager`
    - Create a dedicated VS Code Output Channel named "Verdaccio"
    - Implement `attach(process)` that pipes stdout and stderr to the Output Channel in real time
    - Implement log level filtering: parse each line's severity and compare against the configured threshold (trace < debug < info < warn < error < fatal)
    - Implement `show()` that reveals the Output Channel
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 4.2 Write property test: Log level filtering (Property 5)
    - **Property 5: Log level filtering**
    - Generate random log entries with random severity levels and random configured thresholds using fast-check
    - Verify that an entry is displayed if and only if its severity is at or above the configured threshold
    - **Validates: Requirements 5.4**

  - [x] 4.3 Write unit tests for LogManager
    - Test Output Channel creation with correct name
    - Test `show()` reveals the channel
    - Test stdout/stderr piping writes to channel
    - _Requirements: 5.1, 5.3_

- [x] 5. Checkpoint - Core managers complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement StatusViewProvider
  - [x] 6.1 Create StatusViewProvider class
    - Create `src/statusViewProvider.ts` implementing `IStatusViewProvider` (TreeDataProvider)
    - Render tree items for: server state, listening address:port, uptime (formatted as `Xh Ym Zs`), and package count
    - Subscribe to `ServerManager.onDidChangeState` to trigger `refresh()` automatically
    - Register the view in the Activity Bar via `package.json` contribution and `vscode.window.registerTreeDataProvider`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 6.2 Write property test: Uptime formatting correctness (Property 2)
    - **Property 2: Uptime formatting correctness**
    - Generate random start time and current time pairs (current >= start) using fast-check
    - Verify the formatted uptime string represents a non-negative duration and correctly reflects the difference in hours, minutes, and seconds
    - **Validates: Requirements 3.3**

  - [x] 6.3 Write unit tests for StatusViewProvider
    - Test tree item rendering for each server state (stopped, starting, running, error)
    - Test uptime display updates correctly
    - Test package count display
    - _Requirements: 3.1, 3.2, 3.6_

- [x] 7. Implement CacheViewProvider
  - [x] 7.1 Create CacheViewProvider class
    - Create `src/cacheViewProvider.ts` implementing `ICacheViewProvider` (TreeDataProvider)
    - Implement storage directory scanning to build scope → package → version tree
    - Display total storage size at the root level
    - Implement `deletePackage(item)` with confirmation prompt, file system removal, and cache refresh
    - Set up `FileSystemWatcher` on the storage directory for automatic refresh within 5 seconds
    - Display package metadata (name, version, description, tarball size) when a version node is selected
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [x] 7.2 Write property test: Package tree grouping preserves all packages (Property 3)
    - **Property 3: Package tree grouping preserves all packages**
    - Generate random lists of package entries (some scoped, some unscoped) using fast-check
    - Verify every input package appears exactly once under its correct scope node and the total count matches
    - **Validates: Requirements 4.1**

  - [x] 7.3 Write property test: Storage size aggregation (Property 4)
    - **Property 4: Storage size aggregation**
    - Generate random lists of packages with known tarball sizes using fast-check
    - Verify the computed total storage size equals the sum of all individual tarball sizes
    - **Validates: Requirements 4.7**

  - [x] 7.4 Write unit tests for CacheViewProvider
    - Test version listing for expanded package nodes
    - Test metadata display for selected version
    - Test delete confirmation prompt flow
    - Test file system watcher triggers refresh
    - _Requirements: 4.2, 4.3, 4.5, 4.6_

- [x] 8. Checkpoint - Views complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Implement NpmrcManager
  - [x] 9.1 Create NpmrcManager class
    - Create `src/npmrcManager.ts` implementing `INpmrcManager`
    - Implement `setRegistry(address)` that reads the workspace `.npmrc`, sets the `registry=` line to the Verdaccio address, and writes back preserving all other lines
    - Implement `resetRegistry()` that removes the `registry=` line from `.npmrc` preserving all other content
    - Guard: if server is not running when `setRegistry` is called, show warning and offer to start
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 9.2 Write property test: Npmrc registry round-trip (Property 6)
    - **Property 6: Npmrc registry round-trip**
    - Generate random `.npmrc` file content and random registry URLs using fast-check
    - Verify that setting the registry then resetting produces content equivalent to the original with no residual registry entry, preserving all other lines
    - **Validates: Requirements 6.1, 6.2**

  - [x] 9.3 Write unit tests for NpmrcManager
    - Test server-not-running guard shows warning
    - Test `.npmrc` creation when file doesn't exist
    - Test preserving existing `.npmrc` entries
    - _Requirements: 6.3_

- [x] 10. Implement Configuration Panel (Webview)
  - [x] 10.1 Create ConfigurationPanel webview
    - Create `src/configurationPanel.ts` with a Webview Panel class
    - Render a form with fields for: listen port, storage directory path, max body size, log level
    - Render uplink settings section with fields for URL, timeout, and max retries per uplink
    - On form submission, call `ConfigManager.updateConfig()` with the changed values
    - If server is running when settings change, prompt user to restart for changes to take effect
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 10.2 Write unit tests for ConfigurationPanel
    - Test form renders with current config values
    - Test form submission calls updateConfig with correct patch
    - Test restart prompt appears when server is running
    - _Requirements: 2.1, 2.3, 2.4_

- [x] 11. Wire commands, activation, and deactivation
  - [x] 11.1 Register all commands and wire components in extension.ts
    - Register commands: `verdaccio.start`, `verdaccio.stop`, `verdaccio.restart`, `verdaccio.showLogs`, `verdaccio.openRawConfig`, `verdaccio.openConfigPanel`, `verdaccio.setRegistry`, `verdaccio.resetRegistry`, `verdaccio.deletePackage`
    - Instantiate all managers and providers, passing dependencies (e.g., ServerManager to StatusViewProvider)
    - Create status bar item showing server state and port when running
    - If `autoSetRegistry` setting is enabled, hook into ServerManager state changes to auto-set/reset `.npmrc`
    - On config file missing at first access, offer to generate default config
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 2.4, 2.6, 3.6, 5.3, 6.1, 6.2, 6.4, 7.2_

  - [x] 11.2 Implement deactivation cleanup
    - In `deactivate()`, call `ServerManager.stop()` to gracefully terminate any running Verdaccio process
    - Dispose all disposables (status bar item, file watchers, output channel, tree view registrations)
    - _Requirements: 7.1, 7.3_

  - [x] 11.3 Write unit tests for extension lifecycle
    - Test activation registers all expected commands
    - Test deactivation stops the server and disposes resources
    - Test status bar item updates on server state changes
    - _Requirements: 7.1, 7.2_

- [x] 12. Final checkpoint - Full integration
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Update types.ts with new interfaces for requirements 8-14
  - [x] 13.1 Add scoped registry, auth token, and storage analytics interfaces
    - Add `ScopedRegistryEntry`, `AuthTokenEntry`, `UplinkSnapshot`, `StorageAnalytics`, `PackageSizeInfo`, `StalePackageInfo`, `PruneResult`, `AnalyticsItem` (union of `AnalyticsMetricNode` and `AnalyticsPackageNode`) interfaces
    - Add `WorkspacePackageInfo`, `BulkPublishResult`, `PublishResult` interfaces and `SemverBumpType` type
    - _Requirements: 8.1, 9.1, 10.4, 11.7, 12.1, 13.1_

  - [x] 13.2 Extend VerdaccioConfig and UplinkConfig with proxy fields
    - Add optional `http_proxy`, `https_proxy`, `no_proxy` fields to `VerdaccioConfig`
    - Add optional `cache_ttl`, `http_proxy`, `https_proxy` fields to `UplinkConfig`
    - _Requirements: 10.1, 14.1, 14.2, 14.3, 14.4, 14.5_

  - [x] 13.3 Extend ExtensionSettings with new settings
    - Add `storageWarningThresholdMb` (default 500) and `stalenessThresholdDays` (default 90) to `ExtensionSettings`
    - _Requirements: 11.2, 11.6_

  - [x] 13.4 Add validation helper functions
    - Implement `isValidScope(scope: string): boolean` — returns true if scope starts with `@` and contains no whitespace
    - Implement `isValidRegistryUrl(url: string): boolean` — returns true if url is a valid `http://` or `https://` URL
    - Implement `isValidToken(token: string): boolean` — returns true if token is non-empty and not whitespace-only
    - Implement `maskToken(token: string): string` — masks to `****<last4>` format
    - _Requirements: 8.5, 9.3, 9.7, 14.7_

- [x] 14. Extend NpmrcManager with scoped registry and auth token methods
  - [x] 14.1 Add scoped registry CRUD methods
    - Implement `addScopedRegistry(scope, url)` — validates scope/URL, writes `@scope:registry=<url>` to `.npmrc`, creates `.npmrc` if missing
    - Implement `editScopedRegistry(scope, newUrl)` — presents pre-filled input, updates the entry
    - Implement `removeScopedRegistry(scope)` — removes the `@scope:registry=` line, preserves all other lines
    - Implement `listScopedRegistries()` — parses `.npmrc` and returns all `ScopedRegistryEntry` items
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

  - [x] 14.2 Add auth token CRUD methods with SecretStorage integration
    - Implement `addAuthToken(registryUrl, token)` — validates token non-empty/non-whitespace, writes `//registry/:_authToken=<token>` to `.npmrc`, stores token in VS Code `SecretStorage`
    - Implement `rotateAuthToken(registryUrl, newToken)` — prompts for new token, updates `.npmrc` and `SecretStorage`
    - Implement `removeAuthToken(registryUrl)` — removes `_authToken` line from `.npmrc`, deletes from `SecretStorage`
    - Implement `listAuthTokens()` — returns `AuthTokenEntry[]` with masked tokens
    - Implement `revealToken(registryUrl)` — retrieves from `SecretStorage`, displays in auto-dismissing notification (10s)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_

  - [x] 14.3 Write property tests for NpmrcManager scoped registries and auth tokens
    - **Property 7: Scoped registry .npmrc round-trip**
    - Generate random `.npmrc` content and valid scope/URL pairs using fast-check, verify add then remove produces equivalent content
    - **Validates: Requirements 8.4, 8.7**
    - **Property 8: Scope and URL validation**
    - Generate random strings, verify scope validation accepts iff starts with `@` and no whitespace; URL validation accepts iff valid `http://` or `https://`
    - **Validates: Requirements 8.5, 14.7**
    - **Property 9: Auth token masking**
    - Generate random non-empty token strings, verify masked output is `****<last4>` and never contains the full original token
    - **Validates: Requirements 9.3**
    - **Property 10: Auth token .npmrc round-trip**
    - Generate random `.npmrc` content and valid registry/token pairs, verify add then remove produces equivalent content
    - **Validates: Requirements 9.5, 9.8**
    - **Property 11: Whitespace-only token rejection**
    - Generate random whitespace-only strings, verify rejection; generate strings with at least one non-whitespace char, verify acceptance
    - **Validates: Requirements 9.7**

  - [x] 14.4 Write unit tests for NpmrcManager scoped registries and auth tokens
    - Test scoped registry add/edit/remove/list CRUD operations
    - Test auth token add/rotate/remove/list/reveal CRUD operations
    - Test `SecretStorage` integration (store on add, delete on remove, retrieve on reveal)
    - Test validation rejects invalid scope names and empty/whitespace tokens
    - Test `.npmrc` creation when file does not exist
    - _Requirements: 8.1, 8.3, 8.4, 8.5, 8.6, 9.1, 9.4, 9.5, 9.6, 9.7_

- [x] 15. Checkpoint - NpmrcManager extensions complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. Extend ConfigManager with uplink cache policy and proxy settings
  - [x] 16.1 Add uplink cache policy methods
    - Implement cache-first strategy: set uplink `maxage` to `9999d` in config
    - Implement proxy-first strategy: set uplink `maxage` to `0` in config
    - Implement per-uplink cache settings: TTL (`maxage`), `cache_ttl`, and `timeout` values
    - Prompt user to restart server if running when settings change
    - _Requirements: 10.1, 10.2, 10.6, 10.7, 10.8, 10.9_

  - [x] 16.2 Add offline mode toggle
    - Implement `enableOfflineMode()` — snapshot current uplink `max_fails`/`fail_timeout` values, then set all uplinks to `max_fails: 0` and `fail_timeout: "0"`
    - Implement `disableOfflineMode()` — restore uplink settings from the saved `UplinkSnapshot`
    - Store the snapshot in extension state (e.g., `workspaceState`)
    - _Requirements: 10.3, 10.4, 10.5_

  - [x] 16.3 Add proxy configuration methods
    - Implement global proxy write: set `http_proxy` and `https_proxy` on the root config
    - Implement per-uplink proxy override: set `http_proxy`/`https_proxy` on a specific uplink section
    - Implement no-proxy list: set `no_proxy` field on the root config
    - Validate proxy URLs are valid HTTP/HTTPS before writing
    - Prompt user to restart server if running when proxy settings change
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7_

  - [x] 16.4 Write property test for offline mode round-trip (Property 12)
    - **Property 12: Offline mode round-trip**
    - Generate random `VerdaccioConfig` with one or more uplinks using fast-check
    - Enable offline mode, verify all uplinks have `max_fails: 0` and `fail_timeout: "0"`
    - Disable offline mode, verify each uplink's `max_fails` and `fail_timeout` restored to original values
    - **Validates: Requirements 10.4, 10.5**

  - [x] 16.5 Write unit tests for ConfigManager uplink and proxy extensions
    - Test cache-first sets `maxage` to `9999d`
    - Test proxy-first sets `maxage` to `0`
    - Test offline mode enable/disable round-trip
    - Test global proxy URL write to config
    - Test per-uplink proxy override write
    - Test restart prompt appears when server is running
    - _Requirements: 10.7, 10.8, 10.9, 14.3, 14.4, 14.6_

- [x] 17. Checkpoint - ConfigManager extensions complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 18. Implement StorageAnalyticsProvider
  - [x] 18.1 Create StorageAnalyticsProvider class
    - Create `src/storageAnalyticsProvider.ts` implementing `IStorageAnalyticsProvider` (TreeDataProvider)
    - Implement `computeAnalytics()` — scan storage directory, compute total disk usage, package count, version count, top 5 largest packages, stale package count
    - Implement `getStalePackages()` — identify packages whose last access date exceeds the staleness threshold (default 90 days)
    - Display analytics in a tree view: total disk usage, package count, version count, largest packages, stale count
    - _Requirements: 11.1, 11.6, 11.7_

  - [x] 18.2 Implement storage threshold warning
    - Read `storageWarningThresholdMb` from settings (default 500 MB)
    - After computing analytics, compare total usage against threshold
    - Show warning notification when threshold is exceeded, including current usage and threshold
    - _Requirements: 11.2, 11.3_

  - [x] 18.3 Implement prune and bulk cleanup operations
    - Implement `pruneOldVersions(packageName, keepCount)` — prompt for confirmation showing total size to be freed, delete all but the N most recent versions
    - Implement `bulkCleanup(packages)` — display multi-select list of stale packages, prompt for confirmation, delete selected packages
    - After cleanup, refresh Cache View and Storage Analytics view, show notification with freed space
    - _Requirements: 11.4, 11.5, 11.8, 11.9_

  - [x] 18.4 Write property tests for StorageAnalyticsProvider
    - **Property 13: Storage threshold warning trigger**
    - Generate random usage values (bytes) and threshold values (MB), verify warning triggers iff usage exceeds threshold
    - **Validates: Requirements 11.3**
    - **Property 14: Version pruning retains most recent N**
    - Generate random version lists with publish dates and a positive keep count N, verify exactly the N most recent are retained; if N or fewer versions exist, none are deleted
    - **Validates: Requirements 11.4**
    - **Property 15: Stale package detection**
    - Generate random packages with last-access dates and a staleness threshold in days, verify a package is stale iff its last access exceeds the threshold
    - **Validates: Requirements 11.5**
    - **Property 16: Storage analytics computation**
    - Generate random package data with sizes, version counts, and access dates, verify `totalDiskUsageBytes` = sum of sizes, `packageCount` = distinct names, `versionCount` = total versions, `largestPackages` = top 5 by size descending, `stalePackageCount` = count exceeding threshold
    - **Validates: Requirements 11.7**

  - [x] 18.5 Write unit tests for StorageAnalyticsProvider
    - Test threshold warning notification displays when usage exceeds threshold
    - Test prune confirmation prompt shows total size to be freed
    - Test cleanup notification shows freed space amount
    - Test tree view renders all analytics metrics correctly
    - Test settings defaults (500 MB threshold, 90 days staleness)
    - _Requirements: 11.2, 11.3, 11.6, 11.8, 11.9_

- [x] 19. Checkpoint - StorageAnalyticsProvider complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 20. Implement PublishManager
  - [x] 20.1 Create PublishManager class
    - Create `src/publishManager.ts` implementing `IPublishManager`
    - Implement `publishToVerdaccio(packageDir)` — run `npm publish --registry <verdaccio_url>` in the package directory
    - Guard: if server is not running, show warning and offer to start
    - Implement `checkDuplicate(packageName, version)` — check if name@version already exists in Verdaccio before publishing, warn if duplicate detected
    - Show success notification with package name and version on success
    - Show error notification with npm error output on failure
    - _Requirements: 12.1, 12.2, 12.5, 12.6, 12.7_

  - [x] 20.2 Implement promote and version bump
    - Implement `promotePackage(packageName, version, targetRegistryUrl)` — prompt for target registry URL, republish the package tarball to that registry
    - Implement `bumpVersion(packageDir, bumpType)` — prompt for semver bump type (patch, minor, major, prerelease), run `npm version <type>` in the workspace folder
    - _Requirements: 12.3, 12.4_

  - [x] 20.3 Write unit tests for PublishManager
    - Test server-not-running guard shows warning and offers to start
    - Test success notification includes package name and version
    - Test error notification includes npm error output
    - Test duplicate detection warns before publishing
    - Test version bump constructs correct `npm version` command
    - _Requirements: 12.2, 12.4, 12.5, 12.6, 12.7_

- [x] 21. Implement WorkspacePackageProvider
  - [x] 21.1 Create WorkspacePackageProvider class
    - Create `src/workspacePackageProvider.ts` implementing `IWorkspacePackageProvider` (TreeDataProvider)
    - Implement `detectPackages()` — read `workspaces` field from root `package.json`, resolve glob patterns to package directories, read each `package.json` for name/version/dependencies
    - Display detected packages in a tree view with name and current version
    - _Requirements: 13.1, 13.2_

  - [x] 21.2 Implement dependency-order publish and bulk operations
    - Implement `getPackagesInDependencyOrder()` — topological sort on workspace package dependency graph
    - Implement `publishAll()` — publish each package in dependency order, continue on failure, collect successes/failures, show summary notification
    - Implement `unpublishAll()` — prompt for confirmation, remove all workspace packages from Verdaccio storage
    - Show progress indicator during bulk operations (e.g., "Publishing 3 of 7")
    - Guard: if server is not running, show warning and offer to start
    - _Requirements: 13.3, 13.4, 13.5, 13.6, 13.7_

  - [x] 21.3 Write property test for dependency-order publish (Property 17)
    - **Property 17: Dependency-order publish**
    - Generate random sets of workspace packages with inter-dependencies forming a DAG using fast-check
    - Verify the publish order is a valid topological sort: for every package P depending on Q, Q appears before P
    - **Validates: Requirements 13.3**

  - [x] 21.4 Write unit tests for WorkspacePackageProvider
    - Test tree view renders detected packages with name and version
    - Test partial failure summary shows successes and failures
    - Test unpublish confirmation prompt
    - Test progress indicator updates during bulk publish
    - Test server-not-running guard shows warning
    - _Requirements: 13.2, 13.4, 13.5, 13.6, 13.7_

- [x] 22. Checkpoint - PublishManager and WorkspacePackageProvider complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 23. Update Configuration Panel with new settings UI
  - [x] 23.1 Add uplink cache policy and proxy settings to Configuration Panel
    - Add per-uplink cache strategy selector (cache-first / proxy-first) to the webview form
    - Add per-uplink cache settings fields: TTL (`maxage`), `cache_ttl`, `timeout`
    - Add offline mode toggle to the webview form
    - Add global HTTP/HTTPS proxy URL fields
    - Add per-uplink proxy override URL field
    - Add no-proxy list field
    - Validate proxy URLs before submission
    - On form submission, call `ConfigManager` methods for uplink/proxy updates
    - _Requirements: 10.1, 10.3, 10.6, 14.1, 14.2, 14.5, 14.7_

- [x] 24. Update extension.ts wiring for new features
  - [x] 24.1 Register new commands and instantiate new managers/providers
    - Register commands: `verdaccio.addScopedRegistry`, `verdaccio.editScopedRegistry`, `verdaccio.removeScopedRegistry`, `verdaccio.addAuthToken`, `verdaccio.rotateAuthToken`, `verdaccio.removeAuthToken`, `verdaccio.revealToken`, `verdaccio.enableOfflineMode`, `verdaccio.disableOfflineMode`, `verdaccio.pruneOldVersions`, `verdaccio.bulkCleanup`, `verdaccio.publishToVerdaccio`, `verdaccio.promotePackage`, `verdaccio.bumpVersion`, `verdaccio.publishAllWorkspacePackages`, `verdaccio.unpublishAllWorkspacePackages`
    - Instantiate `StorageAnalyticsProvider`, `PublishManager`, `WorkspacePackageProvider`
    - Pass `SecretStorage` from `ExtensionContext` to `NpmrcManager`
    - Register new tree views: `verdaccioStorageAnalytics`, `verdaccioWorkspacePackages`
    - Wire new views and commands to their respective providers
    - Update `package.json` with new commands, views, activation events, and configuration properties (`storageWarningThresholdMb`, `stalenessThresholdDays`)
    - _Requirements: 8.1, 8.3, 8.4, 9.1, 9.4, 9.5, 9.6, 10.3, 11.4, 11.5, 12.1, 12.3, 12.4, 13.3, 13.5_

- [x] 25. Final checkpoint - All new features integrated (Req 8-14)
  - Ensure all tests pass, ask the user if questions arise.

- [x] 26. Update types.ts with new interfaces for requirements 15-19
  - [x] 26.1 Add MCP response model interfaces
    - Add `McpToolResponse<T>` generic envelope with `success`, `data?`, `error?` fields
    - Add `McpStartResponse` with `port` and `pid` fields
    - Add `McpStatusResponse` with `state`, `port`, `uptimeSeconds`, `packageCount` fields
    - Add `McpPackageListResponse` with `packages: McpPackageEntry[]` field
    - Add `McpPackageEntry` with `name`, `versions`, `totalSizeBytes` fields
    - Add `McpCleanupResponse` with `deletedCount`, `freedBytes` fields
    - Add `McpPackageDetailResponse` with `name`, `versions: McpVersionDetail[]` fields
    - Add `McpVersionDetail` with `version`, `sizeBytes`, `description`, `publishDate`, `downloadCount?` fields
    - Add `McpVersionMetadataResponse` with `description`, `dependencies`, `devDependencies`, `tarballSize`, `publishDate` fields
    - Add `McpCheckCachedResponse` with `cached: string[]`, `notCached: string[]` fields
    - Add `CacheDiffEntry` with `name`, `requiredVersion`, `cachedVersion?` fields
    - Add `McpCacheDiffResponse` with `upToDate: CacheDiffEntry[]`, `outdated: CacheDiffEntry[]`, `missing: CacheDiffEntry[]` fields
    - Add `McpCacheStatsResponse` with `totalPackages`, `totalVersions`, `totalSizeBytes`, `cacheHitRate?`, `mostRecentlyCached?`, `oldestCached?` fields
    - Add `McpDepTreeNode` with `name`, `version`, `cached: boolean`, `dependencies: McpDepTreeNode[]` fields
    - _Requirements: 15.8, 15.9, 15.16, 15.17, 15.18, 15.29, 15.30, 15.31, 15.32, 15.33, 15.34_

  - [x] 26.2 Add dependency mirror and lockfile interfaces
    - Add `MirrorResult` with `newlyCached`, `alreadyAvailable`, `totalNewSizeBytes` fields
    - Add `MirroredDependency` with `name`, `version`, `sizeBytes` fields
    - Add `LockfileDependency` with `name`, `version`, `resolved?` fields
    - _Requirements: 17.1, 17.3, 17.4_

  - [x] 26.3 Add registry health interfaces
    - Add `UplinkHealthStatus` with `uplinkName`, `url`, `latencyMs`, `cacheHitRate`, `failedRequestCount`, `state` fields
    - Add `HealthState` type as `"healthy" | "degraded" | "unreachable"`
    - Add `UplinkHealthNode` with `type: "uplinkHealth"`, `uplinkName`, `state` fields
    - Add `HealthMetricNode` with `type: "healthMetric"`, `label`, `value` fields
    - Add `HealthItem` union type of `UplinkHealthNode | HealthMetricNode`
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5_

  - [x] 26.4 Add profile interface
    - Add `NpmrcProfile` with `name`, `registry`, `scopedRegistries`, `authTokenRegistries` fields
    - _Requirements: 19.1, 19.6_

  - [x] 26.5 Extend ExtensionSettings with new settings
    - Add `mcpAutoStart: boolean` (default `true`) to `ExtensionSettings`
    - Add `healthPingIntervalMs: number` (default `30000`) to `ExtensionSettings`
    - _Requirements: 15.20, 18.2_

- [x] 27. Implement McpServer
  - [x] 27.1 Install ACS dependencies
    - Run `yarn add @ai-capabilities-suite/mcp-client-base @ai-capabilities-suite/vscode-shared-status-bar` to add the ACS MCP client base and shared status bar packages
    - _Requirements: 15.1, 15.22_

  - [x] 27.2 Create McpServer class extending BaseMCPClient
    - Create `src/mcpServer.ts` extending `BaseMCPClient` from `@ai-capabilities-suite/mcp-client-base` (v1.0.2)
    - Implement `getServerCommand()`, `getServerEnv()`, and `onServerReady()` lifecycle methods
    - Use `callTool(name, params)` inherited from `BaseMCPClient` for all tool invocations
    - Register 22 MCP tools: `verdaccio_start`, `verdaccio_stop`, `verdaccio_status`, `verdaccio_publish`, `verdaccio_publish_all`, `verdaccio_list_packages`, `verdaccio_search`, `verdaccio_set_registry`, `verdaccio_reset_registry`, `verdaccio_add_scoped_registry`, `verdaccio_set_offline_mode`, `verdaccio_get_config`, `verdaccio_update_config`, `verdaccio_storage_analytics`, `verdaccio_cleanup`, `verdaccio_walk_cache`, `verdaccio_get_package`, `verdaccio_get_version`, `verdaccio_check_cached`, `verdaccio_cache_diff`, `verdaccio_cache_stats`, `verdaccio_package_deps`
    - Each tool handler delegates to the corresponding manager method (ServerManager, ConfigManager, NpmrcManager, PublishManager, WorkspacePackageProvider, StorageAnalyticsProvider, CacheViewProvider)
    - Wrap all responses in `McpToolResponse<T>` envelope with `success` boolean and `data`/`error` fields
    - Register with `diagnosticCommands` from `@ai-capabilities-suite/mcp-client-base` for ACS troubleshooting
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 15.10, 15.11, 15.12, 15.13, 15.14, 15.15, 15.16, 15.17, 15.18, 15.19, 15.24, 15.25, 15.29, 15.30, 15.31, 15.32, 15.33, 15.34_

  - [x] 27.3 Implement mcp.json discovery file generation
    - On first activation, generate `.kiro/settings/mcp.json` configuration file for agent discoverability
    - _Requirements: 15.21_

  - [x] 27.4 Implement autoStart setting
    - Read `verdaccio.mcp.autoStart` setting (default `true`)
    - If enabled, start MCP server automatically on extension activation
    - _Requirements: 15.20_

  - [x] 27.5 Write property test: MCP search filtering (Property 18)
    - **Property 18: MCP search returns only matching packages**
    - Generate random lists of package names and random search patterns using fast-check
    - Verify the search function returns exactly those packages whose names match the pattern, with no false positives or false negatives
    - **Validates: Requirements 15.9**

  - [x] 27.6 Write property test: MCP response format consistency (Property 19)
    - **Property 19: MCP response format consistency**
    - Invoke MCP tool response builder with success and failure scenarios using fast-check
    - Verify response always contains `success` boolean, `data` field when `success` is `true`, and `error` field when `success` is `false`
    - **Validates: Requirements 15.18**

  - [x] 27.7 Write unit tests for McpServer
    - Test all 22 tools are registered (including `verdaccio_walk_cache` and the 6 cache inspection tools)
    - Test each tool delegates to the correct manager method
    - Test response envelope format (`success` + `data`/`error`)
    - Test autoStart setting controls MCP server startup
    - Test mcp.json file generation
    - Test `BaseMCPClient` lifecycle methods (`getServerCommand`, `getServerEnv`, `onServerReady`)
    - _Requirements: 15.2, 15.18, 15.19, 15.20, 15.21, 15.25_

  - [x] 27.8 Implement `verdaccio_walk_cache` tool
    - Scan the Storage_Directory and return packages grouped by scope with version counts, per-package and total sizes in bytes, last access dates, and origin (uplink vs locally published)
    - Accept optional `scope` parameter to filter results to a specific npm scope
    - Accept optional `pattern` parameter to filter package names by substring/glob
    - Accept optional `sortBy` parameter (one of `"name"`, `"size"`, `"lastAccess"`, `"versionCount"`)
    - Accept optional `includeMetadata` boolean to include full package metadata
    - Accept optional `offset` and `limit` integer parameters for pagination
    - Include a `summary` object with `totalPackages`, `totalVersions`, `totalSizeBytes` computed across all matching packages before pagination is applied
    - _Requirements: 15.25, 15.26, 15.27, 15.28_

  - [x] 27.9 Write property test: Cache walker filtering and pagination (Property 26)
    - **Property 26: Cache walker filtering and pagination**
    - Generate random lists of cached packages with scopes, names, sizes, version counts, and last access dates using fast-check
    - Verify scope filter returns only packages matching the given scope
    - Verify pattern filter returns only packages whose names match the pattern
    - Verify sortBy produces correctly ordered results for each sort key
    - Verify offset/limit pagination returns the correct subset and summary totals reflect pre-pagination counts
    - **Validates: Requirements 15.26, 15.27, 15.28**

  - [x] 27.10 Implement cache inspection MCP tools
    - Implement `verdaccio_get_package` handler — read package.json from storage, return all versions with sizes, descriptions, publish dates
    - Implement `verdaccio_get_version` handler — read specific version metadata including dependencies, devDependencies, tarball size
    - Implement `verdaccio_check_cached` handler — check storage directory for each requested package/version, return cached/notCached arrays
    - Implement `verdaccio_cache_diff` handler — parse lockfile, compare against storage, classify into upToDate/outdated/missing
    - Implement `verdaccio_cache_stats` handler — compute summary stats from storage (total packages, versions, size, most recent, oldest)
    - Implement `verdaccio_package_deps` handler — read package version's dependencies, recursively check cache status up to specified depth
    - _Requirements: 15.29, 15.30, 15.31, 15.32, 15.33, 15.34_

  - [x] 27.11 Write property tests for cache inspection tools
    - **Property 27: Cache diff correctness**
    - Generate random lockfile deps and cache states using fast-check, verify every dep is classified into exactly one bucket (upToDate, outdated, or missing)
    - **Validates: Requirements 15.32**
    - **Property 28: Dependency tree cached flag accuracy**
    - Generate random package deps and cache states using fast-check, verify cached flag on each node matches storage presence
    - **Validates: Requirements 15.34**

- [x] 28. Checkpoint - McpServer complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 29. Implement OnboardingManager
  - [x] 29.1 Create OnboardingManager class
    - Create `src/onboardingManager.ts` implementing `IOnboardingManager` with `checkAndPrompt()` and `runOnboarding()`
    - On workspace open, check for `.verdaccio/config.yaml` existence
    - Check `workspaceState` for persisted onboarding completion flag; skip if already onboarded
    - Display onboarding notification offering to bootstrap the environment
    - On accept: start server via ServerManager, set registry via NpmrcManager, offer to mirror dependencies via DependencyMirrorManager
    - Persist onboarding state in `workspaceState` on completion
    - Skip silently if `.verdaccio/config.yaml` does not exist
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.6, 16.7, 16.8_

  - [x] 29.2 Write unit tests for OnboardingManager
    - Test config detection triggers onboarding notification
    - Test skips when `.verdaccio/config.yaml` does not exist
    - Test skips when already onboarded (state persisted)
    - Test state persistence on completion
    - Test delegates to ServerManager.start() and NpmrcManager.setRegistry()
    - _Requirements: 16.1, 16.2, 16.3, 16.6, 16.7, 16.8_

- [x] 30. Implement DependencyMirrorManager
  - [x] 30.1 Create DependencyMirrorManager class
    - Create `src/dependencyMirrorManager.ts` implementing `IDependencyMirrorManager` with `mirrorDependencies()` and `parseLockfile()`
    - Implement `parseLockfile()` — detect and read `package-lock.json` or `yarn.lock` from workspace root, extract all dependency entries with name and version
    - Implement `mirrorDependencies()` — run `npm install` or `yarn install` with registry pointed to Verdaccio, classify each dependency as "newly cached" or "already available" by checking storage before the operation
    - Show progress indicator during mirroring (e.g., "Mirroring 5 of 42")
    - Produce `MirrorResult` summary with counts and total size of newly cached data
    - Guard: if server is not running, show warning and offer to start
    - Show error when no lockfile is found
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7_

  - [x] 30.2 Write property test: Lockfile dependency extraction (Property 20)
    - **Property 20: Lockfile dependency extraction completeness**
    - Generate random valid lockfile content (both package-lock.json and yarn.lock formats) using fast-check
    - Verify every dependency entry is extracted with correct name and version, and count matches
    - **Validates: Requirements 17.1, 17.6**

  - [x] 30.3 Write property test: Mirror classification consistency (Property 21)
    - **Property 21: Mirror classification and summary consistency**
    - Generate random dependency sets and pre-existing cache states using fast-check
    - Verify each dependency is classified as "newly cached" iff its tarball did not exist before the operation
    - Verify `newlyCached.length + alreadyAvailable.length` equals total dependency count
    - Verify `totalNewSizeBytes` equals sum of sizes of newly cached dependencies
    - **Validates: Requirements 17.3, 17.4**

  - [x] 30.4 Write unit tests for DependencyMirrorManager
    - Test lockfile detection (package-lock.json and yarn.lock)
    - Test no-lockfile error notification
    - Test server-not-running guard
    - Test progress indicator updates
    - Test summary report with correct counts
    - _Requirements: 17.1, 17.2, 17.4, 17.5, 17.6, 17.7_

- [x] 31. Checkpoint - OnboardingManager and DependencyMirrorManager complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 32. Implement RegistryHealthProvider
  - [x] 32.1 Create RegistryHealthProvider class
    - Create `src/registryHealthProvider.ts` implementing `IRegistryHealthProvider` (TreeDataProvider)
    - Implement `startMonitoring()` / `stopMonitoring()` — periodically ping each configured uplink URL using `http.get` on a configurable interval (default 30s from `healthPingIntervalMs` setting)
    - Display one entry per configured uplink in the sidebar tree view
    - Display response latency in milliseconds next to each uplink name
    - Track and display cache hit rate per uplink as percentage
    - Maintain and display failed request counter per uplink
    - Implement `computeHealthState(latencyMs, failedCount, timedOut)` — return "unreachable" if timed out, "degraded" if latency ≥ 500ms or failures > 3, "healthy" otherwise
    - Implement `computeCacheHitRate(hits, misses)` — return `hits / (hits + misses) * 100` or 0 when no requests
    - Show notification suggesting offline mode when all uplinks are unreachable
    - Display "server not running" message when Verdaccio is stopped
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7_

  - [x] 32.2 Write property test: Cache hit rate computation (Property 22)
    - **Property 22: Cache hit rate computation**
    - Generate random non-negative hit and miss counts using fast-check
    - Verify rate equals `hits / (hits + misses) * 100` when total > 0, and 0 when total is 0
    - Verify result is between 0 and 100 inclusive
    - **Validates: Requirements 18.3**

  - [x] 32.3 Write property test: Failed request counter accuracy (Property 23)
    - **Property 23: Failed request counter accuracy**
    - Generate random sequences of success/failure events using fast-check
    - Verify the failed request counter equals the number of failure events in the sequence
    - **Validates: Requirements 18.4**

  - [x] 32.4 Write property test: Health status classification (Property 24)
    - **Property 24: Health status classification**
    - Generate random latency values, failure counts, and timeout booleans using fast-check
    - Verify "unreachable" when timed out, "degraded" when latency ≥ 500ms or failures > 3, "healthy" otherwise
    - **Validates: Requirements 18.5**

  - [x] 32.5 Write unit tests for RegistryHealthProvider
    - Test tree view shows one entry per configured uplink
    - Test offline mode suggestion when all uplinks unreachable
    - Test "server not running" message when Verdaccio is stopped
    - _Requirements: 18.1, 18.6, 18.7_

- [x] 33. Checkpoint - RegistryHealthProvider complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 34. Implement ProfileManager
  - [x] 34.1 Create ProfileManager class
    - Create `src/profileManager.ts` implementing `IProfileManager` with `createProfile()`, `switchProfile()`, `deleteProfile()`, `listProfiles()`, `getActiveProfile()`
    - Implement `createProfile(name)` — save current `.npmrc` state (default registry, scoped registries, auth token registry references) as JSON in `.verdaccio/profiles/<name>.json`
    - Implement `listProfiles()` — read profile names from `.verdaccio/profiles/` directory
    - Implement `switchProfile(name)` — read JSON file, overwrite workspace `.npmrc` with stored configuration via NpmrcManager
    - Implement `deleteProfile(name)` — remove JSON file after confirmation
    - Implement `getActiveProfile()` — return currently active profile name
    - Display active profile name in VS Code status bar
    - Show error with available profile names when switching to nonexistent profile
    - Store profiles as JSON with fields: `name`, `registry`, `scopedRegistries`, `authTokenRegistries`
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.8_

  - [x] 34.2 Write property test: Profile round-trip (Property 25)
    - **Property 25: Profile round-trip**
    - Generate random `.npmrc` content with default registry, scoped registries, and auth token registry references using fast-check
    - Create a profile from that content, then switch to that profile
    - Verify the resulting `.npmrc` content is equivalent to the original
    - **Validates: Requirements 19.1, 19.3, 19.6**

  - [x] 34.3 Write unit tests for ProfileManager
    - Test create/switch/delete/list profile CRUD operations
    - Test status bar displays active profile name
    - Test nonexistent profile error lists available profiles
    - Test profile JSON schema contains required fields
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.8_

- [x] 35. Checkpoint - ProfileManager complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 36. Update extension.ts wiring for requirements 15-19
  - [x] 36.1 Register new commands and instantiate new managers
    - Register commands: `verdaccio.createProfile`, `verdaccio.switchProfile`, `verdaccio.deleteProfile`, `verdaccio.mirrorDependencies`, `verdaccio.cacheAllDependencies`
    - Instantiate `McpServer`, `OnboardingManager`, `DependencyMirrorManager`, `RegistryHealthProvider`, `ProfileManager`
    - Pass required dependencies (ServerManager, ConfigManager, NpmrcManager, etc.) to new managers
    - In `deactivate()`, call `unregisterExtension("verdaccio-mcp")` from `@ai-capabilities-suite/vscode-shared-status-bar` to clean up ACS registration
    - _Requirements: 15.1, 15.23, 16.1, 17.1, 18.1, 19.1_

  - [x] 36.2 Wire MCP server, onboarding, and ACS registration
    - Start MCP server on activation if `verdaccio.mcp.autoStart` is `true`
    - Call `OnboardingManager.checkAndPrompt()` on activation
    - Call `registerExtension("verdaccio-mcp")` from `@ai-capabilities-suite/vscode-shared-status-bar` on activation
    - Call `setOutputChannel()` from `@ai-capabilities-suite/vscode-shared-status-bar` to set up ACS-consistent logging
    - _Requirements: 15.20, 15.22, 15.24, 16.1_

  - [x] 36.3 Wire health monitoring and profile status bar
    - Start health monitoring when server starts, stop when server stops (subscribe to `onDidChangeState`)
    - Register `verdaccioRegistryHealth` tree view for RegistryHealthProvider
    - Create profile status bar item displaying active profile name
    - _Requirements: 18.1, 18.2, 18.7, 19.4_

  - [x] 36.4 Update package.json with new contributions
    - Add new commands, views (`verdaccioRegistryHealth`), activation events, and configuration properties (`verdaccio.mcp.autoStart`, `verdaccio.healthPingIntervalMs`)
    - Add `@ai-capabilities-suite/vscode-shared-status-bar` to package.json dependencies if not already present
    - _Requirements: 15.20, 15.22, 18.1, 18.2, 19.1, 19.2_

- [x] 37. Final checkpoint - All requirements 15-19 integrated
  - Ensure all tests pass, ask the user if questions arise.

- [x] 38. ACS Suite Integration
  - [x] 38.1 Update package.json with ACS branding
    - Update `publisher`, `description`, and `keywords` fields in `package.json` to reflect ACS ecosystem membership
    - Ensure `@ai-capabilities-suite/mcp-client-base` and `@ai-capabilities-suite/vscode-shared-status-bar` are listed as dependencies with correct versions
    - _Requirements: 15.1, 15.22_

  - [x] 38.2 Register ACS diagnostic commands
    - Register ACS diagnostic commands via `diagnosticCommands` from `@ai-capabilities-suite/mcp-client-base` for troubleshooting MCP connectivity and extension health
    - _Requirements: 15.24_

  - [x] 38.3 Write unit tests for ACS integration
    - Test `registerExtension("verdaccio-mcp")` is called on activation
    - Test `unregisterExtension("verdaccio-mcp")` is called on deactivation
    - Test `setOutputChannel()` is called on activation for ACS logging
    - Test ACS diagnostic commands are registered
    - _Requirements: 15.22, 15.23, 15.24_

  - [x] 38.4 Final checkpoint - ACS integration tests pass
    - Ensure all ACS integration tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document using fast-check
- Unit tests validate specific examples and edge cases
- The extension is implemented entirely in TypeScript targeting the VS Code Extension API

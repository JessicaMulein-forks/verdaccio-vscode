# Requirements Document

## Introduction

A VS Code extension that manages a local Verdaccio npm registry instance directly from the editor. The extension allows developers to start, stop, and configure a Verdaccio server, adjust configuration knobs through a dedicated UI, and monitor registry status, cached packages, and storage usage — all without leaving VS Code.

## Glossary

- **Extension**: The VS Code extension that manages the Verdaccio registry lifecycle and provides UI views
- **Verdaccio_Server**: The local Verdaccio npm registry process managed by the Extension
- **Configuration_Panel**: The VS Code webview or settings UI that exposes Verdaccio configuration knobs to the user
- **Status_View**: The VS Code tree view or panel that displays the current state of the Verdaccio_Server
- **Cache_View**: The VS Code tree view that displays cached and stored packages in the local registry
- **Storage_Directory**: The local filesystem directory where Verdaccio persists packages and metadata
- **Config_File**: The Verdaccio YAML configuration file that controls server behavior
- **Uplink**: A remote npm registry (e.g., npmjs.org) that Verdaccio proxies requests to when a package is not found locally
- **Scoped_Registry_Entry**: A line in the `.npmrc` file that maps an npm scope (e.g., `@fortawesome`) to a specific registry URL
- **Auth_Token_Entry**: A line in the `.npmrc` file of the form `//registry.example.com/:_authToken=<token>` that authenticates requests to a specific registry
- **Token_Store**: The VS Code SecretStorage API used to persist auth tokens securely outside of plaintext files
- **Uplink_Cache_Policy**: The caching strategy for a given Uplink, including TTL (time-to-live), maxage, and whether to serve from cache or proxy first
- **Offline_Mode**: A Verdaccio operating mode where the server serves packages only from the local Storage_Directory without contacting any Uplink
- **Storage_Analytics**: Computed metrics about the Storage_Directory including disk usage, package download counts, largest packages, and stale packages
- **Stale_Package**: A package version in the Storage_Directory that has not been downloaded or accessed within a user-configured number of days
- **Publish_Workflow**: The process of packing and publishing an npm package from the workspace to the local Verdaccio_Server
- **Workspace_Packages**: The set of npm packages defined in the workspace, detected from the `workspaces` field in the root `package.json`
- **Network_Proxy**: An HTTP or HTTPS proxy server used to route Verdaccio Uplink traffic, typically required in corporate environments
- **ACS**: The AI Capabilities Suite ecosystem — a collection of VS Code extensions that share a unified status bar, logging conventions, and diagnostic commands
- **BaseMCPClient**: The abstract base class from `@ai-capabilities-suite/mcp-client-base` (v1.0.2) that provides automatic timeout handling, exponential backoff reconnection, connection state management, and `callTool(name, params)` for invoking MCP tools
- **Cache_Walker**: An MCP_Tool (`verdaccio_walk_cache`) that inspects the local Storage_Directory and returns a detailed breakdown of cached packages grouped by scope, with version counts, sizes, last access dates, and origin information
- **MCP_Server**: A Model Context Protocol server embedded in the Extension that exposes Verdaccio management functionality as structured tool calls for AI coding agents, built by extending BaseMCPClient from the ACS ecosystem
- **MCP_Tool**: A single callable function exposed by the MCP_Server, accepting JSON parameters and returning structured JSON responses
- **Onboarding_Flow**: The automated sequence that detects a `.verdaccio` configuration directory in a newly opened workspace and offers to bootstrap the local registry environment
- **Dependency_Mirror**: The process of installing all project dependencies through the Verdaccio_Server so that package tarballs are cached locally in the Storage_Directory for offline use
- **Registry_Health**: Real-time metrics about Uplink connectivity including latency, cache hit rate, failed request count, and reachability status
- **Npmrc_Profile**: A named configuration bundle stored as a JSON file in `.verdaccio/profiles/` that captures a default registry URL, scoped registry entries, and auth token references for quick switching

## Requirements

### Requirement 1: Server Lifecycle Management

**User Story:** As a developer, I want to start and stop a local Verdaccio server from VS Code, so that I can manage my private registry without using the terminal.

#### Acceptance Criteria

1. WHEN the user invokes the "Start Verdaccio" command, THE Extension SHALL spawn a Verdaccio_Server process using the active Config_File
2. WHEN the user invokes the "Stop Verdaccio" command, THE Extension SHALL gracefully terminate the running Verdaccio_Server process
3. WHILE the Verdaccio_Server is running, THE Extension SHALL display a status bar item indicating the server is active and the listening port
4. WHEN the Verdaccio_Server process exits unexpectedly, THE Extension SHALL display an error notification with the exit code and last 20 lines of server output
5. WHEN the user invokes the "Restart Verdaccio" command, THE Extension SHALL stop the running Verdaccio_Server and start a new instance using the active Config_File
6. IF the user invokes "Start Verdaccio" while a Verdaccio_Server is already running, THEN THE Extension SHALL display a warning notification and take no further action

### Requirement 2: Configuration Management

**User Story:** As a developer, I want to view and modify Verdaccio configuration from within VS Code, so that I can tune registry behavior without manually editing YAML files.

#### Acceptance Criteria

1. THE Configuration_Panel SHALL expose the following settings: listen port, Storage_Directory path, max body size, and log level
2. THE Configuration_Panel SHALL expose Uplink settings including URL, timeout, and max retries for each configured Uplink
3. WHEN the user modifies a setting in the Configuration_Panel, THE Extension SHALL update the Config_File on disk with the new value
4. WHEN the user modifies a setting while the Verdaccio_Server is running, THE Extension SHALL prompt the user to restart the server for changes to take effect
5. THE Extension SHALL provide a VS Code setting to specify the path to the Config_File, defaulting to `.verdaccio/config.yaml` in the workspace root
6. IF the Config_File does not exist at the configured path, THEN THE Extension SHALL offer to generate a default Config_File with sensible defaults
7. WHEN the user invokes the "Open Raw Config" command, THE Extension SHALL open the Config_File in the VS Code text editor

### Requirement 3: Server Status View

**User Story:** As a developer, I want to see the current status of my Verdaccio server at a glance, so that I can verify the registry is healthy and accessible.

#### Acceptance Criteria

1. THE Status_View SHALL display the current Verdaccio_Server state (stopped, starting, running, error)
2. WHILE the Verdaccio_Server is running, THE Status_View SHALL display the listening address and port
3. WHILE the Verdaccio_Server is running, THE Status_View SHALL display the server uptime
4. WHILE the Verdaccio_Server is running, THE Status_View SHALL display the number of packages stored in the Storage_Directory
5. WHEN the Verdaccio_Server state changes, THE Status_View SHALL update within 2 seconds
6. THE Status_View SHALL be accessible from the VS Code Activity Bar as a dedicated sidebar panel

### Requirement 4: Cache and Package View

**User Story:** As a developer, I want to browse cached packages in my local registry, so that I can see what is available locally and manage storage.

#### Acceptance Criteria

1. THE Cache_View SHALL display a tree of all packages stored in the Storage_Directory, grouped by scope
2. WHEN the user expands a package node in the Cache_View, THE Cache_View SHALL display all available versions of that package
3. WHEN the user selects a package version in the Cache_View, THE Extension SHALL display the package metadata (name, version, description, tarball size) in a detail panel
4. WHEN the user invokes "Delete Package" on a package node, THE Extension SHALL remove the package from the Storage_Directory and refresh the Cache_View
5. WHEN the user invokes "Delete Package" on a package node, THE Extension SHALL prompt for confirmation before deleting
6. WHEN a new package is published to the Verdaccio_Server, THE Cache_View SHALL refresh automatically within 5 seconds
7. THE Cache_View SHALL display the total storage size used by all cached packages

### Requirement 5: Output and Logging

**User Story:** As a developer, I want to see Verdaccio server logs in VS Code, so that I can debug registry issues without switching to a terminal.

#### Acceptance Criteria

1. THE Extension SHALL create a dedicated VS Code Output Channel named "Verdaccio" for server logs
2. WHILE the Verdaccio_Server is running, THE Extension SHALL stream stdout and stderr from the Verdaccio_Server process to the Output Channel in real time
3. WHEN the user invokes the "Show Verdaccio Logs" command, THE Extension SHALL reveal the Verdaccio Output Channel
4. THE Extension SHALL respect the log level configured in the Config_File when displaying log entries

### Requirement 6: npm Client Integration

**User Story:** As a developer, I want the extension to configure my local npm client to use the Verdaccio registry, so that I can publish and install packages seamlessly.

#### Acceptance Criteria

1. WHEN the user invokes the "Set Registry" command, THE Extension SHALL configure the workspace `.npmrc` file to point to the running Verdaccio_Server address
2. WHEN the user invokes the "Reset Registry" command, THE Extension SHALL remove the Verdaccio registry entry from the workspace `.npmrc` file
3. IF the Verdaccio_Server is not running when the user invokes "Set Registry", THEN THE Extension SHALL display a warning and offer to start the server first
4. THE Extension SHALL provide a VS Code setting to automatically set the registry when the Verdaccio_Server starts and reset it when the server stops

### Requirement 7: Extension Activation and Deactivation

**User Story:** As a developer, I want the extension to clean up resources properly, so that no orphan processes or stale state remain after I close VS Code.

#### Acceptance Criteria

1. WHEN VS Code is closing and the Verdaccio_Server is running, THE Extension SHALL gracefully terminate the Verdaccio_Server process
2. THE Extension SHALL activate on-demand when the user invokes any Verdaccio command or opens a Verdaccio view
3. IF the Verdaccio_Server process cannot be terminated gracefully within 5 seconds, THEN THE Extension SHALL force-kill the process

### Requirement 8: Scoped Registry Management

**User Story:** As a developer, I want to configure per-scope registry URLs in my `.npmrc`, so that I can route specific scopes (e.g., `@fortawesome`) to their private registries while all other packages resolve through Verdaccio.

#### Acceptance Criteria

1. WHEN the user invokes the "Add Scoped Registry" command, THE Extension SHALL prompt for a scope name and a registry URL, then write a `@scope:registry=<url>` entry to the workspace `.npmrc` file
2. THE Extension SHALL display all Scoped_Registry_Entry items currently defined in the workspace `.npmrc` in a dedicated tree view section
3. WHEN the user invokes "Edit Scoped Registry" on a Scoped_Registry_Entry, THE Extension SHALL present a pre-filled input for the registry URL and update the `.npmrc` entry on confirmation
4. WHEN the user invokes "Remove Scoped Registry" on a Scoped_Registry_Entry, THE Extension SHALL remove the corresponding `@scope:registry=` line from the workspace `.npmrc` and preserve all other lines
5. WHEN the user adds or removes a Scoped_Registry_Entry, THE Extension SHALL validate that the scope name starts with `@` and the registry URL is a valid HTTP or HTTPS URL before writing
6. IF the workspace `.npmrc` file does not exist when the user adds a Scoped_Registry_Entry, THEN THE Extension SHALL create the `.npmrc` file with the new entry
7. FOR ALL valid `.npmrc` content, adding a Scoped_Registry_Entry and then removing the same entry SHALL produce `.npmrc` content equivalent to the original (round-trip property)

### Requirement 9: Auth Token Management

**User Story:** As a developer, I want to manage authentication tokens for private registries from within VS Code, so that I can configure access to registries like FontAwesome Pro without manually editing `.npmrc` token lines.

#### Acceptance Criteria

1. WHEN the user invokes the "Add Auth Token" command, THE Extension SHALL prompt for a registry URL and a token value, then write a `//registry.example.com/:_authToken=<token>` entry to the workspace `.npmrc` file
2. THE Extension SHALL store a copy of each auth token in the Token_Store using the VS Code SecretStorage API
3. THE Extension SHALL display all Auth_Token_Entry items in a dedicated tree view section, showing the registry URL with the token value masked (e.g., `****abcd`)
4. WHEN the user invokes "Rotate Token" on an Auth_Token_Entry, THE Extension SHALL prompt for a new token value, update the `.npmrc` entry, and update the Token_Store
5. WHEN the user invokes "Remove Auth Token" on an Auth_Token_Entry, THE Extension SHALL remove the `_authToken` line from the workspace `.npmrc` and delete the token from the Token_Store
6. WHEN the user invokes "Reveal Token" on an Auth_Token_Entry, THE Extension SHALL retrieve the token from the Token_Store and display it in a temporary notification that auto-dismisses after 10 seconds
7. IF the user provides an empty or whitespace-only token value, THEN THE Extension SHALL display a validation error and reject the entry
8. FOR ALL valid `.npmrc` content, adding an Auth_Token_Entry and then removing the same entry SHALL produce `.npmrc` content equivalent to the original (round-trip property)

### Requirement 10: Uplink Failover and Caching Policies

**User Story:** As a developer, I want to configure uplink caching strategies and failover behavior, so that I can optimize registry performance and work offline when upstream registries are unavailable.

#### Acceptance Criteria

1. THE Configuration_Panel SHALL expose per-Uplink cache settings including TTL (maxage), cache_ttl, and timeout values
2. WHEN the user modifies an Uplink_Cache_Policy, THE Extension SHALL update the corresponding Uplink section in the Config_File
3. THE Configuration_Panel SHALL provide a toggle to enable Offline_Mode for the Verdaccio_Server
4. WHEN Offline_Mode is enabled, THE Extension SHALL set all Uplink entries in the Config_File to have `max_fails: 0` and `fail_timeout: 0` to prevent upstream requests
5. WHEN the user disables Offline_Mode, THE Extension SHALL restore the previous Uplink failover settings from before Offline_Mode was enabled
6. THE Configuration_Panel SHALL expose a "cache-first" or "proxy-first" strategy selector for each Uplink
7. WHEN the user selects "cache-first" for an Uplink, THE Extension SHALL set the Uplink `maxage` to `9999d` in the Config_File to prefer cached packages
8. WHEN the user selects "proxy-first" for an Uplink, THE Extension SHALL set the Uplink `maxage` to `0` in the Config_File to always check upstream
9. WHEN the user modifies any Uplink_Cache_Policy while the Verdaccio_Server is running, THE Extension SHALL prompt the user to restart the server for changes to take effect

### Requirement 11: Storage Management

**User Story:** As a developer, I want to monitor disk usage and clean up old packages from my local registry, so that I can keep storage under control and remove stale artifacts.

#### Acceptance Criteria

1. THE Extension SHALL compute and display the total disk usage of the Storage_Directory in the Status_View
2. THE Extension SHALL provide a VS Code setting to configure a storage usage warning threshold in megabytes, defaulting to 500 MB
3. WHEN the total disk usage of the Storage_Directory exceeds the configured warning threshold, THE Extension SHALL display a warning notification with the current usage and threshold
4. WHEN the user invokes the "Prune Old Versions" command on a package node, THE Extension SHALL prompt for the number of recent versions to keep and delete all older versions from the Storage_Directory
5. WHEN the user invokes the "Bulk Cleanup" command, THE Extension SHALL display a multi-select list of all Stale_Package entries and delete the selected packages from the Storage_Directory
6. THE Extension SHALL provide a VS Code setting to configure the staleness threshold in days, defaulting to 90 days
7. THE Storage_Analytics view SHALL display the following metrics: total disk usage, number of packages, number of versions, largest packages (top 5 by size), and Stale_Package count
8. WHEN the user invokes "Prune Old Versions" or "Bulk Cleanup", THE Extension SHALL prompt for confirmation before deleting and display the total size to be freed
9. WHEN a cleanup operation completes, THE Extension SHALL refresh the Cache_View and the Storage_Analytics view and display a notification with the amount of space freed

### Requirement 12: Publish Workflow

**User Story:** As a developer, I want to publish packages from my workspace to the local Verdaccio registry, so that I can test packages locally before publishing to a public registry.

#### Acceptance Criteria

1. WHEN the user invokes the "Publish to Verdaccio" command from a workspace folder containing a `package.json`, THE Extension SHALL run `npm publish --registry <verdaccio_url>` targeting the running Verdaccio_Server
2. IF the Verdaccio_Server is not running when the user invokes "Publish to Verdaccio", THEN THE Extension SHALL display a warning and offer to start the server first
3. WHEN the user invokes the "Promote Package" command on a package in the Cache_View, THE Extension SHALL prompt for a target registry URL and republish the package tarball to that registry
4. WHEN the user invokes the "Bump Version" command from a workspace folder, THE Extension SHALL prompt for a semver bump type (patch, minor, major, prerelease) and run `npm version <type>` in the workspace folder
5. WHEN a publish operation completes successfully, THE Extension SHALL display a success notification with the published package name and version
6. IF a publish operation fails, THEN THE Extension SHALL display an error notification with the npm error output
7. WHEN the user invokes "Publish to Verdaccio", THE Extension SHALL verify that the package name and version do not already exist in the Verdaccio_Server before publishing, and warn the user if a duplicate is detected

### Requirement 13: Monorepo Support

**User Story:** As a developer working in a monorepo, I want to publish all workspace packages to my local Verdaccio at once, so that I can test cross-package dependencies locally without publishing to a public registry.

#### Acceptance Criteria

1. THE Extension SHALL detect Workspace_Packages by reading the `workspaces` field from the root `package.json` and resolving the glob patterns to individual package directories
2. THE Extension SHALL display all detected Workspace_Packages in a dedicated tree view section showing package name and current version
3. WHEN the user invokes the "Publish All Workspace Packages" command, THE Extension SHALL publish each detected Workspace_Package to the running Verdaccio_Server in dependency order
4. IF any Workspace_Package fails to publish during a bulk publish operation, THEN THE Extension SHALL log the error, continue publishing remaining packages, and display a summary of successes and failures
5. WHEN the user invokes the "Unpublish All Workspace Packages" command, THE Extension SHALL remove all detected Workspace_Packages from the Verdaccio_Server Storage_Directory after confirmation
6. WHEN the user invokes "Publish All Workspace Packages", THE Extension SHALL display a progress indicator showing the current package being published and the overall progress (e.g., "3 of 7")
7. IF the Verdaccio_Server is not running when the user invokes a bulk publish or unpublish command, THEN THE Extension SHALL display a warning and offer to start the server first

### Requirement 14: Network Proxy Settings

**User Story:** As a developer in a corporate environment, I want to configure HTTP/HTTPS proxy settings for Verdaccio uplinks, so that the registry can reach upstream registries through my corporate proxy.

#### Acceptance Criteria

1. THE Configuration_Panel SHALL expose global HTTP proxy and HTTPS proxy URL fields for the Verdaccio_Server
2. THE Configuration_Panel SHALL expose a per-Uplink proxy override URL field, allowing different Uplinks to use different proxy servers
3. WHEN the user sets a global proxy URL, THE Extension SHALL write the `http_proxy` and `https_proxy` fields to the Config_File
4. WHEN the user sets a per-Uplink proxy override, THE Extension SHALL write the proxy URL to the specific Uplink section in the Config_File
5. THE Configuration_Panel SHALL expose a "no proxy" list field where the user can specify hostnames or IP ranges that bypass the proxy
6. WHEN the user modifies any proxy setting while the Verdaccio_Server is running, THE Extension SHALL prompt the user to restart the server for changes to take effect
7. IF the user provides a proxy URL that is not a valid HTTP or HTTPS URL, THEN THE Extension SHALL display a validation error and reject the entry

### Requirement 15: MCP Server Integration

**User Story:** As an AI coding agent, I want to programmatically control and inspect the local Verdaccio registry through MCP tool calls, so that I can automate registry operations without requiring manual user interaction in the VS Code UI.

#### Acceptance Criteria

1. THE Extension SHALL embed an MCP_Server by extending BaseMCPClient from `@ai-capabilities-suite/mcp-client-base` (v1.0.2), implementing `getServerCommand()`, `getServerEnv()`, and `onServerReady()` methods, and using `callTool(name, params)` for invoking tools via the stdio transport
2. THE MCP_Server SHALL expose the following MCP_Tools: `verdaccio_start`, `verdaccio_stop`, `verdaccio_status`, `verdaccio_publish`, `verdaccio_publish_all`, `verdaccio_list_packages`, `verdaccio_search`, `verdaccio_set_registry`, `verdaccio_reset_registry`, `verdaccio_add_scoped_registry`, `verdaccio_set_offline_mode`, `verdaccio_get_config`, `verdaccio_update_config`, `verdaccio_storage_analytics`, `verdaccio_cleanup`, `verdaccio_walk_cache`, `verdaccio_get_package`, `verdaccio_get_version`, `verdaccio_check_cached`, `verdaccio_cache_diff`, `verdaccio_cache_stats`, and `verdaccio_package_deps`
3. WHEN the `verdaccio_start` MCP_Tool is invoked, THE MCP_Server SHALL delegate to the ServerManager to start the Verdaccio_Server and return a JSON response containing the listening port and process ID
4. WHEN the `verdaccio_stop` MCP_Tool is invoked, THE MCP_Server SHALL delegate to the ServerManager to stop the Verdaccio_Server and return a JSON response confirming the shutdown
5. WHEN the `verdaccio_status` MCP_Tool is invoked, THE MCP_Server SHALL return a JSON response containing the current server state, listening port, uptime in seconds, and the number of packages in the Storage_Directory
6. WHEN the `verdaccio_publish` MCP_Tool is invoked with a directory path parameter, THE MCP_Server SHALL delegate to the PublishManager to publish the package from that directory and return a JSON response with the published package name and version
7. WHEN the `verdaccio_publish_all` MCP_Tool is invoked, THE MCP_Server SHALL delegate to the WorkspacePackageProvider to publish all Workspace_Packages in dependency order and return a JSON response with the list of successes and failures
8. WHEN the `verdaccio_list_packages` MCP_Tool is invoked, THE MCP_Server SHALL return a JSON response containing all packages in the Storage_Directory with their versions and tarball sizes
9. WHEN the `verdaccio_search` MCP_Tool is invoked with a name pattern parameter, THE MCP_Server SHALL return a JSON response containing packages whose names match the provided pattern
10. WHEN the `verdaccio_set_registry` MCP_Tool is invoked, THE MCP_Server SHALL delegate to the NpmrcManager to configure the workspace `.npmrc` to point to the running Verdaccio_Server
11. WHEN the `verdaccio_reset_registry` MCP_Tool is invoked, THE MCP_Server SHALL delegate to the NpmrcManager to remove the Verdaccio registry entry from the workspace `.npmrc`
12. WHEN the `verdaccio_add_scoped_registry` MCP_Tool is invoked with scope and URL parameters, THE MCP_Server SHALL delegate to the NpmrcManager to add the scoped registry entry
13. WHEN the `verdaccio_set_offline_mode` MCP_Tool is invoked with an enable/disable parameter, THE MCP_Server SHALL delegate to the ConfigManager to enable or disable Offline_Mode
14. WHEN the `verdaccio_get_config` MCP_Tool is invoked, THE MCP_Server SHALL delegate to the ConfigManager and return the current Verdaccio configuration as a JSON response
15. WHEN the `verdaccio_update_config` MCP_Tool is invoked with a partial configuration object, THE MCP_Server SHALL delegate to the ConfigManager to merge the patch into the active Config_File
16. WHEN the `verdaccio_storage_analytics` MCP_Tool is invoked, THE MCP_Server SHALL delegate to the StorageAnalyticsProvider and return storage usage metrics as a JSON response
17. WHEN the `verdaccio_cleanup` MCP_Tool is invoked with optional parameters for staleness threshold or package names, THE MCP_Server SHALL delegate to the StorageAnalyticsProvider to prune matching packages and return a JSON response with the count of deleted packages and bytes freed
18. THE MCP_Server SHALL return structured JSON responses from every MCP_Tool call, including a `success` boolean field and either a `data` field on success or an `error` field on failure
19. THE MCP_Server SHALL delegate all operations to the same manager classes (ServerManager, ConfigManager, NpmrcManager, PublishManager, WorkspacePackageProvider, StorageAnalyticsProvider) used by the VS Code UI
20. THE Extension SHALL provide a VS Code setting `verdaccio.mcp.autoStart` to control whether the MCP_Server starts automatically when the Extension activates, defaulting to `true`
21. THE MCP_Server SHALL be discoverable via a `.kiro/settings/mcp.json` configuration file that the Extension generates on first activation
22. WHEN the Extension activates, THE Extension SHALL register with the ACS shared status bar by calling `registerExtension("verdaccio-mcp")` from `@ai-capabilities-suite/vscode-shared-status-bar` (v1.0.21)
23. WHEN the Extension deactivates, THE Extension SHALL unregister from the ACS shared status bar by calling `unregisterExtension("verdaccio-mcp")`
24. THE Extension SHALL set up logging via the ACS shared status bar `setOutputChannel()` method and register diagnostic commands via `diagnosticCommands`
25. WHEN the `verdaccio_walk_cache` MCP_Tool is invoked, THE Cache_Walker SHALL scan the Storage_Directory and return a JSON response containing packages grouped by scope, version counts per package, total and per-package sizes in bytes, last access dates per package, and whether each package was fetched from an Uplink or published locally
26. THE `verdaccio_walk_cache` MCP_Tool SHALL accept the following optional parameters: `scope` (filter results to a specific npm scope), `pattern` (filter package names by a glob or substring pattern), `includeMetadata` (boolean, include full package metadata in the response), and `sortBy` (one of "name", "size", "lastAccess", or "versionCount")
27. THE `verdaccio_walk_cache` MCP_Tool SHALL accept optional `offset` and `limit` integer parameters for pagination, returning only the subset of results starting at `offset` with at most `limit` entries
28. THE `verdaccio_walk_cache` MCP_Tool SHALL include a `summary` object in the response containing `totalPackages`, `totalVersions`, and `totalSizeBytes` fields computed across all matching packages (before pagination is applied)
29. WHEN the `verdaccio_get_package` MCP_Tool is invoked with a `packageName` string parameter, THE MCP_Server SHALL return a JSON response containing all versions of the specified package with their sizes, descriptions, publish dates, and download counts if available
30. WHEN the `verdaccio_get_version` MCP_Tool is invoked with `packageName` and `version` string parameters, THE MCP_Server SHALL return a JSON response containing the description, dependencies, devDependencies, tarball size, and publish date for the specified package version
31. WHEN the `verdaccio_check_cached` MCP_Tool is invoked with a `packages` string array parameter (where each entry is either a package name or a `name@version` pair), THE MCP_Server SHALL return a JSON response with `cached` and `notCached` string arrays indicating which packages are present in the Storage_Directory and which are not
32. WHEN the `verdaccio_cache_diff` MCP_Tool is invoked with an optional `lockfilePath` string parameter, THE MCP_Server SHALL compare the packages in the Storage_Directory against the project lockfile and return a JSON response with `upToDate`, `outdated`, and `missing` arrays, where each entry contains `name`, `requiredVersion`, and an optional `cachedVersion` field
33. WHEN the `verdaccio_cache_stats` MCP_Tool is invoked, THE MCP_Server SHALL return a JSON response containing `totalPackages`, `totalVersions`, `totalSizeBytes`, an optional `cacheHitRate`, an optional `mostRecentlyCached` object (with `name`, `version`, and `date` fields), and an optional `oldestCached` object (with `name`, `version`, and `date` fields)
34. WHEN the `verdaccio_package_deps` MCP_Tool is invoked with `packageName` and `version` string parameters and an optional `depth` integer parameter, THE MCP_Server SHALL return a JSON response containing a dependency tree where each node has `name`, `version`, `cached` (boolean indicating whether the dependency is present in the Storage_Directory), and a `dependencies` array of child nodes

### Requirement 16: Project Onboarding Flow

**User Story:** As a developer cloning a repository that uses Verdaccio, I want the extension to detect the existing configuration and offer to bootstrap my local registry environment, so that I can start developing immediately without manual setup steps.

#### Acceptance Criteria

1. WHEN a workspace is opened that contains a `.verdaccio/config.yaml` file, THE Extension SHALL detect the file and display an onboarding notification offering to bootstrap the local registry environment
2. WHEN the user accepts the onboarding prompt, THE Onboarding_Flow SHALL start the Verdaccio_Server using the detected Config_File
3. WHEN the user accepts the onboarding prompt, THE Onboarding_Flow SHALL configure the workspace `.npmrc` to point to the running Verdaccio_Server
4. WHEN the user accepts the onboarding prompt, THE Onboarding_Flow SHALL offer to cache all project dependencies by reading the lockfile and installing dependencies through the Verdaccio_Server
5. WHEN the user invokes the "Cache All Project Dependencies" command, THE Extension SHALL read `package-lock.json` or `yarn.lock` from the workspace root, extract all dependency entries, and run `npm install` (or `yarn install`) with the registry pointed to the Verdaccio_Server to populate the local cache
6. WHEN the Onboarding_Flow completes successfully, THE Extension SHALL persist the onboarding state in the workspace storage so that the onboarding prompt does not appear on subsequent workspace opens
7. IF the onboarding state has already been persisted for the current workspace, THEN THE Extension SHALL skip the onboarding notification on workspace open
8. IF the `.verdaccio/config.yaml` file does not exist in the workspace, THEN THE Extension SHALL skip the onboarding detection and take no action

### Requirement 17: Dependency Mirroring

**User Story:** As a developer preparing for offline or airplane-mode development, I want to cache all of my project's dependencies locally in one click, so that I can install packages without network access.

#### Acceptance Criteria

1. WHEN the user invokes the "Mirror Dependencies" command, THE Extension SHALL read the project lockfile (`package-lock.json` or `yarn.lock`) from the workspace root to determine the full dependency list
2. WHEN the Dependency_Mirror operation begins, THE Extension SHALL display a progress indicator showing the number of dependencies mirrored out of the total count
3. WHEN each dependency is fetched through the Verdaccio_Server, THE Extension SHALL classify the dependency as "newly cached" or "already available" based on whether the package tarball existed in the Storage_Directory before the operation
4. WHEN the Dependency_Mirror operation completes, THE Extension SHALL display a summary report showing the count of newly cached packages, the count of already-available packages, and the total size of newly cached data
5. IF the Verdaccio_Server is not running when the user invokes "Mirror Dependencies", THEN THE Extension SHALL display a warning and offer to start the server first
6. THE Extension SHALL support reading dependency entries from both `package-lock.json` and `yarn.lock` formats
7. IF no lockfile is found in the workspace root, THEN THE Extension SHALL display an error notification instructing the user to run `npm install` or `yarn install` first to generate a lockfile

### Requirement 18: Registry Health Dashboard

**User Story:** As a developer, I want to monitor the health and performance of my registry's upstream connections in real time, so that I can diagnose connectivity issues and decide when to switch to offline mode.

#### Acceptance Criteria

1. THE Extension SHALL display a Registry_Health section in the sidebar showing one entry per configured Uplink
2. WHILE the Verdaccio_Server is running, THE Extension SHALL periodically ping each configured Uplink URL and display the response latency in milliseconds next to the Uplink name
3. THE Extension SHALL track the cache hit rate for each Uplink as the percentage of package requests served from the local Storage_Directory versus proxied to the Uplink, and display the rate in the Registry_Health section
4. THE Extension SHALL maintain a failed request counter per Uplink and display the count in the Registry_Health section
5. THE Extension SHALL display a health status indicator per Uplink with the following states: "healthy" when latency is below 500ms and no recent failures, "degraded" when latency exceeds 500ms or the failed request count exceeds 3, and "unreachable" when the Uplink does not respond within the configured timeout
6. WHEN all configured Uplinks have a health status of "unreachable", THE Extension SHALL display a notification suggesting the user enable Offline_Mode
7. WHEN the Verdaccio_Server is not running, THE Registry_Health section SHALL display a message indicating that health monitoring requires a running server

### Requirement 19: .npmrc Profiles

**User Story:** As a developer who switches between different registry configurations (local development, CI, offline), I want to save and restore named `.npmrc` profiles, so that I can switch contexts with a single command instead of manually editing configuration files.

#### Acceptance Criteria

1. WHEN the user invokes the "Create Profile" command, THE Extension SHALL prompt for a profile name and save the current workspace `.npmrc` content (default registry, scoped registries, and auth token registry references) as a JSON file in `.verdaccio/profiles/<name>.json`
2. THE Extension SHALL display all available Npmrc_Profile names in a dedicated tree view section or quick pick list
3. WHEN the user invokes the "Switch Profile" command and selects a profile name, THE Extension SHALL read the corresponding JSON file from `.verdaccio/profiles/` and overwrite the workspace `.npmrc` with the stored configuration
4. WHILE an Npmrc_Profile is active, THE Extension SHALL display the active profile name in the VS Code status bar
5. WHEN the user invokes the "Delete Profile" command on a profile, THE Extension SHALL remove the corresponding JSON file from `.verdaccio/profiles/` after confirmation
6. THE Extension SHALL store each Npmrc_Profile as a JSON file containing the following fields: `name`, `registry` (default registry URL), `scopedRegistries` (array of scope/URL pairs), and `authTokenRegistries` (array of registry URLs that have associated auth tokens)
7. WHEN the `verdaccio_switch_profile` MCP_Tool is invoked with a profile name parameter, THE MCP_Server SHALL switch to the specified Npmrc_Profile by applying the stored configuration to the workspace `.npmrc`
8. IF the user invokes "Switch Profile" with a profile name that does not exist in `.verdaccio/profiles/`, THEN THE Extension SHALL display an error notification listing the available profile names


### Requirement 20: ACS Suite Integration

**User Story:** As a developer using the AI Capabilities Suite, I want the Verdaccio extension to integrate with the shared ACS ecosystem, so that it appears alongside other ACS extensions in the unified status bar and follows consistent logging and diagnostic conventions.

#### Acceptance Criteria

1. THE Extension package metadata SHALL include ACS branding in the publisher name or description to identify the Extension as part of the AI Capabilities Suite
2. WHEN the Extension activates, THE Extension SHALL register with the ACS shared status bar by calling `registerExtension("verdaccio-mcp")` from `@ai-capabilities-suite/vscode-shared-status-bar` (v1.0.21)
3. WHEN the Extension deactivates, THE Extension SHALL unregister from the ACS shared status bar by calling `unregisterExtension("verdaccio-mcp")`
4. THE Extension SHALL register ACS diagnostic commands via the `diagnosticCommands` interface provided by `@ai-capabilities-suite/mcp-client-base`
5. THE Extension SHALL set up structured logging to a shared output channel via the ACS `setOutputChannel()` method, following ACS logging conventions
6. THE Extension SHALL use `@ai-capabilities-suite/mcp-client-base` (v1.0.2) as the foundation for the MCP_Server, leveraging its automatic timeout handling, exponential backoff reconnection, and connection state management

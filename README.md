# MCP ACS Verdaccio

Manage a local [Verdaccio](https://verdaccio.org/) npm registry directly from VS Code with full AI agent integration through MCP. Part of the [Digital Defiance AI Capabilities Suite](https://github.com/Digital-Defiance/ai-capabilities-suite).

## Features

### 🚀 Server Lifecycle Management

- **Start/Stop/Restart**: Control Verdaccio from the command palette or status bar
- **Status Bar Indicator**: See server state and port at a glance
- **Graceful Shutdown**: Automatic cleanup on VS Code close with 5-second SIGTERM→SIGKILL escalation
- **Error Reporting**: Last 20 lines of server output captured on unexpected exit

### 📦 Cache and Package Management

- **Cache Browser**: Browse cached packages grouped by scope with version details
- **Package Metadata**: View name, version, description, tarball size for any cached version
- **Delete Packages**: Remove packages from storage with confirmation prompts
- **Auto-Refresh**: FileSystemWatcher detects new packages within 5 seconds

### 📊 Storage Analytics

- **Disk Usage Monitoring**: Total storage size with configurable warning thresholds
- **Stale Package Detection**: Identify packages not accessed within configurable days
- **Prune Old Versions**: Keep the N most recent versions, delete the rest
- **Bulk Cleanup**: Multi-select stale packages for batch deletion
- **Top 5 Largest Packages**: Quick visibility into storage hogs

### 🔧 Configuration Panel

- **Webview UI**: Edit listen port, storage path, max body size, log level
- **Uplink Settings**: URL, timeout, max retries, cache strategy per uplink
- **Cache Strategies**: Cache-first (maxage=9999d) or proxy-first (maxage=0) per uplink
- **Offline Mode**: Toggle offline mode with automatic uplink snapshot/restore
- **Proxy Settings**: Global and per-uplink HTTP/HTTPS proxy with no-proxy list

### 🔒 Scoped Registries and Auth Tokens

- **Scoped Registries**: Route `@fortawesome`, `@myorg` etc. to private registries
- **Auth Token Management**: Add, rotate, remove, reveal tokens with VS Code SecretStorage
- **Validation**: Scope names must start with `@`, URLs must be valid HTTP/HTTPS
- **Round-Trip Safety**: All .npmrc mutations preserve unrelated lines

### 📤 Publish Workflow

- **Publish to Verdaccio**: One-click publish from workspace with duplicate detection
- **Promote Package**: Re-publish tarballs to upstream registries
- **Version Bumping**: Semver bump (patch/minor/major/prerelease) via npm version
- **Monorepo Support**: Detect workspace packages, publish all in dependency order (topological sort)
- **Partial Failure Handling**: Continue on failure, show summary of successes and failures

### 🌐 Registry Health Dashboard

- **Uplink Latency**: Periodic pings with response time in milliseconds
- **Cache Hit Rate**: Percentage of requests served from cache vs proxied
- **Failed Request Counter**: Track connectivity issues per uplink
- **Health Status**: Healthy / Degraded / Unreachable classification
- **Auto-Suggest Offline Mode**: When all uplinks are unreachable

### 📋 .npmrc Profiles

- **Named Profiles**: Save "local-dev", "ci", "offline" configurations
- **Quick Switching**: Switch profiles with a single command
- **Status Bar**: Active profile name displayed in VS Code status bar
- **JSON Storage**: Profiles stored in `.verdaccio/profiles/` as JSON

### 🚀 Project Onboarding

- **Auto-Detection**: Detects `.verdaccio/config.yaml` on workspace open
- **One-Click Bootstrap**: Start server, set registry, mirror dependencies
- **Persistent State**: Won't re-prompt after initial onboarding

### ✈️ Dependency Mirroring

- **Mirror All Dependencies**: Cache entire lockfile for offline development
- **Lockfile Support**: Both `package-lock.json` and `yarn.lock`
- **Progress Indicator**: Shows mirroring progress
- **Summary Report**: Newly cached vs already available counts

### 🤖 MCP Server (22 AI-Accessible Tools)

AI coding agents can programmatically control the registry through structured MCP tool calls:

| Tool | Description |
|------|-------------|
| `verdaccio_start` | Start the Verdaccio server |
| `verdaccio_stop` | Stop the server |
| `verdaccio_status` | Get server state, port, uptime |
| `verdaccio_publish` | Publish a package from a directory |
| `verdaccio_publish_all` | Publish all workspace packages in dependency order |
| `verdaccio_list_packages` | List all cached packages with versions |
| `verdaccio_search` | Search packages by name pattern |
| `verdaccio_get_package` | Get full package details (all versions) |
| `verdaccio_get_version` | Get version metadata with dependencies |
| `verdaccio_check_cached` | Batch check which packages are cached |
| `verdaccio_cache_diff` | Compare cache vs lockfile (up-to-date/outdated/missing) |
| `verdaccio_cache_stats` | Quick cache summary stats |
| `verdaccio_package_deps` | Dependency tree with cache status flags |
| `verdaccio_walk_cache` | Detailed cache inspection with filtering, sorting, pagination |
| `verdaccio_set_registry` | Configure .npmrc for Verdaccio |
| `verdaccio_reset_registry` | Reset .npmrc to defaults |
| `verdaccio_add_scoped_registry` | Add scoped registry entry |
| `verdaccio_set_offline_mode` | Toggle offline mode |
| `verdaccio_get_config` | Read Verdaccio configuration |
| `verdaccio_update_config` | Patch Verdaccio configuration |
| `verdaccio_storage_analytics` | Get storage usage metrics |
| `verdaccio_cleanup` | Prune stale packages or old versions |

## Requirements

- [Verdaccio](https://verdaccio.org/) installed (`npm i -g verdaccio`)
- Node.js 18+
- VS Code 1.85+

## Installation

Install from VS Code Marketplace:

```bash
code --install-extension DigitalDefiance.mcp-acs-verdaccio
```

## Configuration

### General Settings

```json
{
  "verdaccio.configPath": ".verdaccio/config.yaml",
  "verdaccio.autoSetRegistry": false,
  "verdaccio.storageWarningThresholdMb": 500,
  "verdaccio.stalenessThresholdDays": 90,
  "verdaccio.mcp.autoStart": true,
  "verdaccio.healthPingIntervalMs": 30000
}
```

## Support

- **Issues**: [GitHub Issues](https://github.com/Digital-Defiance/vscode-mcp-acs-verdaccio/issues)
- **Documentation**: [GitHub Repository](https://github.com/Digital-Defiance/vscode-mcp-acs-verdaccio)
- **Email**: <info@digitaldefiance.org>

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Part of AI Capabilities Suite

This extension is part of the Digital Defiance AI Capabilities Suite, which includes:

- **MCP ACS Process Manager**: Process management with security boundaries
- **MCP ACS Screenshot**: Cross-platform screenshot capture
- **MCP ACS Debugger**: Advanced debugging capabilities
- **MCP ACS Filesystem Manager**: Advanced file operations
- **MCP ACS Verdaccio**: Local npm registry management (this extension)

Visit [Digital Defiance](https://digitaldefiance.org) for more information.

# Codex Plugins

Personal Codex plugin marketplace for reusable MCP integrations and workflow skills.

## Repository layout

```text
.agents/
  plugins/
    marketplace.json
plugins/
  jira/
    .codex-plugin/
      plugin.json
    .mcp.json
    skills/
    scripts/
```

Add future plugins under `plugins/<plugin-name>` and register them in `.agents/plugins/marketplace.json`.

## Install

Add this repository as a Codex plugin marketplace:

```powershell
codex plugin marketplace add soomin-kevin-sung/codex-plugins --ref main
```

Restart Codex, open the plugin directory, choose the `Soomin Kevin Sung` marketplace, then install the plugin you want.

Cloning is only needed if you want to edit or develop plugins locally.

## Requirements

- Codex with plugin support
- Node.js 18 or newer
- `npx` available on `PATH`
- An Atlassian account with access to the Jira sites you want to use

The Jira plugin uses Atlassian OAuth through `mcp-remote`. Credentials are not stored in this repository and should not be committed.

## Local validation

```powershell
.\scripts\validate.ps1
```

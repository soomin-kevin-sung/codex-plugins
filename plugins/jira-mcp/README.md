# Jira MCP Codex Plugin

Connect Codex to Atlassian Jira through the Atlassian remote MCP server.

## What it provides

- Search Jira and Confluence content
- Search Jira issues with JQL
- Fetch Jira issue details
- Edit Jira issues when the authenticated user has permission
- Transition Jira issues when the authenticated user has permission
- Add or update Jira worklogs

## Authentication

Each user authenticates with their own Atlassian account. Do not share Codex auth files, OAuth tokens, Jira API tokens, or local credential stores.

## MCP server

```json
{
  "mcpServers": {
    "jira": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "https://mcp.atlassian.com/v1/mcp/authv2"
      ]
    }
  }
}
```

This plugin intentionally does not include machine-specific Node.js certificate configuration. If a local network requires custom certificates, configure that environment on the target machine rather than committing it to the plugin.

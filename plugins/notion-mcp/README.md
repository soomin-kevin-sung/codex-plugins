# Notion Codex Plugin

Connect Codex to Notion through the hosted Notion MCP server.

## What it provides

- Search workspace content
- Fetch and summarize pages
- Create and edit Notion content when the authenticated user has permission
- Work with tasks, docs, and project notes exposed through Notion MCP

## Authentication

Each user authenticates with their own Notion account through OAuth. Do not share Codex auth files, OAuth tokens, API tokens, or local credential stores.

## MCP server

```json
{
  "mcpServers": {
    "notion": {
      "url": "https://mcp.notion.com/mcp"
    }
  }
}
```

This plugin uses the hosted Notion MCP server rather than the legacy local npm package.

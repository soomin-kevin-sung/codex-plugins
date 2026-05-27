#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

const SERVER_VERSION = "0.1.1";
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07"
];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const TEAMS_CLI_OWNER = "soomin-kevin-sung";
const TEAMS_CLI_REPO = "teams-cli";
const DEFAULT_COMMAND_TIMEOUT_MS = 120 * 1000;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const MAX_RELEASE_ASSET_BYTES = 64 * 1024 * 1024;
const DRY_RUN_TOKEN_TTL_MS = 10 * 60 * 1000;

const dryRunTokens = new Map();
const installLocks = new Map();
const connectionState = {
  protocolVersion: LATEST_PROTOCOL_VERSION
};

const TOOL_DEFINITIONS = [
  {
    name: "teams_cli_install",
    description: "Install the teams-cli binary from the latest GitHub release when it is missing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "teams_cli_update",
    description: "Explicitly update teams-cli by reinstalling the latest GitHub release.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        force: {
          type: "boolean",
          description: "Must be true to confirm that a manual update was requested."
        }
      }
    }
  },
  {
    name: "teams_login",
    description: "Run teams login using the CLI device-code flow.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "teams_logout",
    description: "Remove local Teams CLI tokens, state, and cached chat metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "teams_whoami",
    description: "Check Teams login/auth status by showing cached signed-in identity and token expiry information.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "teams_list_chats",
    description: "List recent Teams chats and refresh the local chat cache.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum number of chats to list."
        },
        includePreview: {
          type: "boolean",
          description: "Include last-message previews in the CLI output."
        }
      }
    }
  },
  {
    name: "teams_search_chats",
    description: "Search cached or recent Teams chats by title, member metadata, email, or thread id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          minLength: 1
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100
        }
      }
    }
  },
  {
    name: "teams_resolve",
    description: "Resolve a Teams send/read target without sending a message.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["target"],
      properties: {
        target: {
          type: "string",
          minLength: 1,
          description: "Raw thread id, alias, me/self/notes, exact email, display name, or chat title."
        }
      }
    }
  },
  {
    name: "teams_read",
    description: "Read recent Teams messages from an existing chat.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["target"],
      properties: {
        target: {
          type: "string",
          minLength: 1
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100
        },
        since: {
          type: "string",
          description: "Inclusive RFC3339 lower bound."
        },
        before: {
          type: "string",
          description: "Exclusive RFC3339 upper bound."
        }
      }
    }
  },
  {
    name: "teams_send_dry_run",
    description: "Validate a Teams chat message without sending it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["target", "message", "confirmThreadId"],
      properties: {
        target: {
          type: "string",
          minLength: 1
        },
        message: {
          type: "string",
          minLength: 1,
          description: "Markdown message body. It is passed through stdin, not command-line arguments."
        },
        confirmThreadId: {
          type: "string",
          minLength: 1,
          description: "Thread id returned by teams_resolve. Required to issue a dryRunToken."
        }
      }
    }
  },
  {
    name: "teams_send",
    description: "Send a Teams chat message after a matching dry-run. Requires confirmThreadId and dryRunToken for safety.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["target", "message", "confirmThreadId", "dryRunToken"],
      properties: {
        target: {
          type: "string",
          minLength: 1
        },
        message: {
          type: "string",
          minLength: 1,
          description: "Markdown message body. It is passed through stdin, not command-line arguments."
        },
        confirmThreadId: {
          type: "string",
          minLength: 1,
          description: "Thread id confirmed by teams_resolve or teams_send_dry_run."
        },
        dryRunToken: {
          type: "string",
          minLength: 1,
          description: "Short-lived token returned by teams_send_dry_run for the same target, thread id, and message."
        }
      }
    }
  },
  {
    name: "teams_post_channel_dry_run",
    description: "Validate a Teams channel root-thread post without posting it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["channel", "confirmThreadId"],
      oneOf: [
        { required: ["message"] },
        { required: ["cardJsonPath"] }
      ],
      properties: {
        channel: {
          type: "string",
          minLength: 1
        },
        message: {
          type: "string",
          minLength: 1,
          description: "Markdown message body. It is passed through stdin when present."
        },
        cardJsonPath: {
          type: "string",
          minLength: 1,
          description: "Adaptive Card JSON file path for dry-run validation only."
        },
        confirmThreadId: {
          type: "string",
          minLength: 1,
          description: "Channel thread id returned by teams_resolve_channel."
        }
      }
    }
  },
  {
    name: "teams_resolve_channel",
    description: "Resolve a Teams channel title or thread id without validating a post payload.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["channel"],
      properties: {
        channel: {
          type: "string",
          minLength: 1
        }
      }
    }
  },
  {
    name: "teams_post_channel",
    description: "Post a Teams channel root-thread message after a matching dry-run. Requires confirmThreadId and dryRunToken for safety.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["channel", "message", "confirmThreadId", "dryRunToken"],
      properties: {
        channel: {
          type: "string",
          minLength: 1
        },
        message: {
          type: "string",
          minLength: 1,
          description: "Markdown message body. It is passed through stdin, not command-line arguments."
        },
        confirmThreadId: {
          type: "string",
          minLength: 1
        },
        dryRunToken: {
          type: "string",
          minLength: 1,
          description: "Short-lived token returned by teams_post_channel_dry_run for the same channel, thread id, and message."
        }
      }
    }
  },
  {
    name: "teams_alias_list",
    description: "List local Teams CLI aliases.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "teams_alias_set",
    description: "Set a local alias for a stable Teams thread id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["alias", "threadId"],
      properties: {
        alias: {
          type: "string",
          pattern: "^[A-Za-z0-9._-]+$"
        },
        threadId: {
          type: "string",
          minLength: 1
        }
      }
    }
  },
  {
    name: "teams_alias_remove",
    description: "Remove a local Teams CLI alias.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["alias"],
      properties: {
        alias: {
          type: "string",
          pattern: "^[A-Za-z0-9._-]+$"
        }
      }
    }
  },
  {
    name: "teams_cache_info",
    description: "Show local Teams chat metadata cache information.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "teams_cache_refresh",
    description: "Refresh the local Teams chat metadata cache.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "teams_cache_clear",
    description: "Clear the local Teams chat metadata cache.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  }
];

class UserInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserInputError";
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertNoUnknown(input, allowed, toolName) {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new UserInputError(`${toolName} does not accept argument '${key}'`);
    }
  }
}

function optionalInteger(input, key, defaultValue, min, max) {
  const value = input[key] ?? defaultValue;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UserInputError(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requiredString(input, key) {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new UserInputError(`${key} is required`);
  }
  return value;
}

function optionalString(input, key) {
  const value = input[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new UserInputError(`${key} must be a non-empty string`);
  }
  return value;
}

function safePositional(input, key) {
  const value = requiredString(input, key);
  if (value.startsWith("-")) {
    throw new UserInputError(`${key} must not start with '-'`);
  }
  return value;
}

function optionalSafePositional(input, key) {
  const value = optionalString(input, key);
  if (value && value.startsWith("-")) {
    throw new UserInputError(`${key} must not start with '-'`);
  }
  return value;
}

function optionalBoolean(input, key, defaultValue) {
  const value = input[key] ?? defaultValue;
  if (typeof value !== "boolean") {
    throw new UserInputError(`${key} must be a boolean`);
  }
  return value;
}

function validateRfc3339(value, key) {
  if (!value) {
    return undefined;
  }
  const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!rfc3339.test(value) || Number.isNaN(Date.parse(value))) {
    throw new UserInputError(`${key} must be an RFC3339 timestamp`);
  }
  return value;
}

function validateAliasName(alias) {
  if (!/^[A-Za-z0-9._-]+$/.test(alias)) {
    throw new UserInputError("alias may contain only ASCII letters, numbers, '.', '-', and '_'");
  }
  return alias;
}

function normalizeInput(input) {
  if (input === undefined || input === null) {
    return {};
  }
  if (!isPlainObject(input)) {
    throw new UserInputError("arguments must be an object");
  }
  return input;
}

function buildTeamsArgs(toolName, rawInput) {
  const input = normalizeInput(rawInput);

  switch (toolName) {
    case "teams_login":
      assertNoUnknown(input, new Set(), toolName);
      return {
        args: ["--json", "login"],
        timeoutMs: LOGIN_TIMEOUT_MS,
        forwardStderr: true
      };

    case "teams_logout":
      assertNoUnknown(input, new Set(), toolName);
      return { args: ["--json", "logout"] };

    case "teams_whoami":
      assertNoUnknown(input, new Set(), toolName);
      return { args: ["--json", "whoami"] };

    case "teams_list_chats": {
      assertNoUnknown(input, new Set(["limit", "includePreview"]), toolName);
      const limit = optionalInteger(input, "limit", 20, 1, 100);
      const includePreview = optionalBoolean(input, "includePreview", false);
      const args = ["--json", "list-chats", "-n", String(limit)];
      if (includePreview) {
        args.push("--include-preview");
      }
      return { args };
    }

    case "teams_search_chats": {
      assertNoUnknown(input, new Set(["query", "limit"]), toolName);
      const query = safePositional(input, "query");
      const limit = optionalInteger(input, "limit", 20, 1, 100);
      return { args: ["--json", "search-chats", query, "-n", String(limit)] };
    }

    case "teams_resolve": {
      assertNoUnknown(input, new Set(["target"]), toolName);
      return { args: ["--json", "resolve", safePositional(input, "target")] };
    }

    case "teams_read": {
      assertNoUnknown(input, new Set(["target", "limit", "since", "before"]), toolName);
      const args = ["--json", "read", safePositional(input, "target"), "-n", String(optionalInteger(input, "limit", 20, 1, 100))];
      const since = validateRfc3339(optionalString(input, "since"), "since");
      const before = validateRfc3339(optionalString(input, "before"), "before");
      if (since) {
        args.push("--since", since);
      }
      if (before) {
        args.push("--before", before);
      }
      return { args };
    }

    case "teams_send_dry_run": {
      assertNoUnknown(input, new Set(["target", "message", "confirmThreadId"]), toolName);
      const args = ["--json", "send", "--dry-run", "--stdin"];
      const confirmThreadId = safePositional(input, "confirmThreadId");
      args.push("--confirm-thread-id", confirmThreadId);
      args.push(safePositional(input, "target"));
      return { args, stdin: requiredString(input, "message") };
    }

    case "teams_send": {
      assertNoUnknown(input, new Set(["target", "message", "confirmThreadId", "dryRunToken"]), toolName);
      requiredString(input, "dryRunToken");
      const args = [
        "--json",
        "send",
        "--stdin",
        "--confirm-thread-id",
        safePositional(input, "confirmThreadId"),
        safePositional(input, "target")
      ];
      return { args, stdin: requiredString(input, "message") };
    }

    case "teams_post_channel_dry_run": {
      assertNoUnknown(input, new Set(["channel", "message", "cardJsonPath", "confirmThreadId"]), toolName);
      const message = optionalString(input, "message");
      const cardJsonPath = optionalString(input, "cardJsonPath");
      if (message && cardJsonPath) {
        throw new UserInputError("message and cardJsonPath cannot be used together");
      }
      if (!message && !cardJsonPath) {
        throw new UserInputError("teams_post_channel_dry_run requires message or cardJsonPath; use teams_resolve_channel to resolve a channel without a payload");
      }
      const args = ["--json", "post", "channel", "--dry-run"];
      if (message) {
        args.push("--stdin");
      }
      if (cardJsonPath) {
        args.push("--card-json", cardJsonPath);
      }
      const confirmThreadId = safePositional(input, "confirmThreadId");
      args.push("--confirm-thread-id", confirmThreadId);
      args.push(safePositional(input, "channel"));
      return { args, stdin: message };
    }

    case "teams_resolve_channel": {
      assertNoUnknown(input, new Set(["channel"]), toolName);
      return { args: ["--json", "post", "channel", "--dry-run", safePositional(input, "channel")] };
    }

    case "teams_post_channel": {
      assertNoUnknown(input, new Set(["channel", "message", "confirmThreadId", "dryRunToken"]), toolName);
      requiredString(input, "dryRunToken");
      const args = [
        "--json",
        "post",
        "channel",
        "--stdin",
        "--confirm-thread-id",
        safePositional(input, "confirmThreadId"),
        safePositional(input, "channel")
      ];
      return { args, stdin: requiredString(input, "message") };
    }

    case "teams_alias_list":
      assertNoUnknown(input, new Set(), toolName);
      return { args: ["--json", "alias", "list"] };

    case "teams_alias_set": {
      assertNoUnknown(input, new Set(["alias", "threadId"]), toolName);
      return {
        args: ["--json", "alias", "set", validateAliasName(safePositional(input, "alias")), safePositional(input, "threadId")]
      };
    }

    case "teams_alias_remove": {
      assertNoUnknown(input, new Set(["alias"]), toolName);
      return {
        args: ["--json", "alias", "remove", validateAliasName(safePositional(input, "alias"))]
      };
    }

    case "teams_cache_info":
      assertNoUnknown(input, new Set(), toolName);
      return { args: ["--json", "cache", "info"] };

    case "teams_cache_refresh":
      assertNoUnknown(input, new Set(), toolName);
      return { args: ["--json", "cache", "refresh"] };

    case "teams_cache_clear":
      assertNoUnknown(input, new Set(), toolName);
      return { args: ["--json", "cache", "clear"] };

    default:
      throw new UserInputError(`Unknown tool: ${toolName}`);
  }
}

function getInstallRoot(env = process.env, platform = process.platform) {
  if (env.TEAMS_CLI_HOME) {
    return path.resolve(env.TEAMS_CLI_HOME);
  }
  if (platform === "win32" && env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, "Codex", "teams-cli");
  }
  return path.join(os.homedir(), ".cache", "codex", "teams-cli");
}

function getBinaryPath(installRoot, platform = process.platform) {
  return path.join(installRoot, "bin", platform === "win32" ? "teams.exe" : "teams");
}

function getStatePath(installRoot) {
  return path.join(installRoot, "state", "release.json");
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) {
      return {};
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(tempPath, filePath);
}

function latestReleaseUrl() {
  return `https://api.github.com/repos/${TEAMS_CLI_OWNER}/${TEAMS_CLI_REPO}/releases/latest`;
}

function parseSha256Digest(digest) {
  if (typeof digest !== "string") {
    throw new Error("Release asset is missing a sha256 digest");
  }
  const match = digest.match(/^sha256:([a-fA-F0-9]{64})$/);
  if (!match) {
    throw new Error(`Unsupported release asset digest: ${digest}`);
  }
  return match[1].toLowerCase();
}

function selectReleaseAsset(release, platform = process.platform, arch = process.arch) {
  if (platform !== "win32" || arch !== "x64") {
    throw new Error("teams-cli currently publishes only a Windows x86_64 release asset");
  }
  if (!release || !Array.isArray(release.assets)) {
    throw new Error("GitHub latest release response did not include assets");
  }
  const asset = release.assets.find((candidate) => (
    candidate &&
    typeof candidate.name === "string" &&
    /^teams-v[^/\\]+-windows-x86_64\.exe$/.test(candidate.name) &&
    typeof candidate.browser_download_url === "string"
  ));
  if (!asset) {
    throw new Error("Latest teams-cli release does not contain a Windows x86_64 executable asset");
  }
  parseSha256Digest(asset.digest);
  return asset;
}

function requestBuffer(url, headers = {}, redirectsRemaining = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const request = client.get(url, {
      headers: {
        "User-Agent": "codex-teams-mcp",
        "Accept": "application/vnd.github+json",
        ...headers
      }
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          reject(new Error(`Too many redirects while requesting ${url}`));
          return;
        }
        resolve(requestBuffer(new URL(response.headers.location, url).toString(), headers, redirectsRemaining - 1));
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${statusCode} while requesting ${url}`));
        return;
      }
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks, length)));
    });
    request.on("error", reject);
    request.setTimeout(DEFAULT_COMMAND_TIMEOUT_MS, () => {
      request.destroy(new Error(`Timed out requesting ${url}`));
    });
  });
}

async function requestJson(url) {
  const body = await requestBuffer(url);
  return JSON.parse(body.toString("utf8"));
}

async function downloadAndVerify(asset, destinationPath, maxBytes = MAX_RELEASE_ASSET_BYTES) {
  const expectedSha256 = parseSha256Digest(asset.digest);
  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
  const tempPath = `${destinationPath}.${process.pid}.${Date.now()}.download`;
  try {
    const actualSha256 = await downloadToFileAndHash(asset.browser_download_url, tempPath, maxBytes);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`Checksum mismatch for ${asset.name}: expected ${expectedSha256}, got ${actualSha256}`);
    }
    await fsp.chmod(tempPath, 0o755).catch(() => {});
    await fsp.rename(tempPath, destinationPath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function downloadToFileAndHash(url, destinationPath, maxBytes = MAX_RELEASE_ASSET_BYTES, headers = {}, redirectsRemaining = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const request = client.get(url, {
      headers: {
        "User-Agent": "codex-teams-mcp",
        "Accept": "application/octet-stream",
        ...headers
      }
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          reject(new Error(`Too many redirects while requesting ${url}`));
          return;
        }
        resolve(downloadToFileAndHash(new URL(response.headers.location, url).toString(), destinationPath, maxBytes, headers, redirectsRemaining - 1));
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${statusCode} while requesting ${url}`));
        return;
      }

      const hash = crypto.createHash("sha256");
      const output = fs.createWriteStream(destinationPath, { flags: "wx" });
      let total = 0;
      let settled = false;

      function fail(error) {
        if (!settled) {
          settled = true;
          response.destroy();
          output.destroy();
          reject(error);
        }
      }

      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          fail(new Error(`Release asset exceeded ${maxBytes} bytes`));
          return;
        }
        hash.update(chunk);
      });
      response.on("error", fail);
      output.on("error", fail);
      output.on("finish", () => {
        if (!settled) {
          settled = true;
          resolve(hash.digest("hex"));
        }
      });
      response.pipe(output);
    });
    request.on("error", reject);
    request.setTimeout(DEFAULT_COMMAND_TIMEOUT_MS, () => {
      request.destroy(new Error(`Timed out requesting ${url}`));
    });
  });
}

async function fileSha256(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function cachedBinaryMatches(binaryPath, expectedSha256) {
  if (typeof expectedSha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(expectedSha256)) {
    return false;
  }
  try {
    const actualSha256 = await fileSha256(binaryPath);
    return actualSha256 === expectedSha256.toLowerCase();
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function ensureTeamsCli(options = {}) {
  const env = options.env ?? process.env;
  if (env.TEAMS_MCP_TEAMS_BIN) {
    return {
      binaryPath: path.resolve(env.TEAMS_MCP_TEAMS_BIN),
      source: "env",
      installed: false
    };
  }

  const platform = options.platform ?? process.platform;
  const installRoot = options.installRoot ?? getInstallRoot(env, platform);
  const lockKey = path.resolve(installRoot).toLowerCase();
  const previous = installLocks.get(lockKey) ?? Promise.resolve();

  let releaseLock;
  const current = previous.catch(() => {}).then(async () => {
    try {
      return await ensureTeamsCliUnlocked({
        ...options,
        env,
        platform,
        installRoot
      });
    } finally {
      if (installLocks.get(lockKey) === releaseLock) {
        installLocks.delete(lockKey);
      }
    }
  });
  releaseLock = current;
  installLocks.set(lockKey, current);
  return await current;
}

async function ensureTeamsCliUnlocked(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const installRoot = options.installRoot ?? getInstallRoot(env, platform);
  const binaryPath = options.binaryPath ?? getBinaryPath(installRoot, platform);
  const statePath = options.statePath ?? getStatePath(installRoot);
  const now = options.now ?? Date.now();
  const force = Boolean(options.force);
  const fetchRelease = options.fetchRelease ?? (() => requestJson(latestReleaseUrl()));
  const downloadAsset = options.downloadAsset ?? downloadAndVerify;

  if (platform !== "win32" || arch !== "x64") {
    throw new Error("teams-cli binary install is currently supported only on Windows x86_64");
  }

  const state = await readJsonIfExists(statePath);
  const binaryExists = fs.existsSync(binaryPath);

  if (!force && binaryExists && await cachedBinaryMatches(binaryPath, state.sha256)) {
    return {
      binaryPath,
      source: "cache",
      installed: false,
      version: state.version,
      assetName: state.assetName
    };
  }

  const release = await fetchRelease();

  const asset = selectReleaseAsset(release, platform, arch);
  const sha256 = parseSha256Digest(asset.digest);
  const version = release.tag_name;
  await downloadAsset(asset, binaryPath);

  const nextState = {
    version,
    assetName: asset.name,
    sha256,
    releaseUrl: release.html_url,
    downloadUrl: asset.browser_download_url,
    installedAt: now
  };
  await writeJsonAtomic(statePath, nextState);

  return {
    binaryPath,
    source: "github_release",
    installed: true,
    version,
    assetName: asset.name,
    releaseUrl: release.html_url,
    sha256
  };
}

function tryParseJson(text) {
  if (!text || !text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function appendBounded(chunks, chunk, total) {
  const nextTotal = total + chunk.length;
  if (nextTotal > MAX_CAPTURE_BYTES) {
    throw new Error(`Command output exceeded ${MAX_CAPTURE_BYTES} bytes`);
  }
  chunks.push(chunk);
  return nextTotal;
}

async function runTeamsCommand(command, options = {}) {
  const ensure = options.ensureTeamsCli ?? ensureTeamsCli;
  const spawnImpl = options.spawnImpl ?? spawn;
  const env = options.env ?? process.env;
  const install = await ensure({ env });
  const timeoutMs = command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  return await new Promise((resolve, reject) => {
    const child = spawnImpl(install.binaryPath, command.args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill();
        settled = true;
        reject(new Error(`teams-cli command timed out after ${timeoutMs} ms`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      try {
        stdoutBytes = appendBounded(stdoutChunks, chunk, stdoutBytes);
      } catch (error) {
        child.kill();
        reject(error);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (command.forwardStderr) {
        process.stderr.write(chunk);
      }
      try {
        stderrBytes = appendBounded(stderrChunks, chunk, stderrBytes);
      } catch (error) {
        child.kill();
        reject(error);
      }
    });
    child.stdin.on("error", (error) => {
      if (error.code === "EPIPE" || error.code === "ECONNRESET") {
        return;
      }
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");
      const stderr = Buffer.concat(stderrChunks, stderrBytes).toString("utf8");
      const stdoutJson = tryParseJson(stdout);
      const stderrJson = tryParseJson(stderr);
      if (exitCode === 0) {
        resolve({
          isError: false,
          result: stdoutJson ?? {
            ok: true,
            stdout
          }
        });
        return;
      }
      resolve({
        isError: true,
        result: stderrJson ?? stdoutJson ?? {
          ok: false,
          exit_code: exitCode,
          stderr,
          stdout
        }
      });
    });

    try {
      if (command.stdin !== undefined) {
        child.stdin.end(command.stdin);
      } else {
        child.stdin.end();
      }
    } catch (error) {
      if (error.code !== "EPIPE" && error.code !== "ECONNRESET" && !settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    }
  });
}

function mcpTextResult(value, isError = false) {
  const result = {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
  if (isError) {
    result.isError = true;
  }
  return result;
}

function dryRunFingerprint(operation, input) {
  if (operation === "send") {
    return crypto.createHash("sha256").update(JSON.stringify({
      operation,
      target: requiredString(input, "target"),
      confirmThreadId: requiredString(input, "confirmThreadId"),
      message: requiredString(input, "message")
    })).digest("hex");
  }
  if (operation === "post_channel") {
    return crypto.createHash("sha256").update(JSON.stringify({
      operation,
      channel: requiredString(input, "channel"),
      confirmThreadId: requiredString(input, "confirmThreadId"),
      message: requiredString(input, "message")
    })).digest("hex");
  }
  throw new UserInputError(`Unknown dry-run operation: ${operation}`);
}

function pruneDryRunTokens(now = Date.now()) {
  for (const [token, proof] of dryRunTokens.entries()) {
    if (proof.expiresAt <= now) {
      dryRunTokens.delete(token);
    }
  }
}

function issueDryRunToken(operation, input, now = Date.now()) {
  pruneDryRunTokens(now);
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = now + DRY_RUN_TOKEN_TTL_MS;
  dryRunTokens.set(token, {
    fingerprint: dryRunFingerprint(operation, input),
    expiresAt
  });
  return {
    dryRunToken: token,
    dryRunTokenExpiresAt: new Date(expiresAt).toISOString()
  };
}

function consumeDryRunToken(operation, input, now = Date.now()) {
  pruneDryRunTokens(now);
  const token = requiredString(input, "dryRunToken");
  const proof = dryRunTokens.get(token);
  if (!proof) {
    throw new UserInputError("A matching dryRunToken from a recent dry-run is required before writing to Teams");
  }
  const expected = dryRunFingerprint(operation, input);
  if (proof.fingerprint !== expected) {
    throw new UserInputError("dryRunToken does not match this target, thread id, and message");
  }
  dryRunTokens.delete(token);
}

function attachDryRunTokenIfNeeded(toolName, input, result) {
  if (!isPlainObject(result) || result.ok !== true) {
    return result;
  }
  if (toolName === "teams_send_dry_run" && result.dry_run === true && result.sent === false) {
    return {
      ...result,
      ...issueDryRunToken("send", input)
    };
  }
  if (toolName === "teams_post_channel_dry_run" && result.dry_run === true && result.posted === false && input.message) {
    return {
      ...result,
      ...issueDryRunToken("post_channel", input)
    };
  }
  return result;
}

async function executeTool(name, args, deps = {}) {
  const input = normalizeInput(args);
  if (name === "teams_cli_install") {
    assertNoUnknown(input, new Set(), name);
    const ensure = deps.ensureTeamsCli ?? ensureTeamsCli;
    try {
      return mcpTextResult(await ensure({ force: false }));
    } catch (error) {
      return mcpTextResult({
        ok: false,
        error: {
          code: "teams_cli_install_error",
          message: error.message
        }
      }, true);
    }
  }
  if (name === "teams_cli_update") {
    assertNoUnknown(input, new Set(["force"]), name);
    const force = optionalBoolean(input, "force", false);
    if (!force) {
      return mcpTextResult({
        ok: false,
        error: {
          code: "manual_update_confirmation_required",
          message: "Pass force: true to confirm a manual teams-cli update."
        }
      }, true);
    }
    const ensure = deps.ensureTeamsCli ?? ensureTeamsCli;
    try {
      return mcpTextResult(await ensure({ force: true }));
    } catch (error) {
      return mcpTextResult({
        ok: false,
        error: {
          code: "teams_cli_update_error",
          message: error.message
        }
      }, true);
    }
  }

  if (!TOOL_DEFINITIONS.some((tool) => tool.name === name)) {
    throw new UserInputError(`Unknown tool: ${name}`);
  }

  let command;
  try {
    command = buildTeamsArgs(name, input);
    if (name === "teams_send") {
      consumeDryRunToken("send", input);
    }
    if (name === "teams_post_channel") {
      consumeDryRunToken("post_channel", input);
    }
  } catch (error) {
    if (error instanceof UserInputError) {
      return mcpTextResult({
        ok: false,
        error: {
          code: "invalid_arguments",
          message: error.message
        }
      }, true);
    }
    throw error;
  }

  const runTeams = deps.runTeamsCommand ?? runTeamsCommand;
  try {
    const outcome = await runTeams(command, deps);
    if (!outcome.isError) {
      outcome.result = attachDryRunTokenIfNeeded(name, input, outcome.result);
    }
    return mcpTextResult(outcome.result, outcome.isError);
  } catch (error) {
    return mcpTextResult({
      ok: false,
      error: {
        code: "teams_cli_execution_error",
        message: error.message
      }
    }, true);
  }
}

function jsonRpcSuccess(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  };
}

function negotiateProtocolVersion(requestedVersion) {
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)) {
    return requestedVersion;
  }
  return LATEST_PROTOCOL_VERSION;
}

function isValidRequestId(id) {
  return (typeof id === "string" && id.length > 0) || Number.isInteger(id);
}

async function handleJsonRpcMessage(message, deps = {}) {
  if (!isPlainObject(message) || message.jsonrpc !== "2.0") {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request");
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  if (!hasId) {
    return undefined;
  }
  if (!isValidRequestId(message.id)) {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request id");
  }

  try {
    switch (message.method) {
      case "initialize": {
        const protocolVersion = negotiateProtocolVersion(message.params?.protocolVersion);
        if (deps.connectionState) {
          deps.connectionState.protocolVersion = protocolVersion;
        }
        return jsonRpcSuccess(message.id, {
          protocolVersion,
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: "teams-mcp",
            version: SERVER_VERSION
          },
          instructions: "Use dry-run and confirmThreadId before sending Teams messages or posting to channels."
        });
      }

      case "ping":
        return jsonRpcSuccess(message.id, {});

      case "tools/list":
        return jsonRpcSuccess(message.id, {
          tools: TOOL_DEFINITIONS
        });

      case "tools/call": {
        const params = normalizeInput(message.params);
        const name = requiredString(params, "name");
        const result = await executeTool(name, params.arguments ?? {}, deps);
        return jsonRpcSuccess(message.id, result);
      }

      case "shutdown":
        return jsonRpcSuccess(message.id, {});

      case "notifications/initialized":
      case "notifications/cancelled":
        return undefined;

      default:
        return jsonRpcError(message.id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    if (error instanceof UserInputError) {
      return jsonRpcError(message.id, -32602, error.message);
    }
    return jsonRpcError(message.id, -32603, error.message);
  }
}

function supportsJsonRpcBatch(protocolVersion) {
  return protocolVersion === "2025-03-26" || protocolVersion === "2024-11-05" || protocolVersion === "2024-10-07";
}

async function handleJsonRpcPayload(payload, deps = {}) {
  if (!Array.isArray(payload)) {
    return await handleJsonRpcMessage(payload, deps);
  }
  const protocolVersion = deps.connectionState?.protocolVersion ?? LATEST_PROTOCOL_VERSION;
  if (!supportsJsonRpcBatch(protocolVersion)) {
    return jsonRpcError(null, -32600, `JSON-RPC batch is not supported for MCP ${protocolVersion}`);
  }
  if (payload.length === 0) {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC batch");
  }
  const responses = [];
  for (const message of payload) {
    const response = await handleJsonRpcMessage(message, deps);
    if (response) {
      responses.push(response);
    }
  }
  return responses.length > 0 ? responses : undefined;
}

function encodeMcpMessage(message) {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

function decodeMcpMessages(text) {
  const messages = [];
  const lines = text.split(/\n/);
  const remaining = lines.pop() ?? "";

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) {
      continue;
    }
    messages.push(JSON.parse(line));
  }

  return {
    messages,
    remaining
  };
}

function startStdioServer(deps = {}) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  process.stdin.on("data", async (chunk) => {
    try {
      buffer += decoder.write(chunk);
      const decoded = decodeMcpMessages(buffer);
      buffer = decoded.remaining;
      for (const message of decoded.messages) {
        const response = await handleJsonRpcPayload(message, {
          ...deps,
          connectionState
        });
        if (response) {
          process.stdout.write(encodeMcpMessage(response));
        }
      }
    } catch (error) {
      const response = jsonRpcError(null, -32700, error.message);
      process.stdout.write(encodeMcpMessage(response));
      buffer = "";
    }
  });
}

module.exports = {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  TOOL_DEFINITIONS,
  UserInputError,
  buildTeamsArgs,
  cachedBinaryMatches,
  decodeMcpMessages,
  downloadToFileAndHash,
  downloadAndVerify,
  encodeMcpMessage,
  ensureTeamsCli,
  executeTool,
  fileSha256,
  getBinaryPath,
  getInstallRoot,
  getStatePath,
  handleJsonRpcMessage,
  handleJsonRpcPayload,
  latestReleaseUrl,
  mcpTextResult,
  negotiateProtocolVersion,
  parseSha256Digest,
  requestBuffer,
  requestJson,
  runTeamsCommand,
  selectReleaseAsset,
  startStdioServer
};

if (require.main === module) {
  startStdioServer();
}

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const server = require("../mcp/server");

function sampleRelease(overrides = {}) {
  return {
    tag_name: "v0.1.2",
    html_url: "https://github.com/soomin-kevin-sung/teams-cli/releases/tag/v0.1.2",
    assets: [
      {
        name: "teams-v0.1.2-windows-x86_64.exe",
        browser_download_url: "https://example.test/teams.exe",
        digest: "sha256:23c7474a8a43ba4d817304db5ad169f20ef676e2c351a3d85679b79f46ff8b9f"
      }
    ],
    ...overrides
  };
}

test("buildTeamsArgs keeps chat message bodies on stdin", () => {
  const command = server.buildTeamsArgs("teams_send", {
    target: "user@example.com",
    confirmThreadId: "19:example@thread.v2",
    message: "secret message",
    dryRunToken: "token"
  });

  assert.deepEqual(command.args, [
    "--json",
    "send",
    "--stdin",
    "--confirm-thread-id",
    "19:example@thread.v2",
    "user@example.com"
  ]);
  assert.equal(command.stdin, "secret message");
  assert.equal(command.args.includes("secret message"), false);
});

test("buildTeamsArgs requires confirmThreadId for actual chat sends", () => {
  assert.throws(
    () => server.buildTeamsArgs("teams_send", {
      target: "user@example.com",
      message: "hello",
      dryRunToken: "token"
    }),
    /confirmThreadId is required/
  );
});

test("buildTeamsArgs rejects unknown and incompatible channel dry-run arguments", () => {
  assert.throws(
    () => server.buildTeamsArgs("teams_post_channel_dry_run", {
      channel: "Announcements",
      message: "hello",
      cardJsonPath: ".\\card.json"
    }),
    /message and cardJsonPath cannot be used together/
  );
  assert.throws(
    () => server.buildTeamsArgs("teams_post_channel_dry_run", {
      channel: "Announcements"
    }),
    /requires message or cardJsonPath/
  );
  assert.throws(
    () => server.buildTeamsArgs("teams_list_chats", {
      limit: 20,
      extra: true
    }),
    /does not accept argument/
  );
});

test("buildTeamsArgs rejects leading-hyphen untrusted positionals", () => {
  assert.throws(
    () => server.buildTeamsArgs("teams_search_chats", {
      query: "--help"
    }),
    /query must not start/
  );
  assert.throws(
    () => server.buildTeamsArgs("teams_resolve", {
      target: "-n"
    }),
    /target must not start/
  );
  assert.throws(
    () => server.buildTeamsArgs("teams_post_channel", {
      channel: "--help",
      confirmThreadId: "19:example@thread.tacv2",
      message: "hello",
      dryRunToken: "token"
    }),
    /channel must not start/
  );
});

test("buildTeamsArgs separates channel resolution from payload dry-run", () => {
  assert.deepEqual(
    server.buildTeamsArgs("teams_resolve_channel", {
      channel: "Announcements"
    }),
    {
      args: ["--json", "post", "channel", "--dry-run", "Announcements"]
    }
  );

  const dryRun = server.buildTeamsArgs("teams_post_channel_dry_run", {
    channel: "Announcements",
    confirmThreadId: "19:example@thread.tacv2",
    message: "channel payload"
  });

  assert.deepEqual(dryRun.args, [
    "--json",
    "post",
    "channel",
    "--dry-run",
    "--stdin",
    "--confirm-thread-id",
    "19:example@thread.tacv2",
    "Announcements"
  ]);
  assert.equal(dryRun.stdin, "channel payload");
});

test("buildTeamsArgs validates read timestamps and alias names", () => {
  assert.throws(
    () => server.buildTeamsArgs("teams_read", {
      target: "me",
      since: "2026-05-22"
    }),
    /RFC3339/
  );
  assert.throws(
    () => server.buildTeamsArgs("teams_alias_set", {
      alias: "bad alias",
      threadId: "19:example@thread.v2"
    }),
    /ASCII letters/
  );
});

test("selectReleaseAsset picks the latest Windows x86_64 executable and validates digest", () => {
  const asset = server.selectReleaseAsset(sampleRelease(), "win32", "x64");
  assert.equal(asset.name, "teams-v0.1.2-windows-x86_64.exe");

  assert.throws(
    () => server.selectReleaseAsset(sampleRelease({
      assets: [
        {
          name: "teams-v0.1.2-windows-x86_64.exe",
          browser_download_url: "https://example.test/teams.exe",
          digest: "sha512:not-supported"
        }
      ]
    }), "win32", "x64"),
    /Unsupported release asset digest/
  );

  assert.throws(
    () => server.selectReleaseAsset(sampleRelease(), "linux", "x64"),
    /Windows x86_64/
  );
});

test("MCP newline encoder and decoder round-trip multiple messages", () => {
  const one = { jsonrpc: "2.0", id: 1, method: "ping" };
  const two = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const combined = Buffer.concat([
    server.encodeMcpMessage(one),
    server.encodeMcpMessage(two)
  ]);

  const decoded = server.decodeMcpMessages(combined.toString("utf8"));
  assert.deepEqual(decoded.messages, [one, two]);
  assert.equal(decoded.remaining, "");
});

test("initialize negotiates only supported protocol versions", async () => {
  const supported = await server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18"
    }
  });
  assert.equal(supported.result.protocolVersion, "2025-06-18");

  const unsupported = await server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {
      protocolVersion: "1900-01-01"
    }
  });
  assert.equal(unsupported.result.protocolVersion, server.LATEST_PROTOCOL_VERSION);

  const march2025 = await server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26"
    }
  });
  assert.equal(march2025.result.protocolVersion, "2025-03-26");
});

test("handleJsonRpcPayload supports JSON-RPC batch messages", async () => {
  const response = await server.handleJsonRpcPayload([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "ping"
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    }
  ], {
    connectionState: {
      protocolVersion: "2025-03-26"
    }
  });

  assert.equal(Array.isArray(response), true);
  assert.equal(response.length, 2);
  assert.deepEqual(response[0].result, {});
  assert.equal(response[1].result.tools.some((tool) => tool.name === "teams_send"), true);

  const rejected = await server.handleJsonRpcPayload([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "ping"
    }
  ], {
    connectionState: {
      protocolVersion: "2025-11-25"
    }
  });
  assert.equal(rejected.error.code, -32600);
  assert.match(rejected.error.message, /batch is not supported/);
});

test("handleJsonRpcMessage rejects invalid ids before dispatch", async () => {
  let called = false;
  const response = await server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: null,
    method: "tools/call",
    params: {
      name: "teams_whoami"
    }
  }, {
    runTeamsCommand: async () => {
      called = true;
      return {
        isError: false,
        result: {
          ok: true
        }
      };
    }
  });

  assert.equal(response.error.code, -32600);
  assert.equal(called, false);
});

test("handleJsonRpcMessage exposes tools and calls mocked command runner", async () => {
  const list = await server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list"
  });
  assert.equal(list.result.tools.some((tool) => tool.name === "teams_send_dry_run"), true);
  assert.equal(list.result.tools.some((tool) => tool.name === "teams_resolve_channel"), true);

  const calls = [];
  const response = await server.handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "teams_send_dry_run",
      arguments: {
        target: "user@example.com",
        confirmThreadId: "19:example@thread.v2",
        message: "secret body"
      }
    }
  }, {
    runTeamsCommand: async (command) => {
      calls.push(command);
      return {
        isError: false,
        result: {
          ok: true,
          args: command.args,
          stdinLength: command.stdin.length
        }
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].stdin, "secret body");
  assert.equal(calls[0].args.includes("secret body"), false);
  const parsed = JSON.parse(response.result.content[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.stdinLength, "secret body".length);
});

test("stdio MCP server responds over newline-delimited JSON transport", async () => {
  const serverPath = path.join(__dirname, "..", "mcp", "server.js");
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  let buffer = Buffer.alloc(0);
  const messages = [];

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for MCP stdio response")), 5000);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (messages.length < 2) {
        reject(new Error(`MCP server exited before responses were received: ${code}`));
      }
    });
    child.stdout.on("data", (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        const decoded = server.decodeMcpMessages(buffer.toString("utf8"));
        buffer = Buffer.from(decoded.remaining, "utf8");
        messages.push(...decoded.messages);
        if (messages.length >= 2) {
          clearTimeout(timer);
          resolve(messages);
        }
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  });

  try {
    child.stdin.write(server.encodeMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05"
      }
    }));
    child.stdin.write(server.encodeMcpMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    }));

    const responses = await done;
    assert.equal(responses[0].result.serverInfo.name, "teams-mcp");
    assert.equal(responses[0].result.protocolVersion, "2024-11-05");
    assert.equal(responses[1].result.tools.some((tool) => tool.name === "teams_read"), true);
  } finally {
    child.kill();
  }
});

test("executeTool returns MCP tool errors for invalid arguments", async () => {
  const response = await server.executeTool("teams_send", {
    target: "user@example.com",
    message: "hello"
  }, {
    runTeamsCommand: async () => {
      throw new Error("should not run");
    }
  });

  assert.equal(response.isError, true);
  const parsed = JSON.parse(response.content[0].text);
  assert.equal(parsed.error.code, "invalid_arguments");
});

test("executeTool separates install from explicit update", async () => {
  const install = await server.executeTool("teams_cli_install", {}, {
    ensureTeamsCli: async (options) => ({
      ok: true,
      force: options.force,
      installed: false
    })
  });
  assert.equal(JSON.parse(install.content[0].text).force, false);

  const missingConfirmation = await server.executeTool("teams_cli_update", {}, {
    ensureTeamsCli: async () => {
      throw new Error("should not update without force");
    }
  });
  assert.equal(missingConfirmation.isError, true);
  assert.equal(JSON.parse(missingConfirmation.content[0].text).error.code, "manual_update_confirmation_required");

  const update = await server.executeTool("teams_cli_update", { force: true }, {
    ensureTeamsCli: async (options) => ({
      ok: true,
      force: options.force,
      installed: true
    })
  });
  assert.equal(JSON.parse(update.content[0].text).force, true);
});

test("executeTool requires a matching dry-run token before Teams writes", async () => {
  let sent = false;
  const dryRun = await server.executeTool("teams_send_dry_run", {
    target: "user@example.com",
    confirmThreadId: "19:example@thread.v2",
    message: "hello"
  }, {
    runTeamsCommand: async () => ({
      isError: false,
      result: {
        ok: true,
        sent: false,
        dry_run: true
      }
    })
  });
  const dryRunPayload = JSON.parse(dryRun.content[0].text);
  assert.equal(typeof dryRunPayload.dryRunToken, "string");

  const mismatch = await server.executeTool("teams_send", {
    target: "user@example.com",
    confirmThreadId: "19:example@thread.v2",
    message: "different",
    dryRunToken: dryRunPayload.dryRunToken
  }, {
    runTeamsCommand: async () => {
      sent = true;
      return {
        isError: false,
        result: {
          ok: true
        }
      };
    }
  });
  assert.equal(mismatch.isError, true);
  assert.equal(sent, false);

  const dryRun2 = await server.executeTool("teams_send_dry_run", {
    target: "user@example.com",
    confirmThreadId: "19:example@thread.v2",
    message: "hello"
  }, {
    runTeamsCommand: async () => ({
      isError: false,
      result: {
        ok: true,
        sent: false,
        dry_run: true
      }
    })
  });
  const token = JSON.parse(dryRun2.content[0].text).dryRunToken;
  const write = await server.executeTool("teams_send", {
    target: "user@example.com",
    confirmThreadId: "19:example@thread.v2",
    message: "hello",
    dryRunToken: token
  }, {
    runTeamsCommand: async () => {
      sent = true;
      return {
        isError: false,
        result: {
          ok: true,
          sent: true
        }
      };
    }
  });
  assert.equal(write.isError, undefined);
  assert.equal(sent, true);
});

test("ensureTeamsCli installs once, verifies state, then reuses cache without release checks", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "teams-mcp-test-"));
  const fakeExe = Buffer.from("fake exe");
  const fakeExeSha256 = crypto.createHash("sha256").update(fakeExe).digest("hex");
  const release = sampleRelease({
    assets: [
      {
        name: "teams-v0.1.2-windows-x86_64.exe",
        browser_download_url: "https://example.test/teams.exe",
        digest: `sha256:${fakeExeSha256}`
      }
    ]
  });
  try {
    let downloads = 0;
    const first = await server.ensureTeamsCli({
      installRoot: tempRoot,
      platform: "win32",
      arch: "x64",
      now: 1000,
      fetchRelease: async () => release,
      downloadAsset: async (asset, destinationPath) => {
        downloads += 1;
        assert.equal(asset.name, "teams-v0.1.2-windows-x86_64.exe");
        await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
        await fsp.writeFile(destinationPath, fakeExe);
      }
    });

    assert.equal(first.installed, true);
    assert.equal(downloads, 1);
    assert.equal(fs.existsSync(first.binaryPath), true);

    const second = await server.ensureTeamsCli({
      installRoot: tempRoot,
      platform: "win32",
      arch: "x64",
      now: 2000,
      fetchRelease: async () => {
        throw new Error("fresh cache should not fetch");
      },
      downloadAsset: async () => {
        throw new Error("fresh cache should not download");
      }
    });

    assert.equal(second.installed, false);
    assert.equal(downloads, 1);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test("ensureTeamsCli installs when the cached binary hash is wrong", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "teams-mcp-hash-test-"));
  const binaryPath = server.getBinaryPath(tempRoot, "win32");
  const statePath = server.getStatePath(tempRoot);
  const goodBinary = Buffer.from("known good binary");
  const goodSha256 = crypto.createHash("sha256").update(goodBinary).digest("hex");
  const release = sampleRelease({
    assets: [
      {
        name: "teams-v0.1.2-windows-x86_64.exe",
        browser_download_url: "https://example.test/teams.exe",
        digest: `sha256:${goodSha256}`
      }
    ]
  });

  try {
    await fsp.mkdir(path.dirname(binaryPath), { recursive: true });
    await fsp.mkdir(path.dirname(statePath), { recursive: true });
    await fsp.writeFile(binaryPath, "corrupted binary");
    await fsp.writeFile(statePath, JSON.stringify({
      version: "v0.1.2",
      assetName: "teams-v0.1.2-windows-x86_64.exe",
      sha256: goodSha256,
      installedAt: 1000
    }), "utf8");

    let downloads = 0;
    const result = await server.ensureTeamsCli({
      installRoot: tempRoot,
      platform: "win32",
      arch: "x64",
      now: 2000,
      fetchRelease: async () => release,
      downloadAsset: async (asset, destination) => {
        downloads += 1;
        assert.equal(asset.digest, `sha256:${goodSha256}`);
        await fsp.writeFile(destination, goodBinary);
      }
    });

    assert.equal(result.installed, true);
    assert.equal(downloads, 1);
    assert.equal(await server.fileSha256(binaryPath), goodSha256);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test("ensureTeamsCli treats corrupt state as cache miss and reinstalls", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "teams-mcp-corrupt-state-"));
  const binaryPath = server.getBinaryPath(tempRoot, "win32");
  const statePath = server.getStatePath(tempRoot);
  const goodBinary = Buffer.from("known good binary");
  const goodSha256 = crypto.createHash("sha256").update(goodBinary).digest("hex");

  try {
    await fsp.mkdir(path.dirname(binaryPath), { recursive: true });
    await fsp.mkdir(path.dirname(statePath), { recursive: true });
    await fsp.writeFile(binaryPath, goodBinary);
    await fsp.writeFile(statePath, "{not json", "utf8");

    let downloads = 0;
    const result = await server.ensureTeamsCli({
      installRoot: tempRoot,
      platform: "win32",
      arch: "x64",
      now: 2000,
      fetchRelease: async () => sampleRelease({
        assets: [
          {
            name: "teams-v0.1.2-windows-x86_64.exe",
            browser_download_url: "https://example.test/teams.exe",
            digest: `sha256:${goodSha256}`
          }
        ]
      }),
      downloadAsset: async (asset, destination) => {
        downloads += 1;
        assert.equal(asset.digest, `sha256:${goodSha256}`);
        await fsp.writeFile(destination, goodBinary);
      }
    });

    assert.equal(result.installed, true);
    assert.equal(downloads, 1);
    const repairedState = JSON.parse(await fsp.readFile(statePath, "utf8"));
    assert.equal(repairedState.sha256, goodSha256);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test("ensureTeamsCli serializes concurrent installs for one install root", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "teams-mcp-lock-"));
  const fakeExe = Buffer.from("locked install binary");
  const fakeExeSha256 = crypto.createHash("sha256").update(fakeExe).digest("hex");
  const release = sampleRelease({
    assets: [
      {
        name: "teams-v0.1.2-windows-x86_64.exe",
        browser_download_url: "https://example.test/teams.exe",
        digest: `sha256:${fakeExeSha256}`
      }
    ]
  });

  try {
    let fetches = 0;
    let downloads = 0;
    const fetchRelease = async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return release;
    };
    const downloadAsset = async (asset, destinationPath) => {
      downloads += 1;
      await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
      await fsp.writeFile(destinationPath, fakeExe);
    };

    const [first, second] = await Promise.all([
      server.ensureTeamsCli({
        installRoot: tempRoot,
        platform: "win32",
        arch: "x64",
        now: 3000,
        fetchRelease,
        downloadAsset
      }),
      server.ensureTeamsCli({
        installRoot: tempRoot,
        platform: "win32",
        arch: "x64",
        now: 3000,
        fetchRelease,
        downloadAsset
      })
    ]);

    assert.equal(first.installed, true);
    assert.equal(second.installed, false);
    assert.equal(fetches, 1);
    assert.equal(downloads, 1);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test("ensureTeamsCli updates only when force is requested", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "teams-mcp-manual-update-"));
  const binaryPath = server.getBinaryPath(tempRoot, "win32");
  const statePath = server.getStatePath(tempRoot);
  const oldBinary = Buffer.from("old verified binary");
  const oldSha256 = crypto.createHash("sha256").update(oldBinary).digest("hex");
  const newBinary = Buffer.from("new release binary");
  const newSha256 = crypto.createHash("sha256").update(newBinary).digest("hex");

  try {
    await fsp.mkdir(path.dirname(binaryPath), { recursive: true });
    await fsp.mkdir(path.dirname(statePath), { recursive: true });
    await fsp.writeFile(binaryPath, oldBinary);
    await fsp.writeFile(statePath, JSON.stringify({
      version: "v0.1.1",
      assetName: "teams-v0.1.1-windows-x86_64.exe",
      sha256: oldSha256,
      installedAt: 1000
    }), "utf8");

    let fetches = 0;
    const cached = await server.ensureTeamsCli({
      installRoot: tempRoot,
      platform: "win32",
      arch: "x64",
      now: 2000,
      fetchRelease: async () => {
        fetches += 1;
        throw new Error("manual update was not requested");
      },
      downloadAsset: async () => {
        throw new Error("manual update was not requested");
      }
    });
    assert.equal(cached.source, "cache");
    assert.equal(cached.installed, false);
    assert.equal(fetches, 0);

    let downloads = 0;
    const updated = await server.ensureTeamsCli({
      installRoot: tempRoot,
      platform: "win32",
      arch: "x64",
      now: 3000,
      force: true,
      fetchRelease: async () => sampleRelease({
        tag_name: "v0.1.2",
        assets: [
          {
            name: "teams-v0.1.2-windows-x86_64.exe",
            browser_download_url: "https://example.test/teams.exe",
            digest: `sha256:${newSha256}`
          }
        ]
      }),
      downloadAsset: async (asset, destination) => {
        downloads += 1;
        assert.equal(asset.digest, `sha256:${newSha256}`);
        await fsp.writeFile(destination, newBinary);
      }
    });

    assert.equal(updated.source, "github_release");
    assert.equal(updated.installed, true);
    assert.equal(downloads, 1);
    assert.equal(await server.fileSha256(binaryPath), newSha256);
    const nextState = JSON.parse(await fsp.readFile(statePath, "utf8"));
    assert.equal(nextState.version, "v0.1.2");
    assert.equal(nextState.sha256, newSha256);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test("downloadAndVerify downloads release asset only when sha256 matches", async () => {
  const body = Buffer.from("binary body");
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "teams-mcp-download-"));
  const destination = path.join(tempRoot, "teams.exe");

  const httpServer = http.createServer((request, response) => {
    if (request.url === "/teams.exe") {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end(body);
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = httpServer.address();
    await server.downloadAndVerify({
      name: "teams-v0.1.2-windows-x86_64.exe",
      browser_download_url: `http://127.0.0.1:${port}/teams.exe`,
      digest: `sha256:${digest}`
    }, destination);

    assert.equal(await fsp.readFile(destination, "utf8"), "binary body");
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test("downloadAndVerify rejects oversized release assets while streaming", async () => {
  const body = Buffer.from("0123456789");
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "teams-mcp-oversize-"));
  const destination = path.join(tempRoot, "teams.exe");

  const httpServer = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    response.end(body);
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = httpServer.address();
    await assert.rejects(
      server.downloadAndVerify({
        name: "teams-v0.1.2-windows-x86_64.exe",
        browser_download_url: `http://127.0.0.1:${port}/teams.exe`,
        digest: `sha256:${digest}`
      }, destination, 4),
      /exceeded/
    );
    assert.equal(fs.existsSync(destination), false);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

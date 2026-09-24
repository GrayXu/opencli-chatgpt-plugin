import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { loadCatalog } from './catalog.mjs';

const arg = (name, type, required, positional, defaultValue = null) =>
  ({ name, type, required, positional, valueRequired: false, choices: [], default: defaultValue });
const mockCatalog = [
  { site: 'xiaohongshu', name: 'search', access: 'read', description: 'Search Xiaohongshu notes',
    args: [arg('query', 'str', true, true), arg('limit', 'int', false, false, 20)] },
  { site: 'xiaohongshu', name: 'note', access: 'read', description: 'Read a Xiaohongshu note',
    args: [arg('note-id', 'str', true, true)] },
  { site: 'xiaohongshu', name: 'comments', access: 'read', description: 'Read comments',
    args: [arg('note-id', 'str', true, true), arg('limit', 'int', false, false, 20),
      arg('with-replies', 'boolean', false, false, false)] },
  { site: 'xiaohongshu', name: 'publish', access: 'write', description: 'Publish a note',
    args: [arg('title', 'str', true, false), arg('content', 'str', true, true),
      arg('images', 'str', true, false), arg('draft', 'bool', false, false, false)] },
  { site: 'xianyu', name: 'search', access: 'read', description: 'Search Xianyu items',
    args: [arg('query', 'str', true, true), arg('limit', 'int', false, false, 20)] },
  { site: 'xianyu', name: 'item', access: 'read', description: 'Read a Xianyu item',
    args: [arg('item_id', 'str', true, true)] },
  { site: 'xianyu', name: 'publish', access: 'write', description: 'Publish a Xianyu item',
    args: [arg('title', 'str', true, true), arg('description', 'str', true, true),
      arg('price', 'float', true, true), arg('condition', 'str', true, true),
      arg('category', 'str', true, true)] },
  { site: 'douyu', name: 'search', access: 'read', description: 'Search Douyu rooms',
    args: [arg('query', 'string', true, true), arg('limit', 'int', false, false, 20)] },
  { site: 'douyu', name: 'ranking', access: 'read', description: 'Rank Douyu rooms',
    args: [{ ...arg('sort', 'string', false, false), choices: ['hot', 'new'] },
      { ...arg('page', 'int', false, false), choices: ['1'] }] },
];

function writeMockCli(file) {
  const catalog = JSON.stringify(mockCatalog.map(entry =>
    ({ ...entry, command: `${entry.site}/${entry.name}` })));
  writeFileSync(file, `#!/usr/bin/env node\nconst args=process.argv.slice(2);\n` +
    `if(args[0]==='list')process.stdout.write(${JSON.stringify(catalog)});\n` +
    `else if(args.includes('__bad_json__'))process.stdout.write('not-json');\n` +
    `else if(args.includes('__stderr__')){process.stderr.write('mock failure');process.exitCode=2;}\n` +
    `else process.stdout.write(JSON.stringify({args}));\n`);
  chmodSync(file, 0o700);
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('Configured read tools preserve OAuth, PKCE, refresh rotation, and legacy names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xhs-mcp-test-'));
  const port = await freePort();
  const local = `http://127.0.0.1:${port}`;
  const publicBase = 'https://mcp.example.com';
  const password = randomBytes(32).toString('hex');
  const passwordFile = join(dir, 'password');
  const signingFile = join(dir, 'signing');
  const configFile = join(dir, 'config.json');
  const mockCli = join(dir, 'opencli');
  writeFileSync(passwordFile, password);
  writeFileSync(signingFile, randomBytes(32).toString('hex'));
  writeFileSync(configFile, readFileSync(join(import.meta.dirname, 'test/fixtures/config.full.json')));
  writeMockCli(mockCli);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: import.meta.dirname,
    env: { ...process.env, MCP_BASE_URL: publicBase, MCP_PORT: String(port),
      MCP_HOST: '127.0.0.1', MCP_PASSWORD_FILE: passwordFile,
      MCP_SIGNING_KEY_FILE: signingFile, MCP_STATE_FILE: join(dir, 'state.json'),
      OPENCLI_BIN: mockCli, MCP_CONFIG_FILE: configFile },
    stdio: 'ignore',
  });
  const post = (path, body, headers = {}) => fetch(`${local}${path}`, {
    method: 'POST', headers, body,
  });
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      if (child.exitCode !== null) throw new Error('MCP process exited before listening');
      try {
        const response = await fetch(`${local}/healthz`);
        ready = response.ok;
        if (ready) break;
      } catch { /* Wait for listen. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready);

    assert.equal((await fetch(`${local}/healthz`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const wrongHostStatus = await new Promise((resolve, reject) => {
      const request = httpRequest(`${local}/healthz`, { headers: { Host: 'evil.example' } }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(wrongHostStatus, 421);

    const unauthorized = await post('/mcp', JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      { 'content-type': 'application/json' });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate'), /oauth-protected-resource/);

    const publicCatalog = await (await fetch(`${local}/catalog`)).json();
    assert.equal(publicCatalog.name, 'OpenCLI');
    assert.deepEqual(publicCatalog.adapters.map(adapter => adapter.id), ['xiaohongshu', 'xianyu']);
    assert.deepEqual(publicCatalog.adapters.flatMap(adapter => adapter.tools.map(tool => tool.name)),
      ['xiaohongshu_search_notes', 'xiaohongshu_get_note', 'xiaohongshu_get_comments',
        'xianyu_search_items', 'xianyu_get_item']);
    assert.deepEqual(publicCatalog.adapters[0].tools[0].inputSchema.required, ['query']);
    assert.match(publicCatalog.adapters[0].tools[1].inputSchema.properties.url.description,
      /HTTPS host: www\.xiaohongshu\.com/);

    const metadata = await (await fetch(`${local}/.well-known/oauth-authorization-server`)).json();
    assert.equal(metadata.issuer, publicBase);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(metadata.scopes_supported, ['xhs:read', 'xianyu:read']);

    const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
    for (let i = 0; i < 21; i++) {
      const badRegistration = await post('/register', JSON.stringify({ redirect_uris: ['https://evil.example/callback'] }),
        { 'content-type': 'application/json' });
      assert.equal(badRegistration.status, 400);
    }
    const registration = await post('/register', JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
      { 'content-type': 'application/json' });
    assert.equal(registration.status, 201);
    const { client_id: clientId } = await registration.json();

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorization = new URL(`${local}/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId,
      redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256',
      scope: 'xhs:read', resource: `${publicBase}/mcp`, state: 'test-state' })) {
      authorization.searchParams.set(key, value);
    }
    const authResponse = await fetch(authorization);
    assert.match(authResponse.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const authPage = await authResponse.text();
    const requestId = authPage.match(/name="request_id" value="([^"]+)"/)?.[1];
    assert.ok(requestId);
    for (let i = 0; i < 11; i++) {
      const invalid = await post('/authorize', new URLSearchParams({ request_id: 'invalid', password: 'x' }),
        { 'content-type': 'application/x-www-form-urlencoded' });
      assert.equal(invalid.status, 400);
    }
    const approval = await fetch(`${local}/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ request_id: requestId, password }),
    });
    assert.equal(approval.status, 302);
    const callback = new URL(approval.headers.get('location'));
    assert.equal(callback.origin, 'https://chatgpt.com');
    assert.equal(callback.searchParams.get('state'), 'test-state');
    assert.equal(callback.searchParams.get('iss'), publicBase);
    const code = callback.searchParams.get('code');
    assert.ok(code);

    const tokenRequest = new URLSearchParams({ grant_type: 'authorization_code', code,
      code_verifier: verifier, client_id: clientId, redirect_uri: redirect,
      resource: `${publicBase}/mcp` });
    const tokenResponse = await post('/token', tokenRequest, { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    assert.equal(tokens.scope, 'xhs:read');
    const replay = await post('/token', tokenRequest, { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(replay.status, 400);
    const refreshed = await post('/token', new URLSearchParams({ grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token, client_id: clientId, resource: `${publicBase}/mcp` }),
      { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(refreshed.status, 200);
    const oldRefresh = await post('/token', new URLSearchParams({ grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token, client_id: clientId }),
      { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(oldRefresh.status, 400);

    const localVerifier = randomBytes(32).toString('base64url');
    const localAuthorization = new URL(authorization);
    localAuthorization.searchParams.set('code_challenge',
      createHash('sha256').update(localVerifier).digest('base64url'));
    localAuthorization.searchParams.set('state', 'local-approval');
    localAuthorization.searchParams.set('scope', 'xhs:read xianyu:read');
    const publicAuthorization = new URL(`${publicBase}/authorize${localAuthorization.search}`);
    const localApproval = spawnSync(process.execPath, ['approve.mjs'], {
      cwd: import.meta.dirname,
      input: publicAuthorization.toString(),
      encoding: 'utf8',
      env: { ...process.env, MCP_BASE_URL: publicBase, MCP_STATE_FILE: join(dir, 'state.json'),
        MCP_CONFIG_FILE: configFile, OPENCLI_BIN: mockCli },
    });
    assert.equal(localApproval.status, 0, localApproval.stderr);
    assert.equal(statSync(join(dir, 'state.json.approval')).mode & 0o777, 0o600);
    const differentRequest = new URL(localAuthorization);
    differentRequest.searchParams.set('state', 'different-state');
    assert.equal((await fetch(differentRequest, { redirect: 'manual' })).status, 200);
    const differentScope = new URL(localAuthorization);
    differentScope.searchParams.set('scope', 'xhs:read');
    assert.equal((await fetch(differentScope, { redirect: 'manual' })).status, 200);
    const approved = await fetch(localAuthorization, { redirect: 'manual' });
    assert.equal(approved.status, 302);
    assert.equal((await fetch(localAuthorization, { redirect: 'manual' })).status, 200);
    const localCode = new URL(approved.headers.get('location')).searchParams.get('code');
    const localToken = await post('/token', new URLSearchParams({ grant_type: 'authorization_code',
      code: localCode, code_verifier: localVerifier, client_id: clientId, redirect_uri: redirect,
      resource: `${publicBase}/mcp` }), { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(localToken.status, 200);
    const dualTokens = await localToken.json();
    assert.equal(dualTokens.scope, 'xhs:read xianyu:read');
    const dualRefresh = await post('/token', new URLSearchParams({ grant_type: 'refresh_token',
      refresh_token: dualTokens.refresh_token, client_id: clientId, resource: `${publicBase}/mcp` }),
      { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(dualRefresh.status, 200);
    const rotatedTokens = await dualRefresh.json();
    assert.equal(rotatedTokens.scope, 'xhs:read xianyu:read');

    const minimalAuthorization = new URL(authorization);
    minimalAuthorization.searchParams.delete('state');
    minimalAuthorization.searchParams.delete('scope');
    minimalAuthorization.searchParams.delete('resource');
    const minimalApproval = spawnSync(process.execPath, ['approve.mjs'], {
      cwd: import.meta.dirname,
      input: new URL(`${publicBase}/authorize${minimalAuthorization.search}`).toString(),
      encoding: 'utf8',
      env: { ...process.env, MCP_BASE_URL: publicBase, MCP_STATE_FILE: join(dir, 'state.json'),
        MCP_CONFIG_FILE: configFile, OPENCLI_BIN: mockCli },
    });
    assert.equal(minimalApproval.status, 0, minimalApproval.stderr);
    const minimalCallback = await fetch(minimalAuthorization, { redirect: 'manual' });
    assert.equal(minimalCallback.status, 302);
    assert.equal(new URL(minimalCallback.headers.get('location')).searchParams.has('state'), false);
    const duplicateState = new URL(`${publicBase}/authorize${minimalAuthorization.search}`);
    duplicateState.searchParams.append('state', 'one');
    duplicateState.searchParams.append('state', 'two');
    const duplicateApproval = spawnSync(process.execPath, ['approve.mjs'], {
      cwd: import.meta.dirname, input: duplicateState.toString(), encoding: 'utf8',
      env: { ...process.env, MCP_BASE_URL: publicBase, MCP_STATE_FILE: join(dir, 'state.json'),
        MCP_CONFIG_FILE: configFile, OPENCLI_BIN: mockCli },
    });
    assert.notEqual(duplicateApproval.status, 0);

    const mcpWithToken = async (accessToken, body) => {
      const response = await post('/mcp', JSON.stringify(body), {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const mcp = body => mcpWithToken(tokens.access_token, body);
    const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    assert.equal(init.result.serverInfo.name, 'OpenCLI');
    const tools = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.deepEqual(tools.result.tools.map(tool => tool.name), ['search_notes', 'get_note', 'get_comments']);
    assert.match(tools.result.tools[1].inputSchema.properties.url.description,
      /HTTPS host: www\.xiaohongshu\.com/);
    const deniedItem = await mcp({ jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'xianyu_get_item', arguments: { item_id: '1040754408976' } } });
    assert.ok(deniedItem.error || deniedItem.result?.isError);
    const search = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'search_notes', arguments: { query: 'coffee', limit: 2 } } });
    const args = JSON.parse(search.result.content[0].text).args;
    assert.deepEqual(args, ['xiaohongshu', 'search', '-f', 'json', '--site-session', 'persistent',
      '--keep-tab', 'true', '--window', 'foreground', '--limit=2', '--', 'coffee']);
    const leadingDash = await mcp({ jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'search_notes', arguments: { query: '--help', limit: 2 } } });
    assert.deepEqual(JSON.parse(leadingDash.result.content[0].text).args.slice(-2), ['--', '--help']);
    const invalidJson = await mcp({ jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'search_notes', arguments: { query: '__bad_json__' } } });
    assert.equal(invalidJson.result.isError, true);
    const failedCli = await mcp({ jsonrpc: '2.0', id: 12, method: 'tools/call',
      params: { name: 'search_notes', arguments: { query: '__stderr__' } } });
    assert.equal(failedCli.result.isError, true);
    assert.match(failedCli.result.content[0].text, /mock failure/);
    const blocked = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'get_note', arguments: { url: 'https://evil.example/explore/0123456789abcdef01234567?xsec_token=x' } } });
    assert.equal(blocked.result.isError, true);
    const dualTools = await mcpWithToken(dualTokens.access_token,
      { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
    assert.deepEqual(dualTools.result.tools.map(tool => tool.name),
      ['xiaohongshu_search_notes', 'xiaohongshu_get_note', 'xiaohongshu_get_comments',
        'xianyu_search_items', 'xianyu_get_item']);
    const itemSearch = await mcpWithToken(dualTokens.access_token, { jsonrpc: '2.0', id: 6,
      method: 'tools/call', params: { name: 'xianyu_search_items', arguments: { query: 'keyboard', limit: 2 } } });
    const itemSearchArgs = JSON.parse(itemSearch.result.content[0].text).args;
    assert.deepEqual(itemSearchArgs, ['xianyu', 'search', '-f', 'json', '--site-session', 'ephemeral',
      '--keep-tab', 'false', '--limit=2', '--', 'keyboard']);
    const item = await mcpWithToken(dualTokens.access_token, { jsonrpc: '2.0', id: 7,
      method: 'tools/call', params: { name: 'xianyu_get_item', arguments: { item_id: '1040754408976' } } });
    assert.deepEqual(JSON.parse(item.result.content[0].text).args.slice(-2),
      ['--', '1040754408976']);
    const invalidItem = await mcpWithToken(dualTokens.access_token, { jsonrpc: '2.0', id: 8,
      method: 'tools/call', params: { name: 'xianyu_get_item', arguments: { item_id: '1;publish' } } });
    assert.equal(invalidItem.result.isError, true);
    for (let i = 0; i < 60; i++) {
      const call = await mcpWithToken(rotatedTokens.access_token, { jsonrpc: '2.0', id: 100 + i,
        method: 'tools/call', params: { name: 'xianyu_search_items', arguments: { query: 'quota' } } });
      assert.equal(call.result.isError, undefined);
    }
    const overQuota = await mcpWithToken(rotatedTokens.access_token, { jsonrpc: '2.0', id: 160,
      method: 'tools/call', params: { name: 'xianyu_search_items', arguments: { query: 'quota' } } });
    assert.ok(overQuota.error || overQuota.result?.isError);
  } finally {
    child.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Readwrite tools require both configuration and OAuth write scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencli-mcp-write-test-'));
  const port = await freePort();
  const local = `http://127.0.0.1:${port}`;
  const publicBase = 'https://mcp.example.com';
  const configFile = join(dir, 'config.json');
  const passwordFile = join(dir, 'password');
  const signingFile = join(dir, 'signing');
  const mockCli = join(dir, 'opencli');
  const password = randomBytes(32).toString('hex');
  const config = JSON.parse(readFileSync(join(import.meta.dirname, 'test/fixtures/config.full.json')));
  config.adapters.xiaohongshu.enabled = false;
  config.adapters.xianyu.access = 'readwrite';
  writeFileSync(configFile, JSON.stringify(config));
  writeFileSync(passwordFile, password);
  writeFileSync(signingFile, randomBytes(32).toString('hex'));
  writeMockCli(mockCli);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: import.meta.dirname,
    env: { ...process.env, MCP_BASE_URL: publicBase, MCP_PORT: String(port), MCP_HOST: '127.0.0.1',
      MCP_PASSWORD_FILE: passwordFile, MCP_SIGNING_KEY_FILE: signingFile,
      MCP_STATE_FILE: join(dir, 'state.json'), OPENCLI_BIN: mockCli, MCP_CONFIG_FILE: configFile },
    stdio: 'ignore',
  });
  const post = (path, body, headers = {}) => fetch(`${local}${path}`, { method: 'POST', headers, body });
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      if (child.exitCode !== null) throw new Error('MCP process exited before listening');
      try { ready = (await fetch(`${local}/healthz`)).ok; if (ready) break; }
      catch { /* Wait for listen. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready);

    const catalog = await (await fetch(`${local}/catalog`)).json();
    assert.deepEqual(catalog.scopes, ['xianyu:read', 'xianyu:write']);
    assert.deepEqual(catalog.adapters.map(adapter => adapter.id), ['xianyu']);
    assert.deepEqual(catalog.adapters[0].tools.map(tool => tool.name),
      ['xianyu_search_items', 'xianyu_get_item', 'xianyu_publish_item']);
    const metadata = await (await fetch(`${local}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(metadata.scopes_supported, catalog.scopes);

    const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
    const registration = await post('/register', JSON.stringify({ redirect_uris: [redirect] }),
      { 'content-type': 'application/json' });
    assert.equal(registration.status, 201);
    const { client_id: clientId } = await registration.json();
    const authorize = async scope => {
      const verifier = randomBytes(32).toString('base64url');
      const url = new URL(`${local}/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId,
        redirect_uri: redirect, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256', resource: `${publicBase}/mcp`, scope })) url.searchParams.set(key, value);
      const page = await (await fetch(url)).text();
      const requestId = page.match(/name="request_id" value="([^"]+)"/)?.[1];
      assert.ok(requestId);
      const approval = await fetch(`${local}/authorize`, { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ request_id: requestId, password }) });
      assert.equal(approval.status, 302);
      const code = new URL(approval.headers.get('location')).searchParams.get('code');
      assert.ok(code);
      const token = await post('/token', new URLSearchParams({ grant_type: 'authorization_code',
        code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect,
        resource: `${publicBase}/mcp` }), { 'content-type': 'application/x-www-form-urlencoded' });
      assert.equal(token.status, 200);
      return (await token.json()).access_token;
    };
    const readToken = await authorize('xianyu:read');
    const bothToken = await authorize('xianyu:read xianyu:write');
    const mcp = async (token, id, method, params = {}) => {
      const response = await post('/mcp', JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          accept: 'application/json, text/event-stream' });
      assert.equal(response.status, 200);
      return response.json();
    };
    const readTools = await mcp(readToken, 1, 'tools/list');
    assert.deepEqual(readTools.result.tools.map(tool => tool.name), ['xianyu_search_items', 'xianyu_get_item']);
    const denied = await mcp(readToken, 2, 'tools/call', { name: 'xianyu_publish_item',
      arguments: { title: 'test', description: 'test', price: 1, condition: '全新', category: '图书' } });
    assert.ok(denied.error || denied.result?.isError);
    const allTools = await mcp(bothToken, 3, 'tools/list');
    assert.deepEqual(allTools.result.tools.map(tool => tool.name),
      ['xianyu_search_items', 'xianyu_get_item', 'xianyu_publish_item']);
    assert.equal(allTools.result.tools[2].annotations.destructiveHint, true);
    const published = await mcp(bothToken, 4, 'tools/call', { name: 'xianyu_publish_item',
      arguments: { title: 'test', description: 'test item', price: 1, condition: '全新', category: '图书' } });
    assert.deepEqual(JSON.parse(published.result.content[0].text).args,
      ['xianyu', 'publish', '-f', 'json', '--site-session', 'ephemeral', '--keep-tab', 'false',
        '--', 'test', 'test item', '1', '全新', '图书']);
  } finally {
    child.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Invalid adapter selections fail before serving', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencli-mcp-config-test-'));
  const file = join(dir, 'config.json');
  const mockCli = join(dir, 'opencli');
  writeMockCli(mockCli);
  try {
    writeFileSync(file, JSON.stringify({ version: 1, adapters: {
      xianyu: { enabled: true, access: 'readwrite', tools: ['search'] },
    } }));
    await assert.rejects(loadCatalog(file, mockCli), /readwrite but has no selected write command/);
    writeFileSync(file, JSON.stringify({ version: 1, adapters: {
      xianyu: { enabled: true, access: 'read', tools: ['no-such-tool'] },
    } }));
    await assert.rejects(loadCatalog(file, mockCli), /OpenCLI command not installed: xianyu\/no-such-tool/);
    writeFileSync(file, JSON.stringify({ version: 1, adapters: {
      douyu: { enabled: true, access: 'read', tools: ['search', 'ranking'] },
    } }));
    const plugin = await loadCatalog(file, mockCli);
    assert.deepEqual(plugin.publicCatalog.adapters[0].tools.map(tool => tool.name),
      ['douyu_search', 'douyu_ranking']);
    assert.deepEqual(plugin.adapters[0].tools[0].buildArgs({ query: 'coffee', limit: 2 }),
      ['--limit=2', '--', 'coffee']);
    const sortSchema = plugin.publicCatalog.adapters[0].tools[1].inputSchema.properties.sort;
    assert.deepEqual(sortSchema.allOf.find(part => part.enum).enum, ['hot', 'new']);
    const pageSchema = plugin.publicCatalog.adapters[0].tools[1].inputSchema.properties.page;
    assert.equal(pageSchema.allOf.find(part => part.const !== undefined).const, 1);

    const full = JSON.parse(readFileSync(join(import.meta.dirname, 'test/fixtures/config.full.json')));
    full.adapters.xianyu.enabled = false;
    full.adapters.xiaohongshu.access = 'readwrite';
    writeFileSync(file, JSON.stringify(full));
    const writeCatalog = await loadCatalog(file, mockCli);
    const publish = writeCatalog.adapters[0].tools.find(tool => tool.name === 'publish');
    assert.deepEqual(publish.buildArgs({ title: '--draft', content: '--help', images: '/tmp/a.jpg', draft: true }),
      ['--title=--draft', '--images=/tmp/a.jpg', '--draft', '--', '--help']);

    full.adapters.xiaohongshu.legacyNames.note = 'get_comments';
    writeFileSync(file, JSON.stringify(full));
    await assert.rejects(loadCatalog(file, mockCli), /Duplicate legacy tool name/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

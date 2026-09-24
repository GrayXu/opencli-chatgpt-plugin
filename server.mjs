import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { promisify } from 'node:util';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadCatalog } from './catalog.mjs';

const execFileAsync = promisify(execFile);
const baseUrl = process.env.MCP_BASE_URL?.replace(/\/$/, '');
const resource = `${baseUrl}/mcp`;
const port = Number(process.env.MCP_PORT || 18060);
const host = process.env.MCP_HOST || '127.0.0.1';
const opencli = process.env.OPENCLI_BIN || 'opencli';
const catalog = await loadCatalog();
const { supportedScopes, defaultScope } = catalog;
const password = readFileSync(process.env.MCP_PASSWORD_FILE, 'utf8').trim();
const signingKey = Buffer.from(readFileSync(process.env.MCP_SIGNING_KEY_FILE, 'utf8').trim(), 'hex');
const stateFile = process.env.MCP_STATE_FILE;
if (!baseUrl?.startsWith('https://') || password.length < 32 || signingKey.length !== 32) {
  throw new Error('Invalid MCP base URL or credential files');
}
if (!stateFile) throw new Error('MCP_STATE_FILE is required');
const approvalFile = `${stateFile}.approval`;
let refreshState;
try { refreshState = JSON.parse(readFileSync(stateFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  refreshState = {};
}

function saveRefreshState() {
  const now = Date.now();
  for (const [id, exp] of Object.entries(refreshState)) if (exp <= now) delete refreshState[id];
  const temporary = `${stateFile}.tmp`;
  writeFileSync(temporary, JSON.stringify(refreshState), { mode: 0o600 });
  renameSync(temporary, stateFile);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb', type: 'application/json' }));
app.use(express.urlencoded({ extended: false, limit: '8kb' }));
const pendingAuth = new Map();
const pendingCodes = new Map();
const toolUsage = new Map();
let nextUsagePruneAt = 0;
let activeCli = false;

function normalizeScopes(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const requested = value.trim().split(/\s+/);
  if (new Set(requested).size !== requested.length ||
      requested.some(scope => !supportedScopes.includes(scope))) return null;
  return supportedScopes.filter(scope => requested.includes(scope)).join(' ');
}

function randomToken() {
  return randomBytes(32).toString('base64url');
}

function signed(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = createHmac('sha256', signingKey).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifySigned(value, type) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const expected = createHmac('sha256', signingKey).update(parts[0]).digest();
  let actual;
  try { actual = Buffer.from(parts[1], 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (data.type !== type || data.exp <= Date.now() || data.iss !== baseUrl) return null;
    return data;
  } catch { return null; }
}

function officialRedirect(value) {
  if (typeof value !== 'string' || value.length > 300) return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://chatgpt.com' && !url.username && !url.password &&
      !url.port && !url.search && !url.hash &&
      (url.pathname === '/connector_platform_oauth_redirect' ||
       /^\/connector\/oauth\/[A-Za-z0-9_-]{1,100}$/.test(url.pathname));
  } catch { return false; }
}

function clientFromId(value) {
  const client = verifySigned(value, 'client');
  return client && Array.isArray(client.redirects) && client.redirects.every(officialRedirect) ? client : null;
}

function jsonNoStore(res, status, data) {
  res.set('Cache-Control', 'no-store').status(status).json(data);
}

function oauthError(res, status, error, description) {
  jsonNoStore(res, status, { error, error_description: description });
}

function prunePending() {
  for (const [key, value] of pendingAuth) if (value.exp < Date.now()) pendingAuth.delete(key);
  for (const [key, value] of pendingCodes) if (value.exp < Date.now()) pendingCodes.delete(key);
}

function consumeLocalApproval(request) {
  let approval;
  try { approval = JSON.parse(readFileSync(approvalFile, 'utf8')); }
  catch { return false; }
  if (!approval || approval.exp <= Date.now() || approval.clientId !== request.clientId ||
      approval.redirect !== request.redirect || approval.challenge !== request.challenge ||
      approval.state !== request.state || approval.scope !== request.scope) return false;
  try { unlinkSync(approvalFile); } catch { return false; }
  return true;
}

function redirectWithCode(request, res) {
  const code = randomToken();
  pendingCodes.set(createHash('sha256').update(code).digest('hex'), { ...request, exp: Date.now() + 90000 });
  const target = new URL(request.redirect);
  target.searchParams.set('code', code);
  if (request.state) target.searchParams.set('state', request.state);
  target.searchParams.set('iss', baseUrl);
  res.set('Cache-Control', 'no-store').redirect(302, target.toString());
}

app.use((req, res, next) => {
  const requestedHost = req.headers.host;
  if (requestedHost !== new URL(baseUrl).host && requestedHost !== `${host}:${port}`) {
    return res.status(421).end();
  }
  const origin = req.headers.origin;
  if (origin && origin !== baseUrl && origin !== 'https://chatgpt.com') {
    return res.status(403).end();
  }
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.get('/catalog', (_req, res) => res.json(catalog.publicCatalog));
const protectedMetadata = {
  resource,
  authorization_servers: [baseUrl],
  scopes_supported: supportedScopes,
};
app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
  (_req, res) => res.json(protectedMetadata));
app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json({
  issuer: baseUrl,
  authorization_endpoint: `${baseUrl}/authorize`,
  token_endpoint: `${baseUrl}/token`,
  registration_endpoint: `${baseUrl}/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
  scopes_supported: supportedScopes,
  authorization_response_iss_parameter_supported: true,
}));

app.post('/register', (req, res) => {
  const body = req.body;
  if (!body || !Array.isArray(body.redirect_uris) || body.redirect_uris.length < 1 ||
      body.redirect_uris.length > 3 || !body.redirect_uris.every(officialRedirect) ||
      (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none')) {
    return oauthError(res, 400, 'invalid_client_metadata', 'Unsupported redirect URI or client metadata');
  }
  const now = Date.now();
  const clientId = signed({ type: 'client', iss: baseUrl, redirects: body.redirect_uris,
    iat: now, exp: now + 365 * 86400000, nonce: randomToken() });
  jsonNoStore(res, 201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(now / 1000),
    client_secret_expires_at: 0,
    redirect_uris: body.redirect_uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
});

function authParams(query) {
  const client = clientFromId(query.client_id);
  const scope = normalizeScopes(query.scope ?? defaultScope);
  if (!client || query.response_type !== 'code' || !client.redirects.includes(query.redirect_uri) ||
      query.code_challenge_method !== 'S256' ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(query.code_challenge || '') ||
      (query.resource && query.resource !== resource) ||
      !scope ||
      (query.state && (typeof query.state !== 'string' || query.state.length > 500))) return null;
  return { clientId: query.client_id, redirect: query.redirect_uri,
    challenge: query.code_challenge, state: query.state || '', scope, exp: Date.now() + 300000 };
}

app.get('/authorize', (req, res) => {
  const request = authParams(req.query);
  if (!request) return res.status(400).type('text').send('Invalid authorization request');
  prunePending();
  if (consumeLocalApproval(request)) return redirectWithCode(request, res);
  if (pendingAuth.size >= 50) return res.status(429).end();
  const id = randomToken();
  pendingAuth.set(id, { ...request, attempts: 0 });
  res.set('Cache-Control', 'no-store');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorize OpenCLI</title><body style="font:16px sans-serif;max-width:28rem;margin:4rem auto"><h1>Authorize OpenCLI</h1><p>Grant ChatGPT access to the configured OpenCLI tools: <code>${request.scope}</code>.</p><form method="post" action="/authorize"><input type="hidden" name="request_id" value="${id}"><label>Connection password <input type="password" name="password" required autofocus autocomplete="off"></label><p><button type="submit">Authorize</button></p></form></body></html>`);
});

app.post('/authorize', (req, res) => {
  const id = req.body?.request_id;
  const pending = pendingAuth.get(id);
  if (!pending || pending.exp < Date.now() || pending.attempts >= 5) {
    return res.status(400).type('text').send('Authorization request expired');
  }
  pending.attempts++;
  const candidate = typeof req.body.password === 'string' ? Buffer.from(req.body.password) : Buffer.alloc(0);
  const expected = Buffer.from(password);
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    return res.status(401).type('text').send('Invalid connection password');
  }
  pendingAuth.delete(id);
  redirectWithCode(pending, res);
});

function issueTokens(res, clientId, scope) {
  const now = Date.now();
  const common = { iss: baseUrl, aud: resource, cid: clientId, scope };
  const refreshId = randomToken();
  refreshState[refreshId] = now + 30 * 86400000;
  saveRefreshState();
  jsonNoStore(res, 200, {
    access_token: signed({ ...common, type: 'access', exp: now + 3600000, jti: randomToken() }),
    refresh_token: signed({ ...common, type: 'refresh', exp: refreshState[refreshId], jti: refreshId }),
    token_type: 'Bearer',
    expires_in: 3600,
    scope,
  });
}

app.post('/token', (req, res) => {
  const body = req.body || {};
  if (!clientFromId(body.client_id)) return oauthError(res, 401, 'invalid_client', 'Unknown client');
  if (body.grant_type === 'authorization_code') {
    const hash = createHash('sha256').update(String(body.code || '')).digest('hex');
    const pending = pendingCodes.get(hash);
    pendingCodes.delete(hash);
    if (!pending || pending.exp < Date.now() || pending.clientId !== body.client_id ||
        pending.redirect !== body.redirect_uri || typeof body.code_verifier !== 'string' ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier) ||
        createHash('sha256').update(body.code_verifier).digest('base64url') !== pending.challenge ||
        (body.resource && body.resource !== resource)) {
      return oauthError(res, 400, 'invalid_grant', 'Invalid authorization code or PKCE verifier');
    }
    return issueTokens(res, body.client_id, pending.scope || defaultScope);
  }
  if (body.grant_type === 'refresh_token') {
    const refresh = verifySigned(body.refresh_token, 'refresh');
    if (!refresh || refresh.cid !== body.client_id || refresh.aud !== resource ||
        !normalizeScopes(refresh.scope) ||
        refreshState[refresh.jti] !== refresh.exp ||
        (body.resource && body.resource !== resource)) {
      return oauthError(res, 400, 'invalid_grant', 'Invalid refresh token');
    }
    delete refreshState[refresh.jti];
    return issueTokens(res, body.client_id, refresh.scope);
  }
  oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
});

function requireAccess(req, res, next) {
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
  const token = match && verifySigned(match[1], 'access');
  const scope = token && normalizeScopes(token.scope);
  if (!token || token.aud !== resource || !scope) {
    return res.status(401).set('WWW-Authenticate',
      `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="${defaultScope}"`).end();
  }
  req.accessToken = { ...token, scope };
  next();
}

async function runCli(adapter, tool, args, tokenId) {
  const now = Date.now();
  if (now >= nextUsagePruneAt) {
    for (const [id, usage] of toolUsage) if (now - usage.start >= 3600000) toolUsage.delete(id);
    nextUsagePruneAt = now + 60000;
  }
  const usage = toolUsage.get(tokenId) || { start: now, count: 0 };
  if (now - usage.start >= 3600000) { usage.start = now; usage.count = 0; }
  if (usage.count >= 60) throw new Error('Hourly tool limit reached');
  if (activeCli) throw new Error('Another OpenCLI command is running; retry shortly');
  usage.count++;
  toolUsage.set(tokenId, usage);
  activeCli = true;
  try {
    const { stdout } = await execFileAsync(opencli,
      [adapter.cliSite, tool.command, '-f', 'json', ...adapter.sessionArgs, ...tool.buildArgs(args)],
      { timeout: 60000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    const value = JSON.parse(stdout);
    const result = JSON.stringify(value);
    if (result.length > 120000) throw new Error('Result exceeds 120 KB limit');
    return { content: [{ type: 'text', text: result }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: String(error.stderr || error.message).slice(0, 500) }] };
  } finally { activeCli = false; }
}

function createServer(token) {
  const server = new McpServer({ name: 'OpenCLI', version: '2.0.0' });
  const scopes = new Set(token.scope.split(' '));
  const legacyXhsOnly = scopes.size === 1 && scopes.has('xhs:read');
  for (const adapter of catalog.adapters) {
    for (const tool of adapter.tools) {
      if (!scopes.has(`${adapter.scope}:${tool.access}`)) continue;
      const name = legacyXhsOnly && adapter.id === 'xiaohongshu' && tool.legacyName
        ? tool.legacyName : tool.publicName;
      server.registerTool(name, {
        title: tool.title,
        description: `${tool.description} Requires ${adapter.scope}:${tool.access}.`,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.access === 'read', destructiveHint: tool.access === 'write', openWorldHint: true },
      }, async args => runCli(adapter, tool, args, token.jti));
    }
  }
  return server;
}

app.post('/mcp', requireAccess, async (req, res) => {
  const server = createServer(req.accessToken);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) res.status(500).end();
  } finally {
    await transport.close();
    await server.close();
  }
});
app.get('/mcp', requireAccess, (_req, res) => res.set('Allow', 'POST').status(405).end());
app.all('/mcp', (_req, res) => res.set('Allow', 'POST').status(405).end());

app.listen(port, host, () => console.log(`OpenCLI MCP listening on ${host}:${port}`));

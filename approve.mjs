import { randomBytes } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { loadCatalog } from './catalog.mjs';

const baseUrl = process.env.MCP_BASE_URL?.replace(/\/$/, '');
const stateFile = process.env.MCP_STATE_FILE;
const { supportedScopes, defaultScope } = await loadCatalog();
if (!baseUrl?.startsWith('https://') || !stateFile) {
  throw new Error('MCP_BASE_URL and MCP_STATE_FILE are required');
}

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 8192) throw new Error('Authorization URL is too long');
}
const url = new URL(input.trim());
if (url.origin !== baseUrl || url.pathname !== '/authorize' || url.username || url.password || url.hash) {
  throw new Error('Expected an authorization URL from this MCP server');
}

function one(name) {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || !values[0]) throw new Error(`Missing or repeated ${name}`);
  return values[0];
}

function optional(name) {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new Error(`Repeated ${name}`);
  return values.length ? values[0] : null;
}

const redirect = one('redirect_uri');
const callback = new URL(redirect);
if (callback.origin !== 'https://chatgpt.com' || callback.username || callback.password ||
    callback.search || callback.hash ||
    (callback.pathname !== '/connector_platform_oauth_redirect' &&
     !/^\/connector\/oauth\/[A-Za-z0-9_-]{1,100}$/.test(callback.pathname))) {
  throw new Error('Unsupported ChatGPT redirect URI');
}
const requestedScopes = (optional('scope') ?? defaultScope).trim().split(/\s+/);
const requestedResource = optional('resource');
if (one('response_type') !== 'code' || one('code_challenge_method') !== 'S256' ||
    (requestedResource && requestedResource !== `${baseUrl}/mcp`) ||
    new Set(requestedScopes).size !== requestedScopes.length ||
    requestedScopes.some(scope => !supportedScopes.includes(scope))) {
  throw new Error('Unexpected OAuth request parameters');
}

const approval = {
  clientId: one('client_id'),
  redirect,
  challenge: one('code_challenge'),
  state: optional('state') || '',
  scope: supportedScopes.filter(scope => requestedScopes.includes(scope)).join(' '),
  exp: Date.now() + 60000,
};
if (!/^[A-Za-z0-9_-]{43,128}$/.test(approval.challenge) || approval.state.length > 500) {
  throw new Error('Invalid OAuth challenge or state');
}

const approvalFile = `${stateFile}.approval`;
const temporary = `${approvalFile}.${randomBytes(8).toString('hex')}.tmp`;
try {
  writeFileSync(temporary, JSON.stringify(approval), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, approvalFile);
} finally {
  try { unlinkSync(temporary); } catch { /* Renamed or not created. */ }
}
console.log('One-time local OAuth approval is ready for 60 seconds. Reload the authorization tab.');

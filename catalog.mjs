import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod/v4';

const execFileAsync = promisify(execFile);
const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const argumentName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const toolName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const urlRule = z.object({
  hostname: z.string().min(1),
  pathnamePattern: z.string().max(256),
  requiredQuery: z.array(z.string().min(1)).default([]),
}).strict();
const argumentRule = z.object({
  publicName: argumentName.optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  minLength: z.number().int().min(0).max(10000).optional(),
  maxLength: z.number().int().min(1).max(10000).optional(),
  pattern: z.string().max(256).optional(),
  url: urlRule.optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
}).strict();
const selectionSchema = z.object({
  enabled: z.boolean(),
  access: z.enum(['read', 'readwrite']),
  tools: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1),
  scope: identifier.optional(),
  names: z.record(z.string(), toolName).default({}),
  legacyNames: z.record(z.string(), toolName).default({}),
  session: z.object({
    mode: z.enum(['persistent', 'ephemeral']),
    keepTab: z.boolean(),
    window: z.enum(['foreground', 'background']).optional(),
  }).strict().optional(),
  rules: z.record(z.string(), z.record(z.string(), argumentRule)).default({}),
}).strict();
const configSchema = z.object({
  version: z.literal(1),
  adapters: z.record(identifier, selectionSchema),
}).strict();

function checkedUrl(value, rule) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== rule.hostname || url.port ||
        url.username || url.password ||
        !new RegExp(rule.pathnamePattern, 'i').test(url.pathname) ||
        rule.requiredQuery.some(name => !url.searchParams.get(name))) return null;
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

function schemaFor(spec, rule, context) {
  const stringType = ['str', 'string'].includes(spec.type);
  const numberType = ['int', 'float', 'number'].includes(spec.type);
  if ((rule.pattern || rule.url || rule.minLength !== undefined || rule.maxLength !== undefined) && !stringType) {
    throw new Error(`String rule applied to non-string argument ${context}`);
  }
  if ((rule.min !== undefined || rule.max !== undefined) && !numberType) {
    throw new Error(`Numeric rule applied to non-numeric argument ${context}`);
  }
  let schema;
  switch (spec.type) {
    case 'str': case 'string': schema = z.string().min(rule.minLength ?? 0).max(rule.maxLength ?? 10000); break;
    case 'int': schema = z.number().int(); break;
    case 'float': case 'number': schema = z.number().finite(); break;
    case 'bool': case 'boolean': schema = z.boolean(); break;
    default: throw new Error(`Unsupported OpenCLI argument type ${context}: ${spec.type}`);
  }
  if (rule.pattern) schema = schema.regex(new RegExp(rule.pattern));
  if (rule.url) schema = schema.url().refine(value => checkedUrl(value, rule.url) !== null, 'Invalid URL');
  if (rule.min !== undefined) schema = schema.min(rule.min);
  if (rule.max !== undefined) schema = schema.max(rule.max);
  if (Array.isArray(spec.choices) && spec.choices.length) {
    const values = spec.choices.map(value => {
      if (numberType) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || (spec.type === 'int' && !Number.isInteger(numeric))) {
          throw new Error(`Invalid numeric choice for ${context}`);
        }
        return numeric;
      }
      if (stringType) return String(value);
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw new Error(`Invalid boolean choice for ${context}`);
    });
    const choices = stringType
      ? z.enum(values)
      : values.length === 1
        ? z.literal(values[0])
        : z.union(values.map(value => z.literal(value)));
    schema = schema.and(choices);
  }
  const urlDescription = rule.url ?
    `HTTPS host: ${rule.url.hostname}; path: ${rule.url.pathnamePattern}; required query: ${rule.url.requiredQuery.join(', ') || 'none'}.` : '';
  const description = [spec.help, urlDescription, spec.choices?.length ? `Choices: ${spec.choices.join(', ')}` : '']
    .filter(Boolean).join(' ');
  if (description) schema = schema.describe(description);
  if (rule.default !== undefined) {
    if (!schema.safeParse(rule.default).success) throw new Error(`Invalid default for ${context}`);
    return schema.default(rule.default);
  }
  return spec.required ? schema : schema.optional();
}

function buildCliArgs(specs, rules, args) {
  const positionals = [];
  const options = [];
  let missingPositional = false;
  for (const spec of specs) {
    const rule = rules[spec.name] || {};
    const value = args[rule.publicName || spec.name];
    if (spec.positional) {
      if (value === undefined) { missingPositional = true; continue; }
      if (missingPositional) throw new Error(`Cannot skip a positional argument before ${spec.name}`);
      positionals.push(rule.url ? checkedUrl(value, rule.url) : String(value));
      continue;
    }
    if (value === undefined) continue;
    if (spec.type === 'bool' || spec.type === 'boolean') {
      if (spec.valueRequired) options.push(`--${spec.name}=${value}`);
      else if (value) options.push(`--${spec.name}`);
      else if (spec.default === true) throw new Error(`Cannot disable ${spec.name} through this OpenCLI flag`);
    } else options.push(`--${spec.name}=${rule.url ? checkedUrl(value, rule.url) : String(value)}`);
  }
  return [...options, ...(positionals.length ? ['--', ...positionals] : [])];
}

function compileTool(adapterId, command, selection) {
  const rules = selection.rules[command.name] || {};
  const specs = command.args || [];
  if (!Array.isArray(specs)) throw new Error(`Invalid OpenCLI arguments for ${adapterId}/${command.name}`);
  const specNames = new Set(specs.map(spec => spec.name));
  if (specNames.size !== specs.length || Object.keys(rules).some(name => !specNames.has(name))) {
    throw new Error(`Unknown or duplicate argument in ${adapterId}/${command.name}`);
  }
  const inputSchema = {};
  for (const spec of specs) {
    argumentName.parse(spec.name);
    const rule = rules[spec.name] || {};
    const publicName = rule.publicName || spec.name;
    if (inputSchema[publicName]) throw new Error(`Duplicate public argument ${adapterId}/${command.name}.${publicName}`);
    if (rule.pattern) new RegExp(rule.pattern);
    if (rule.url) new RegExp(rule.url.pathnamePattern, 'i');
    inputSchema[publicName] = schemaFor(spec, rule, `${adapterId}/${command.name}.${spec.name}`);
  }
  const publicName = selection.names[command.name] ||
    `${/^[a-z]/.test(adapterId) ? '' : 'opencli_'}${adapterId}_${command.name.replace(/-/g, '_')}`;
  toolName.parse(publicName);
  return {
    name: command.name,
    publicName,
    legacyName: selection.legacyNames[command.name],
    title: `${adapterId} ${command.name}`,
    description: command.description || `Run OpenCLI ${adapterId}/${command.name}`,
    access: command.access,
    command: command.name,
    inputSchema,
    rules,
    buildArgs: args => buildCliArgs(specs, rules, args),
  };
}

export async function loadCatalog(configFile = process.env.MCP_CONFIG_FILE || './config.json',
  opencli = process.env.OPENCLI_BIN || 'opencli') {
  const config = configSchema.parse(JSON.parse(readFileSync(resolve(configFile), 'utf8')));
  const { stdout } = await execFileAsync(opencli, ['list', '-f', 'json'],
    { timeout: 15000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
  const discovered = JSON.parse(stdout);
  if (!Array.isArray(discovered)) throw new Error('OpenCLI command catalog is not an array');
  const commands = new Map();
  for (const entry of discovered) {
    if (entry && typeof entry.site === 'string' && typeof entry.name === 'string' &&
        ['read', 'write'].includes(entry.access)) {
      const key = `${entry.site}/${entry.name}`;
      if (commands.has(key)) throw new Error(`Duplicate OpenCLI command: ${key}`);
      commands.set(key, entry);
    }
  }

  const adapters = [];
  const publicNames = new Set();
  const scopePrefixes = new Set();
  for (const [id, selection] of Object.entries(config.adapters)) {
    if (!selection.enabled) continue;
    const scope = selection.scope || id;
    if (scopePrefixes.has(scope)) throw new Error(`Duplicate scope prefix: ${scope}`);
    scopePrefixes.add(scope);
    if (new Set(selection.tools).size !== selection.tools.length) throw new Error(`Duplicate selected command in ${id}`);
    for (const key of ['names', 'legacyNames', 'rules']) {
      if (Object.keys(selection[key]).some(name => !selection.tools.includes(name))) {
        throw new Error(`Unknown command in ${id}.${key}`);
      }
    }
    const tools = [];
    for (const name of selection.tools) {
      const command = commands.get(`${id}/${name}`);
      if (!command) throw new Error(`OpenCLI command not installed: ${id}/${name}`);
      if (command.command !== `${id}/${name}`) throw new Error(`Invalid OpenCLI command identity: ${id}/${name}`);
      if (command.access === 'write' && selection.access === 'read') continue;
      const tool = compileTool(id, command, selection);
      if (publicNames.has(tool.publicName)) throw new Error(`Duplicate public tool: ${tool.publicName}`);
      publicNames.add(tool.publicName);
      tools.push(tool);
    }
    if (!tools.some(tool => tool.access === 'read')) throw new Error(`Adapter ${id} must select a read command`);
    if (selection.access === 'readwrite' && !tools.some(tool => tool.access === 'write')) {
      throw new Error(`Adapter ${id} is readwrite but has no selected write command`);
    }
    const registeredNames = new Set();
    for (const tool of tools) {
      const name = tool.legacyName || tool.publicName;
      if (registeredNames.has(name)) throw new Error(`Duplicate legacy tool name in ${id}: ${name}`);
      registeredNames.add(name);
    }
    const sessionArgs = selection.session ?
      ['--site-session', selection.session.mode, '--keep-tab', String(selection.session.keepTab),
        ...(selection.session.window ? ['--window', selection.session.window] : [])] : [];
    adapters.push({ id, scope, cliSite: id, sessionArgs, tools });
  }
  if (!adapters.length) throw new Error('At least one adapter must be enabled');
  const supportedScopes = adapters.flatMap(adapter => [
    `${adapter.scope}:read`,
    ...(adapter.tools.some(tool => tool.access === 'write') ? [`${adapter.scope}:write`] : []),
  ]);
  const defaultScope = adapters.map(adapter => `${adapter.scope}:read`).join(' ');
  const publicCatalog = {
    name: 'OpenCLI', version: config.version, scopes: supportedScopes,
    adapters: adapters.map(adapter => ({
      id: adapter.id,
      access: adapter.tools.some(tool => tool.access === 'write') ? 'readwrite' : 'read',
      tools: adapter.tools.map(tool => ({
        name: tool.publicName,
        command: `${adapter.id}/${tool.command}`,
        description: tool.description,
        access: tool.access,
        scope: `${adapter.scope}:${tool.access}`,
        inputSchema: z.toJSONSchema(z.object(tool.inputSchema), { io: 'input' }),
        ...(Object.keys(tool.rules).length ? { rules: tool.rules } : {}),
      })),
    })),
  };
  return { adapters, supportedScopes, defaultScope, publicCatalog };
}

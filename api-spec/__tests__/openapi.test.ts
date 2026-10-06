import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Keeps api-spec/openapi.yaml honest about the ported routes: every route
 * handler is documented, nothing is documented that has no handler, auth
 * declarations match the handlers, and every status a handler can return is
 * listed in the spec.
 */

interface Operation {
  operationId: string;
  security?: Array<Record<string, unknown>>;
  responses: Record<string, unknown>;
}

type Spec = {
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
};

const ROOT = join(__dirname, '..', '..');
const API_DIR = join(ROOT, 'app', 'api');
const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
// `@ima-jin/auth-client` handler wrappers (kernel redirect callback, logout, session): thin SDK
// delegations that are part of "Sign in with Imajin", not this app's API surface.
const SDK_ROUTE_PREFIX = `auth${sep}`;

const spec = parse(readFileSync(join(ROOT, 'api-spec', 'openapi.yaml'), 'utf-8')) as Spec;

function findRouteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : findRouteFiles(full);
    return entry.name === 'route.ts' ? [full] : [];
  });
}

interface Route {
  path: string;
  file: string;
  source: string;
  methods: string[];
}

const routes: Route[] = findRouteFiles(API_DIR)
  .map((file) => relative(API_DIR, file))
  .filter((rel) => !rel.startsWith(SDK_ROUTE_PREFIX))
  .map((rel) => {
    const source = readFileSync(join(API_DIR, rel), 'utf-8');
    const urlPath = `/api/${rel.slice(0, -'/route.ts'.length)}`.replaceAll(sep, '/').replaceAll(/\[(\w+)\]/g, '{$1}');
    const methods = METHODS.filter((method) =>
      new RegExp(String.raw`export (async function|const) ${method}\b`).test(source),
    );
    return { path: urlPath, file: rel, source, methods };
  });

function operationsOf(path: string): Array<[string, Operation]> {
  return Object.entries(spec.paths[path] ?? {}).map(([method, op]) => [method.toUpperCase(), op]);
}

/** Every HTTP status a handler source can return, from errorResponse(..., N), jsonResponse(..., N) and { status: N }. */
function statusesIn(source: string): Set<string> {
  const statuses = new Set<string>();
  for (const match of source.matchAll(/(?:errorResponse|jsonResponse)\((?:[^()]|\([^()]*\))*?,\s*(\d{3})\s*\)/g)) {
    statuses.add(match[1]);
  }
  for (const match of source.matchAll(/status:\s*(\d{3})/g)) {
    statuses.add(match[1]);
  }
  return statuses;
}

describe('api-spec/openapi.yaml', () => {
  it('discovers the ported route handlers', () => {
    expect(routes.map((r) => r.path).sort()).toEqual([
      '/api/checkout',
      '/api/health',
      '/api/me',
      '/api/pages',
      '/api/pages/mine',
      '/api/pages/{handle}',
      '/api/spec',
      '/api/tip',
      '/api/tips/{did}',
      '/api/webhook/payment',
    ]);
  });

  it.each(routes)('documents every method exported by $file', ({ path, methods }) => {
    expect(methods.length).toBeGreaterThan(0);
    expect(operationsOf(path).map(([method]) => method).sort()).toEqual([...methods].sort());
  });

  it('documents no path that has no route handler', () => {
    const handled = new Set(routes.map((r) => r.path));

    expect(Object.keys(spec.paths).filter((path) => !handled.has(path))).toEqual([]);
  });

  it('uses unique operationIds', () => {
    const ids = Object.values(spec.paths).flatMap((ops) => Object.values(ops).map((op) => op.operationId));

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares only security schemes that exist', () => {
    const declared = Object.values(spec.paths).flatMap((ops) =>
      Object.values(ops).flatMap((op) => (op.security ?? []).flatMap((requirement) => Object.keys(requirement))),
    );

    for (const scheme of declared) {
      expect(Object.keys(spec.components.securitySchemes)).toContain(scheme);
    }
  });

  it.each(routes)('declares app-token auth exactly where $file authenticates callers', ({ path, source, methods }) => {
    for (const method of methods) {
      const op = spec.paths[path][method.toLowerCase()];
      const schemes = (op.security ?? []).flatMap((requirement) => Object.keys(requirement));
      const handler = source.slice(source.indexOf(`function ${method}`));
      const nextHandler = handler.slice(1).search(/export (async function|const) (GET|POST|PUT|DELETE)\b/);
      const body = nextHandler === -1 ? handler : handler.slice(0, nextHandler + 1);

      if (/\bauthenticate\(/.test(body)) {
        expect(schemes, `${method} ${path}`).toContain('bearerAuth');
        expect(schemes, `${method} ${path}`).toContain('cookieAuth');
        expect(Object.keys(op.responses), `${method} ${path}`).toContain('401');
      } else if (/optionalCallerDid\(/.test(body)) {
        expect(schemes, `${method} ${path}`).toContain('bearerAuth');
        expect(schemes, `${method} ${path}`).toContainEqual(expect.anything());
      } else {
        expect(schemes, `${method} ${path}`).not.toContain('bearerAuth');
      }
    }
  });

  it.each(routes)('documents every status code $file can return', ({ path, source, methods }) => {
    const documented = new Set(operationsOf(path).flatMap(([, op]) => Object.keys(op.responses)));

    for (const status of statusesIn(source)) {
      // Statuses surfaced through the shared authenticate() failure are covered by the 401 check above;
      // the webhook route's own 401/500 are literal `status:` values and are caught here.
      expect(documented, `${path} returns ${status}`).toContain(status);
    }
    expect(methods.length).toBeGreaterThan(0);
  });

  it.each(routes)('documents a success response for every method of $file', ({ path }) => {
    for (const [method, op] of operationsOf(path)) {
      expect(Object.keys(op.responses).some((status) => status.startsWith('2')), `${method} ${path}`).toBe(true);
    }
  });

  it('resolves every $ref to a defined schema', () => {
    const text = readFileSync(join(ROOT, 'api-spec', 'openapi.yaml'), 'utf-8');
    const refs = [...text.matchAll(/\$ref:\s*"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]);

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(Object.keys(spec.components.schemas)).toContain(ref);
    }
  });
});

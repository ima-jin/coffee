import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DELEGATION_EXCEPTIONS, DELEGATION_ROUTES } from '@/lib/delegation-policy';

const ROOT = resolve(__dirname, '../../..');
const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function routes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routes(path);
    return entry.name === 'route.ts' ? [path] : [];
  });
}

/** AST inventory includes function declarations, wrappers, SDK handlers, and re-exports. */
function exportedMutations(file: string) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const handlers: { method: string; path: string; source: string }[] = [];
  const path = `/${relative(join(ROOT, 'app'), file).replaceAll('\\', '/').slice(0, -'/route.ts'.length)}`;
  const localFunctions = source.statements.filter(ts.isFunctionDeclaration);
  function add(method: string, node: ts.Node) {
    if (!MUTATIONS.has(method)) return;
    let text = node.getText(source);
    for (const helper of localFunctions) {
      if (helper.name && text.includes(`${helper.name.text}(`)) text += `\n${helper.getText(source)}`;
    }
    handlers.push({ method, path, source: text });
  }
  for (const node of source.statements) {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) add(element.name.text, node);
    }
    if (!ts.canHaveModifiers(node) || !ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(node) && node.name) add(node.name.text, node);
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) add(declaration.name.text, declaration);
      }
    }
  }
  return handlers;
}

const handlers = routes(join(ROOT, 'app')).flatMap(exportedMutations);
const inventory = [...Object.values(DELEGATION_ROUTES), ...DELEGATION_EXCEPTIONS];
const signature = (entry: { method: string; path: string }) => `${entry.method} ${entry.path}`;
const REQUIRED_AUTH = /\b(?:authenticate)\s*\(/;
const OPTIONAL_AUTH = /\b(?:optionalAuthenticate)\s*\(/;

describe('delegation mutation coverage (#26)', () => {
  it('discovers a nonempty mutation inventory', () => {
    expect(handlers.length).toBeGreaterThanOrEqual(8);
  });

  it.each(handlers)('$method $path has exactly one classification or documented exception', (handler) => {
    expect(inventory.filter((entry) => signature(entry) === signature(handler))).toHaveLength(1);
  });

  it.each(inventory)('$method $path points at exactly one real exported handler', (entry) => {
    expect(entry.why.length).toBeGreaterThan(10);
    expect(handlers.filter((handler) => signature(handler) === signature(entry))).toHaveLength(1);
  });

  it.each(Object.values(DELEGATION_ROUTES))('$method $path reaches the policy auth boundary', (entry) => {
    const handler = handlers.find((candidate) => signature(candidate) === signature(entry));
    expect(handler).toBeDefined();
    const allowedAuth = entry.class === 'reversible' ? new RegExp(`${REQUIRED_AUTH.source}|${OPTIONAL_AUTH.source}`) : REQUIRED_AUTH;
    expect(handler?.source).toMatch(allowedAuth);
  });

  it('keeps the shared auth boundary connected to the SDK policy and complete responses', () => {
    const auth = readFileSync(join(ROOT, 'src/lib/auth/authenticate.ts'), 'utf8');
    expect(auth).toContain('await evaluateCoffeeDelegationPolicy(request, { id: auth.did, actingFor: auth.actingFor })');
    expect(auth).toContain('return authorizeMutation(request, result.auth)');
    expect(auth).toContain("return authorizeMutation(request, { did, scopes: [], via: 'session' })");
    expect(auth).toContain('result.proposal ?? { error: result.error }');
    expect(auth).toContain('const result = await authenticate(request)');
    expect(auth).toContain("if ('error' in result && result.status === 401) return { auth: null }");
    for (const entry of Object.values(DELEGATION_ROUTES)) {
      const handler = handlers.find((candidate) => signature(candidate) === signature(entry));
      expect(handler?.source).toContain('return authErrorResponse(authResult)');
    }
  });
});

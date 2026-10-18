import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from 'vitest';
const root = dirname(fileURLToPath(import.meta.url));
const allowed: Record<string, string[]> = {
	domain: ['domain'],
	application: ['application', 'domain'],
	api: ['api', 'application', 'domain'],
	infrastructure: ['infrastructure', 'api', 'application', 'domain']
};
function sources(layer: string) {
	return readdirSync(resolve(root, layer)).filter(
		(name) => name.endsWith('.ts') && !name.endsWith('.test.ts')
	);
}
function imports(source: string) {
	return [...source.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)].map(
		(match) => match[1]
	);
}
function checkImport(layer: string, file: string, specifier: string) {
	if (!specifier.startsWith('.')) {
		return;
	}
	const target = relative(root, resolve(root, layer, dirname(file), specifier));
	checkTarget(layer, file, target);
}
function checkTarget(layer: string, file: string, target: string) {
	if (target.startsWith('../')) {
		expect(target.startsWith('../../shared/')).toBe(true);
		return;
	}
	expect(allowed[layer], `${layer}/${file} imports ${target}`).toContain(
		target.split('/')[0]
	);
}
for (const layer of Object.keys(allowed)) {
	test(layer + ' respects the dependency direction', () => {
		for (const file of sources(layer)) {
			const source = readFileSync(resolve(root, layer, file), 'utf8');
			for (const specifier of imports(source)) {
				checkImport(layer, file, specifier);
			}
		}
	});
}
test.each(['domain', 'application'])(
	'%s does not depend on HTTP or Cloudflare runtime APIs',
	(layer) => {
		for (const file of sources(layer)) {
			const source = readFileSync(resolve(root, layer, file), 'utf8');
			expect(source, file).not.toMatch(
				/\b(?:Request|Response|DurableObjectState|DurableObjectStorage|WebSocketPair|Bindings)\b|from ['"](?:hono|cloudflare:)/
			);
		}
	}
);

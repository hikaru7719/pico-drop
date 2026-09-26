import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { expect, test } from 'vitest';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const document = new Window().document;
document.write(html);

test('navigation fragment links resolve to document sections', () => {
	const links = document.querySelectorAll('a[href^="#"]:not([href="#"])');
	expect(links.length).toBeGreaterThan(0);
	for (const link of links) {
		const id = link.getAttribute('href')!.slice(1);
		expect(document.getElementById(id), `Missing anchor: ${id}`).not.toBeNull();
	}
});
test('document IDs are unique', () => {
	const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
	expect(new Set(ids).size).toBe(ids.length);
});
test('accessible labels reference existing elements', () => {
	for (const node of document.querySelectorAll('[aria-labelledby]')) {
		for (const id of node.getAttribute('aria-labelledby')!.split(/\s+/)) {
			expect(document.getElementById(id)).not.toBeNull();
		}
	}
});

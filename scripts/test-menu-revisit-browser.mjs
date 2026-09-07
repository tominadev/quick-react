import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const output = resolve(import.meta.dirname, '../dist/menu-revisit-test.mjs');
await build({
	entryPoints: [resolve(import.meta.dirname, 'test-menu-revisit-browser.tsx')],
	bundle: true,
	packages: 'external',
	platform: 'node',
	format: 'esm',
	outfile: output,
	alias: { '@': resolve(import.meta.dirname, '../clients/antd'), '@clients': resolve(import.meta.dirname, '../clients'), '@shared': resolve(import.meta.dirname, '../shared') },
	resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mts', '.mjs', '.json'],
});
await import(`${pathToFileURL(output)}?test=${Date.now()}`);
process.exit(0);

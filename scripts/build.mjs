import { build } from 'esbuild';
import { rm, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });

const common = {
	bundle: true,
	platform: 'node',
	target: 'node18',
	legalComments: 'eof',
	logLevel: 'info'
};

const entries = [
	['src/index.js', 'dist/index'],
	['src/buble-plugin.js', 'dist/plugin']
];

for (const [entry, out] of entries) {
	await build({ ...common, entryPoints: [entry], format: 'cjs', outfile: `${out}.cjs` });
}

// esbuild only exposes `default` for our CJS entry; thin ESM wrappers restore
// the named exports (and keep `default` = rollup function / buble plugin)
await writeFile(
	'dist/index.mjs',
	`import mod from './index.cjs';

export const rollup = mod.rollup;
export const VERSION = mod.VERSION;
export const Bundle = mod.Bundle;
export default mod.rollup;
`
);
await writeFile(
	'dist/plugin.mjs',
	`import buble from './plugin.cjs';

export default buble;
`
);

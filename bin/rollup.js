#!/usr/bin/env node
'use strict';

/**
 * rollup CLI drop-in: supports `rollup -c <config>` (ESM/CJS configs),
 * `-o/--file`, `-f/--format`, `--dir`, `--silent`, `-v`, `-h`.
 * Imports of `rollup` and `@rollup/plugin-buble` inside the config are
 * internally redirected to this package so configs run unmodified.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const pkg = require('../package.json');

const HELP = `rollup (buble-rollup ${pkg.version})
Usage: rollup -c <config> [options]

Options:
  -c, --config <file>      Use specified config file
  -o, --file <file>        Output file (overrides output.file)
  -d, --dir <directory>    Output directory (overrides output.dir)
  -f, --format <format>    Output format (es, cjs, iife, umd, amd)
      --silent             Suppress warnings
  -v, --version            Print version
  -h, --help               Print help
`;

function parseArgs(argv) {
	const opts = {
		config: null,
		file: null,
		dir: null,
		format: null,
		silent: false,
		help: false,
		version: false,
		unknown: []
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v == null) {
				console.error(`rollup: missing value for ${arg}`);
				process.exit(1);
			}
			return v;
		};
		if (arg === '-h' || arg === '--help') opts.help = true;
		else if (arg === '-v' || arg === '--version') opts.version = true;
		else if (arg === '-c' || arg === '--config') opts.config = next();
		else if (arg.startsWith('--config=')) opts.config = arg.slice('--config='.length);
		else if (arg === '-o' || arg === '--file') opts.file = next();
		else if (arg.startsWith('--file=')) opts.file = arg.slice('--file='.length);
		else if (arg === '-d' || arg === '--dir') opts.dir = next();
		else if (arg.startsWith('--dir=')) opts.dir = arg.slice('--dir='.length);
		else if (arg === '-f' || arg === '--format') opts.format = next();
		else if (arg.startsWith('--format=')) opts.format = arg.slice('--format='.length);
		else if (arg === '--silent') opts.silent = true;
		else opts.unknown.push(arg);
	}
	return opts;
}

function findConfig() {
	for (const candidate of ['rollup.config.mjs', 'rollup.config.js', 'rollup.config.cjs']) {
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

const REDIRECTS = [
	{ bare: 'rollup', cjsPath: path.join(__dirname, '../src/index.js'), esmUrl: pathToFileURL(path.join(__dirname, '../index.mjs')).href },
	{
		bare: '@rollup/plugin-buble',
		cjsPath: path.join(__dirname, '../src/buble-plugin.js'),
		esmUrl: pathToFileURL(path.join(__dirname, '../plugin.mjs')).href
	},
	{ bare: 'buble-rollup', cjsPath: path.join(__dirname, '../src/index.js'), esmUrl: pathToFileURL(path.join(__dirname, '../index.mjs')).href }
];

/** Rewrite `rollup` / `@rollup/plugin-buble` specifiers to this package. */
function redirectSpecifiers(source) {
	for (const { bare, cjsPath, esmUrl } of REDIRECTS) {
		const q = '(["\'])';
		const esc = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		// require('bare')
		source = source.replace(
			new RegExp(`(require\\s*\\(\\s*)${q}${esc}\\2`, 'g'),
			`$1${JSON.stringify(cjsPath)}`
		);
		// import ... from 'bare' / export ... from 'bare'
		source = source.replace(
			new RegExp(`(\\bfrom\\s*)${q}${esc}\\2`, 'g'),
			`$1${JSON.stringify(esmUrl)}`
		);
		// import 'bare' / import('bare') / export * from already covered by from
		source = source.replace(
			new RegExp(`(\\bimport\\s*\\(\\s*)${q}${esc}\\2`, 'g'),
			`$1${JSON.stringify(esmUrl)}`
		);
		source = source.replace(
			new RegExp(`(\\bimport\\s*)${q}${esc}\\2`, 'g'),
			`$1${JSON.stringify(esmUrl)}`
		);
	}
	return source;
}

function isEsmConfig(filePath, source) {
	if (filePath.endsWith('.mjs')) return true;
	if (filePath.endsWith('.cjs')) return false;
	if (/\b(import|export)\b/.test(source) && !/\brequire\s*\(/.test(source)) return true;
	try {
		let dir = path.dirname(path.resolve(filePath));
		for (;;) {
			const pj = path.join(dir, 'package.json');
			if (fs.existsSync(pj)) {
				return JSON.parse(fs.readFileSync(pj, 'utf8')).type === 'module';
			}
			const parent = path.dirname(dir);
			if (parent === dir) return false;
			dir = parent;
		}
	} catch {
		return false;
	}
}

async function loadConfig(configPath) {
	const abs = path.resolve(configPath);
	const source = fs.readFileSync(abs, 'utf8');
	const redirected = redirectSpecifiers(source);
	const esm = isEsmConfig(abs, source);
	const dir = path.dirname(abs);
	const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp.${esm ? 'mjs' : 'cjs'}`);
	fs.writeFileSync(tmp, redirected);
	try {
		let mod;
		if (esm) {
			mod = await import(pathToFileURL(tmp).href);
		} else {
			delete require.cache[tmp];
			mod = require(tmp);
		}
		const config = mod && mod.default !== undefined ? mod.default : mod;
		return config && typeof config.then === 'function' ? await config : config;
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
	}
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		process.stdout.write(HELP);
		return 0;
	}
	if (opts.version) {
		process.stdout.write(`${pkg.version}\n`);
		return 0;
	}
	const configPath = opts.config || findConfig();
	if (!configPath) {
		console.error('rollup: could not find rollup.config.js, rollup.config.mjs or rollup.config.cjs — use -c <file>');
		process.exit(1);
	}
	if (opts.unknown.length) {
		console.error(`rollup: unknown command line option: ${opts.unknown.join(', ')}`);
		process.exit(1);
	}

	const { rollup } = require('../src/index.js');
	let configs;
	try {
		configs = await loadConfig(configPath);
	} catch (err) {
		console.error(`rollup: failed to load config "${configPath}":\n${err && err.stack ? err.stack : err}`);
		process.exit(1);
	}
	if (!Array.isArray(configs)) configs = [configs];

	for (const config of configs) {
		if (!config || typeof config !== 'object') continue;
		const { output: outputOption, ...inputConfig } = config;
		if (opts.silent) inputConfig.logLevel = 'silent';
		let bundle;
		try {
			bundle = await rollup(inputConfig);
		} catch (err) {
			console.error(formatError(err));
			process.exit(1);
		}
		const outputs = Array.isArray(outputOption)
			? outputOption
			: outputOption
				? [outputOption]
				: [{ format: 'es' }];
		for (const output of outputs) {
			const finalOutput = { ...output };
			if (opts.file) finalOutput.file = opts.file;
			if (opts.dir) finalOutput.dir = opts.dir;
			if (opts.format) finalOutput.format = opts.format;
			try {
				await bundle.write(finalOutput);
			} catch (err) {
				console.error(formatError(err));
				process.exit(1);
			}
		}
		await bundle.close();
	}
	return 0;
}

function formatError(err) {
	if (!err) return String(err);
	const parts = [];
	if (err.code) parts.push(`[!] (${err.code})`);
	if (err.message) parts.push(err.message);
	else parts.push(String(err));
	return parts.join(' ');
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(formatError(err));
		process.exit(1);
	}
);

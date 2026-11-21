'use strict';

const { error } = require('../utils/errors.js');
const { flattenPlugins } = require('./input.js');

const GENERATED_CODE_PRESETS = {
	es2015: {
		arrowFunctions: true,
		constBindings: true,
		objectShorthand: true,
		reservedNamesAsProps: false,
		symbols: true
	},
	es5: {
		arrowFunctions: false,
		constBindings: false,
		objectShorthand: false,
		reservedNamesAsProps: true,
		symbols: false
	}
};

function getFormat(config) {
	const configFormat = config.format;
	switch (configFormat) {
		case undefined:
		case 'es':
		case 'esm':
		case 'module':
			return 'es';
		case 'cjs':
		case 'commonjs':
			return 'cjs';
		case 'system':
		case 'systemjs':
			return 'system';
		case 'amd':
		case 'iife':
		case 'umd':
			return configFormat;
		default:
			return error({
				code: 'INVALID_OPTION',
				message: `Valid values are "amd", "cjs", "system", "es", "iife" or "umd", received ${JSON.stringify(configFormat)}`
			});
	}
}

function getAddon(config, name) {
	const value = config[name];
	if (typeof value === 'function') return value;
	return () => value || '';
}

function getGeneratedCode(config) {
	const value = config.generatedCode;
	let preset = {};
	if (typeof value === 'string') {
		preset = GENERATED_CODE_PRESETS[value] || {};
	} else if (value && typeof value === 'object') {
		if (typeof value === 'object' && GENERATED_CODE_PRESETS[value.preset]) {
			preset = { ...GENERATED_CODE_PRESETS[value.preset] };
		}
		preset = { ...preset, ...value };
	}
	return {
		arrowFunctions: preset.arrowFunctions === true,
		constBindings: preset.constBindings === true,
		objectShorthand: preset.objectShorthand === true,
		reservedNamesAsProps: preset.reservedNamesAsProps !== false,
		symbols: preset.symbols === true
	};
}

function getIndent(config, compact) {
	if (compact) return '';
	const configIndent = config.indent;
	return configIndent === false ? '' : (configIndent ?? true);
}

const ALLOWED_INTEROP_TYPES = new Set(['compat', 'auto', 'esModule', 'default', 'defaultOnly']);

function getInterop(config) {
	const configInterop = config.interop;
	if (typeof configInterop === 'function') {
		const interopPerId = Object.create(null);
		let defaultInterop = null;
		return (id) => {
			if (id === null) {
				if (defaultInterop == null) defaultInterop = validateInterop(configInterop(id));
				return defaultInterop;
			}
			if (id in interopPerId) return interopPerId[id];
			return (interopPerId[id] = validateInterop(configInterop(id)));
		};
	}
	return configInterop === undefined ? () => 'default' : () => validateInterop(configInterop);
}

function validateInterop(interop) {
	if (!ALLOWED_INTEROP_TYPES.has(interop)) {
		return error({
			code: 'INVALID_OPTION',
			message: `use one of ${Array.from(ALLOWED_INTEROP_TYPES, (v) => JSON.stringify(v)).join(', ')}`
		});
	}
	return interop;
}

function getAmd(config) {
	const merged = {
		autoId: false,
		basePath: '',
		define: 'define',
		forceJsExtensionForImports: false,
		...config.amd
	};
	if ((merged.autoId || merged.basePath) && merged.id) {
		error({
			code: 'INVALID_OPTION',
			message: 'output.amd.id cannot be used together with output.amd.autoId/basePath'
		});
	}
	if (merged.basePath && !merged.autoId) {
		error({ code: 'INVALID_OPTION', message: 'output.amd.basePath only works with output.amd.autoId' });
	}
	return merged.autoId
		? {
				autoId: true,
				basePath: merged.basePath,
				define: merged.define,
				forceJsExtensionForImports: merged.forceJsExtensionForImports
			}
		: {
				autoId: false,
				define: merged.define,
				forceJsExtensionForImports: merged.forceJsExtensionForImports,
				id: merged.id
			};
}

const OUTPUT_OPTION_KEYS = new Set([
	'amd',
	'assetFileNames',
	'banner',
	'chunkFileNames',
	'compact',
	'dir',
	'dynamicImportInCjs',
	'entryFileNames',
	'esModule',
	'experimentalMinChunkSize',
	'exports',
	'extend',
	'externalImportAssertions',
	'externalImportAttributes',
	'externalLiveBindings',
	'file',
	'footer',
	'format',
	'freeze',
	'generatedCode',
	'globals',
	'hashCharacters',
	'hoistTransitiveImports',
	'importAttributesKey',
	'indent',
	'inlineDynamicImports',
	'interop',
	'intro',
	'manualChunks',
	'minifyInternalExports',
	'name',
	'noConflict',
	'onlyExplicitManualChunks',
	'outro',
	'paths',
	'plugins',
	'preserveModules',
	'preserveModulesRoot',
	'reexportProtoFromExternal',
	'sanitizeFileName',
	'sourcemap',
	'sourcemapBaseUrl',
	'sourcemapDebugIds',
	'sourcemapExcludeSources',
	'sourcemapFile',
	'sourcemapFileNames',
	'sourcemapIgnoreList',
	'sourcemapPathTransform',
	'strict',
	'systemNullSetters',
	'validate',
	'virtualDirname'
]);

function normalizeOutputOptions(config = {}, inputOptions, unsetInputOptions = new Set()) {
	const unsetOptions = new Set(unsetInputOptions);
	for (const key of Object.keys(config)) {
		if (!OUTPUT_OPTION_KEYS.has(key)) unsetOptions.add(key);
	}

	const compact = config.compact || false;
	const format = getFormat(config);
	const inlineDynamicImports = config.inlineDynamicImports || false;
	const file = config.file;
	const dir = config.dir;
	if (typeof dir === 'string' && typeof file === 'string') {
		error({
			code: 'INVALID_OPTION',
			message:
				'you must set either output.file for a single-file build or output.dir when generating multiple chunks'
		});
	}

	const externalImportAttributes = config.externalImportAttributes ?? config.externalImportAssertions ?? true;

	const options = {
		amd: getAmd(config),
		assetFileNames: config.assetFileNames ?? 'assets/[name]-[hash][extname]',
		banner: getAddon(config, 'banner'),
		chunkFileNames: config.chunkFileNames ?? '[name]-[hash].js',
		compact,
		dir,
		dynamicImportInCjs: config.dynamicImportInCjs ?? true,
		entryFileNames: config.entryFileNames ?? '[name].js',
		esModule: config.esModule ?? 'if-default-prop',
		experimentalMinChunkSize: config.experimentalMinChunkSize ?? 1,
		exports: config.exports ?? 'auto',
		extend: config.extend || false,
		externalImportAttributes,
		externalLiveBindings: config.externalLiveBindings ?? true,
		file,
		footer: getAddon(config, 'footer'),
		format,
		freeze: config.freeze ?? true,
		generatedCode: getGeneratedCode(config),
		globals: config.globals || {},
		hashCharacters: config.hashCharacters ?? 'base64',
		hoistTransitiveImports: config.hoistTransitiveImports ?? true,
		importAttributesKey: config.importAttributesKey ?? 'assert',
		indent: getIndent(config, compact),
		inlineDynamicImports,
		interop: getInterop(config),
		intro: getAddon(config, 'intro'),
		manualChunks: config.manualChunks || {},
		minifyInternalExports: config.minifyInternalExports ?? (compact || format === 'es' || format === 'system'),
		name: config.name,
		noConflict: config.noConflict || false,
		outro: getAddon(config, 'outro'),
		paths: config.paths || {},
		plugins: flattenPlugins(config.plugins),
		preserveModules: config.preserveModules || false,
		preserveModulesRoot: config.preserveModulesRoot ? require('path').resolve(config.preserveModulesRoot) : undefined,
		reexportProtoFromExternal: config.reexportProtoFromExternal ?? true,
		sanitizeFileName:
			typeof config.sanitizeFileName === 'function'
				? config.sanitizeFileName
				: config.sanitizeFileName === false
					? (id) => id
					: require('../utils/ids.js').sanitizeFileName,
		sourcemap: config.sourcemap || false,
		sourcemapBaseUrl: config.sourcemapBaseUrl,
		sourcemapDebugIds: config.sourcemapDebugIds || false,
		sourcemapExcludeSources: config.sourcemapExcludeSources || false,
		sourcemapFile: config.sourcemapFile,
		sourcemapFileNames: config.sourcemapFileNames,
		sourcemapIgnoreList:
			typeof config.sourcemapIgnoreList === 'function'
				? config.sourcemapIgnoreList
				: config.sourcemapIgnoreList === false
					? () => false
					: (relativeSourcePath) => relativeSourcePath.includes('node_modules'),
		sourcemapPathTransform: config.sourcemapPathTransform,
		strict: config.strict ?? true,
		systemNullSetters: config.systemNullSetters ?? true,
		validate: config.validate || false,
		virtualDirname: config.virtualDirname || '_virtual'
	};

	if (config.exports != null && !['default', 'named', 'none', 'auto'].includes(config.exports)) {
		error({
			code: 'INVALID_OPTION',
			message: `output.exports must be "default", "named", "none" or "auto", received ${JSON.stringify(config.exports)}`
		});
	}
	if (inputOptions) {
		void inputOptions;
	}
	return { options, unsetOptions };
}

module.exports = { normalizeOutputOptions, GENERATED_CODE_PRESETS };

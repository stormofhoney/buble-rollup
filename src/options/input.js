'use strict';

const { error } = require('../utils/errors.js');

function flattenPlugins(plugins, out = []) {
	if (!plugins) return out;
	if (Array.isArray(plugins)) {
		for (const p of plugins) flattenPlugins(p, out);
	} else {
		out.push(plugins);
	}
	return out;
}

function ensureArray(value) {
	return Array.isArray(value) ? value : [value];
}

function getIdMatcher(option) {
	if (option === true) return () => true;
	if (typeof option === 'function') {
		return (id, ...parameters) => (id[0] !== '\0' && option(id, ...parameters)) || false;
	}
	if (option) {
		const ids = new Set();
		const matchers = [];
		for (const value of ensureArray(option)) {
			if (value instanceof RegExp) matchers.push(value);
			else ids.add(value);
		}
		return (id) =>
			ids.has(id) ||
			matchers.some((matcher) =>
				matcher.global || matcher.sticky ? id.search(matcher) !== -1 : matcher.test(id)
			);
	}
	return () => false;
}

function getHasModuleSideEffects(moduleSideEffectsOption) {
	if (typeof moduleSideEffectsOption === 'boolean') return () => moduleSideEffectsOption;
	if (moduleSideEffectsOption === 'no-external') return (_id, external) => !external;
	if (typeof moduleSideEffectsOption === 'function') {
		return (id, external) =>
			id[0] === '\0' ? true : moduleSideEffectsOption(id, external) !== false;
	}
	if (Array.isArray(moduleSideEffectsOption)) {
		const ids = new Set(moduleSideEffectsOption);
		return (id) => ids.has(id);
	}
	if (moduleSideEffectsOption) {
		error({
			code: 'INVALID_OPTION',
			message:
				'treeshake.moduleSideEffects must be one of false, "no-external", a function or an array'
		});
	}
	return () => true;
}

function getTreeshake(configTreeshake) {
	if (configTreeshake === false) return false;
	const cfg = configTreeshake === true || configTreeshake == null ? {} : configTreeshake;
	return {
		annotations: cfg.annotations !== false,
		correctVarValueBeforeDeclaration: cfg.correctVarValueBeforeDeclaration === true,
		manualPureFunctions: cfg.manualPureFunctions ?? [],
		moduleSideEffects: getHasModuleSideEffects(cfg.moduleSideEffects),
		propertyReadSideEffects:
			cfg.propertyReadSideEffects === 'always' ? 'always' : cfg.propertyReadSideEffects !== false,
		tryCatchDeoptimization: cfg.tryCatchDeoptimization !== false,
		unknownGlobalSideEffects: cfg.unknownGlobalSideEffects !== false
	};
}

const INPUT_OPTION_KEYS = new Set([
	'cache',
	'context',
	'external',
	'fs',
	'input',
	'jsx',
	'logLevel',
	'makeAbsoluteExternalsRelative',
	'maxParallelFileOps',
	'moduleContext',
	'onLog',
	'onwarn',
	'perf',
	'plugins',
	'preserveEntrySignatures',
	'preserveSymlinks',
	'shimMissingExports',
	'strictDeprecations',
	'treeshake',
	'experimentalCacheExpiry',
	'experimentalLogSideEffects',
	'watch',
	// buble-rollup specific
	'transpile'
]);

function normalizeInputOptions(config = {}) {
	const unsetOptions = new Set();
	for (const key of Object.keys(config)) {
		if (!INPUT_OPTION_KEYS.has(key)) {
			unsetOptions.add(key);
		}
	}
	const options = {
		cache: config.cache === true ? undefined : config.cache || undefined,
		context: config.context ?? 'undefined',
		external: getIdMatcher(config.external),
		input: config.input == null ? [] : typeof config.input === 'string' ? [config.input] : config.input,
		logLevel: config.logLevel || 'info',
		makeAbsoluteExternalsRelative: config.makeAbsoluteExternalsRelative ?? 'ifRelativeSource',
		maxParallelFileOps:
			typeof config.maxParallelFileOps === 'number'
				? config.maxParallelFileOps <= 0
					? Infinity
					: config.maxParallelFileOps
				: 1000,
		onLog: config.onLog,
		onwarn: config.onwarn,
		perf: config.perf || false,
		plugins: flattenPlugins(config.plugins),
		preserveEntrySignatures: config.preserveEntrySignatures ?? 'exports-only',
		preserveSymlinks: config.preserveSymlinks || false,
		shimMissingExports: config.shimMissingExports || false,
		strictDeprecations: config.strictDeprecations || false,
		treeshake: getTreeshake(config.treeshake),
		// buble-rollup: built-in transpilation (default on, `false` disables)
		transpile: config.transpile === undefined ? true : config.transpile,
		_moduleContext:
			typeof config.moduleContext === 'function'
				? config.moduleContext
				: () => config.moduleContext ?? config.context ?? 'undefined'
	};
	return { options, unsetOptions, rawConfig: config };
}

module.exports = { normalizeInputOptions, flattenPlugins, getIdMatcher, getTreeshake };

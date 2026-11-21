'use strict';

const acorn = require('acorn');
const { RollupError, error, augmentCodeframe } = require('../utils/errors.js');
const { normalizeLog } = require('../utils/logger.js');

/**
 * Runs plugin hooks with rollup-compatible context semantics.
 */
class PluginDriver {
	constructor(plugins, { onLog, meta, watchMode = false, getModuleInfo, getModuleIds, getWatchFiles, emitFile, addWatchFile, resolve, load, parse }) {
		this.plugins = plugins;
		this.onLog = onLog;
		this.meta = meta;
		this.watchMode = watchMode;
		this._getModuleInfo = getModuleInfo || (() => null);
		this._getModuleIds = getModuleIds || (() => []);
		this._getWatchFiles = getWatchFiles || (() => []);
		this._emitFile = emitFile;
		this._addWatchFile = addWatchFile;
		this._resolve = resolve;
		this._load = load;
		this._parse =
			parse ||
			((code) =>
				acorn.parse(code, {
					ecmaVersion: 'latest',
					sourceType: 'module',
					allowHashBang: true,
					allowAwaitOutsideFunction: true
				}));
	}

	createContext(plugin, { id, code, hook } = {}) {
		const driver = this;
		const pluginName = plugin && plugin.name;
		const makeLog =
			(level) =>
			(input, position) => {
				const log = normalizeLog(input, level === 'error' ? 'PLUGIN_ERROR' : 'PLUGIN_WARNING');
				if (pluginName && !log.plugin) log.plugin = pluginName;
				if (id && !log.id) log.id = id;
				if (position != null && code != null && !log.loc) {
					log.loc = locationFromPos(code, position);
					if (id) log.loc.file = id;
					augmentCodeframe(log, code);
				}
				if (level === 'error') {
					error(log);
				}
				driver.onLog(log, level);
			};

		const context = {
			meta: driver.meta,
			get watchMode() {
				return driver.watchMode;
			},
			error: makeLog('error'),
			warn: makeLog('warn'),
			info: (input) => makeLog('info')(input),
			debug: (input) => makeLog('debug')(input),
			parse: (codeToParse, opts) =>
				driver._parse(codeToParse, opts),
			getModuleInfo: (moduleId) => driver._getModuleInfo(moduleId),
			getModuleIds: () => driver._getModuleIds(),
			getWatchFiles: () => driver._getWatchFiles(),
			emitFile: (file) => {
				if (!driver._emitFile) error({ code: 'PLUGIN_ERROR', message: 'emitFile is not available here', plugin: pluginName });
				return driver._emitFile(file, pluginName);
			},
			addWatchFile: (file) => {
				if (driver._addWatchFile) driver._addWatchFile(file);
			},
			resolve: async (source, importer, resolveOptions = {}) => {
				if (!driver._resolve) return null;
				return driver._resolve(source, importer, resolveOptions, plugin);
			},
			load: async (loadOptions) => {
				if (!driver._load) return null;
				return driver._load(loadOptions, plugin);
			}
		};
		if (hook) context.__hook = hook;
		return context;
	}

	_hookError(err, plugin) {
		if (err instanceof RollupError) {
			if (plugin && plugin.name && !err.plugin) err.plugin = plugin.name;
			return err;
		}
		const wrapped = new RollupError({
			message: err && err.message ? err.message : String(err),
			plugin: (err && err.plugin) || (plugin && plugin.name),
			...((err && err.code && { code: err.code }) || {}),
			...((err && err.loc && { loc: err.loc }) || {}),
			...((err && err.frame && { frame: err.frame }) || {}),
			...((err && err.id && { id: err.id }) || {})
		});
		wrapped.stack = err && err.stack ? err.stack : wrapped.stack;
		return wrapped;
	}

	/** Runs a hook on all plugins; returns the first non-null result (resolveId/load style). */
	async first(hookName, args, hookContext) {
		for (const plugin of this.plugins) {
			const hook = plugin[hookName];
			if (!hook) continue;
			try {
				const result = await (typeof hook === 'function'
					? hook.apply(this.createContext(plugin, hookContext), args)
					: hook.handler.apply(this.createContext(plugin, hookContext), args));
				if (result != null) return { result, plugin };
			} catch (err) {
				throw this._hookError(err, plugin);
			}
		}
		return null;
	}

	/** Runs a hook on all plugins, awaiting each in order, ignoring results. */
	async sequential(hookName, args, hookContext) {
		for (const plugin of this.plugins) {
			const hook = plugin[hookName];
			if (!hook) continue;
			try {
				await (typeof hook === 'function'
					? hook.apply(this.createContext(plugin, hookContext), args)
					: hook.handler.apply(this.createContext(plugin, hookContext), args));
			} catch (err) {
				throw this._hookError(err, plugin);
			}
		}
	}

	/** Runs a hook on all plugins in parallel. */
	async parallel(hookName, args, hookContext) {
		const promises = [];
		for (const plugin of this.plugins) {
			const hook = plugin[hookName];
			if (!hook) continue;
			promises.push(
				(async () => {
					try {
						await (typeof hook === 'function'
							? hook.apply(this.createContext(plugin, hookContext), args)
							: hook.handler.apply(this.createContext(plugin, hookContext), args));
					} catch (err) {
						throw this._hookError(err, plugin);
					}
				})()
			);
		}
		await Promise.all(promises);
	}

	/**
	 * Chains a hook where each plugin receives the previous result:
	 * args[0] is replaced by the previous return value (transform/renderChunk style).
	 */
	async chain(hookName, args, initialValue, hookContext, pickValue) {
		let current = initialValue;
		for (const plugin of this.plugins) {
			const hook = plugin[hookName];
			if (!hook) continue;
			try {
				const result = await (typeof hook === 'function'
					? hook.apply(this.createContext(plugin, hookContext), [current, ...args])
					: hook.handler.apply(this.createContext(plugin, hookContext), [current, ...args]));
				if (result != null) {
					current = pickValue ? pickValue(result, current) : result;
				}
			} catch (err) {
				throw this._hookError(err, plugin);
			}
		}
		return current;
	}
}

function locationFromPos(code, pos) {
	if (typeof pos !== 'number') return undefined;
	const before = code.slice(0, pos);
	const lines = before.split('\n');
	return { line: lines.length, column: lines[lines.length - 1].length };
}

module.exports = { PluginDriver };

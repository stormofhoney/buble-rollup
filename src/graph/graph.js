'use strict';

const fs = require('fs/promises');
const path = require('path');
const { analyzeModule } = require('./analyze.js');
const { PluginDriver } = require('../plugins/driver.js');
const { relativeId, isAbsoluteSource, isRelativeSource } = require('../utils/pathcheck.js');
const { error } = require('../utils/errors.js');

let assetCounter = 0;

class ExternalModule {
	constructor(id, attributes) {
		this.id = id;
		this.attributes = attributes || {};
		this.importers = new Set();
		this.isIncluded = true;
		this.moduleSideEffects = true;
	}
}

class Graph {
	constructor(options, rawConfig, { onLog, watchMode = false }) {
		this.options = options;
		this.rawConfig = rawConfig;
		this.onLog = onLog;
		this.watchMode = watchMode;
		this.modulesById = new Map();
		this.externalById = new Map();
		this.entryModules = [];
		this.dynamicEntryModules = [];
		this.orderedModules = [];
		this.cyclePaths = [];
		this.watchFiles = new Set();
		this.assets = new Map(); // refId -> asset
		this.emittedChunks = [];
		this.meta = { rollupVersion: require('../../package.json').version, rollupMode: 'build', watchMode };

		this.driver = new PluginDriver(options.plugins, {
			onLog,
			meta: this.meta,
			watchMode,
			getModuleInfo: (id) => this.getModuleInfo(id),
			getModuleIds: () => this.modulesById.keys(),
			getWatchFiles: () => [...this.watchFiles],
			emitFile: (file, pluginName) => this.emitFile(file, pluginName),
			addWatchFile: (file) => this.watchFiles.add(file),
			resolve: (source, importer, resolveOptions, skipPlugin) =>
				this.resolveForPlugin(source, importer, resolveOptions, skipPlugin),
			load: (loadOptions, plugin) => this.loadForPlugin(loadOptions, plugin)
		});
	}

	warn(log, level = 'warn') {
		this.onLog(log, level);
	}

	// ---------------------------------------------------------------- resolution

	async resolveForPlugin(source, importer, resolveOptions = {}, skipPlugin) {
		const result = await this.resolveId(
			source,
			importer,
			{
				isEntry: resolveOptions.isEntry || false,
				attributes: resolveOptions.attributes || {},
				custom: resolveOptions.custom
			},
			skipPlugin
		);
		if (!result) return null;
		return {
			id: result.id,
			external: result.external || false,
			moduleSideEffects: result.moduleSideEffects,
			syntheticNamedExports: result.syntheticNamedExports,
			meta: result.meta
		};
	}

	async resolveId(source, importer, { isEntry = false, attributes = {}, custom } = {}, skipPlugin = null) {
		// pre-resolution external check (imports only, matches rollup)
		if (importer !== undefined && this.options.external(source, importer, false)) {
			return this.finalizeExternal(source, source, importer, attributes, false);
		}

		// plugin resolveId hooks
		for (const plugin of this.options.plugins) {
			if (skipPlugin && plugin === skipPlugin) continue;
			const hook = plugin.resolveId;
			if (!hook) continue;
			let result;
			try {
				result = await (typeof hook === 'function'
					? hook.call(
							this.driver.createContext(plugin, { id: source, code: undefined, hook: 'resolveId' }),
							source,
							importer,
							{ attributes, custom, isEntry, isResolved: false }
						)
					: hook.handler.call(
							this.driver.createContext(plugin, { hook: 'resolveId' }),
							source,
							importer,
							{ attributes, custom, isEntry, isResolved: false }
						));
			} catch (err) {
				throw this.driver._hookError(err, plugin);
			}
			if (result == null) continue;
			if (result === false) {
				return this.finalizeExternal(source, source, importer, attributes, false);
			}
			const resolved =
				typeof result === 'string'
					? { id: result, resolvedBy: plugin.name }
					: { ...result, resolvedBy: result.resolvedBy || plugin.name };
			return this.postResolve(resolved, source, importer, attributes, true);
		}

		// default resolution
		const defaultResolved = await this.defaultResolve(source, importer);
		if (defaultResolved == null) return this.handleUnresolved(source, importer, attributes, isEntry);
		return this.postResolve({ id: defaultResolved }, source, importer, attributes, false);
	}

	async defaultResolve(source, importer) {
		if (importer !== undefined && !isAbsoluteSource(source) && source[0] !== '.') return null;
		const base = importer ? path.resolve(path.dirname(importer), source) : path.resolve(source);
		return (
			(await this.findFile(base)) ??
			(await this.findFile(base + '.mjs')) ??
			(await this.findFile(base + '.js'))
		);
	}

	async findFile(file) {
		try {
			const stats = await fs.lstat(file);
			if (!this.options.preserveSymlinks && stats.isSymbolicLink()) {
				return await this.findFile(await fs.realpath(file));
			}
			if ((this.options.preserveSymlinks && stats.isSymbolicLink()) || stats.isFile()) {
				const name = path.basename(file);
				const files = await fs.readdir(path.dirname(file));
				if (files.includes(name)) return file;
			}
		} catch {
			// suppress
		}
		return null;
	}

	async postResolve(resolved, source, importer, attributes, fromPlugin) {
		const id = resolved.id;
		if (fromPlugin && this.options.external(id, importer, true)) {
			return this.finalizeExternal(source, id, importer, attributes, true, resolved);
		}
		if (!fromPlugin && this.options.external(id, importer, true)) {
			return this.finalizeExternal(source, id, importer, attributes, true, resolved);
		}
		return {
			id,
			external: false,
			moduleSideEffects: resolved.moduleSideEffects,
			syntheticNamedExports: resolved.syntheticNamedExports,
			meta: resolved.meta || {},
			attributes,
			resolvedBy: resolved.resolvedBy
		};
	}

	finalizeExternal(source, id, importer, attributes, isResolved, resolved = {}) {
		let externalId = id;
		const makeRelative =
			this.options.makeAbsoluteExternalsRelative === true ||
			(this.options.makeAbsoluteExternalsRelative === 'ifRelativeSource' &&
				isRelativeSource(source)) ||
			(this.options.makeAbsoluteExternalsRelative === 'ifRelativeSource' && !isAbsoluteSource(id));
		if (isAbsoluteSource(externalId) && this.options.makeAbsoluteExternalsRelative !== false && makeRelative) {
			const rel = importer ? path.relative(path.dirname(importer), externalId) : externalId;
			externalId = rel.startsWith('.') ? rel : './' + rel;
		}
		return {
			id: externalId,
			external: true,
			attributes,
			moduleSideEffects: resolved.moduleSideEffects,
			meta: resolved.meta || {},
			resolvedBy: resolved.resolvedBy
		};
	}

	handleUnresolved(source, importer, attributes, isEntry) {
		if (isEntry || importer === undefined) {
			return error({
				code: 'UNRESOLVED_ENTRY',
				message: `Could not resolve entry module "${relativeId(source)}".`
			});
		}
		if (isRelativeSource(source)) {
			return error({
				code: 'UNRESOLVED_IMPORT',
				exporter: source,
				id: importer,
				message: `Could not resolve "${source}" from "${relativeId(importer)}"`
			});
		}
		this.warn({
			code: 'UNRESOLVED_IMPORT',
			exporter: source,
			id: importer,
			message: `"${source}" is imported by "${relativeId(
				importer
			)}", but could not be resolved – treating it as an external dependency.`
		});
		return this.finalizeExternal(source, source, importer, attributes, false);
	}

	// ---------------------------------------------------------------- loading

	async build(entrySources) {
		try {
			await this.driver.sequential('buildStart', [this.options], { hook: 'buildStart' });
		} catch (err) {
			await this.driver.sequential('buildEnd', [err], { hook: 'buildEnd' });
			throw err;
		}

		for (const { source, name } of entrySources) {
			const resolved = await this.resolveId(source, undefined, { isEntry: true });
			if (!resolved || resolved.external) {
				error({
					code: 'UNRESOLVED_ENTRY',
					message: `Could not resolve entry module "${relativeId(source)}".`
				});
			}
			const module = await this.fetchModule(resolved.id, { isEntry: true, entryName: name, attributes: resolved.attributes });
			module.entryName = name;
			this.entryModules.push(module);
		}

		this.sortAndBind();
		const { runTreeShake } = require('./treeshake.js');
		runTreeShake(this, this.options, (log) => this.warn(log, 'warn'));
		await this.driver.sequential('buildEnd', [undefined], { hook: 'buildEnd' });
		return this;
	}

	async fetchModule(id, { isEntry = false, entryName = null, attributes = {}, syntheticNamedExports } = {}) {
		let module = this.modulesById.get(id);
		if (module) {
			if (isEntry && !module.isEntry) {
				module.isEntry = true;
				module.entryName = entryName;
				this.entryModules.push(module);
			}
			return module;
		}
		module = {
			id,
			isEntry,
			entryName,
			isDynamicEntry: false,
			code: null,
			transformedCode: null,
			transformMaps: [],
			analysis: null,
			deps: [], // [{ source, resolved, module | externalModule }]
			dynamicDeps: [],
			externalDeps: [],
			attributes,
			executionOrder: -1,
			needsNamespace: false,
			namespaceBaseName: null,
			syntheticNamedExports: syntheticNamedExports || false,
			info: null
		};
		this.modulesById.set(id, module);
		this.watchFiles.add(id);

		try {
			await this.loadModule(module);
		} catch (err) {
			this.modulesById.delete(id);
			throw err;
		}
		return module;
	}

	async loadModule(module) {
		const id = module.id;
		let code = null;
		let loadedMeta = {};

		// load hooks
		for (const plugin of this.options.plugins) {
			const hook = plugin.load;
			if (!hook) continue;
			let result;
			try {
				result = await (typeof hook === 'function'
					? hook.call(this.driver.createContext(plugin, { id, hook: 'load' }), id)
					: hook.handler.call(this.driver.createContext(plugin, { id, hook: 'load' }), id));
			} catch (err) {
				throw this.driver._hookError(err, plugin);
			}
			if (result != null) {
				if (typeof result === 'string') {
					code = result;
				} else {
					code = result.code;
					if (result.moduleSideEffects != null) loadedMeta.moduleSideEffects = result.moduleSideEffects;
					if (result.syntheticNamedExports != null) loadedMeta.syntheticNamedExports = result.syntheticNamedExports;
					if (result.meta) loadedMeta.meta = result.meta;
				}
				break;
			}
		}
		if (code == null) {
			try {
				code = await fs.readFile(id, 'utf8');
			} catch (err) {
				error({
					code: 'UNRESOLVED_IMPORT',
					id,
					message: `Could not load ${relativeId(id)}: ${err.message}`
				});
			}
		}
		module.code = code;

		// transform hooks (chained)
		let current = code;
		for (const plugin of this.options.plugins) {
			const hook = plugin.transform;
			if (!hook) continue;
			let result;
			try {
				result = await (typeof hook === 'function'
					? hook.call(this.driver.createContext(plugin, { id, code: current, hook: 'transform' }), current, id)
					: hook.handler.call(this.driver.createContext(plugin, { id, code: current, hook: 'transform' }), current, id));
			} catch (err) {
				throw this.driver._hookError(err, plugin);
			}
			if (result == null) continue;
			if (typeof result === 'string') {
				current = result;
				module.transformMaps.push({ plugin: plugin.name, map: null });
			} else {
				current = result.code;
				module.transformMaps.push({ plugin: plugin.name, map: result.map || null });
			}
		}
		module.transformedCode = current;

		// analyse
		const treeshake = this.options.treeshake;
		module.analysis = analyzeModule(
			current,
			id,
			treeshake === false
				? { annotations: false, propertyReadSideEffects: false, unknownGlobalSideEffects: false, manualPureFunctions: [] }
				: {
						annotations: treeshake.annotations,
						propertyReadSideEffects: treeshake.propertyReadSideEffects !== false,
						unknownGlobalSideEffects: treeshake.unknownGlobalSideEffects,
						manualPureFunctions: treeshake.manualPureFunctions
					}
		);

		const moduleSideEffects =
			loadedMeta.moduleSideEffects !== undefined
				? loadedMeta.moduleSideEffects
				: this.options.treeshake === false
					? true
					: this.options.treeshake.moduleSideEffects(id, false);
		module.moduleSideEffects = moduleSideEffects === true;
		module.syntheticNamedExports = loadedMeta.syntheticNamedExports ?? module.syntheticNamedExports;

		module.info = {
			id,
			meta: { ...(loadedMeta.meta || {}) },
			code: current,
			moduleSideEffects,
			syntheticNamedExports: module.syntheticNamedExports,
			isEntry: module.isEntry,
			importedIds: [],
			dynamicallyImportedIds: [],
			importers: new Set(),
			hasDefaultExport: module.analysis.hasDefaultExport,
			exports: module.analysis.exports.map((e) => e.exported),
			ast: module.analysis.ast
		};

		await this.driver.sequential('moduleParsed', [module.info], { id, code: current, hook: 'moduleParsed' });

		// resolve static imports
		for (const imp of module.analysis.imports) {
			const resolved = await this.resolveId(imp.source, id, { attributes: {} });
			if (!resolved) continue;
			if (resolved.external) {
				let externalModule = this.externalById.get(resolved.id);
				if (!externalModule) {
					externalModule = new ExternalModule(resolved.id, resolved.attributes);
					externalModule.moduleSideEffects =
						resolved.moduleSideEffects !== undefined
							? resolved.moduleSideEffects
							: this.options.treeshake === false
								? true
								: this.options.treeshake.moduleSideEffects(resolved.id, true);
					this.externalById.set(resolved.id, externalModule);
				}
				externalModule.importers.add(module);
				module.externalDeps.push({ source: imp.source, external: true, externalModule, importNode: imp.node });
				module.info.importedIds.push(resolved.id);
			} else {
				const dep = await this.fetchModule(resolved.id, { attributes: resolved.attributes, syntheticNamedExports: resolved.syntheticNamedExports });
				dep.info.importers.add(id);
				module.deps.push({ source: imp.source, module: dep, importNode: imp.node });
				module.info.importedIds.push(resolved.id);
			}
		}

		// resolve reexport sources (`export ... from '...'`) — they are not ImportDeclarations
		for (const source of module.analysis.reexportSources || []) {
			if (this.dependencyBySource(module, source)) continue;
			const resolved = await this.resolveId(source, id, { attributes: {} });
			if (!resolved) continue;
			if (resolved.external) {
				let externalModule = this.externalById.get(resolved.id);
				if (!externalModule) {
					externalModule = new ExternalModule(resolved.id, resolved.attributes);
					externalModule.moduleSideEffects =
						resolved.moduleSideEffects !== undefined
							? resolved.moduleSideEffects
							: this.options.treeshake === false
								? true
								: this.options.treeshake.moduleSideEffects(resolved.id, true);
					this.externalById.set(resolved.id, externalModule);
				}
				externalModule.importers.add(module);
				module.externalDeps.push({ source, external: true, externalModule, importNode: null });
				module.info.importedIds.push(resolved.id);
			} else {
				const dep = await this.fetchModule(resolved.id, {
					attributes: resolved.attributes,
					syntheticNamedExports: resolved.syntheticNamedExports
				});
				dep.info.importers.add(id);
				module.deps.push({ source, module: dep, importNode: null });
				module.info.importedIds.push(resolved.id);
			}
		}

		// resolve dynamic imports
		for (const source of module.analysis.dynamicImports) {
			const resolved = await this.resolveId(source, id, { attributes: {} });
			if (!resolved) continue;
			if (resolved.external) {
				let externalModule = this.externalById.get(resolved.id);
				if (!externalModule) {
					externalModule = new ExternalModule(resolved.id, resolved.attributes);
					this.externalById.set(resolved.id, externalModule);
				}
				externalModule.importers.add(module);
				module.dynamicDeps.push({ source, external: true, externalModule, dynamic: true });
			} else {
				const dep = await this.fetchModule(resolved.id, { attributes: resolved.attributes });
				dep.isDynamicEntry = true;
				dep.info.importers.add(id);
				if (!this.dynamicEntryModules.includes(dep)) this.dynamicEntryModules.push(dep);
				module.dynamicDeps.push({ source, module: dep, dynamic: true });
				module.info.dynamicallyImportedIds.push(resolved.id);
			}
		}
	}

	async loadForPlugin(loadOptions, plugin) {
		const id = loadOptions.id;
		let module = this.modulesById.get(id);
		if (!module) {
			module = await this.fetchModule(id, {
				isEntry: !!loadOptions.isEntry,
				attributes: loadOptions.attributes
			});
		}
		return module.info;
	}

	// ---------------------------------------------------------------- linking

	/**
	 * Resolves an export of a module to { binding } or { external, imported } or null.
	 * Handles local exports, reexports and star exports recursively.
	 */
	resolveExport(module, name, seen = new Set()) {
		if (seen.has(module)) return null;
		seen.add(module);
		const analysis = module.analysis;

		// explicit local exports first
		let starSources = null;
		for (const exp of analysis.exports) {
			if (exp.type === 'local' && exp.exported === name) {
				if (exp.local === '@default') {
					return { module, defaultVar: true, exportEntry: exp };
				}
				const binding = analysis.bindings.get(exp.local);
				return binding ? { module, binding, exportEntry: exp } : null;
			}
			if (exp.type === 'reexport' && exp.exported === name) {
				const dep = this.dependencyBySource(module, exp.source);
				if (!dep) return null; // external reexport handled elsewhere
				if (dep.external) return { module, external: dep.externalModule, imported: exp.imported, exportEntry: exp };
				return this.resolveExport(dep.module, exp.imported, seen);
			}
			if (exp.type === 'star-as' && exp.exported === name) {
				const dep = this.dependencyBySource(module, exp.source);
				if (!dep) return null;
				if (dep.external) return { module, namespaceOf: dep.externalModule, exportEntry: exp };
				return { module, namespaceOf: dep.module, exportEntry: exp };
			}
			if (exp.type === 'star') {
				(starSources ||= []).push(exp.source);
			}
		}

		// fall back to star exports
		if (starSources) {
			for (const source of starSources) {
				const dep = this.dependencyBySource(module, source);
				if (!dep || dep.external) continue;
				const resolved = this.resolveExport(dep.module, name, new Set(seen));
				if (resolved) return resolved;
			}
		}
		return null;
	}

	/** All export names visible on a module (locals + reexports + stars). */
	collectExportNames(module, seen = new Set()) {
		if (seen.has(module)) return new Set();
		seen.add(module);
		const names = new Set();
		const starDeps = [];
		for (const exp of module.analysis.exports) {
			if (exp.type === 'star') starDeps.push(exp.source);
			else if (exp.exported) names.add(exp.exported);
		}
		for (const source of starDeps) {
			const dep = this.dependencyBySource(module, source);
			if (!dep || dep.external) continue;
			for (const name of this.collectExportNames(dep.module, seen)) {
				if (!names.has(name)) names.add(name);
			}
		}
		return names;
	}

	dependencyBySource(module, source) {
		for (const dep of module.deps) if (dep.source === source) return dep;
		for (const dep of module.externalDeps) if (dep.source === source) return dep;
		for (const dep of module.dynamicDeps) if (dep.source === source) return dep;
		return null;
	}

	// ---------------------------------------------------------------- ordering & warnings

	sortAndBind() {
		const state = new Map(); // module -> 0 in progress, 1 done
		const stack = [];
		const ordered = [];
		const visit = (module) => {
			const s = state.get(module);
			if (s === 1) return;
			if (s === 0) {
				const idx = stack.indexOf(module);
				if (idx !== -1) this.cyclePaths.push(stack.slice(idx).map((m) => m.id).concat(module.id));
				return;
			}
			state.set(module, 0);
			stack.push(module);
			for (const dep of module.deps) visit(dep.module);
			stack.pop();
			state.set(module, 1);
			ordered.push(module);
		};
		for (const entry of this.entryModules) visit(entry);
		// dynamic entries and any orphan modules reached later
		for (const dyn of this.dynamicEntryModules) visit(dyn);

		for (const cycle of this.cyclePaths) {
			this.warn({
				code: 'CIRCULAR_DEPENDENCY',
				ids: cycle,
				message: `Circular dependency: ${cycle.map(relativeId).join(' -> ')}`
			});
		}

		ordered.forEach((module, index) => {
			module.executionOrder = index;
		});
		this.orderedModules = ordered;

		this.warnForMissingExports();
	}

	warnForMissingExports() {
		for (const module of this.orderedModules) {
			for (const imp of module.analysis.imports) {
				for (const spec of imp.specifiers) {
					if (spec.kind === 'namespace') continue;
					const dep = this.dependencyBySource(module, imp.source);
					if (!dep || dep.external || !dep.module) continue;
					const resolved = this.resolveExport(
						dep.module,
						spec.kind === 'named' ? spec.imported : spec.kind === 'namespace' ? '*' : 'default'
					);
					if (!resolved) {
						this.warn({
							code: 'MISSING_EXPORT',
							binding: spec.kind === 'named' ? spec.imported : spec.kind === 'default' ? 'default' : '*',
							exporter: dep.module.id,
							id: module.id,
							message: `"${spec.kind === 'named' ? spec.imported : spec.kind === 'default' ? 'default' : spec.local}" is not exported by "${relativeId(dep.module.id)}"`
						});
					}
				}
			}
		}
	}

	// ---------------------------------------------------------------- misc

	getModuleInfo(id) {
		const module = this.modulesById.get(id);
		if (module) return module.info;
		const external = this.externalById.get(id);
		if (external) {
			return {
				id,
				meta: {},
				code: null,
				moduleSideEffects: external.moduleSideEffects,
				syntheticNamedExports: false,
				isEntry: false,
				importedIds: [],
				dynamicallyImportedIds: [],
				importers: [...external.importers].map((m) => m.id),
				hasDefaultExport: false,
				exports: [],
				ast: null
			};
		}
		return null;
	}

	emitFile(file, pluginName) {
		if (file.type === 'asset') {
			const ref = `asset_ref_${++assetCounter}`;
			const asset = {
				ref,
				pluginName,
				name: file.name,
				fileName: file.fileName,
				source: file.source,
				needsSource: file.source == null
			};
			this.assets.set(ref, asset);
			return ref;
		}
		if (file.type === 'chunk') {
			error({
				code: 'PLUGIN_ERROR',
				plugin: pluginName,
				message: 'emitFile({ type: "chunk" }) is not yet supported by buble-rollup'
			});
		}
		error({ code: 'PLUGIN_ERROR', plugin: pluginName, message: `Invalid emitFile type: ${file.type}` });
	}

	setAssetSource(refId, source) {
		const asset = this.assets.get(refId);
		if (!asset) error({ code: 'PLUGIN_ERROR', message: `Unknown asset reference id "${refId}"` });
		asset.source = source;
		asset.needsSource = false;
	}

	getFileName(refId) {
		const asset = this.assets.get(refId);
		if (!asset) error({ code: 'PLUGIN_ERROR', message: `Unknown asset reference id "${refId}"` });
		if (asset.fileName) return asset.fileName;
		error({
			code: 'PLUGIN_ERROR',
			message: 'The file name of the asset is not available yet during the build phase'
		});
	}
}

function entrySourcesFromInput(input) {
	if (typeof input === 'string') {
		return [{ source: input, name: path.basename(input, path.extname(input)) }];
	}
	if (Array.isArray(input)) {
		return input.map((source) => ({ source, name: path.basename(source, path.extname(source)) }));
	}
	if (input && typeof input === 'object') {
		return Object.entries(input).map(([name, source]) => ({ source, name }));
	}
	return [];
}

module.exports = { Graph, entrySourcesFromInput, ExternalModule };

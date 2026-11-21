'use strict';

const fs = require('fs/promises');
const path = require('path');
const { normalizeInputOptions } = require('./options/input.js');
const { normalizeOutputOptions } = require('./options/output.js');
const { Graph, entrySourcesFromInput } = require('./graph/graph.js');
const { renderChunk } = require('./render/render.js');
const { createLogger } = require('./utils/logger.js');
const { error } = require('./utils/errors.js');

const VERSION = require('../package.json').version;

async function rollup(config = {}) {
	const { options: inputOptions, unsetOptions, rawConfig } = normalizeInputOptions(config);
	void unsetOptions;
	const logger = createLogger({
		onLog: inputOptions.onLog,
		onwarn: inputOptions.onwarn,
		logLevel: inputOptions.logLevel
	});
	const graph = new Graph(inputOptions, rawConfig, {
		onLog: (log, level) => logger.handleLog(log, level)
	});
	const entrySources = entrySourcesFromInput(inputOptions.input);
	if (!entrySources.length) {
		error({
			code: 'UNRESOLVED_ENTRY',
			message: 'You must supply options.input to rollup'
		});
	}
	await graph.build(entrySources);
	return new Bundle(graph, inputOptions, logger, rawConfig);
}

class Bundle {
	constructor(graph, inputOptions, logger, rawConfig) {
		this.graph = graph;
		this.inputOptions = inputOptions;
		this.logger = logger;
		this.rawConfig = rawConfig;
		this.closed = false;
	}

	async generate(outputConfig = {}) {
		if (this.closed) {
			error({ code: 'INVALID_STATE', message: 'Bundle was already closed' });
		}
		const { options: outputOptions, unsetOptions } = normalizeOutputOptions(
			outputConfig,
			this.inputOptions,
			new Set()
		);
		void unsetOptions;
		const warnings = [];
		const onwarn = (log) => {
			warnings.push(log);
			const handler = outputConfig.onwarn || this.inputOptions.onwarn;
			if (typeof handler === 'function') handler(log);
			else this.logger.warn(log);
		};
		const { code, exports, exportMode } = renderChunk(this.graph, outputOptions, onwarn);
		const entry = this.graph.entryModules[0];
		const fileName =
			outputOptions.file ||
			outputOptions.entryFileNames.replace(/\[name\]/g, entry.entryName || 'main');
		const chunk = {
			type: 'chunk',
			code,
			fileName,
			name: entry.entryName || 'main',
			isEntry: true,
			isDynamicEntry: false,
			exports: exports.map((e) => e.exported),
			exportMode,
			implicitEntry: false,
			map: null,
			sourcemapFileName: null,
			assets: [],
			dynamicImports: [],
			importedBindings: {},
			implicitlyLoadedBefore: [],
			metadata: {},
			moduleIds: this.graph.orderedModules.map((m) => m.id),
			trusted: false
		};
		const assets = [];
		for (const asset of this.graph.assets.values()) {
			assets.push({
				type: 'asset',
				fileName: asset.fileName || asset.name,
				name: asset.name,
				source: asset.source,
				needsCodeReference: false
			});
		}
		return { output: [chunk, ...assets], warnings };
	}

	async write(outputConfig = {}) {
		const { output, warnings } = await this.generate(outputConfig);
		const outOptions = normalizeOutputOptions(outputConfig, this.inputOptions, new Set())
			.options;
		// build the output bundle descriptor for generateBundle/writeBundle
		const bundleMap = {};
		for (const item of output) {
			if (item.fileName) bundleMap[item.fileName] = item;
		}
		await this.graph.driver.sequential('generateBundle', [bundleMap, outOptions], {
			hook: 'generateBundle'
		});
		const writtenFiles = [];
		for (const item of output) {
			let fileName = item.fileName;
			if (outOptions.dir && !outOptions.file) {
				fileName = path.join(outOptions.dir, fileName);
			} else if (outOptions.file) {
				fileName = outOptions.file;
			}
			await fs.mkdir(path.dirname(fileName), { recursive: true });
			if (item.type === 'chunk') {
				await fs.writeFile(fileName, item.code, 'utf8');
				item.code = undefined;
			} else {
				const source = item.source;
				await fs.writeFile(
					fileName,
					Buffer.isBuffer(source) ? source : String(source),
					'utf8'
				);
				item.source = undefined;
			}
			writtenFiles.push({ fileName, ...item });
		}
		await this.graph.driver.sequential('writeBundle', [bundleMap, outOptions], {
			hook: 'writeBundle'
		});
		return { output, warnings };
	}

	async close() {
		this.closed = true;
	}
}

module.exports = { rollup, VERSION, Bundle };

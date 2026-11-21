'use strict';

const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/**
 * Creates the log handler used throughout a build. Mirrors rollup's
 * onLog/onwarn/logLevel semantics closely enough for drop-in behaviour.
 */
function createLogger({ onLog, onwarn, logLevel = 'info', silent = false } = {}) {
	const threshold = silent ? LOG_LEVELS.silent : LOG_LEVELS[logLevel] ?? LOG_LEVELS.info;
	const handlers = [];

	if (typeof onLog === 'function') handlers.push(onLog);
	if (typeof onwarn === 'function') {
		// rollup passes warnings through onLog first, then falls back to onwarn
		handlers.push((log, level) => {
			if (level === 'warn') onwarn(log);
		});
	}

	function handleLog(log, level = 'warn') {
		if ((LOG_LEVELS[level] ?? LOG_LEVELS.warn) > threshold) return;
		for (const handler of handlers) {
			if (handler(log, level) === false) return;
		}
		if (handlers.length === 0 || typeof onLog !== 'function') {
			printLog(log, level);
		}
	}

	return {
		threshold,
		handleLog,
		warn: (log) => handleLog(log, 'warn'),
		error: (log) => handleLog(log, 'error'),
		info: (log) => handleLog(log, 'info'),
		debug: (log) => handleLog(log, 'debug')
	};
}

function printLog(log, level) {
	const message = typeof log === 'string' ? log : log.message;
	const plugin = typeof log === 'object' && log.plugin ? ` (plugin ${log.plugin})` : '';
	const text = `(!) ${message}${plugin}`;
	if (level === 'error') console.error(text);
	else console.warn(text);
}

function normalizeLog(input, defaultCode = 'PLUGIN_ERROR') {
	if (typeof input === 'string') return { message: input, code: defaultCode };
	const log = { ...input };
	if (!log.code) log.code = defaultCode;
	if (!log.message) log.message = String(log);
	return log;
}

module.exports = { createLogger, printLog, normalizeLog, LOG_LEVELS };

'use strict';

/**
 * Drop-in replacement for @rollup/plugin-buble (v1.0.3 behaviour).
 * Port of rollup/plugins packages/buble/src/index.ts.
 */

const { transform } = require('buble');
const picomatch = require('picomatch');

function toMatcher(pattern) {
	if (pattern instanceof RegExp) return (id) => pattern.test(id);
	if (typeof pattern === 'function') return pattern;
	if (typeof pattern === 'string') {
		const isMatch = picomatch(pattern, { dot: true });
		return (id) => isMatch(id);
	}
	return () => false;
}

function toArray(value) {
	if (value == null) return [];
	return Array.isArray(value) ? value : [value];
}

/** Minimal @rollup/pluginutils createFilter equivalent. */
function createFilter(include, exclude) {
	const includeMatchers = toArray(include).map(toMatcher);
	const excludeMatchers = toArray(exclude).map(toMatcher);
	return (id) => {
		if (typeof id !== 'string') return false;
		if (id.startsWith('\0')) return false;
		if (excludeMatchers.length && excludeMatchers.some((m) => m(id))) return false;
		if (includeMatchers.length) return includeMatchers.some((m) => m(id));
		return true;
	};
}

function buble(options = {}) {
	const filter = createFilter(options.include, options.exclude);
	const transformOptions = { ...options, transforms: { ...options.transforms, modules: false } };

	return {
		name: 'buble',
		transform(code, id) {
			if (!filter(id)) return null;
			try {
				return transform(code, transformOptions);
			} catch (e) {
				e.plugin = 'buble';
				if (!e.loc) e.loc = {};
				e.loc.file = id;
				e.frame = e.snippet;
				throw e;
			}
		}
	};
}

module.exports = buble;
module.exports.default = buble;
module.exports.createFilter = createFilter;

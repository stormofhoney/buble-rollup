'use strict';

const path = require('path');
const { makeLegal } = require('../render/snippets.js');

/** Normalizes a resolved id to a posix-style absolute path for stable comparisons. */
function normalizeId(id) {
	if (id.startsWith('\0')) return id;
	return path.normalize(id).replace(/\\/g, '/');
}

/** Turns an id into a path relative to cwd for warnings, like rollup's relativeId. */
function relativeId(id) {
	if (id.startsWith('\0')) return id;
	const rel = path.relative(process.cwd(), id);
	if (rel.startsWith('..')) return id;
	return rel || id;
}

/** Module basename without extension, made into a legal identifier (rollup Module.basename). */
function makeModuleLegal(name) {
	return makeLegal(name);
}

function moduleBasename(id) {
	if (id.startsWith('\0')) {
		const clean = id.slice(1).replace(/\?.*$/, '');
		const base = path.basename(clean, path.extname(clean));
		return makeLegal(base || 'module');
	}
	const clean = id.replace(/\?.*$/, '');
	const ext = path.extname(clean);
	const base = path.basename(clean, ext);
	return makeLegal(base || 'module');
}

/** Determines whether an import source should be treated as external. */
function isExternalSource(source, external, isResolved, id) {
	if (typeof external === 'function') {
		return !!external(source, id, isResolved);
	}
	if (Array.isArray(external)) {
		return external.some((pattern) => matchExternal(pattern, source, id));
	}
	if (external === true) return true;
	return false;
}

function matchExternal(pattern, source, id) {
	if (pattern instanceof RegExp) return pattern.test(source);
	if (typeof pattern !== 'string') return false;
	if (source === pattern) return true;
	// prefix matching: 'foo' matches 'foo/bar'
	if (pattern.endsWith('/') ? source.startsWith(pattern) : source.startsWith(pattern + '/')) {
		return true;
	}
	return false;
}

function sanitizeFileName(name) {
	return name.replace(/[?*#:<>|]/g, '_').replace(/\0/g, '');
}

module.exports = {
	normalizeId,
	relativeId,
	makeLegal,
	moduleBasename,
	isExternalSource,
	sanitizeFileName
};

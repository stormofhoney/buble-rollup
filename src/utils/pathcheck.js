'use strict';

const path = require('path');

function isAbsoluteSource(source) {
	return path.isAbsolute(source) || source[0] === '/';
}

function isRelativeSource(source) {
	return source.startsWith('./') || source.startsWith('../');
}

function relativeId(id) {
	if (id.startsWith('\0')) return id;
	const rel = path.relative(process.cwd(), id);
	return rel || id;
}

module.exports = { isAbsoluteSource, isRelativeSource, relativeId };

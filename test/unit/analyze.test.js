'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { analyzeModule, DEFAULT_LOCAL } = require('../../src/graph/analyze.js');

test('extracts imports with specifier kinds', () => {
	const a = analyzeModule(
		`import def, { a as b, "str" as c } from './x.js';\nimport * as ns from './y.js';\nimport './z.js';`,
		'/m.js'
	);
	assert.equal(a.imports.length, 3);
	assert.deepEqual(
		a.imports[0].specifiers.map((s) => [s.kind, s.local, s.imported || null]),
		[
			['default', 'def', null],
			['named', 'b', 'a'],
			['named', 'c', 'str']
		]
	);
	assert.equal(a.imports[1].specifiers[0].kind, 'namespace');
	assert.equal(a.imports[2].specifiers.length, 0);
	assert.equal(a.bindings.get('def').importInfo.imported, 'default');
	assert.equal(a.bindings.get('ns').importInfo.imported, '*');
	assert.equal(a.bindings.get('b').importInfo.imported, 'a');
});

test('extracts exports in all shapes', () => {
	const a = analyzeModule(
		[
			'export const x = 1;',
			'export function f() {}',
			'export { x as y };',
			'export { q } from "./other.js";',
			'export * from "./star.js";',
			'export * as ns from "./ns.js";',
			'export default function main() {}'
		].join('\n'),
		'/m.js'
	);
	const kinds = a.exports.map((e) => {
		if (e.type === 'reexport') return `reexport:${e.imported}->${e.exported}`;
		if (e.type === 'star-as') return `star-as:${e.exported}`;
		if (e.type === 'star') return 'star';
		return `local:${e.exported}=${e.local}`;
	});
	assert.deepEqual(kinds, [
		'local:x=x',
		'local:f=f',
		'local:y=x',
		'reexport:q->q',
		'star',
		'star-as:ns',
		'local:default=main'
	]);
	assert.equal(a.defaultInfo.kind, 'named-decl');
	assert.equal(a.defaultInfo.localName, 'main');
});

test('classifies default export forms', () => {
	assert.equal(analyzeModule('export default 42;', '/a.js').defaultInfo.kind, 'expression');
	assert.equal(analyzeModule('export default function() {}', '/a.js').defaultInfo.kind, 'anon-fn');
	assert.equal(analyzeModule('export default class {}', '/a.js').defaultInfo.kind, 'anon-class');
	const ident = analyzeModule('const foo = 1; export default foo;', '/a.js');
	assert.equal(ident.defaultInfo.kind, 'identifier');
	assert.equal(ident.exports.find((e) => e.exported === 'default').local, 'foo');
	const anon = analyzeModule('export const a = 1; export default 2;', '/b.js');
	assert.equal(anon.exports.find((e) => e.exported === 'default').local, DEFAULT_LOCAL);
});

test('collects references but skips export/import specifiers and JSX attribute names', () => {
	const a = analyzeModule(
		[
			'const value = 1;',
			'export { value };',
			'const obj = { value };',
			'function read() { return obj.value; }',
			'const el = <div value={value} data-x="y" />;'
		].join('\n'),
		'/m.js'
	);
	const value = a.bindings.get('value');
	const refRanges = a.refsByBinding.get(value).map((r) => r.node.start);
	// export specifier excluded, shorthand included, jsx expression included, member prop excluded
	const objStmt = a.statements.find((s) => s.type === 'ExpressionStatement');
	const jsxStmt = a.statements[a.statements.length - 1];
	const shorthandRef = a.refsByBinding
		.get(a.bindings.get('value'))
		.find((r) => r.shorthandKey);
	assert.ok(shorthandRef, 'shorthand reference detected');
	assert.equal(shorthandRef.shorthandKey.name, 'value');
	// member expression `.value` is not a reference of the const
	const memberRef = a.refsByBinding
		.get(value)
		.find((r) => r.node.start >= a.statements[3].start && r.node.start <= a.statements[3].end && !r.shorthandKey);
	assert.equal(memberRef, undefined);
	// JSX attribute name not a reference, JSX expression container is
	const jsxRefs = a.refsByBinding.get(value).filter((r) => r.node.start >= jsxStmt.start);
	assert.equal(jsxRefs.length, 1);
	assert.ok(jsxRefs[0].node.start > jsxStmt.declarations[0].start);
	void objStmt;
});

test('detects top-level statement effects and references', () => {
	const a = analyzeModule(
		[
			'const pure = 1;',
			'const unused = someGlobal;',
			'sideEffect();',
			'const local = 2;',
			'export const used = local + pure;'
		].join('\n'),
		'/m.js'
	);
	const infos = a.statements;
	const pureStmt = infos[0];
	const globalStmt = infos[1];
	const callStmt = infos[2];
	const usedStmt = infos[4];
	assert.equal(a.statementsInfo.get(pureStmt).effects, false);
	assert.equal(a.statementsInfo.get(globalStmt).effects, true, 'global read is an effect');
	assert.equal(a.statementsInfo.get(callStmt).effects, true);
	assert.equal(a.statementsInfo.get(usedStmt).effects, false);
	assert.deepEqual([...a.statementsInfo.get(usedStmt).refs].map((b) => b.name).sort(), ['local', 'pure']);
});

test('pure-annotated and local pure function calls are not effects', () => {
	const a = analyzeModule(
		[
			'function pureHelper() { return 1; }',
			'const a = /*#__PURE__*/ makeThing();',
			'const b = pureHelper();',
			'const c = impure();'
		].join('\n'),
		'/m.js'
	);
	assert.equal(a.statementsInfo.get(a.statements[1]).effects, false);
	assert.equal(a.statementsInfo.get(a.statements[2]).effects, false);
	assert.equal(a.statementsInfo.get(a.statements[3]).effects, true);
});

test('detects constant violations including shorthand and destructuring', () => {
	const a = analyzeModule(
		['let count = 0;', 'count++;', '({ count } = other);', 'for (count of list) {}'].join('\n'),
		'/m.js'
	);
	const count = a.bindings.get('count');
	assert.equal(count.constantViolated, true);
	const violStarts = a.violationsByBinding.get(count).map((v) => v.node.start);
	assert.equal(violStarts.length, 3);
	const shorthandViol = a.violationsByBinding.get(count).find((v) => v.shorthandKey);
	assert.ok(shorthandViol, 'shorthand violation detected');
});

test('collects dynamic imports', () => {
	const a = analyzeModule('const p = import("./lazy.js");', '/m.js');
	assert.deepEqual(a.dynamicImports, ['./lazy.js']);
});

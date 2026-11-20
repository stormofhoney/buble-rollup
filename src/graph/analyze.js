'use strict';

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const PARSE_PLUGINS = ['jsx', 'decorators-legacy', 'importAttributes'];

/** Marker used in export lists for the synthesized default-export variable. */
const DEFAULT_LOCAL = '@default';

function parseCode(code) {
	return parser.parse(code, {
		sourceType: 'module',
		allowAwaitOutsideFunction: true,
		allowHashBang: true,
		plugins: PARSE_PLUGINS
	});
}

function endWithSemi(code, end) {
	return code[end] === ';' ? end + 1 : end;
}

function collectPatternIdents(node, out = []) {
	if (!node) return out;
	switch (node.type) {
		case 'Identifier':
			out.push(node);
			break;
		case 'ObjectPattern':
			for (const prop of node.properties) {
				if (prop.type === 'RestElement') collectPatternIdents(prop.argument, out);
				else collectPatternIdents(prop.value, out);
			}
			break;
		case 'ArrayPattern':
			for (const el of node.elements) collectPatternIdents(el, out);
			break;
		case 'AssignmentPattern':
			collectPatternIdents(node.left, out);
			break;
		case 'RestElement':
			collectPatternIdents(node.argument, out);
			break;
		default:
			break;
	}
	return out;
}

function declaredNames(declaration, out = []) {
	if (!declaration) return out;
	if (declaration.type === 'VariableDeclaration') {
		for (const d of declaration.declarations) collectPatternIdents(d.id, out);
	} else if (declaration.id) {
		out.push({ name: declaration.id.name, node: declaration.id });
	}
	return out;
}

function isRenameableReference(path) {
	const node = path.node;
	if (node.type !== 'Identifier' && node.type !== 'JSXIdentifier') return false;
	const parent = path.parent;
	if (!parent) return false;
	if (
		parent.type === 'ExportSpecifier' ||
		parent.type === 'ImportSpecifier' ||
		parent.type === 'ImportDefaultSpecifier' ||
		parent.type === 'ImportNamespaceSpecifier'
	) {
		return false;
	}
	// JSX attribute names are not variable references
	if (parent.type === 'JSXAttribute' && parent.name === node) return false;
	// object keys are not references (unless computed — then the key node is the expression itself)
	if (parent.type === 'ObjectProperty' && parent.key === node && !parent.computed) return false;
	if (parent.type === 'ObjectMethod' && parent.key === node && !parent.computed) return false;
	if (
		(parent.type === 'ClassProperty' || parent.type === 'ClassPrivateProperty') &&
		parent.key === node &&
		!parent.computed
	) {
		return false;
	}
	if (
		(parent.type === 'MethodDefinition' || parent.type === 'ClassMethod' || parent.type === 'ClassPrivateMethod') &&
		parent.key === node &&
		!parent.computed
	) {
		return false;
	}
	return true;
}

/** If the reference sits in a shorthand object property, returns its key node. */
function getShorthandKey(path) {
	let node = path.node;
	let parent = path.parentPath;
	if (parent && parent.node.type === 'AssignmentPattern' && parent.node.left === node) {
		node = parent.node;
		parent = parent.parentPath;
	}
	if (
		parent &&
		parent.node.type === 'ObjectProperty' &&
		parent.node.shorthand &&
		(parent.node.value === node || (parent.node.value && parent.node.value.left === node)) &&
		parent.node.key.type === 'Identifier'
	) {
		return parent.node.key;
	}
	return null;
}

function extractViolationIdents(path) {
	const out = [];
	const node = path.node;
	switch (node.type) {
		case 'AssignmentExpression':
			collectPatternIdents(node.left, out);
			break;
		case 'UpdateExpression':
			if (node.argument.type === 'Identifier') out.push(node.argument);
			break;
		case 'ForInStatement':
		case 'ForOfStatement':
			collectPatternIdents(node.left, out);
			break;
		case 'Identifier':
			out.push(node);
			break;
		default:
			collectPatternIdents(node, out);
			break;
	}
	return out;
}

function topLevelStatementOf(bindingPath) {
	let p = bindingPath;
	while (p.parentPath && p.parentPath.parentPath) {
		if (p.parentPath.parentPath.node.type === 'Program' || !p.parentPath.parentPath) break;
		p = p.parentPath;
	}
	// p is now a direct child of Program
	while (p.parentPath && p.parentPath.node.type !== 'Program') p = p.parentPath;
	return p.node;
}

function hasPureAnnotation(code, node) {
	if (!node) return false;
	const slice = code.slice(Math.max(0, node.start - 250), node.start);
	return /\/\*#\s*__PURE__\s*\*\/\s*$/.test(slice);
}

/**
 * Conservative side-effect classifier over Babel AST nodes.
 * Unknown node types are treated as effectful (safe default).
 */
function createEffectChecker(code, identPosMap, options) {
	const {
		annotations = true,
		propertyReadSideEffects = true,
		unknownGlobalSideEffects = true,
		manualPureFunctions = []
	} = options || {};
	const memo = new WeakMap();
	const purityCache = new WeakMap();
	const purityInProgress = new Set();

	function isLocalIdentifier(node) {
		return node.type === 'Identifier' && identPosMap.has(node.start);
	}

	function isManualPure(node) {
		return (
			node.type === 'Identifier' &&
			manualPureFunctions.length > 0 &&
			manualPureFunctions.includes(node.name)
		);
	}

	function effects(node) {
		if (!node) return false;
		const cached = memo.get(node);
		if (cached !== undefined) return cached;
		const result = computeEffects(node);
		memo.set(node, result);
		return result;
	}

	function computeEffects(node) {
		switch (node.type) {
			case 'Identifier':
				if (isLocalIdentifier(node) || isManualPure(node)) return false;
				return unknownGlobalSideEffects;
			case 'JSXIdentifier':
				return false;
			case 'StringLiteral':
			case 'NumericLiteral':
			case 'BooleanLiteral':
			case 'NullLiteral':
			case 'RegExpLiteral':
			case 'DecimalLiteral':
			case 'ThisExpression':
			case 'Super':
			case 'MetaProperty':
			case 'FunctionExpression':
			case 'ArrowFunctionExpression':
			case 'EmptyStatement':
				return false;
			case 'BigIntLiteral':
				return false;
			case 'FunctionDeclaration':
				return false;
			case 'ClassDeclaration':
				return classEffects(node);
			case 'VariableDeclaration':
				return node.declarations.some(
					(d) =>
						(d.init && effects(d.init)) ||
						patternHasEffects(d.id) ||
						patternComputedKeyEffects(d.id)
				);
			case 'ExpressionStatement':
				return effects(node.expression);
			case 'BlockStatement':
				return node.body.some((s) => effects(s));
			case 'IfStatement':
				return (
					effects(node.test) ||
					effects(node.consequent) ||
					(node.alternate ? effects(node.alternate) : false)
				);
			case 'ForStatement':
				return (
					(node.init && effects(node.init)) ||
					(node.test && effects(node.test)) ||
					(node.update && effects(node.update)) ||
					effects(node.body)
				);
			case 'ForInStatement':
			case 'ForOfStatement':
				return (
					(node.left.type === 'VariableDeclaration' &&
						node.left.declarations.some((d) => patternHasEffects(d.id))) ||
					effects(node.right) ||
					effects(node.body)
				);
			case 'WhileStatement':
			case 'DoWhileStatement':
				return effects(node.test) || effects(node.body);
			case 'SwitchStatement':
				return (
					effects(node.discriminant) ||
					node.cases.some((c) => c.consequent.some((s) => effects(s)))
				);
			case 'TryStatement':
				return (
					effects(node.block) ||
					(node.handler ? effects(node.handler.body) : false) ||
					(node.finalizer ? effects(node.finalizer) : false)
				);
			case 'ThrowStatement':
				return effects(node.argument);
			case 'ReturnStatement':
				return node.argument ? effects(node.argument) : false;
			case 'LabeledStatement':
				return effects(node.body);
			case 'BreakStatement':
			case 'ContinueStatement':
				return false;
			case 'DebuggerStatement':
				return true;
			case 'WithStatement':
				return true;
			case 'ClassExpression':
				return classEffects(node);
			case 'ObjectExpression': {
				for (const prop of node.properties) {
					if (prop.type === 'SpreadElement') return true; // iteration may trigger getters
					if (prop.computed && effects(prop.key)) return true;
					if (prop.type === 'ObjectMethod') continue; // bodies are not evaluated
					if (effects(prop.value)) return true;
				}
				return false;
			}
			case 'ArrayExpression':
				for (const el of node.elements) {
					if (el && effects(el)) return true;
				}
				return false;
			case 'SpreadElement':
			case 'RestElement':
				return true;
			case 'MemberExpression':
			case 'OptionalMemberExpression':
				return propertyReadSideEffects || effects(node.object);
			case 'CallExpression':
			case 'OptionalCallExpression':
				return callEffects(node);
			case 'NewExpression':
				if (annotations && hasPureAnnotation(code, node)) {
					return node.arguments.some((arg) => arg && effects(arg));
				}
				return true;
			case 'BinaryExpression':
			case 'LogicalExpression':
				return effects(node.left) || effects(node.right);
			case 'AssignmentExpression':
				return true;
			case 'UpdateExpression':
				return true;
			case 'UnaryExpression':
				if (node.operator === 'typeof') {
					return node.argument.type !== 'Identifier' && effects(node.argument);
				}
				if (node.operator === 'delete') return true;
				return effects(node.argument);
			case 'ConditionalExpression':
				return effects(node.test) || effects(node.consequent) || effects(node.alternate);
			case 'SequenceExpression':
				return node.expressions.some((e) => effects(e));
			case 'TemplateLiteral':
				return node.expressions.some((e) => effects(e));
			case 'TaggedTemplateExpression':
				return true;
			case 'AwaitExpression':
			case 'YieldExpression':
				return true;
			case 'ImportExpression':
				return true;
			case 'ParenthesizedExpression':
				return effects(node.expression);
			case 'TSAsExpression':
			case 'TSSatisfiesExpression':
			case 'TSNonNullExpression':
			case 'TSTypeAssertion':
				return effects(node.expression);
			case 'JSXElement':
			case 'JSXFragment':
				return jsxEffects(node);
			case 'TypeCastExpression':
				return effects(node.expression);
			default:
				return true;
		}
	}

	function jsxEffects(node) {
		// JSX compiles to calls — treat as effectful unless pure-annotated (buble handles JSX before this)
		return true;
	}

	function callEffects(node) {
		const callee = node.callee;
		if (annotations && hasPureAnnotation(code, node)) {
			return node.arguments.some((arg) => arg && effects(arg));
		}
		// Calls to known-pure local functions only evaluate their arguments
		if (callee.type === 'Identifier') {
			if (isManualPure(callee)) {
				return node.arguments.some((arg) => arg && effects(arg));
			}
			const binding = identPosMap.get(callee.start);
			if (binding && !binding.constantViolated && isPureFunction(binding)) {
				return node.arguments.some((arg) => arg && effects(arg));
			}
		}
		return true;
	}

	function isPureFunction(binding) {
		const decl = binding.functionNode;
		if (!decl) return false;
		if (purityInProgress.has(decl)) return false; // conservative with recursion
		const cached = purityCache.get(decl);
		if (cached !== undefined) return cached;
		purityInProgress.add(decl);
		let pure;
		try {
			pure = isPureFunctionNode(decl);
		} finally {
			purityInProgress.delete(decl);
		}
		purityCache.set(decl, pure);
		return pure;
	}

	function isPureFunctionNode(fn) {
		const body = fn.body;
		if (body.type !== 'BlockStatement') return !effects(body);
		return body.body.every((stmt) => isPureStatement(stmt));
	}

	function isPureStatement(stmt) {
		switch (stmt.type) {
			case 'VariableDeclaration':
				return stmt.declarations.every((d) => {
					if (d.init && effects(d.init)) return false;
					for (const ident of collectPatternIdents(d.id)) {
						// default values inside patterns
					}
					return !patternHasEffects(d.id);
				});
			case 'ReturnStatement':
				return !stmt.argument || !effects(stmt.argument);
			case 'ExpressionStatement':
				return !effects(stmt.expression);
			case 'EmptyStatement':
			case 'DebuggerStatement':
				return stmt.type === 'EmptyStatement';
			case 'BlockStatement':
				return stmt.body.every(isPureStatement);
			case 'IfStatement':
				return (
					!effects(stmt.test) &&
					isPureStatement(stmt.consequent) &&
					(!stmt.alternate || isPureStatement(stmt.alternate))
				);
			case 'FunctionDeclaration':
			case 'ClassDeclaration':
				return stmt.type === 'FunctionDeclaration' ? true : !classEffects(stmt);
			case 'LabeledStatement':
				return isPureStatement(stmt.body);
			case 'SwitchStatement':
				return (
					!effects(stmt.discriminant) &&
					stmt.cases.every((c) => c.consequent.every(isPureStatement))
				);
			default:
				return false;
		}
	}

	function patternComputedKeyEffects(pattern) {
		if (!pattern) return false;
		switch (pattern.type) {
			case 'ObjectPattern':
				return pattern.properties.some(
					(p) =>
						(p.computed && effects(p.key)) ||
						(p.type !== 'RestElement' && patternComputedKeyEffects(p.value))
				);
			case 'ArrayPattern':
				return pattern.elements.some((el) => patternComputedKeyEffects(el));
			case 'AssignmentPattern':
				return patternComputedKeyEffects(pattern.left);
			default:
				return false;
		}
	}

	function patternHasEffects(pattern) {
		if (!pattern) return false;
		switch (pattern.type) {
			case 'AssignmentPattern':
				return effects(pattern.right) || patternHasEffects(pattern.left);
			case 'ObjectPattern':
				return pattern.properties.some((p) => {
					if (p.type === 'RestElement') return true;
					if (p.computed && effects(p.key)) return true;
					return patternHasEffects(p.value);
				});
			case 'ArrayPattern':
				return pattern.elements.some((el) => patternHasEffects(el));
			default:
				return false;
		}
	}

	function classEffects(node) {
		if (node.decorators && node.decorators.length > 0) return true;
		return node.superClass ? effects(node.superClass) : false;
	}

	return { effects, isPureFunction, patternHasEffects, patternComputedKeyEffects, classEffects };
}

/**
 * Parses and analyses a module: imports, exports, top-level bindings,
 * per-statement references and side effects.
 */
function analyzeModule(code, id, treeshakeOptions) {
	const ast = parseCode(code);
	const program = ast.program;
	const statements = program.body;

	const bindings = new Map();
	const refsByBinding = new Map(); // binding name -> [{node, shorthandKey}]
	const violationsByBinding = new Map();

	let globalNames = new Set();
	traverse(ast, {
		Program(path) {
			globalNames = new Set(
				Array.isArray(path.scope.globals)
					? path.scope.globals.map((ref) => ref.identifier.name || ref.name)
					: Object.keys(path.scope.globals)
			);
			for (const [name, b] of Object.entries(path.scope.bindings)) {
				const binding = {
					name,
					kind: b.kind,
					identifier: b.identifier,
					statement: topLevelStatementOf(b.path),
					functionNode: null,
					constantViolated: false,
					importInfo: null,
					target: null, // { module, binding } for import bindings, set by the graph
					included: false,
					markIncluded: null
				};
				const fnPath = getFunctionPath(b.path, b.kind);
				if (fnPath) binding.functionNode = fnPath.node;

				const refs = [];
				for (const refPath of b.referencePaths) {
					if (!isRenameableReference(refPath)) continue;
					refs.push({
						node: refPath.node,
						shorthandKey: getShorthandKey(refPath),
						parent: refPath.parent,
						parentKey: refPath.parentKey
					});
				}
				const violations = [];
				for (const violPath of b.constantViolations) {
					binding.constantViolated = true;
					for (const ident of extractViolationIdents(violPath)) {
						violations.push({
							node: ident,
							shorthandKey: getShorthandKeyForIdent(ident, violPath),
							parent: ident.type === 'Identifier' ? findParentOfIdent(violPath.node, ident) : null
						});
					}
				}
				bindings.set(name, binding);
				refsByBinding.set(binding, refs);
				violationsByBinding.set(binding, violations);
			}
		}
	});
	// Position -> binding map for effect checking and statement reference collection
	const identPosMap = new Map();
	for (const [binding, refs] of refsByBinding) {
		identPosMap.set(binding.identifier.start, binding);
		for (const { node } of refs) identPosMap.set(node.start, binding);
		for (const { node } of violationsByBinding.get(binding)) identPosMap.set(node.start, binding);
	}

	// ---- imports ----
	const imports = [];
	for (const stmt of statements) {
		if (stmt.type !== 'ImportDeclaration') continue;
		const source = stmt.source.value;
		const specifiers = stmt.specifiers.map((spec) => {
			if (spec.type === 'ImportDefaultSpecifier') {
				return { kind: 'default', local: spec.local.name, node: spec };
			}
			if (spec.type === 'ImportNamespaceSpecifier') {
				return { kind: 'namespace', local: spec.local.name, node: spec };
			}
			return {
				kind: 'named',
				imported: spec.imported.type === 'StringLiteral' ? spec.imported.value : spec.imported.name,
				local: spec.local.name,
				node: spec
			};
		});
		for (const spec of specifiers) {
			const binding = bindings.get(spec.local);
			if (binding) {
				const imported =
					spec.kind === 'named' ? spec.imported : spec.kind === 'namespace' ? '*' : 'default';
				binding.importInfo = { source, imported };
			}
		}
		imports.push({
			node: stmt,
			source,
			specifiers,
			removalStart: stmt.start,
			removalEnd: endWithSemi(code, stmt.end)
		});
	}

	// ---- exports ----
	const exports = [];
	let defaultInfo = null;
	const reexportSources = [];
	for (const stmt of statements) {
		switch (stmt.type) {
			case 'ExportNamedDeclaration': {
				if (stmt.declaration) {
					for (const { name } of declaredNames(stmt.declaration)) {
						exports.push({ type: 'local', exported: name, local: name });
					}
					// remove only the `export ` keyword
					stmt._renderOp = { kind: 'strip-keyword', start: stmt.start, end: stmt.declaration.start };
				} else if (stmt.source) {
					const source = stmt.source.value;
					reexportSources.push(source);
					for (const spec of stmt.specifiers) {
						if (spec.type === 'ExportNamespaceSpecifier') {
							// `export * as ns from './x'` — Babel represents this as a named export
							exports.push({
								type: 'star-as',
								source,
								exported:
									spec.exported.type === 'StringLiteral' ? spec.exported.value : spec.exported.name
							});
						} else if (spec.type === 'ExportDefaultSpecifier') {
							exports.push({
								type: 'reexport',
								source,
								imported: 'default',
								exported:
									spec.exported.type === 'StringLiteral' ? spec.exported.value : spec.exported.name
							});
						} else {
							exports.push({
								type: 'reexport',
								source,
								imported:
									spec.local.type === 'StringLiteral' ? spec.local.value : spec.local.name,
								exported:
									spec.exported.type === 'StringLiteral' ? spec.exported.value : spec.exported.name
							});
						}
					}
					stmt._renderOp = { kind: 'remove', start: stmt.start, end: endWithSemi(code, stmt.end) };
				} else {
					for (const spec of stmt.specifiers) {
						exports.push({
							type: 'local',
							exported: spec.exported.type === 'StringLiteral' ? spec.exported.value : spec.exported.name,
							local: spec.local.name
						});
					}
					stmt._renderOp = { kind: 'remove', start: stmt.start, end: endWithSemi(code, stmt.end) };
				}
				break;
			}
			case 'ExportDefaultDeclaration': {
				const decl = stmt.declaration;
				if (
					(decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') &&
					decl.id
				) {
					exports.push({ type: 'local', exported: 'default', local: decl.id.name });
					defaultInfo = { kind: 'named-decl', statement: stmt, declaration: decl, localName: decl.id.name };
					stmt._renderOp = { kind: 'strip-keyword', start: stmt.start, end: decl.start };
				} else if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
					exports.push({ type: 'local', exported: 'default', local: DEFAULT_LOCAL });
					defaultInfo = {
						kind: decl.type === 'FunctionDeclaration' ? 'anon-fn' : 'anon-class',
						statement: stmt,
						declaration: decl
					};
					stmt._renderOp = { kind: 'anon-default', start: stmt.start, end: decl.start };
				} else if (decl.type === 'Identifier') {
					exports.push({ type: 'local', exported: 'default', local: decl.name });
					defaultInfo = { kind: 'identifier', statement: stmt, declaration: decl, localName: decl.name };
					stmt._renderOp = { kind: 'remove', start: stmt.start, end: endWithSemi(code, stmt.end) };
				} else {
					exports.push({ type: 'local', exported: 'default', local: DEFAULT_LOCAL });
					defaultInfo = { kind: 'expression', statement: stmt, declaration: decl };
					stmt._renderOp = { kind: 'expr-default', start: stmt.start, end: decl.start };
				}
				break;
			}
			case 'ExportAllDeclaration': {
				const source = stmt.source.value;
				reexportSources.push(source);
				if (stmt.exported) {
					exports.push({
						type: 'star-as',
						source,
						exported: stmt.exported.type === 'StringLiteral' ? stmt.exported.value : stmt.exported.name
					});
				} else {
					exports.push({ type: 'star', source });
				}
				stmt._renderOp = { kind: 'remove', start: stmt.start, end: endWithSemi(code, stmt.end) };
				break;
			}
			default:
				break;
		}
	}

	// ---- dynamic imports & import.meta ----
	const dynamicImports = [];
	let usesImportMeta = false;
	walk(program, (node) => {
		if (node.type === 'ImportExpression' && node.source && node.source.type === 'StringLiteral') {
			dynamicImports.push(node.source.value);
		}
		if (node.type === 'MetaProperty' && node.meta && node.meta.name === 'import') {
			usesImportMeta = true;
		}
	});

	// ---- per-statement info ----
	const { effects, isPureFunction, patternHasEffects, patternComputedKeyEffects, classEffects } = createEffectChecker(
		code,
		identPosMap,
		treeshakeOptions
	);

	const statementsInfo = new Map();
	for (const stmt of statements) {
		const declNames = new Set();
		const refs = new Set();
		for (const [binding, refList] of refsByBinding) {
			if (binding.statement === stmt) declNames.add(binding.name);
			for (const { node } of refList) {
				if (node.start >= stmt.start && node.end <= stmt.end) refs.add(binding);
			}
			for (const { node } of violationsByBinding.get(binding)) {
				if (node.start >= stmt.start && node.end <= stmt.end) refs.add(binding);
			}
		}
		const info = {
			node: stmt,
			declNames,
			refs,
			effects: statementEffects(stmt),
			declaratorEffects: null
		};
		if (stmt.type === 'VariableDeclaration') {
			info.declaratorEffects = new Map();
			for (const d of stmt.declarations) {
				info.declaratorEffects.set(
					d,
					(d.init && effects(d.init)) || patternHasEffects(d.id) || computedKeyEffects(d)
				);
			}
		}
		statementsInfo.set(stmt, info);
	}

	function computedKeyEffects(declarator) {
		return patternComputedKeyEffects(declarator.id);
	}

	function statementEffects(stmt) {
		switch (stmt.type) {
			case 'ImportDeclaration':
			case 'ExportAllDeclaration':
				return false; // module-level effects come from the imported module itself
			case 'ExportNamedDeclaration':
				return stmt.declaration ? effects(stmt.declaration) : false;
			case 'ExportDefaultDeclaration':
				return defaultInfo && defaultInfo.kind === 'identifier' ? false : effects(stmt.declaration);
			default:
				return effects(stmt);
		}
	}

	// Hook purity helpers into the binding objects for tree-shaking
	for (const binding of bindings.values()) {
		binding.isPureFunction = () => isPureFunction(binding);
	}

	return {
		id,
		code,
		ast,
		program,
		statements,
		statementsInfo,
		imports,
		exports,
		bindings,
		refsByBinding,
		violationsByBinding,
		identPosMap,
		defaultInfo,
		dynamicImports,
		usesImportMeta,
		reexportSources,
		globals: globalNames,
		hasDefaultExport: defaultInfo !== null
	};
}

function getFunctionPath(path, kind) {
	if (kind === 'hoisted' || kind === 'function') {
		if (path.node.type === 'FunctionDeclaration') return path;
		if (path.node.type === 'VariableDeclarator' && path.node.init) {
			const init = path.node.init;
			if (init.type === 'FunctionExpression' || init.type === 'ArrowFunctionExpression') {
				return { node: init };
			}
		}
		if (path.node.type === 'ClassDeclaration') return null;
	}
	if (kind === 'const' || kind === 'let' || kind === 'var') {
		if (path.node.type === 'VariableDeclarator') {
			const init = path.node.init;
			if (init && (init.type === 'FunctionExpression' || init.type === 'ArrowFunctionExpression')) {
				return { node: init };
			}
		}
	}
	return null;
}

function findParentOfIdent(root, ident) {
	let result = null;
	walk(root, (node, parent) => {
		if (node === ident) result = parent;
	});
	return result;
}

function getShorthandKeyForIdent(ident, violationPath) {
	// Search within the violation subtree for a shorthand ObjectProperty covering this ident
	const root = violationPath.node;
	if (root.start <= ident.start && root.end >= ident.end) {
		let found = null;
		walk(root, (node) => {
			if (found) return;
			if (
				node.type === 'ObjectProperty' &&
				node.shorthand &&
				node.key.type === 'Identifier' &&
				ident.start >= node.start &&
				ident.end <= node.end
			) {
				found = node.key;
			}
		});
		if (found) return found;
	}
	return null;
}

/** Generic AST walker over Babel nodes. */
function walk(node, callback, parent = null) {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const item of node) walk(item, callback, parent);
		return;
	}
	if (typeof node.type === 'string') callback(node, parent);
	for (const key of Object.keys(node)) {
		if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') {
			continue;
		}
		const value = node[key];
		if (value && typeof value === 'object') {
			walk(value, callback, typeof node.type === 'string' ? node : parent);
		}
	}
}

module.exports = {
	analyzeModule,
	parseCode,
	collectPatternIdents,
	declaredNames,
	walk,
	DEFAULT_LOCAL,
	endWithSemi
};

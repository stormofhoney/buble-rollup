'use strict';

const MagicString = require('magic-string');
const { relativeId } = require('../utils/pathcheck.js');
const {
	getSafeName,
	makeLegal,
	unescapeExportName,
	stringifyIdentifierIfNeeded,
	getGenerateCodeSnippets,
	RESERVED_NAMES
} = require('./snippets.js');
const {
	defaultInteropHelpersByInteropType,
	namespaceInteropHelpersByInteropType,
	isDefaultAProperty,
	canDefaultBeTakenFromNamespace,
	getHelpersBlock,
	HELPER_NAMES
} = require('./interop.js');

// --------------------------------------------------------------------- helpers

function basename(id) {
	const clean = id.split(/[/\\]/).pop() || id;
	return clean.replace(/\.[^.]*$/, '') || clean;
}

function guessIndentString(code) {
	const lines = code.split('\n');
	const tabbed = lines.filter((line) => /^\t+/.test(line));
	const spaced = lines.filter((line) => /^ {2,}/.test(line));
	if (tabbed.length === 0 && spaced.length === 0) return null;
	if (tabbed.length >= spaced.length) return '\t';
	const min = spaced.reduce((previous, current) => {
		const numberSpaces = /^ +/.exec(current)[0].length;
		return Math.min(numberSpaces, previous);
	}, Infinity);
	return ' '.repeat(min);
}

function getIndentString(modules, options) {
	if (options.indent !== true) return options.indent;
	for (const module of modules) {
		const indent = guessIndentString(module.code || '');
		if (indent !== null) return indent;
	}
	return '\t';
}

function getExportMode(exportKeys, exportOption, format, entry, name, onwarn) {
	let exportMode = exportOption;
	if (exportMode === 'default') {
		if (exportKeys.length !== 1 || exportKeys[0] !== 'default') {
			onwarn({
				code: 'INVALID_EXPORT_OPTION',
				message: `Entry module "${entry.relativeId}" cannot be exported as "default" because it ${exportKeys.length ? `has ${exportKeys.map((k) => `"${k}"`).join(', ')} exports` : 'has no exports'}`
			});
			return 'default';
		}
	} else if (exportMode === 'none' && exportKeys.length > 0) {
		onwarn({
			code: 'INVALID_EXPORT_OPTION',
			message: `Entry module "${entry.relativeId}" cannot be exported as "none" because it has ${exportKeys.map((k) => `"${k}"`).join(', ')} exports`
		});
		return 'none';
	}
	if (exportMode === 'auto') {
		if (exportKeys.length === 0) {
			exportMode = 'none';
		} else if (exportKeys.length === 1 && exportKeys[0] === 'default') {
			exportMode = 'default';
		} else {
			if (format !== 'es' && exportKeys.includes('default')) {
				onwarn({
					code: 'MIXED_EXPORTS',
					message: `Entry module "${entry.relativeId}" is using named and default exports together. Consumers of your bundle will have to use \`${name || 'chunk'}.default\` to access the default export, which may not be what you want. Use \`output.exports: "named"\` to disable this warning.`
				});
			}
			exportMode = 'named';
		}
	}
	return exportMode;
}

// ------------------------------------------------------------- render names

function computeRenderNames(graph, entry, outputOptions, format, onwarn) {
	const snippets = getGenerateCodeSnippets(outputOptions);
	const usedNames = new Set();
	// seed with globals used anywhere + helper names + format reserved words
	for (const module of graph.orderedModules) {
		for (const g of module.analysis.globals) usedNames.add(g);
	}
	for (const helper of HELPER_NAMES) usedNames.add(helper);
	if (format !== 'es') {
		usedNames.add('exports');
		usedNames.add('module');
		usedNames.add('require');
	}
	if (format === 'amd' || format === 'umd') usedNames.add('define');
	if (format === 'iife' || format === 'umd') usedNames.add('global');

	const reversed = [...graph.orderedModules].reverse();
	const interopFn = makeInteropGetter(outputOptions);

	// externals in first-use order (entry-first module scan)
	const dependencies = [];
	const depByExternal = new Map();
	for (const module of reversed) {
		for (const dep of module.externalDeps) {
			const ext = dep.externalModule;
			if (!depByExternal.has(ext)) {
				const paths = outputOptions.paths || {};
				const pathEntry = paths[ext.id];
				const importPath =
					typeof pathEntry === 'function' ? pathEntry(ext.id) : pathEntry || ext.id;
				depByExternal.set(ext, {
					external: ext,
					name: null,
					importPath,
					isChunk: false,
					namedExportsMode: true,
					namespaceVariableName: null,
					defaultVariableName: null,
					imports: [],
					reexports: []
				});
				dependencies.push(depByExternal.get(ext));
			}
		}
	}

	// external suggestions from default/namespace import locals (most common wins)
	for (const dep of dependencies) {
		const ext = dep.external;
		const votes = new Map();
		for (const module of graph.orderedModules) {
			for (const binding of module.analysis.bindings.values()) {
				const link = binding.importLink;
				if (
					!link ||
					link.external !== ext ||
					(link.imported !== 'default' && link.imported !== '*')
				)
					continue;
				votes.set(binding.name, (votes.get(binding.name) || 0) + 1);
			}
		}
		let suggested = null;
		let best = 0;
		for (const [name, count] of votes) {
			if (count > best) {
				best = count;
				suggested = name;
			}
		}
		const rawSuggested = makeLegal(suggested || basename(ext.id));
		ext.suggestedVariableName =
			format === 'es' ? rawSuggested : getSafeName(rawSuggested, usedNames, null);
	}

	// Phase A: top-level bindings, default vars, namespace objects (entry first)
	for (const module of reversed) {
		const analysis = module.analysis;
		for (const binding of analysis.bindings.values()) {
			if (!binding.included || binding.importLink) continue;
			binding.renderName = getSafeName(binding.name, usedNames, null);
		}
		// default variable
		if (analysis.defaultInfo) {
			const info = analysis.defaultInfo;
			if (info.kind === 'identifier' || info.kind === 'named-decl') {
				const localBinding = analysis.bindings.get(info.localName);
				module.defaultVarRenderName = localBinding ? localBinding.renderName : null;
			} else {
				const base = makeLegal(basename(module.id));
				module.defaultVarRenderName = usedNames.has(base)
					? getSafeName(`${base}_default`, usedNames, null)
					: getSafeName(base, usedNames, null);
			}
		}
		// namespace object variable
		if (module.namespaceVariableIncluded) {
			const base = makeLegal(module.namespaceBaseName || basename(module.id));
			module.namespaceRenderName = getSafeName(base, usedNames, null);
		}
	}

	// mutable export aliasing for non-es formats
	if (format !== 'es') {
		const exportNameByBinding = new Map();
		const names = graph.collectExportNames(entry);
		for (const name of names) {
			const resolved = graph.resolveExport(entry, name);
			if (resolved && resolved.binding) {
				if (!exportNameByBinding.has(resolved.binding)) {
					exportNameByBinding.set(resolved.binding, name);
				}
			}
		}
		for (const module of reversed) {
			for (const binding of module.analysis.bindings.values()) {
				if (!binding.included || binding.renderName == null) continue;
				if (!binding.constantViolated) continue;
				const exportedName = exportNameByBinding.get(binding);
				if (exportedName == null) continue;
				// only for simple identifier declarations (single declarator)
				const stmt = binding.statement;
				const simple =
					stmt &&
					((stmt.type === 'VariableDeclaration' && stmt.declarations.length === 1) ||
						(stmt.type === 'ExportNamedDeclaration' &&
							stmt.declaration &&
							stmt.declaration.type === 'VariableDeclaration' &&
							stmt.declaration.declarations.length === 1));
				if (simple && binding.identifier.type === 'Identifier') {
					binding.renderName = `exports${snippets.getPropertyAccess(unescapeExportName(exportedName))}`;
					binding.exportsAliased = true;
				}
			}
		}
	}

	// Phase B: external render names per format
	if (format === 'es') {
		for (const dep of dependencies) {
			const ext = dep.external;
			const used = ext.usedExternalImports;
			if (used && used.namespace.size) {
				ext.renderName = getSafeName(ext.suggestedVariableName, usedNames, null);
			}
			// default/named claimed lazily per import below
		}
	} else {
		for (const dep of dependencies) {
			const ext = dep.external;
			const used = ext.usedExternalImports;
			dep.name = ext.suggestedVariableName; // already claimed in suggestions pass
			if (used && used.namespace.size) {
				dep.namespaceVariableName = getSafeName(
					`${ext.suggestedVariableName}__namespace`,
					usedNames,
					null
				);
				ext.namespaceRenderName = dep.namespaceVariableName;
			}
			if (used && used.default.size) {
				const interopType = interopFn(ext.id);
				if (
					dep.namespaceVariableName &&
					canDefaultBeTakenFromNamespace(interopType, outputOptions.externalLiveBindings !== false)
				) {
					dep.defaultVariableName = dep.namespaceVariableName;
				} else {
					dep.defaultVariableName = getSafeName(
						`${ext.suggestedVariableName}__default`,
						usedNames,
						null
					);
				}
				ext.defaultVariableName = dep.defaultVariableName;
			}
		}
	}

	// import binding render names
	const externalVarByImported = (ext) => {
		if (!ext._vars) ext._vars = new Map();
		return ext._vars;
	};
	for (const module of reversed) {
		for (const binding of module.analysis.bindings.values()) {
			const link = binding.importLink;
			if (!link || !binding.included) continue;
			if (link.external) {
				const ext = link.external;
				const imported = link.imported;
				if (imported === '*') {
					binding.renderName =
						format === 'es'
							? ext.renderName || ext.suggestedVariableName
							: ext.namespaceRenderName || ext.suggestedVariableName;
				} else if (imported === 'default') {
					if (format === 'es') {
						const vars = externalVarByImported(ext);
						if (!vars.has('default')) {
							vars.set(
								'default',
								getSafeName(ext.suggestedVariableName, usedNames, null)
							);
						}
						binding.renderName = vars.get('default');
						binding.renderProp = null;
					} else {
						const interopType = interopFn(ext.id);
						if (isDefaultAProperty(interopType, outputOptions.externalLiveBindings !== false)) {
							binding.renderName = ext.defaultVariableName || ext.suggestedVariableName;
							binding.renderProp = 'default';
						} else {
							binding.renderName =
								(defaultInteropHelpersByInteropType[interopType]
									? ext.defaultVariableName
									: null) || ext.suggestedVariableName;
							binding.renderProp = null;
						}
					}
				} else {
					if (format === 'es') {
						const vars = externalVarByImported(ext);
						if (!vars.has(imported)) {
							vars.set(imported, getSafeName(makeLegal(imported), usedNames, null));
						}
						binding.renderName = vars.get(imported);
						binding.renderProp = null;
					} else {
						binding.renderName = ext.suggestedVariableName;
						binding.renderProp = unescapeExportName(imported);
					}
				}
			} else if (link.namespaceModule) {
				binding.renderName = link.namespaceModule.namespaceRenderName;
				binding.renderProp = null;
			} else if (link.binding) {
				binding.renderName = link.binding.renderName;
				binding.renderProp = null;
			} else if (link.defaultVar) {
				binding.renderName = link.module.defaultVarRenderName;
				binding.renderProp = null;
			}
		}
	}

	// namespace member replacements referencing externals need vars too
	for (const module of graph.orderedModules) {
		for (const rep of module.namespaceReplacements) {
			const resolved = rep.resolved;
			if (!resolved || !resolved.external) continue;
			const ext = resolved.external;
			const imported = resolved.imported;
			if (format === 'es') {
				const vars = externalVarByImported(ext);
				if (!vars.has(imported)) {
					vars.set(imported, getSafeName(makeLegal(imported), usedNames, null));
				}
				rep.renderText = vars.get(imported);
			} else {
				rep.renderText = `${ext.suggestedVariableName}${snippets.getPropertyAccess(unescapeExportName(imported))}`;
			}
		}
	}

	// dependency reexports for export blocks
	for (const dep of dependencies) {
		const used = dep.external.usedExternalImports;
		if (!used) continue;
		for (const reexport of used.reexports) {
			dep.reexports.push({
				imported: reexport.type === 'star' ? '*' : reexport.imported || '*',
				reexported: reexport.exported || '*',
				needsLiveBinding:
					reexport.type === 'named'
						? outputOptions.externalLiveBindings !== false
						: false
			});
		}
		dep.imports = [];
		if (used.default.size) dep.imports.push({ imported: 'default', reexported: '*' });
		if (used.namespace.size) {
			// a plain namespace import (not `export * from`): reexported is the local name
			dep.imports.push({ imported: '*', reexported: dep.name || 'namespace' });
		}
	}

	return { snippets, usedNames, dependencies, interopFn };
}

function makeInteropGetter(outputOptions) {
	const cache = new Map();
	const raw = outputOptions.interop;
	return (id) => {
		if (cache.has(id)) return cache.get(id);
		let result;
		if (typeof raw === 'function') result = raw(id);
		else if (raw == null) result = 'default';
		else result = raw;
		cache.set(id, result);
		return result;
	};
}

// ------------------------------------------------------------------ rendering

function renderNamespaceObject(module, graph, snippets, format) {
	const name = module.namespaceRenderName;
	const names = [...graph.collectExportNames(module)].sort();
	const fields = [[null, '__proto__: null']];
	for (const exported of names) {
		const resolved = graph.resolveExport(module, exported);
		if (!resolved) continue;
		if (resolved.external) continue; // external members are not inlined
		let value = null;
		let getter = false;
		if (resolved.binding) {
			value = resolved.binding.renderName;
			getter = !!resolved.binding.constantViolated;
		} else if (resolved.defaultVar) {
			value = module.defaultVarRenderName;
		} else if (resolved.namespaceOf) {
			value = resolved.namespaceOf.namespaceRenderName;
		}
		if (value == null) continue;
		const key = exported;
		if (getter) {
			fields.push([
				null,
				`get${snippets._}${key}${snippets._}()${snippets._}{${snippets._}return ${value};${snippets._}}`
			]);
		} else {
			fields.push([key, value]);
		}
	}
	const obj = snippets.getObject(fields, { lineBreakIndent: { base: '', t: '\t' } });
	return `${snippets.cnst} ${name} = /*#__PURE__*/Object.freeze(${obj});${snippets.n}`;
}

function firstLineBreakAfter(text) {
	// port of rollup's findFirstLineBreakOutsideComment: returns the offset
	// just past the first newline that is not inside a comment, or 0
	let lineBreakPos = text.indexOf('\n');
	let start = 0;
	while (true) {
		start = text.indexOf('/', start);
		if (start === -1 || start > lineBreakPos) return lineBreakPos + 1 > 0 ? lineBreakPos + 1 : 0;
		if (text[start + 1] === '/') return lineBreakPos + 1 > 0 ? lineBreakPos + 1 : 0;
		const close = text.indexOf('*/', start + 2);
		if (close === -1) return lineBreakPos + 1 > 0 ? lineBreakPos + 1 : 0;
		start = close + 2;
		if (start > lineBreakPos) lineBreakPos = text.indexOf('\n', start);
	}
}

// port of rollup's ChildScope.deconflict for nested scopes: each scope
// (functions and blocks, pre-order) deconflicts its own bindings against
// free names accessed from that scope plus the synthetic `arguments`/`this`
// variables that FunctionScope always declares first.
function deconflictNestedBindings(analysis, removedRanges) {
	const scopes = analysis.nestedScopes;
	if (!scopes || scopes.length === 0) return;
	const thisExprs = analysis.thisExprs || [];
	const argRefs = analysis.argRefs || [];

	const scopeByFnNode = new Map();
	for (const s of scopes) {
		if (s.isFunction) scopeByFnNode.set(s.node, s);
	}

	// innermost collected scope containing a position (pre-order => later = deeper)
	const scopeOfPos = (start, end) => {
		let found = null;
		for (const s of scopes) {
			if (s.node.start <= start && end <= s.node.end) found = s;
		}
		return found;
	};
	const isRemoved = (node) =>
		removedRanges.some(([s, e]) => node.start >= s && node.end <= e);

	// free-name entries per scope: a name referenced inside S that resolves
	// outside S (rollup's accessedOutsideVariables)
	const freeByScope = new Map();
	const addFree = (S, entry) => {
		if (!S) return;
		let list = freeByScope.get(S);
		if (!list) freeByScope.set(S, (list = []));
		list.push(entry);
	};
	const ownerOf = new Map(); // binding -> owning scope or null (top-level)
	for (const s of scopes) {
		for (const b of s.bindings) ownerOf.set(b, s);
	}
	const topBindings = [...analysis.bindings.values()];
	for (const b of topBindings) ownerOf.set(b, null);

	for (const b of [...topBindings, ...scopes.flatMap((s) => s.bindings)]) {
		if (isRemoved(b.identifier)) continue;
		const refs = b.refs || analysis.refsByBinding.get(b) || [];
		const viols = b.violations || analysis.violationsByBinding.get(b) || [];
		for (const r of refs) {
			if (!r.node || isRemoved(r.node)) continue;
			const S = scopeOfPos(r.node.start, r.node.end);
			if (S && S !== ownerOf.get(b)) addFree(S, { binding: b });
		}
		for (const v of viols) {
			if (!v.node || isRemoved(v.node)) continue;
			const S = scopeOfPos(v.node.start, v.node.end);
			if (S && S !== ownerOf.get(b)) addFree(S, { binding: b });
		}
	}
	// `this`/`arguments` free in a child scope resolve to the owning
	// function's synthetic variable (renderName set when that fn was processed)
	for (const t of thisExprs) {
		const S = scopeOfPos(t.start, t.end);
		const fnScope = t.fnNode ? scopeByFnNode.get(t.fnNode) : null;
		if (S && fnScope && S !== fnScope) addFree(S, { thisFrom: fnScope });
	}
	for (const a of argRefs) {
		const S = scopeOfPos(a.start, a.end);
		const fnScope = a.fnNode ? scopeByFnNode.get(a.fnNode) : null;
		if (S && fnScope && S !== fnScope) addFree(S, { argsFrom: fnScope });
	}

	// process scopes pre-order (parents before children)
	for (const S of scopes) {
		const usedNames = new Set();
		for (const entry of freeByScope.get(S) || []) {
			if (entry.binding) {
				usedNames.add(
					entry.binding.renderName != null
						? entry.binding.renderName
						: entry.binding.name
				);
			} else if (entry.thisFrom && entry.thisFrom.thisRenderName) {
				usedNames.add(entry.thisFrom.thisRenderName);
			} else if (entry.argsFrom && entry.argsFrom.argsRenderName) {
				usedNames.add(entry.argsFrom.argsRenderName);
			}
		}
		if (S.isFunction) {
			// FunctionScope always declares `arguments` then `this` first;
			// getSafeName renames `this` (reserved) to `this$1` which then
			// occupies that name for real bindings in this scope
			if (argRefs.some((a) => a.fnNode === S.node)) {
				S.argsRenderName = getSafeName('arguments', usedNames, null);
			}
			if (thisExprs.some((t) => t.fnNode === S.node)) {
				S.thisRenderName = getSafeName('this', usedNames, null);
			}
		}
		for (const b of S.bindings) {
			b.renderName = getSafeName(b.name, usedNames, null);
		}
	}
}

function fixEmptyIfBranches(node, ms, source, isIfAlternate) {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const child of node) fixEmptyIfBranches(child, ms, source, false);
		return;
	}
	if (typeof node.type !== 'string') return;
	if (node.type === 'IfStatement') {
		const cons = node.consequent;
		if (cons && cons.type === 'BlockStatement' && cons.body.length === 0) {
			ms.overwrite(cons.start, cons.end, ';');
		}
		if (node.alternate) {
			const alt = node.alternate;
			if (alt.type === 'BlockStatement' && alt.body.length === 0) {
				// rollup shouldKeepAlternateBranch: keep `;` when this if is
				// itself an alternate of an outer if (else-if chains)
				if (isIfAlternate) {
					ms.overwrite(alt.start, node.end, ';');
				} else if (cons) {
					ms.remove(cons.end, node.end);
				}
			}
		}
	}
	for (const key of Object.keys(node)) {
		if (
			key === 'type' ||
			key === 'start' ||
			key === 'end' ||
			key === 'loc' ||
			key === 'range' ||
			key === 'parent' ||
			key === 'scope' ||
			key === 'leadingComments' ||
			key === 'trailingComments' ||
			key === 'comments'
		) {
			continue;
		}
		fixEmptyIfBranches(node[key], ms, source, key === 'alternate' && node.type === 'IfStatement');
	}
}

function statementNeedsSemicolon(node, parent, source) {
	if (source[node.end - 1] === ';') return false;
	if (node.type === 'ExpressionStatement') return true;
	if (node.type === 'VariableDeclaration') {
		if (parent) {
			if (
				(parent.type === 'ForStatement' && parent.init === node) ||
				((parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') &&
					parent.left === node) ||
				parent.type === 'ExportNamedDeclaration'
			) {
				return false;
			}
		}
		return true;
	}
	if (node.type === 'ExportNamedDeclaration') {
		return !!node.declaration && node.declaration.type === 'VariableDeclaration';
	}
	if (node.type === 'ExportDefaultDeclaration') {
		const d = node.declaration;
		return !(d && (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration'));
	}
	return false;
}

// rollup appends a semicolon to expression/variable/default-export
// statements whose source does not already end with one, at every level
function appendStatementSemicolons(node, parent, source, ms, removedRanges) {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const child of node) {
			appendStatementSemicolons(child, parent, source, ms, removedRanges);
		}
		return;
	}
	if (typeof node.type !== 'string') return;
	if (
		typeof node.start === 'number' &&
		removedRanges.some(([s, e]) => node.start >= s && node.end <= e)
	) {
		return;
	}
	if (statementNeedsSemicolon(node, parent, source)) {
		ms.appendLeft(node.end, ';');
	}
	for (const key of Object.keys(node)) {
		if (
			key === 'type' ||
			key === 'start' ||
			key === 'end' ||
			key === 'loc' ||
			key === 'range' ||
			key === 'parent' ||
			key === 'scope' ||
			key === 'leadingComments' ||
			key === 'trailingComments' ||
			key === 'comments'
		) {
			continue;
		}
		appendStatementSemicolons(node[key], node, source, ms, removedRanges);
	}
}

function renderModule(module, graph, format, snippets, options) {
	const analysis = module.analysis;
	const ms = new MagicString(module.transformedCode || module.code);
	const treeshakeOff = options.treeshake === false;

	// 1. remove excluded statements / filter declarators
	// Region model ported from rollup's renderStatementList: an excluded
	// statement is removed from the previous statement's end (up to the
	// first line break) through its own end (plus first line break), so
	// comments attached to removed statements are swallowed. Leading file
	// comment lines are preserved like rollup's Program.render.
	const source = module.transformedCode || module.code;
	const stmts = analysis.statements;
	const removedRanges = [];
	let regionStart = 0;
	if (stmts.length > 0) {
		while (source[regionStart] === '/' && /[*/]/.test(source[regionStart + 1] || '')) {
			const off = firstLineBreakAfter(source.slice(regionStart, stmts[0].start));
			if (!off) break;
			regionStart += off;
		}
	}
	for (let si = 0; si < stmts.length; si++) {
		const stmt = stmts[si];
		const nextStart = si + 1 < stmts.length ? stmts[si + 1].start : source.length;
		const included = module.includedStatements.has(stmt);
		const absStart = regionStart + firstLineBreakAfter(source.slice(regionStart, stmt.start));
		const absEnd = stmt.end + firstLineBreakAfter(source.slice(stmt.end, nextStart));
		if (stmt.type === 'ImportDeclaration') {
			// rollup's ImportDeclaration.needsBoundaries: removal always spans
			// the statement's region (swallowing comments in the gaps)
			ms.remove(absStart, absEnd);
			removedRanges.push([absStart, absEnd]);
			regionStart = stmt.end;
			continue;
		}
		let effectiveIncluded = included;
		if (
			included &&
			(stmt.type === 'VariableDeclaration' ||
				(stmt.type === 'ExportNamedDeclaration' &&
					stmt.declaration &&
					stmt.declaration.type === 'VariableDeclaration'))
		) {
			const inner =
				stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
			const keepSet = module.includedDeclarators.get(stmt);
			const keep = inner.declarations.filter(
				(d) => !keepSet || keepSet.has(d) || treeshakeOff
			);
			if (keep.length < inner.declarations.length && keep.length > 0) {
				// remove excluded declarators together with one adjacent comma
				for (const d of inner.declarations) {
					if (keep.includes(d)) continue;
					let start = d.start;
					let end = d.end;
					const before = source.slice(inner.start, d.start);
					const commaIdx = before.lastIndexOf(',');
					if (commaIdx !== -1) {
						start = inner.start + commaIdx;
					} else {
						const after = source.slice(d.end, inner.end);
						const nextComma = after.indexOf(',');
						if (nextComma !== -1) end = d.end + nextComma + 1;
					}
					ms.remove(start, end);
					removedRanges.push([start, end]);
				}
			} else if (keep.length === 0) {
				effectiveIncluded = false;
			}
		}
		if (!effectiveIncluded) {
			ms.remove(absStart, absEnd);
			removedRanges.push([absStart, absEnd]);
			regionStart = stmt.end;
			continue;
		}
		regionStart = stmt.end;
	}

	// 2. export operations
	for (const stmt of analysis.statements) {
		if (!module.includedStatements.has(stmt)) continue;
		const op = stmt._renderOp;
		if (!op) continue;
		if (op.kind === 'strip-keyword') {
			ms.remove(op.start, op.end);
		} else if (op.kind === 'remove') {
			ms.remove(op.start, op.end);
		} else if (op.kind === 'anon-default') {
			const defaultInfo = analysis.defaultInfo;
			const name =
				module.defaultVarRenderName || 'default';
			// insert name after keyword (`function`/`class`)
			const kwEnd = op.end;
			ms.appendRight(kwEnd, ` ${name}`);
		} else if (op.kind === 'expr-default') {
			ms.appendLeft(op.start, `${snippets.cnst} ${module.defaultVarRenderName} = `);
			ms.remove(op.start, op.end);
		}
	}

	// nested scope deconfliction needs removedRanges (loop 1) and runs before
	// renames are applied; top-level names were set by computeRenderNames
	deconflictNestedBindings(analysis, removedRanges);

	// 3. binding renames
	const renderIdText = (binding) =>
		binding.renderProp != null
			? `${binding.renderName}${snippets.getPropertyAccess(binding.renderProp)}`
			: binding.renderName;

	const refsOf = (b) => b.refs || analysis.refsByBinding.get(b) || [];
	const violationsOf = (b) =>
		b.violations || analysis.violationsByBinding.get(b) || [];
	const allBindings = [...analysis.bindings.values()];
	for (const scope of analysis.nestedScopes || []) {
		allBindings.push(...scope.bindings);
	}
	for (const binding of allBindings) {
		if (!binding.included || binding.renderName == null) continue;
		if (
			binding.refs &&
			removedRanges.some(
				([s, e]) => binding.identifier.start >= s && binding.identifier.end <= e
			)
		) {
			continue;
		}
		const original = binding.name;
		const text = renderIdText(binding);
		if (binding.exportsAliased && binding.renderName.startsWith('exports')) {
			// declaration renders as an assignment without the kind keyword
			const stmt = binding.statement;
			const inner =
				stmt && stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
			if (
				inner &&
				inner.type === 'VariableDeclaration' &&
				inner.declarations.length === 1 &&
				inner.declarations[0].id === binding.identifier
			) {
				// remove `let `/`const `/`var ` between declaration start and identifier
				ms.remove(inner.start, binding.identifier.start);
				ms.overwrite(binding.identifier.start, binding.identifier.end, binding.renderName);
			}
			// other refs
			for (const ref of refsOf(binding)) {
				applyRef(ms, ref, text, snippets, binding);
			}
			for (const v of violationsOf(binding)) {
				if (v.node.type !== 'Identifier') continue;
				// assignments to aliased exports: `exports.a = ...` handled via renderName text
				ms.overwrite(v.node.start, v.node.end, text);
			}
			continue;
		}
		if (text !== original) {
			for (const ref of refsOf(binding)) {
				applyRef(ms, ref, text, snippets, binding);
			}
			for (const v of violationsOf(binding)) {
				if (v.node.type === 'Identifier') {
					ms.overwrite(v.node.start, v.node.end, text);
				}
			}
			// declaration identifier
			if (
				binding.identifier &&
				binding.identifier.start >= (binding.statement ? binding.statement.start : 0) &&
				(binding.kind === 'const' ||
					binding.kind === 'let' ||
					binding.kind === 'var' ||
					binding.kind === 'function' ||
					binding.kind === 'class' ||
					binding.kind === 'hoisted' ||
					binding.kind === 'param')
			) {
				const id = binding.identifier;
				// only if it's the declared name (not a reference)
				const isDeclaration =
					binding.statement &&
					id.start >= binding.statement.start &&
					id.end <= binding.statement.end &&
					(id.type === 'Identifier') &&
					!isReferencePosition(analysis, binding, id);
				if (isDeclaration) {
					ms.overwrite(id.start, id.end, binding.renderName);
				}
			}
		}
	}

	// 4. namespace member replacements
	for (const rep of module.namespaceReplacements) {
		let text;
		if (rep.resolved == null) {
			text = 'undefined';
		} else if (rep.renderText != null) {
			text = rep.renderText;
		} else if (rep.resolved.binding) {
			text = rep.resolved.binding.renderName;
		} else if (rep.resolved.defaultVar) {
			text = rep.resolved.module.defaultVarRenderName;
		} else if (rep.resolved.namespaceOf) {
			text = rep.resolved.namespaceOf.namespaceRenderName;
		} else {
			text = 'undefined';
		}
		ms.overwrite(rep.start, rep.end, text);
	}

	// 5. missing import targets -> undefined refs are already unrendered bindings
	//    (binding.importLink === null keeps original name which does not exist) —
	//    rewrite those refs to `undefined`
	for (const binding of analysis.bindings.values()) {
		if (!binding.importInfo || binding.importLink !== null || !binding.included) continue;
		for (const ref of analysis.refsByBinding.get(binding) || []) {
			applyRef(ms, ref, 'undefined', snippets, binding);
		}
	}

	// 6. append namespace object
	if (module.namespaceVariableIncluded && module.namespaceRenderName) {
		ms.append(`\n\n${renderNamespaceObject(module, graph, snippets, format)}`);
	}

	// empty if-branches (rollup IfStatement.render overwrites them with `;`)
	if (!treeshakeOff) {
		for (const stmt of analysis.statements) {
			if (!module.includedStatements.has(stmt)) continue;
			fixEmptyIfBranches(stmt, ms, source, false);
		}
	}

	// semicolons for all kept statements (every nesting level); runs after all
	// renames so appendLeft content is not cleared by overwrites
	for (const stmt of analysis.statements) {
		if (!module.includedStatements.has(stmt)) continue;
		appendStatementSemicolons(stmt, null, source, ms, removedRanges);
	}

	let code = ms.toString().trim();
	return code;
}

function isReferencePosition(analysis, binding, id) {
	for (const ref of binding.refs || analysis.refsByBinding.get(binding) || []) {
		if (ref.node === id) return true;
	}
	for (const v of binding.violations || analysis.violationsByBinding.get(binding) || []) {
		if (v.node === id) return true;
	}
	return false;
}

function applyRef(ms, ref, text, snippets, binding) {
	const { node, shorthandKey, parent } = ref;
	if (shorthandKey && node === shorthandKey) return;
	if (shorthandKey && parent && parent.type === 'ObjectProperty' && parent.shorthand) {
		// expand `key: value`
		ms.overwrite(node.start, node.end, `${shorthandKey.name}: ${text}`);
		return;
	}
	ms.overwrite(node.start, node.end, text);
}

// --------------------------------------------------------------- finalisers

function buildEntryExportList(graph, entry, format) {
	const names = [...graph.collectExportNames(entry)].sort();
	const list = [];
	for (const exported of names) {
		const resolved = graph.resolveExport(entry, exported);
		if (!resolved) continue;
		let local = null;
		let external = null;
		let imported = null;
		if (resolved.binding) local = resolved.binding.renderName;
		else if (resolved.defaultVar) local = entry.defaultVarRenderName;
		else if (resolved.namespaceOf)
			local = resolved.namespaceOf.namespaceRenderName;
		else if (resolved.external) {
			external = resolved.external;
			imported = resolved.imported;
		}
		list.push({ exported, local, external, imported });
	}
	return list;
}

function getExportBlockCjs(exportsList, dependencies, namedExportsMode, snippets, interopFn, options, format) {
	const { _, n, s, getFunctionIntro, getPropertyAccess } = snippets;
	if (!namedExportsMode) {
		if (exportsList.length > 0 && exportsList[0].local) {
			const mechanism = format === 'cjs' ? 'module.exports = ' : 'return ';
			return `${n}${n}${mechanism}${exportsList[0].local};`;
		}
		return '';
	}
	let exportBlock = '';

	// external reexports
	for (const dep of dependencies) {
		if (!dep.reexports || !dep.reexports.length) continue;
		for (const specifier of dep.reexports) {
			if (specifier.reexported === '*') continue;
			const importName = getReexportedImportName(dep, specifier.imported, interopFn, options);
			if (exportBlock) exportBlock += n;
			if (specifier.imported !== '*' && specifier.needsLiveBinding) {
				exportBlock += `Object.defineProperty(exports,${_}${JSON.stringify(
					unescapeExportName(specifier.reexported)
				)},${_}${getGetter(importName, false, snippets)});`;
			} else {
				exportBlock += `exports${getPropertyAccess(
					unescapeExportName(specifier.reexported)
				)}${_}=${_}${importName};`;
			}
		}
	}

	for (const { exported, local, needsLiveBinding } of exportsList) {
		if (local == null) continue;
		const lhs = `exports${getPropertyAccess(unescapeExportName(exported))}`;
		const rhs = local;
		if (lhs !== rhs) {
			if (exportBlock) exportBlock += n;
			if (needsLiveBinding) {
				exportBlock += `Object.defineProperty(exports,${_}${JSON.stringify(
					unescapeExportName(exported)
				)},${_}${getGetter(rhs, true, snippets)});`;
			} else {
				exportBlock += `${lhs}${_}=${_}${rhs};`;
			}
		}
	}

	// star reexports from externals
	for (const dep of dependencies) {
		if (!dep.reexports) continue;
		for (const specifier of dep.reexports) {
			if (specifier.reexported !== '*') continue;
			if (exportBlock) exportBlock += n;
			const copyPropertyIfNecessary = `{${n}\tif${_}(k${_}!==${_}'default'${_}&&${_}!Object.prototype.hasOwnProperty.call(exports,${_}k))${_}${getDefineProperty(
				dep.name,
				specifier.needsLiveBinding,
				snippets
			)}${s}${n}}`;
			exportBlock += `Object.keys(${dep.name}).forEach(${getFunctionIntro(['k'], {
				isAsync: false,
				name: null
			})}${copyPropertyIfNecessary});`;
		}
	}

	if (exportBlock) return `${n}${n}${exportBlock}`;
	return '';
}

function getReexportedImportName(dep, imported, interopFn, options) {
	const { getPropertyAccess } = { getPropertyAccess: (n) => (VALID(n) ? `.${n}` : `[${JSON.stringify(n)}]`) };
	if (imported === 'default') {
		const moduleInterop = interopFn(dep.importPath);
		const variableName = defaultInteropHelpersByInteropType[moduleInterop]
			? dep.defaultVariableName
			: dep.name;
		return isDefaultAProperty(moduleInterop, options.externalLiveBindings !== false)
			? `${variableName}.default`
			: variableName;
	}
	if (imported === '*') {
		return namespaceInteropHelpersByInteropType[interopFn(dep.importPath)]
			? dep.namespaceVariableName
			: dep.name;
	}
	return `${dep.name}${getPropertyAccess(unescapeExportName(imported))}`;
}

function VALID(name) {
	return /^[$_a-zA-Z][\w$]*$/.test(name);
}

function getGetter(expression, configurable, snippets) {
	const { _, getDirectReturnFunction, getObject } = snippets;
	const [left, right] = getDirectReturnFunction([], {
		functionReturn: true,
		lineBreakIndent: null,
		name: null
	});
	const fields = [
		['enumerable', 'true'],
		['get', `${left}${expression}${right}`]
	];
	if (configurable) fields.unshift(['configurable', 'true']);
	return getObject(fields, { lineBreakIndent: { base: '', t: '\t' } });
}

function getDefineProperty(name, needsLiveBinding, snippets) {
	const { _ } = snippets;
	if (needsLiveBinding) {
		return `Object.defineProperty(exports,${_}k,${_}${getGetter(`${name}[k]`, false, snippets)}`;
	}
	return `exports[k]${_}=${_}${name}[k]`;
}

function getNamespaceMarkers(hasNamedExports, addEsModule, snippets) {
	const { _, getObject } = snippets;
	if (hasNamedExports && addEsModule) {
		return `Object.defineProperty(exports,${_}'__esModule',${_}${getObject(
			[['value', 'true']],
			{ lineBreakIndent: null }
		)});`;
	}
	return '';
}

function getInteropBlock(dependencies, interopFn, options, accessedGlobals, indent, snippets) {
	const { _, cnst, n } = snippets;
	const neededInteropHelpers = new Set();
	const interopStatements = [];
	const addInteropStatement = (helperVariableName, helper, dependencyVariableName) => {
		neededInteropHelpers.add(helper);
		interopStatements.push(
			`${cnst} ${helperVariableName}${_}=${_}/*#__PURE__*/${helper}(${dependencyVariableName});`
		);
	};
	for (const dep of dependencies) {
		const used = dep.external.usedExternalImports;
		if (!used) continue;
		const moduleInterop = interopFn(dep.importPath);
		let hasDefault = false;
		let hasNamespace = false;
		for (const { imported, reexported } of dep.imports) {
			let helper = null;
			let variableName;
			if (imported === 'default') {
				if (!hasDefault) {
					hasDefault = true;
					if (dep.defaultVariableName !== dep.namespaceVariableName) {
						variableName = dep.defaultVariableName;
						helper = defaultInteropHelpersByInteropType[moduleInterop];
					}
				}
			} else if (imported === '*' && reexported !== '*' && !hasNamespace) {
				hasNamespace = true;
				helper = namespaceInteropHelpersByInteropType[moduleInterop];
				variableName = dep.namespaceVariableName;
			}
			if (helper && variableName) {
				addInteropStatement(variableName, helper, dep.name);
			}
		}
	}
	const helpersBlock = getHelpersBlock(
		neededInteropHelpers,
		accessedGlobals || new Set(),
		indent,
		snippets,
		options.externalLiveBindings !== false,
		options.freeze !== false,
		options.generatedCode && options.generatedCode.symbols === true
	);
	return `${helpersBlock}${interopStatements.length > 0 ? `${interopStatements.join(n)}${n}${n}` : ''}`;
}

function renderEs(chunkData, outputOptions, snippets, onwarn) {
	const { graph, entry, modules, dependencies, exportsList, exportMode, indent, intro, outro } =
		chunkData;
	const parts = [];

	// --- compute export lists first (needed for ordering below)
	const reexportLines = [];
	const localExports = [];
	const starLines = [];
	for (const { exported, local, external, imported } of exportsList) {
		if (external) {
			const imp = stringifyIdentifierIfNeeded(imported);
			const exp = stringifyIdentifierIfNeeded(exported);
			reexportLines.push(
				imp === exp
					? `export { ${imp} } from '${external.id}';`
					: `export { ${imp} as ${exp} } from '${external.id}';`
			);
			continue;
		}
		if (local == null) continue;
		const exportedText = stringifyIdentifierIfNeeded(exported);
		localExports.push(local === exportedText ? local : `${local} as ${exportedText}`);
	}
	for (const dep of dependencies) {
		if (!dep.reexports) continue;
		for (const specifier of dep.reexports) {
			if (specifier.reexported === '*') {
				starLines.push(`export * from '${dep.importPath}';`);
			}
		}
	}

	// --- import block
	const importLines = [];
	const sideEffectGates = new Map(); // ext -> any import stmt included?
	for (const module of modules) {
		for (const imp of module.analysis.imports) {
			if (!module.includedStatements.has(imp.node)) continue;
			const dep = graph.dependencyBySource(module, imp.source);
			if (dep && dep.external) sideEffectGates.set(dep.externalModule, true);
		}
	}
	for (const dep of dependencies) {
		const ext = dep.external;
		const used = ext.usedExternalImports || {
			default: new Set(),
			named: new Set(),
			namespace: new Set(),
			reexports: []
		};
		const vars = ext._vars || new Map();
		const defName = vars.get('default');
		const namedList = [...used.named];
		const nsName = used.namespace.size ? ext.renderName || ext.suggestedVariableName : null;
		if (defName || namedList.length) {
			if (defName && namedList.length) {
				importLines.push(
					`import ${defName}, { ${namedList.join(', ')} } from '${dep.importPath}';`
				);
			} else if (namedList.length) {
				importLines.push(`import { ${namedList.join(', ')} } from '${dep.importPath}';`);
			} else {
				importLines.push(`import ${defName} from '${dep.importPath}';`);
			}
		}
		if (nsName) {
			importLines.push(`import * as ${nsName} from '${dep.importPath}';`);
		}
		if (!defName && !namedList.length && !nsName) {
			if (ext.moduleSideEffects !== false && sideEffectGates.get(ext)) {
				importLines.push(`import '${dep.importPath}';`);
			}
		}
	}
	if (importLines.length) parts.push(importLines.join('\n'));

	// reexport/star lines sit with the import block (top), locals at the bottom
	if (reexportLines.length || starLines.length) {
		parts.push([...reexportLines, ...starLines].join('\n'));
	}

	// bodies
	const bodies = modules.map((m) => m._renderedBody).filter(Boolean);
	if (bodies.length) parts.push(bodies.join('\n\n'));

	if (intro) parts.push(intro.trim());

	const exportLines = [];
	if (localExports.length) exportLines.push(`export { ${localExports.join(', ')} };`);
	if (exportLines.length) parts.push(exportLines.join('\n'));

	if (outro) parts.push(outro.trim());

	let code = parts.join('\n\n');
	code = code.replace(/^\n+|\n+$/g, '');
	return code + '\n';
}

function renderCjs(chunkData, outputOptions, snippets, onwarn) {
	const { graph, entry, modules, dependencies, exportsList, exportMode, indent, intro, outro } =
		chunkData;
	const parts = [];
	parts.push(`'use strict';`);

	const esModuleValue =
		exportMode === 'named' &&
		(outputOptions.esModule === true ||
			outputOptions.esModule === 'esModule' ||
			((outputOptions.esModule === undefined ||
				outputOptions.esModule === 'if-default-prop') &&
				entry.analysis.hasDefaultExport));
	if (esModuleValue) {
		parts.push(`Object.defineProperty(exports, '__esModule', { value: true });`);
	}

	// requires (single block)
	const requireLines = [];
	for (const dep of dependencies) {
		const used = dep.external.usedExternalImports;
		const usedCount = used
			? used.named.size + used.default.size + used.namespace.size + used.reexports.length
			: 0;
		if (usedCount > 0) {
			requireLines.push(`${snippets.cnst} ${dep.name} = require('${dep.importPath}');`);
		} else if (dep.external.moduleSideEffects !== false && sideEffectImported(graph, dep.external)) {
			requireLines.push(`require('${dep.importPath}');`);
		}
	}
	if (requireLines.length) parts.push(requireLines.join('\n'));

	// interop helpers + statements
	const interopBlock = getInteropBlock(
		dependencies,
		chunkData.interopFn,
		outputOptions,
		chunkData.accessedGlobals,
		indent,
		snippets
	);
	if (interopBlock) parts.push(interopBlock.trimEnd());

	if (intro) parts.push(intro.trim());

	const bodies = modules.map((m) => m._renderedBody).filter(Boolean);
	if (bodies.length) parts.push(bodies.join('\n\n'));

	const exportBlock = getExportBlockCjs(
		exportsList,
		dependencies,
		exportMode === 'named',
		snippets,
		chunkData.interopFn,
		outputOptions,
		'cjs'
	);
	if (exportBlock) parts.push(exportBlock.replace(/^\n+/, ''));

	if (outro) parts.push(outro.trim());

	let code = parts.join('\n\n');
	code = code.replace(/^\n+|\n+$/g, '');
	return code + '\n';
}

function sideEffectImported(graph, external) {
	for (const module of graph.orderedModules) {
		for (const imp of module.analysis.imports) {
			if (imp.source !== external.id) continue;
			if (module.includedStatements.has(imp.node)) return true;
		}
	}
	return false;
}

function renderWrapped(chunkData, outputOptions, snippets, format, onwarn) {
	const { graph, entry, modules, dependencies, exportsList, exportMode, indent: t, intro, outro } =
		chunkData;
	const { _, n, getNonArrowFunctionIntro, getPropertyAccess } = snippets;
	const name = outputOptions.name;
	const compact = !!outputOptions.compact;
	const strict = outputOptions.strict !== false;
	const esModule = outputOptions.esModule;
	const hasExports = exportsList.length > 0;
	const namedExportsMode = exportMode === 'named';
	const globals = outputOptions.globals || {};

	function hasAnyUse(ext) {
		const used = ext.usedExternalImports;
		return (
			!!used &&
			(used.named.size + used.default.size + used.namespace.size + used.reexports.length > 0)
		);
	}
	const trimmedDeps = dependencies.filter(
		(dep) => dep.external.moduleSideEffects !== false || hasAnyUse(dep.external)
	);

	if (hasExports && (format === 'iife' || format === 'umd')) {
		if (!name) {
			onwarn({
				code: 'MISSING_NAME_OPTION',
				message:
					format === 'iife'
						? 'Given name for IIFE bundle is undefined. Pass output.name as option to define a global variable name.'
						: 'Given name for UMD bundle is undefined. Pass output.name as option to define a global variable name.'
			});
		} else if (!isLegalName(name)) {
			onwarn({
				code: 'ILLEGAL_IDENTIFIER_AS_NAME',
				message: `Given name "${name}" is not a legal JS identifier. If you need this, you can try "output.extend: true".`
			});
		}
	}

	const interopBlock = getInteropBlock(
		dependencies,
		chunkData.interopFn,
		outputOptions,
		chunkData.accessedGlobals,
		t,
		snippets
	);

	const exportBlock = getExportBlockCjs(
		exportsList,
		dependencies,
		namedExportsMode,
		snippets,
		chunkData.interopFn,
		outputOptions,
		format
	);
	const defaultReturn =
		!namedExportsMode && hasExports && exportsList[0] && exportsList[0].local
			? exportsList[0].local
			: null;

	const addEsModule =
		exportMode === 'named' &&
		(outputOptions.esModule === true ||
			outputOptions.esModule === 'esModule' ||
			((esModule === undefined || esModule === 'if-default-prop') &&
				entry.analysis.hasDefaultExport));

	const bodies = modules.map((m) => m._renderedBody).filter(Boolean);
	const body = bodies.join('\n\n');

	const indentBlock = (code) =>
		code
			.split('\n')
			.map((line) => (line.length ? t + line : line))
			.join('\n');

	let exportPart = '';
	if (namedExportsMode && hasExports) exportPart = exportBlock;
	else if (defaultReturn) exportPart = `${n}${n}return ${defaultReturn};`;
	const marker = addEsModule ? `${n}${n}${getNamespaceMarkers(true, true, snippets)}` : '';
	const content = indentBlock(`${body}${exportPart}${marker}`.trim());

	if (format === 'iife') {
		const isNamespaced = name && name.includes('.');
		const useVariableAssignment = !outputOptions.extend && !isNamespaced;
		const deps = trimmedDeps.map((dep) => globals[dep.importPath] || 'null');
		const parameters = trimmedDeps.map((dep) => dep.name);
		const useStrict = strict ? `${t}'use strict';${n}` : '';
		const needsExportsParam =
			hasExports &&
			(namedExportsMode || (exportsList[0] && exportsList[0].local === 'exports.default'));
		if (needsExportsParam) {
			if (outputOptions.extend) {
				deps.unshift(
					`this${keypath(name, getPropertyAccess)}${_}=${_}this${keypath(name, getPropertyAccess)}${_}||${_}{}`
				);
				parameters.unshift('exports');
			} else {
				deps.unshift('{}');
				parameters.unshift('exports');
			}
		}
		let wrapperIntro = `(${getNonArrowFunctionIntro(parameters, {
			isAsync: false,
			name: null
		})}{${n}${useStrict}${n}`;
		if (hasExports && name && !(outputOptions.extend && namedExportsMode)) {
			wrapperIntro =
				(useVariableAssignment ? `var ${name}` : `this${keypath(name, getPropertyAccess)}`) +
				`${_}=${_}${wrapperIntro}`;
		}
		const needsReturnExports = namedExportsMode && hasExports;
		const wrapperOutro = needsReturnExports
			? `${n}${n}${t}return exports;${n}${n}})(${deps.join(`,${_}`)});`
			: `${n}${n}})(${deps.join(`,${_}`)});`;
		return `${wrapperIntro}${indentBlock(`${intro || ''}${interopBlock}`)}${content}${wrapperOutro}${outro || ''}\n`;
	}

	if (format === 'amd') {
		const deps = dependencies.map((dep) => `'${dep.importPath}'`);
		const parameters = dependencies.map((dep) => dep.name);
		const needsExportsParam =
			hasExports &&
			(namedExportsMode || (exportsList[0] && exportsList[0].local === 'exports.default'));
		if (needsExportsParam) {
			parameters.unshift('exports');
			deps.unshift(`'exports'`);
		}
		const defineParameters = deps.length > 0 ? `[${deps.join(`,${_}`)}],${_}` : '';
		const useStrict = strict ? `${_}'use strict';` : '';
		return `define(${defineParameters}(${getNonArrowFunctionIntro(
			parameters,
			{ isAsync: false, name: null }
		)}{${useStrict}${n}${n}${indentBlock(`${intro || ''}${interopBlock}`)}${content}${n}${n}}));${outro || ''}\n`;
	}

	if (format === 'umd') {
		const factoryVariable = compact ? 'f' : 'factory';
		const globalVariable = compact ? 'g' : 'global';
		const amdDependencies = dependencies.map((dep) => `'${dep.importPath}'`);
		const cjsDependencies = dependencies.map((dep) => `require('${dep.importPath}')`);
		const globalDependencies = trimmedDeps.map((dep) => {
			const g = globals[dep.importPath];
			return g ? `${globalVariable}${keypath(g, getPropertyAccess)}` : 'null';
		});
		const factoryParameters = trimmedDeps.map((dep) => dep.name);
		const needsExportsParam =
			(hasExports || outputOptions.noConflict) &&
			(namedExportsMode || (exportsList[0] && exportsList[0].local === 'exports.default'));
		if (needsExportsParam) {
			amdDependencies.unshift(`'exports'`);
			cjsDependencies.unshift(`exports`);
			globalDependencies.unshift(
				name
					? `${globalVariable}${keypath(name, getPropertyAccess)}${_}=${_}${
							outputOptions.extend
								? `${globalVariable}${keypath(name, getPropertyAccess)}${_}||${_}`
								: ''
						}{}`
					: `{}`
			);
			factoryParameters.unshift('exports');
		}
		const amdParameters =
			amdDependencies.length > 0 ? `[${amdDependencies.join(`,${_}`)}],${_}` : '';
		const define = (outputOptions.amd && outputOptions.amd.define) || 'define';
		const cjsExport = !namedExportsMode && hasExports ? `module.exports${_}=${_}` : ``;
		const useStrict = strict ? `${_}'use strict';${n}` : ``;
		let iifeExport = `${factoryVariable}(${globalDependencies.join(`,${_}`)})`;
		if (!namedExportsMode && hasExports && name) {
			iifeExport = `${globalVariable}${keypath(name, getPropertyAccess)}${_}=${_}${iifeExport}`;
		}
		const iifeNeedsGlobal = hasExports || globalDependencies.length > 0;
		const wrapperParameters = [factoryVariable];
		if (iifeNeedsGlobal) wrapperParameters.unshift(globalVariable);
		const globalArgument = iifeNeedsGlobal ? `this,${_}` : '';
		const iifeStart = iifeNeedsGlobal
			? `(${globalVariable}${_}=${_}typeof globalThis${_}!==${_}'undefined'${_}?${_}globalThis${_}:${_}${globalVariable}${_}||${_}self,${_}`
			: '';
		const iifeEnd = iifeNeedsGlobal ? ')' : '';
		const cjsIntro = iifeNeedsGlobal
			? `${t}typeof exports${_}===${_}'object'${_}&&${_}typeof module${_}!==${_}'undefined'${_}?${_}${cjsExport}${factoryVariable}(${cjsDependencies.join(`,${_}`)})${_}:${n}`
			: '';
		const wrapperIntro =
			`(${getNonArrowFunctionIntro(wrapperParameters, { isAsync: false, name: null })}{${n}` +
			cjsIntro +
			`${t}typeof ${define}${_}===${_}'function'${_}&&${_}${define}.amd${_}?${_}${define}(${amdParameters}${factoryVariable})${_}:${n}` +
			`${t}${iifeStart}${iifeExport}${iifeEnd};${n}` +
			`})(${globalArgument}(${getNonArrowFunctionIntro(factoryParameters, {
				isAsync: false,
				name: null
			})}{${useStrict}${n}`;
		const wrapperOutro = n + n + '}));';
		return `${wrapperIntro}${indentBlock(`${intro || ''}${interopBlock}`)}${content}${wrapperOutro}${outro || ''}\n`;
	}

	throw new Error(`Unknown format ${format}`);
}

function isLegalName(name) {
	return /^[$_a-zA-Z][\w$]*(\.[\w$]+)*$/.test(name);
}

function keypath(name, getPropertyAccess) {
	if (!name) return '';
	return name
		.split('.')
		.map((part) => getPropertyAccess(part))
		.join('');
}

// ------------------------------------------------------------------ chunk

function renderChunk(graph, outputOptions, onwarn) {
	const entry = graph.entryModules[0];
	const modules = [...graph.orderedModules];
	const format = outputOptions.format;
	const indent = getIndentString(graph.orderedModules, outputOptions);
	const snippets = getGenerateCodeSnippets(outputOptions);
	const { dependencies, interopFn } = computeRenderNames(
		graph,
		entry,
		outputOptions,
		format,
		onwarn
	);

	// export list & mode
	const exportsList = buildEntryExportList(graph, entry, format);
	const exportKeys = exportsList.map((e) => e.exported);
	const name =
		entry.entryName ||
		(entry.entryName === null ? basename(entry.id) : basename(entry.id));
	const exportMode = getExportMode(
		exportKeys,
		outputOptions.exports,
		format,
		entry,
		outputOptions.name,
		onwarn
	);

	// needsLiveBinding for internal exports: never (aliased instead), external handled in deps

	// render all module bodies
	for (const module of modules) {
		module._renderedBody = renderModule(module, graph, format, snippets, outputOptions);
	}

	const chunkData = {
		graph,
		entry,
		modules,
		dependencies,
		exportsList,
		exportMode,
		indent,
		intro: resolveAddon(outputOptions.intro),
		outro: resolveAddon(outputOptions.outro),
		accessedGlobals: new Set(),
		interopFn,
		name: outputOptions.name
	};

	let code;
	if (format === 'es') {
		code = renderEs(chunkData, outputOptions, snippets, onwarn);
	} else if (format === 'cjs') {
		code = renderCjs(chunkData, outputOptions, snippets, onwarn);
	} else if (format === 'iife' || format === 'amd' || format === 'umd') {
		code = renderWrapped(chunkData, outputOptions, snippets, format, onwarn);
	} else {
		throw new Error(`Invalid format "${format}"`);
	}

	// banner/footer
	const banner = resolveAddon(outputOptions.banner);
	if (banner) code = `${banner}\n${code}`;
	const footer = resolveAddon(outputOptions.footer);
	if (footer) code = `${code}${footer}\n`;

	return { code, exports: exportsList, exportMode };
}

function resolveAddon(addon) {
	if (typeof addon === 'function') return addon();
	return addon || '';
}

module.exports = {
	renderChunk,
	computeRenderNames,
	getIndentString,
	getExportMode,
	basename
};

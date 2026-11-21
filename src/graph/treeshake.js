'use strict';

const { relativeId } = require('../utils/pathcheck.js');

/**
 * Tree-shaking against the graph.js structures.
 * - modules: graph.orderedModules (execution order, deps first)
 * - entry: graph.entryModules[0]
 * - externals: graph.externalById.values()
 * - module.deps / module.externalDeps: [{source, module|externalModule, importNode}]
 */

function ensureModuleIncluded(module, graph, onwarn) {
	if (module.included) return;
	module.included = true;
	if (!module.analysis) return; // external modules have no statements
	const analysis = module.analysis;
	for (const stmt of analysis.statements) {
		const info = analysis.statementsInfo.get(stmt);
		if (info && info.effects) includeStatement(module, stmt, graph, onwarn);
	}
	// keep imports whose targets may have side effects
	for (const imp of analysis.imports) {
		const dep = graph.dependencyBySource(module, imp.source);
		if (!dep) continue;
		const target = dep.external ? dep.externalModule : dep.module;
		if (target.moduleSideEffects !== false) {
			includeStatement(module, imp.node, graph, onwarn);
		}
	}
}

function bindingsInDeclarator(module, stmt, declarator) {
	const out = [];
	for (const binding of module.analysis.bindings.values()) {
		if (
			binding.statement === stmt &&
			binding.identifier &&
			binding.identifier.start >= declarator.start &&
			binding.identifier.end <= declarator.end
		) {
			out.push(binding);
		}
	}
	return out;
}

function findDeclarator(stmt, identifier) {
	const decls =
		stmt.type === 'ExportNamedDeclaration' && stmt.declaration
			? stmt.declaration.declarations
			: stmt.declarations;
	if (!decls) return null;
	return decls.find((d) => identifier.start >= d.start && identifier.end <= d.end) || null;
}

function includeDeclarator(module, stmt, declarator, graph, onwarn) {
	let set = module.includedDeclarators.get(stmt);
	if (!set) {
		set = new Set();
		module.includedDeclarators.set(stmt, set);
	}
	module.includedStatements.add(stmt);
	if (set.has(declarator)) return;
	set.add(declarator);
	for (const b of bindingsInDeclarator(module, stmt, declarator)) {
		includeBinding(module, b, graph, onwarn);
	}
	const info = module.analysis.statementsInfo.get(stmt);
	if (info) {
		for (const dep of info.refs) includeBinding(module, dep, graph, onwarn);
	}
}

function includeStatement(module, stmt, graph, onwarn) {
	if (module.includedStatements.has(stmt)) return;
	const info = module.analysis.statementsInfo.get(stmt);
	if (!info) return;
	module.includedStatements.add(stmt);

	if (stmt.type === 'ImportDeclaration') {
		const dep = graph.dependencyBySource(module, stmt.source.value);
		if (dep) {
			const target = dep.external ? dep.externalModule : dep.module;
			ensureModuleIncluded(target, graph, onwarn);
		}
		// import bindings are only included when actually referenced
		for (const dep of info.refs) includeBinding(module, dep, graph, onwarn);
		return;
	}

	if (stmt.type === 'VariableDeclaration' && info.declaratorEffects) {
		for (const d of stmt.declarations) {
			if (info.declaratorEffects.get(d)) includeDeclarator(module, stmt, d, graph, onwarn);
		}
		for (const dep of info.refs) includeBinding(module, dep, graph, onwarn);
	} else if (
		stmt.type === 'FunctionDeclaration' ||
		stmt.type === 'ClassDeclaration' ||
		stmt.type === 'ExportDefaultDeclaration' ||
		stmt.type === 'ExportNamedDeclaration'
	) {
		// function/class declarations: including the statement includes its name
		for (const name of info.declNames) {
			const binding = module.analysis.bindings.get(name);
			if (binding && !binding.included) includeBinding(module, binding, graph, onwarn);
		}
		for (const dep of info.refs) includeBinding(module, dep, graph, onwarn);
	} else {
		for (const dep of info.refs) includeBinding(module, dep, graph, onwarn);
	}
}

function includeBinding(module, binding, graph, onwarn) {
	if (!binding || binding.included) return;
	binding.included = true;
	ensureModuleIncluded(module, graph, onwarn);

	const stmt = binding.statement;
	if (!stmt) return;

	if (
		stmt.type === 'VariableDeclaration' ||
		(stmt.type === 'ExportNamedDeclaration' &&
			stmt.declaration &&
			stmt.declaration.type === 'VariableDeclaration')
	) {
		const declarator = findDeclarator(stmt, binding.identifier);
		if (declarator) {
			includeDeclarator(module, stmt, declarator, graph, onwarn);
			return;
		}
	}
	includeStatement(module, stmt, graph, onwarn);
}

function includeResolved(module, resolved, graph, onwarn, exportedName) {
	if (!resolved) return;
	if (resolved.binding) {
		includeBinding(resolved.module, resolved.binding, graph, onwarn);
	} else if (resolved.defaultVar) {
		const defaultInfo = resolved.module.analysis.defaultInfo;
		if (defaultInfo && defaultInfo.statement) {
			includeStatement(resolved.module, defaultInfo.statement, graph, onwarn);
		}
	} else if (resolved.namespaceOf) {
		if (resolved.namespaceOf.external) {
			// `export * as ns from 'external'`
			const ext = resolved.namespaceOf;
			const used = (ext.usedExternalImports ||= {
				default: new Set(),
				named: new Set(),
				namespace: new Set(),
				reexports: []
			});
			used.namespace.add('*');
			used.reexports.push({
				type: 'namespace',
				exported: exportedName || 'ns',
				id: ext.id
			});
		} else {
			includeNamespaceModule(resolved.namespaceOf, graph, onwarn);
		}
	} else if (resolved.external) {
		// reexport through an external module: recorded for the export block only
		const ext = resolved.external;
		const used = (ext.usedExternalImports ||= {
			default: new Set(),
			named: new Set(),
			namespace: new Set(),
			reexports: []
		});
		used.reexports.push({
			type: resolved.imported === 'default' ? 'default' : 'named',
			exported: exportedName || resolved.imported,
			imported: resolved.imported,
			id: ext.id
		});
	}
}

function includeNamespaceModule(target, graph, onwarn) {
	if (!target || target.external) return;
	if (target.namespaceVariableIncluded) {
		ensureModuleIncluded(target, graph, onwarn);
		return;
	}
	target.namespaceVariableIncluded = true;
	ensureModuleIncluded(target, graph, onwarn);
	for (const name of graph.collectExportNames(target)) {
		includeResolved(
			target,
			graph.resolveExport(target, name),
			graph,
			onwarn
		);
	}
}

function markExternalImportUsed(external, { imported, namespace }) {
	const used = (external.usedExternalImports ||= {
		default: new Set(),
		named: new Set(),
		namespace: new Set(),
		reexports: []
	});
	let added = false;
	const add = (set, key) => {
		if (!set.has(key)) {
			set.add(key);
			added = true;
		}
	};
	if (namespace) add(used.namespace, '*');
	else if (imported === 'default') add(used.default, '*');
	else if (imported && imported !== '*') add(used.named, imported);
	return added;
}

function linkImportBindings(graph, onwarn) {
	for (const module of graph.orderedModules) {
		for (const binding of module.analysis.bindings.values()) {
			const { importInfo } = binding;
			if (!importInfo) continue;
			const dep = graph.dependencyBySource(module, importInfo.source);
			if (!dep) {
				binding.importLink = null;
				continue;
			}
			if (dep.external) {
				binding.importLink = { external: dep.externalModule, imported: importInfo.imported };
				continue;
			}
			if (importInfo.imported === '*') {
				binding.importLink = { namespaceModule: dep.module };
				continue;
			}
			const resolved = graph.resolveExport(dep.module, importInfo.imported);
			if (resolved && resolved.binding) {
				binding.importLink = { module: resolved.module, binding: resolved.binding };
			} else if (resolved && resolved.defaultVar) {
				binding.importLink = { module: resolved.module, defaultVar: true };
			} else if (resolved && resolved.external) {
				binding.importLink = { external: resolved.external, imported: resolved.imported };
			} else if (resolved && resolved.namespaceOf) {
				binding.importLink = { namespaceModule: resolved.namespaceOf };
			} else {
				binding.importLink = null;
			}
		}
	}
}

function classifyNamespaces(graph, onwarn) {
	for (const module of graph.orderedModules) {
		const analysis = module.analysis;
		const refs = (binding) => analysis.refsByBinding.get(binding) || [];
		const violations = (binding) => analysis.violationsByBinding.get(binding) || [];
		for (const binding of analysis.bindings.values()) {
			if (!binding.importLink || !binding.importLink.namespaceModule) continue;
			const target = binding.importLink.namespaceModule;

			const handleOccurrence = (node, parent) => {
				if (
					parent &&
					parent.type === 'MemberExpression' &&
					parent.object === node
				) {
					if (!parent.computed) {
						const prop = parent.property.name;
						const resolved = graph.resolveExport(target, prop);
						let adapted = null;
						if (resolved && resolved.binding) {
							adapted = { module: resolved.module, binding: resolved.binding };
						} else if (resolved && resolved.defaultVar) {
							adapted = { module: resolved.module, defaultVar: true };
						} else if (resolved && resolved.namespaceOf) {
							adapted = { module: resolved.module, namespaceOf: resolved.namespaceOf };
						} else if (resolved && resolved.external) {
							adapted = { external: resolved.external, imported: resolved.imported };
						}
						module.namespaceReplacements.push({
							start: parent.start,
							end: parent.end,
							resolved: adapted // null -> renders `undefined`
						});
						return;
					}
					// computed member access: escape to the namespace variable
					binding.namespaceEscape = true;
					target.namespaceBaseName ||= binding.name;
					return;
				}
				if (parent && parent.type === 'MemberExpression' && parent.property === node) {
					return; // property position of some other object
				}
				// any other usage: treat as the namespace object itself
				binding.namespaceEscape = true;
				target.namespaceBaseName ||= binding.name;
			};

			for (const ref of refs(binding)) {
				if (ref.shorthandKey && ref.node === ref.shorthandKey) continue;
				handleOccurrence(ref.node, ref.parent);
			}
			for (const v of violations(binding)) {
				handleOccurrence(v.node, v.parent);
			}
		}
	}
}

function runTreeShake(graph, inputOptions, onwarn) {
	const treeshakeOpt = inputOptions.treeshake;
	const modules = graph.orderedModules;
	const entry = graph.entryModules[0];

	// initialize per-module state
	for (const module of modules) {
		module.included = false;
		module.includedStatements = new Set();
		module.includedDeclarators = new Map();
		module.relativeId = relativeId(module.id);
		module.namespaceVariableIncluded = false;
		module.namespaceReplacements = [];
		module.defaultVarRenderName = null;
		module.namespaceRenderName = null;
		module.effectfulStatements = [];
		const analysis = module.analysis;
		for (const stmt of analysis.statements) {
			const info = analysis.statementsInfo.get(stmt);
			if (info && info.effects) module.effectfulStatements.push(stmt);
		}
	}
	for (const external of graph.externalById.values()) {
		external.relativeId = relativeId(external.id);
		external.suggestedVariableName = null;
		external.usedExternalImports = null;
	}

	linkImportBindings(graph, onwarn);
	classifyNamespaces(graph, onwarn);

	const mark = (fn) => fn();

	// seeds
	if (treeshakeOpt === false) {
		for (const module of modules) {
			ensureModuleIncluded(module, graph, onwarn);
			for (const stmt of module.analysis.statements) {
				module.includedStatements.add(stmt);
			}
			for (const stmt of module.analysis.statements) {
				if (
					stmt.type === 'VariableDeclaration' ||
					(stmt.type === 'ExportNamedDeclaration' &&
						stmt.declaration &&
						stmt.declaration.type === 'VariableDeclaration')
				) {
					const decls = (
						stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt
					).declarations;
					let set = module.includedDeclarators.get(stmt);
					if (!set) {
						set = new Set();
						module.includedDeclarators.set(stmt, set);
					}
					for (const d of decls || []) set.add(d);
				}
			}
			for (const binding of module.analysis.bindings.values()) {
				binding.included = true;
				if (binding.importLink && binding.importLink.external) {
					markExternalImportUsed(binding.importLink.external, {
						imported: binding.importLink.imported,
						namespace: binding.importLink.imported === '*'
					});
				}
			}
		}
	} else {
		ensureModuleIncluded(entry, graph, onwarn);
		// entry exports
		for (const name of graph.collectExportNames(entry)) {
			includeResolved(entry, graph.resolveExport(entry, name), graph, onwarn, name);
		}
		// external star reexports (`export * from 'ext'`) are not name-resolvable
		for (const exp of entry.analysis.exports) {
			if (exp.type !== 'star') continue;
			const dep = graph.dependencyBySource(entry, exp.source);
			if (!dep || !dep.external) continue;
			const used = (dep.externalModule.usedExternalImports ||= {
				default: new Set(),
				named: new Set(),
				namespace: new Set(),
				reexports: []
			});
			used.reexports.push({ type: 'star', imported: '*', reexported: '*', id: dep.externalModule.id });
		}
		// dynamic entries
		for (const dyn of graph.dynamicEntryModules) {
			ensureModuleIncluded(dyn, graph, onwarn);
		}
		// namespace escapes and star-as namespaces need namespace objects
		for (const module of modules) {
			for (const binding of module.analysis.bindings.values()) {
				if (binding.namespaceEscape && binding.importLink && binding.importLink.namespaceModule) {
					includeNamespaceModule(binding.importLink.namespaceModule, graph, onwarn);
				}
			}
			for (const exp of module.analysis.exports) {
				if (exp.type === 'star-as') {
					const dep = graph.dependencyBySource(module, exp.source);
					if (dep && !dep.external) {
						dep.module.namespaceBaseName ||= exp.exported;
						includeNamespaceModule(dep.module, graph, onwarn);
					} else if (dep && dep.external) {
						// external namespace reexport: needs namespace import of the external
						const used = (dep.externalModule.usedExternalImports ||= {
							default: new Set(),
							named: new Set(),
							namespace: new Set(),
							reexports: []
						});
						used.namespace.add('*');
					}
				}
			}
		}
	}

	// fixpoint
	for (let pass = 0; pass < 100; pass++) {
		let changed = false;
		for (const module of modules) {
			for (const stmt of [...module.includedStatements]) {
				const info = module.analysis.statementsInfo.get(stmt);
				if (!info) continue;
				for (const dep of info.refs) {
					if (!dep.included) {
						includeBinding(module, dep, graph, onwarn);
						changed = true;
					}
				}
			}
			for (const binding of module.analysis.bindings.values()) {
				if (!binding.included) continue;
				const link = binding.importLink;
				if (link) {
					if (link.external) {
						if (
							markExternalImportUsed(link.external, {
								imported: link.imported,
								namespace: link.imported === '*'
							})
						) {
							changed = true;
						}
					} else if (link.namespaceModule) {
						if (!link.namespaceModule.namespaceVariableIncluded) {
							includeNamespaceModule(link.namespaceModule, graph, onwarn);
							changed = true;
						}
						if (!link.namespaceModule.included) {
							ensureModuleIncluded(link.namespaceModule, graph, onwarn);
							changed = true;
						}
					} else if (link.binding && !link.binding.included) {
						includeBinding(link.module, link.binding, graph, onwarn);
						changed = true;
					} else if (link.defaultVar) {
						const di = link.module.analysis.defaultInfo;
						if (di && di.statement && !link.module.includedStatements.has(di.statement)) {
							includeStatement(link.module, di.statement, graph, onwarn);
							changed = true;
						}
					}
				}
			}
			// namespace member replacements pull in their targets
			for (const rep of module.namespaceReplacements) {
				const resolved = rep.resolved;
				if (!resolved) continue;
				if (resolved.external) {
					if (
						markExternalImportUsed(resolved.external, {
							imported: resolved.imported,
							namespace: resolved.imported === '*'
						})
					) {
						changed = true;
					}
				} else if (resolved.binding) {
					if (!resolved.binding.included) {
						includeBinding(resolved.module, resolved.binding, graph, onwarn);
						changed = true;
					}
				} else if (resolved.defaultVar) {
					const di = resolved.module.analysis.defaultInfo;
					if (di && di.statement && !resolved.module.includedStatements.has(di.statement)) {
						includeStatement(resolved.module, di.statement, graph, onwarn);
						changed = true;
					}
				} else if (resolved.namespaceOf) {
					if (!resolved.namespaceOf.namespaceVariableIncluded) {
						includeNamespaceModule(resolved.namespaceOf, graph, onwarn);
						changed = true;
					}
				}
			}
		}
		if (!changed) break;
	}

	// unused external import warnings
	if (treeshakeOpt !== false) {
		for (const module of modules) {
			for (const binding of module.analysis.bindings.values()) {
				const link = binding.importLink;
				if (!link || !link.external || binding.included) continue;
				const imported = (binding.importInfo && binding.importInfo.imported) || binding.name;
				onwarn({
					code: 'UNUSED_EXTERNAL_IMPORT',
					message: `"${imported}" is imported from external module "${link.external.relativeId}" but never used in "${module.relativeId}".`,
					binding,
					importer: module,
					source: link.external.id
				});
			}
		}
	}
}

module.exports = {
	runTreeShake,
	ensureModuleIncluded,
	includeBinding,
	includeStatement,
	includeNamespaceModule,
	includeResolved,
	markExternalImportUsed,
	linkImportBindings,
	classifyNamespaces
};

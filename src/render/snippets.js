'use strict';

/** Port of rollup's RESERVED_NAMES + identifier helpers + generateCodeSnippets. */

const RESERVED_NAMES = new Set([
	'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
	'delete', 'do', 'else', 'enum', 'eval', 'export', 'extends', 'false', 'finally', 'for',
	'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'NaN',
	'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'static', 'super',
	'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while',
	'with', 'yield'
]);

const illegalCharacters = /[^\w$]/g;
const illegalCharacter = /[^\w$]/;
const startsWithDigit = (value) => /\d/.test(value[0]);
const needsEscape = (value) => startsWithDigit(value) || RESERVED_NAMES.has(value) || value === 'arguments';

function isLegal(value) {
	if (needsEscape(value)) return false;
	return !illegalCharacter.test(value);
}

function makeLegal(value) {
	value = value.replace(/-(\w)/g, (_, letter) => letter.toUpperCase()).replace(illegalCharacters, '_');
	if (needsEscape(value)) value = `_${value}`;
	return value || '_';
}

const VALID_IDENTIFIER_REGEXP = /^[$_‌‍\p{ID_Start}][$‌‍\p{ID_Continue}]*$/u;
const NUMBER_REGEXP = /^(?:0|[1-9]\d*)$/;

function stringifyObjectKeyIfNeeded(key) {
	if (VALID_IDENTIFIER_REGEXP.test(key)) {
		return key === '__proto__' ? '["__proto__"]' : key;
	}
	if (NUMBER_REGEXP.test(key) && +key <= Number.MAX_SAFE_INTEGER) {
		return key;
	}
	return JSON.stringify(key);
}

function stringifyIdentifierIfNeeded(key) {
	if (VALID_IDENTIFIER_REGEXP.test(key)) {
		return key;
	}
	return JSON.stringify(key);
}

const toBase64Chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
function toBase64(value) {
	let out = '';
	do {
		const digit = value % 64;
		value = (value / 64) | 0;
		out = toBase64Chars[digit] + out;
	} while (value !== 0);
	return out;
}

function getSafeName(baseName, usedNames, forbiddenNames) {
	let safeName = baseName;
	let count = 1;
	while (usedNames.has(safeName) || RESERVED_NAMES.has(safeName) || (forbiddenNames && forbiddenNames.has(safeName))) {
		safeName = `${baseName}$${toBase64(count++)}`;
	}
	usedNames.add(safeName);
	return safeName;
}

const unescapeExportName = (name) => (name.startsWith('**') ? name.slice(1) : name);

/**
 * Creates the snippets object used by finalisers (port of getGenerateCodeSnippets).
 */
function getGenerateCodeSnippets({ compact, generatedCode }) {
	const { arrowFunctions, constBindings, objectShorthand, reservedNamesAsProps } = generatedCode;
	const _ = compact ? '' : ' ';
	const n = compact ? '' : '\n';
	const s = compact ? '' : ';';
	const cnst = constBindings ? 'const' : 'var';

	const getNonArrowFunctionIntro = (parameters, { isAsync, name }) =>
		`${isAsync ? 'async ' : ''}function${name ? ` ${name}` : ''}${_}(${parameters.join(`,${_}`)})${_}`;

	const getFunctionIntro = arrowFunctions
		? (parameters, { isAsync, name }) => {
				const singleParameter = parameters.length === 1;
				const asyncString = isAsync ? `async${singleParameter ? ' ' : _}` : '';
				return `${name ? `${cnst} ${name}${_}=${_}` : ''}${asyncString}${
					singleParameter ? parameters[0] : `(${parameters.join(`,${_}`)})`
				}${_}=>${_}`;
			}
		: getNonArrowFunctionIntro;

	const getDirectReturnFunction = (parameters, { functionReturn, lineBreakIndent, name }) => [
		`${getFunctionIntro(parameters, { isAsync: false, name })}${
			arrowFunctions
				? lineBreakIndent
					? `${n}${lineBreakIndent.base}${lineBreakIndent.t}`
					: ''
				: `{${lineBreakIndent ? `${n}${lineBreakIndent.base}${lineBreakIndent.t}` : _}${
						functionReturn ? 'return ' : ''
					}`
		}`,
		arrowFunctions
			? `${name ? ';' : ''}${lineBreakIndent ? `${n}${lineBreakIndent.base}` : ''}`
			: `${s}${lineBreakIndent ? `${n}${lineBreakIndent.base}` : _}}`
	];

	const isValidPropertyName = reservedNamesAsProps
		? (name) => VALID_IDENTIFIER_REGEXP.test(name)
		: (name) => !RESERVED_NAMES.has(name) && VALID_IDENTIFIER_REGEXP.test(name);

	return {
		_,
		cnst,
		n,
		s,
		getDirectReturnFunction,
		getFunctionIntro,
		getNonArrowFunctionIntro,
		getObject(fields, { lineBreakIndent }) {
			const prefix = lineBreakIndent ? `${n}${lineBreakIndent.base}${lineBreakIndent.t}` : _;
			return `{${fields
				.map(([key, value]) => {
					if (key === null) return `${prefix}${value}`;
					const keyInObject = stringifyObjectKeyIfNeeded(key);
					return key === value && objectShorthand && key === keyInObject
						? prefix + key
						: `${prefix}${keyInObject}:${_}${value}`;
				})
				.join(',')}${
				fields.length === 0 ? '' : lineBreakIndent ? `${n}${lineBreakIndent.base}` : _
			}}`;
		},
		getPropertyAccess: (name) => (isValidPropertyName(name) ? `.${name}` : `[${JSON.stringify(name)}]`),
		getDirectReturnIifeLeft(parameters, returned, { needsArrowReturnParens, needsWrappedFunction }) {
			const [left, right] = getDirectReturnFunction(parameters, {
				functionReturn: true,
				lineBreakIndent: null,
				name: null
			});
			const wrapIfNeeded = (code, needsParens) => (needsParens ? `(${code})` : code);
			return `${wrapIfNeeded(
				`${left}${wrapIfNeeded(returned, arrowFunctions && needsArrowReturnParens)}${right}`,
				arrowFunctions || needsWrappedFunction
			)}(`;
		}
	};
}

module.exports = {
	RESERVED_NAMES,
	isLegal,
	makeLegal,
	VALID_IDENTIFIER_REGEXP,
	stringifyObjectKeyIfNeeded,
	stringifyIdentifierIfNeeded,
	toBase64,
	getSafeName,
	unescapeExportName,
	getGenerateCodeSnippets
};

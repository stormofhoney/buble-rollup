'use strict';

/**
 * Error type mirroring rollup's RollupError: every log property is attached
 * directly to the error object (`code`, `loc`, `frame`, `plugin`, ...).
 */
class RollupError extends Error {
	constructor(props) {
		super(props.message);
		this.name = 'RollupError';
		Object.assign(this, props);
		if (this.loc && !this.loc.file && this.id) this.loc.file = this.id;
	}
}

function error(props) {
	if (props instanceof Error) throw props;
	throw new RollupError(props);
}

function augmentCodeframe(err, code) {
	if (err.frame || err.loc == null || code == null) return;
	const { line, column } = err.loc;
	if (typeof line !== 'number' || typeof column !== 'number') return;
	const lines = code.split(/\r?\n/);
	const start = Math.max(0, line - 3);
	const end = Math.min(lines.length, line + 2);
	const digits = String(end).length;
	const frameLines = [];
	for (let i = start; i < end; i++) {
		const num = String(i + 1).padStart(digits, ' ');
		const marker = i + 1 === line ? '>' : ' ';
		frameLines.push(`${marker} ${num} | ${lines[i]}`);
		if (i + 1 === line) {
			frameLines.push(`  ${' '.repeat(digits)} | ${' '.repeat(Math.max(0, column))}^`);
		}
	}
	err.frame = frameLines.join('\n');
}

module.exports = { RollupError, error, augmentCodeframe };

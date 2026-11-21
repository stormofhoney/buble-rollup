import type { RollupOptions, OutputOptions, OutputBundle, NormalizedOutputOptions } from './rollup-shim';

export type { RollupOptions, OutputOptions, OutputBundle };

export interface RollupWarning {
	code?: string;
	message: string;
	[key: string]: unknown;
}

export interface PluginContext {
	meta: { rollupVersion: string; rollupMode: string; watchMode: boolean };
	warn: (warning: RollupWarning | string) => void;
	error: (error: RollupWarning | string | Error) => never;
	parse: (code: string, options?: unknown) => unknown;
	emitFile: (file: Record<string, unknown>) => string;
	addWatchFile: (id: string) => void;
	resolve: (source: string, importer?: string, options?: Record<string, unknown>) => Promise<unknown>;
	load: (options: { id: string }) => Promise<unknown>;
	getModuleInfo: (id: string) => unknown;
	getModuleIds: () => Iterable<string>;
	getWatchFiles: () => string[];
	readonly watchMode: boolean;
}

export interface Plugin {
	name: string;
	buildStart?: (this: PluginContext, options: RollupOptions) => void | Promise<void>;
	resolveId?: (
		this: PluginContext,
		source: string,
		importer: string | undefined,
		options: Record<string, unknown>
	) => string | false | null | undefined | Promise<string | false | null | undefined>;
	load?: (this: PluginContext, id: string) => string | null | undefined | { code: string; map?: unknown } | Promise<string | null | undefined | { code: string; map?: unknown }>;
	transform?: (
		this: PluginContext,
		code: string,
		id: string
	) => string | null | undefined | { code: string; map?: unknown } | Promise<string | null | undefined | { code: string; map?: unknown }>;
	moduleParsed?: (this: PluginContext, moduleInfo: unknown) => void | Promise<void>;
	buildEnd?: (this: PluginContext, error?: Error) => void | Promise<void>;
	generateBundle?: (this: PluginContext, bundle: OutputBundle, options: NormalizedOutputOptions) => void | Promise<void>;
	writeBundle?: (this: PluginContext, bundle: OutputBundle, options: NormalizedOutputOptions) => void | Promise<void>;
	[key: string]: unknown;
}

export interface RollupBuild {
	generate: (outputOptions?: OutputOptions) => Promise<{ output: Array<Record<string, unknown>>; warnings: RollupWarning[] }>;
	write: (outputOptions?: OutputOptions) => Promise<{ output: Array<Record<string, unknown>>; warnings: RollupWarning[] }>;
	close: () => Promise<void>;
	cache: unknown;
}

export declare function rollup(options?: RollupOptions): Promise<RollupBuild>;
export declare const VERSION: string;
export declare class Bundle {
	generate(outputOptions?: OutputOptions): Promise<{ output: Array<Record<string, unknown>>; warnings: RollupWarning[] }>;
	write(outputOptions?: OutputOptions): Promise<{ output: Array<Record<string, unknown>>; warnings: RollupWarning[] }>;
	close(): Promise<void>;
}
export default rollup;

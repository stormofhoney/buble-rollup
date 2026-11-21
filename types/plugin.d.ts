import type { Plugin } from './index';

export interface RollupBubleOptions {
	transforms?: Record<string, unknown>;
	include?: string | RegExp | Array<string | RegExp> | ((id: string) => boolean);
	exclude?: string | RegExp | Array<string | RegExp> | ((id: string) => boolean);
	[target: string]: unknown;
}

declare function buble(options?: RollupBubleOptions): Plugin;
export default buble;

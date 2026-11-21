import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./src/index.js');

export const rollup = mod.rollup;
export const VERSION = mod.VERSION;
export const Bundle = mod.Bundle;
export default mod.rollup;

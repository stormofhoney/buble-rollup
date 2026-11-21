import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const buble = require('./src/buble-plugin.js');

export default buble;

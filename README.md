# @stormofhoney/rollup-comb

All-in-one bundler & ES2015+ transpiler replacing `rollup` and `@rollup/plugin-buble` — **zero runtime dependencies** (everything is bundled into `dist/`).

- Drop-in CLI: `rollup -c rollup.config.mjs` works unchanged
- Configs may keep `import buble from "@rollup/plugin-buble"` (redirected automatically)
- JS API: `import { rollup } from "@stormofhoney/rollup-comb"`
- Plugin: `import buble from "@stormofhoney/rollup-comb/plugin"`

```json
"devDependencies": {
  "@stormofhoney/rollup-comb": "github:stormofhoney/buble-rollup"
}
```

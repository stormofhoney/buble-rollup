# @stormofhoney/rollup-comb

All-in-one bundler & ES2015+ transpiler replacing `rollup` and `@rollup/plugin-buble` — **zero runtime dependencies** (everything is bundled into `dist/`).

- Drop-in CLI: `rollup -c rollup.config.mjs` works unchanged
- Configs may keep `import buble from "@rollup/plugin-buble"` (redirected automatically)
- JS API: `import { rollup } from "@stormofhoney/rollup-comb"`
- Plugin: `import buble from "@stormofhoney/rollup-comb/plugin"`

```json
"devDependencies": {
  "@stormofhoney/rollup-comb": "github:stormofhoney/rollup-comb"
}
```

## Versioning (git dependency)

`^x.y.z` only works against the npm registry. For `github:` specs you pin via the URL fragment — npm resolves `#semver:` against **git tags**:

```json
"github:stormofhoney/rollup-comb#semver:^0.9.9-rc001"   // like ^x.y.z, against tags
"github:stormofhoney/rollup-comb#v0.9.9-rc001"           // exactly that tag
"github:stormofhoney/rollup-comb#main"                   // branch tip
"github:stormofhoney/rollup-comb"                        // default branch (main)
```

## Development

The package itself has **no dependencies and no devDependencies**. Tooling for tests/builds is installed on demand (not saved to package.json):

```sh
npm run dev:install   # babel, esbuild, buble, rollup, … (node_modules only)
npm test
npm run build         # regenerates dist/ — commit it, git installs use it as-is
```

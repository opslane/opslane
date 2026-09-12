#!/usr/bin/env node
import('../dist/sourcemaps-cli.js').then(({ main }) => main(process.argv.slice(2))).then((code) => process.exit(code), (err) => { console.error(err?.message ?? err); process.exit(1); });

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
  // Database drivers are optionalDependencies loaded at runtime via dynamic
  // import(). They must be external so tsup does not bundle their CJS code
  // into ESM chunks (which causes "Dynamic require of X is not supported").
  external: ['pg'],
});

/** @type {import('next').NextConfig} */
export default {
  webpack: (config) => {
    // `lib/pipelines.ts` (the TypeScript surface: types + loadPipeline/listPipelines)
    // and `lib/pipelines.mjs` (the canonical Zod schema, also loadable by plain node
    // for scripts/validate-pipelines.sh) share a basename by spec design. Webpack
    // resolves `.mjs` before `.ts`, so a bare `@/lib/pipelines` value-import would hit
    // the schema-only `.mjs` and `loadPipeline`/`listPipelines` would be undefined at
    // runtime. Resolve `.ts`/`.tsx` first so `@/lib/pipelines` → `pipelines.ts`.
    config.resolve.extensions = [
      '.ts',
      '.tsx',
      ...config.resolve.extensions.filter((e) => e !== '.ts' && e !== '.tsx'),
    ];
    return config;
  },
};

import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: false,
    external: [
        '@aws-sdk/client-cloudwatch-logs',
        '@meteora-ag/dlmm',
        'dotenv',
        'edwin-sdk',
        'redis',
    ],
}); 
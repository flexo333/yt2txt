import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const lambdaUrl = env.VITE_LAMBDA_URL

  return {
    plugins: [react()],
    // `vite dev` has no CloudFront, so proxy /api to the real Function URL to
    // keep one code path in src/api.js. Only when a backend is configured.
    //
    // changeOrigin: a Function URL origin rejects a foreign Host header, which
    // mirrors the AllViewerExceptHostHeader policy CloudFront uses in production.
    //
    // No rewrite: the /api prefix is deliberately NOT stripped. CloudFront does
    // not strip it in production and the Lambda ignores the path, so stripping
    // it in dev only would make dev and prod diverge.
    ...(lambdaUrl && {
      server: {
        proxy: {
          '/api': {
            target: lambdaUrl.replace(/\/+$/, ''),
            changeOrigin: true,
          },
        },
      },
    }),
  }
})

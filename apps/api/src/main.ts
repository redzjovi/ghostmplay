import 'reflect-metadata'
import { Logger, ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import cookieParser from 'cookie-parser'
import { AppModule } from './app.module'
import { env } from './config/env'
import { AuthService } from './modules/auth/auth.service'
import { RateLimiterService } from './common/rate-limiter.service'

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap')
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: env.isProd,
  })

  // DomCloud's NGINX forwards the real client IP via X-Forwarded-For. Without this,
  // req.ip is always the proxy and per-IP rate limiting is useless.
  app.set('trust proxy', env.trustProxy)
  app.enableShutdownHooks()
  app.use(cookieParser())

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Unknown query keys are dropped rather than rejected: the client sends
      // deprecated aliases and ad-hoc filters, and a hard 400 there is hostile.
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    })
  )

  if (env.corsOrigins.length > 0) {
    app.enableCors({
      origin: env.corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    })
  }

  await app.listen(env.port, '0.0.0.0')

  // Admin is granted per sign-in from GOOGLE_ADMIN_EMAILS rather than seeded, so
  // there is nothing to bootstrap here — only expired sessions to sweep.
  const auth = app.get(AuthService, { strict: false })
  await auth.purgeExpiredSessions()

  // Admin comes from GOOGLE_ADMIN_EMAILS and nothing else now — there is no password
  // account left — so both of these are silent lockouts that need saying out loud
  // rather than being discovered as a 403 on /admin/data.
  if (!env.google.enabled) {
    logger.warn(
      'Google sign-in is not configured: nobody can sign in at all. ' +
        'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI.'
    )
  } else if (env.google.adminEmails.length === 0) {
    logger.warn(
      'GOOGLE_ADMIN_EMAILS is empty: visitors can sign in but no account can become admin. ' +
        'Add the verified Google address allowed to reach /admin/data.'
    )
  }

  logger.log(`ghostmplay-api listening on :${env.port} (${env.nodeEnv})`)
  logger.log(env.webRoot ? `Serving web build from ${env.webRoot}` : 'No web build found — API only')
  if (env.corsOrigins.length === 0) {
    logger.log('CORS disabled (same-origin only)')
  }
}

bootstrap()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[bootstrap] failed to start', err)
    process.exit(1)
  })

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import { requestLogger } from './common/middleware/request-logger.middleware';

// "Today", "this month" and document-number years are worked out in the server's local time. A PC here runs on
// IST, but Vercel runs on UTC (and reserves the TZ variable), so set it here; APP_TIMEZONE overrides it.
process.env.TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';

function trustProxySetting(value: string | undefined): boolean | number | string {
  if (value === undefined || value === '') return 'loopback';
  if (value === 'true') return true;
  if (value === 'false') return false;
  const hops = Number(value);
  return Number.isInteger(hops) ? hops : value;
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  app.enableShutdownHooks();
  const config = app.get(ConfigService);
  const port = Number(config.get('PORT', 4000));
  const production = config.get('NODE_ENV') === 'production';
  const frontendUrl = config.get<string>('FRONTEND_URL', 'http://localhost:3000');

  // Behind nginx every request comes from 127.0.0.1. Without this, rate
  // limiting would put all users in one bucket and audit/login IPs would be wrong.
  app.set('trust proxy', trustProxySetting(config.get<string>('TRUST_PROXY')));
  app.disable('x-powered-by');

  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.use(compression({ threshold: 1024 }));
  app.use(cookieParser());
  app.use(requestLogger());
  app.enableCors({ origin: frontendUrl.split(',').map((v) => v.trim()), credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new PrismaExceptionFilter());

  const swaggerEnabled = config.get('SWAGGER_ENABLED', production ? 'false' : 'true') === 'true';
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Yarn Production ERP API')
      .setDescription('Order → Yarn → Knitting → Dyeing → QC → Delivery ERP')
      .setVersion('1.0')
      .addCookieAuth('access_token')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  await app.listen(port, '0.0.0.0');
  Logger.log(`API listening on port ${port}${swaggerEnabled ? ' (Swagger at /api/docs)' : ''}`, 'Bootstrap');
}

bootstrap().catch((error) => {
  Logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error), 'Bootstrap');
  process.exit(1);
});

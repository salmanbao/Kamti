import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { EnvironmentConfigService } from './shared/services/environment-config.service';
import { WinstonLoggerService } from './shared/services/winston-logger.service';
import { MyLogger } from './logger/logger.service';
import { join } from 'path';

/**
 * Application Bootstrap
 *
 * Initializes and configures the NestJS application:
 * - Sets up Winston logger for file-based logging
 * - Sets up CORS configuration
 * - Configures Swagger API documentation
 * - Starts the HTTP server
 */
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new MyLogger(),
    bufferLogs: true,
  });

  // Use Winston logger globally
  const winstonLogger = app.get(WinstonLoggerService);
  app.useLogger(winstonLogger);

  // Get environment configuration service for runtime config
  const envConfig = app.get(EnvironmentConfigService);

  // Configure CORS for cross-origin requests
  // Origin is configurable via environment variables
  app.enableCors({
    origin: envConfig.corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Note: Validation pipe is configured globally in CoreModule
  // No need to set it up here

  // Configure Swagger API documentation
  // Accessible at /api/docs endpoint
  const config = new DocumentBuilder()
    .setTitle('Aggregator AML APIs')
    .setDescription(
      'Non-custodial wallet swap aggregator API with multiple DEX support',
    )
    .setVersion('1.0')
    .addTag('Swap', 'Token swap operations')
    .addTag('Health', 'Health check endpoints')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true, // Persist auth tokens across page refreshes
    },
  });

  // Start the HTTP server on configured port
  const port = envConfig.port;

  // Set up Handlebars as view engine
  app.setBaseViewsDir(join(__dirname, '..', 'views'));
  app.setViewEngine('hbs');

  // Optional: Serve static assets if you have CSS/JS in public/
  // app.useStaticAssets(join(__dirname, '..', 'public'));

  await app.listen(port);

  // Log startup information
  winstonLogger.setContext('Bootstrap');
  winstonLogger.log(`Application is running on: http://localhost:${port}`);
  winstonLogger.log(`Swagger documentation: http://localhost:${port}/api/docs`);
  winstonLogger.log(`Environment: ${envConfig.nodeEnv}`);
}

bootstrap();

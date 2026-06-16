import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { mkdirSync } from 'fs';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const screenshotsDir = process.env.SCREENSHOTS_DIR ?? '/tmp/screenshots';
  mkdirSync(screenshotsDir, { recursive: true });
  app.useStaticAssets(screenshotsDir, { prefix: '/screenshots' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

  app.enableCors();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Test Script Generator')
    .setDescription(
      'Upload a screen recording and extract structured test steps with screenshots using the Gemini Video Understanding API.',
    )
    .setVersion('1.0')
    .addTag('Jobs', 'Submit videos and poll for results')
    .addTag('Column Configs', 'Manage custom output column configurations')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Server:      http://localhost:${port}`);
  console.log(`Swagger:     http://localhost:${port}/api/docs`);
  console.log(`Screenshots: http://localhost:${port}/screenshots/<uuid>.png`);
}
bootstrap();

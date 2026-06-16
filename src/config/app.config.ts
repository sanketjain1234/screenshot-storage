import { ConfigModule } from '@nestjs/config';
import * as Joi from 'joi';

export const AppConfigModule = ConfigModule.forRoot({
  isGlobal: true,
  validationSchema: Joi.object({
    GEMINI_API_KEY: Joi.string().required(),
    GEMINI_MODEL: Joi.string().default('gemini-2.5-flash'),
    GEMINI_FALLBACK_MODEL: Joi.string().default('gemini-2.5-flash-lite'),
    PORT: Joi.number().default(3000),
    MAX_FILE_SIZE_BYTES: Joi.number().default(209715200),
    TEMP_DIR: Joi.string().default('/tmp'),
    SCREENSHOTS_DIR: Joi.string().default('/tmp/screenshots'),
    APP_BASE_URL: Joi.string().default('http://localhost:3000'),
    GEMINI_UPLOAD_SPEED_MBPS: Joi.number().default(1),
    GEMINI_PROCESSING_BUFFER_SECONDS: Joi.number().default(30),
  }),
  validationOptions: {
    abortEarly: true,
  },
});

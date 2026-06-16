import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { GeminiModule } from '../gemini/gemini.module';
import { ScreenshotModule } from '../screenshot/screenshot.module';
import { VideoModule } from '../video/video.module';
import { ColumnConfigsModule } from '../column-configs/column-configs.module';
import { IJobRepository } from '../common/repositories/job.repository.interface';
import { InMemoryJobRepository } from '../common/repositories/job.repository';
import { IVideoHashRepository } from '../common/repositories/video-hash.repository.interface';
import { InMemoryVideoHashRepository } from '../common/repositories/video-hash.repository';

@Module({
  imports: [GeminiModule, ScreenshotModule, VideoModule, ColumnConfigsModule],
  controllers: [JobsController],
  providers: [
    JobsService,
    {
      provide: IJobRepository,
      useClass: InMemoryJobRepository,
    },
    {
      provide: IVideoHashRepository,
      useClass: InMemoryVideoHashRepository,
    },
  ],
})
export class JobsModule {}

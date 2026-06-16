import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ffmpeg from '../common/ffmpeg/ffmpeg-setup';
import { promises as fs } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class ScreenshotService {
  private readonly logger = new Logger(ScreenshotService.name);

  constructor(private readonly configService: ConfigService) {}

  async extractFrame(videoPath: string, timestampSeconds: number): Promise<string> {
    const screenshotsDir = this.configService.getOrThrow<string>('SCREENSHOTS_DIR');
    const appBaseUrl = this.configService.getOrThrow<string>('APP_BASE_URL');
    const baseUrl = appBaseUrl.replace(/\/$/, '');
    const filename = `${uuidv4()}.png`;
    const outputPath = join(screenshotsDir, filename);
    const start = Date.now();

    try {
      await fs.mkdir(screenshotsDir, { recursive: true });
      this.logger.debug(`Extracting frame at ${timestampSeconds}s → ${outputPath}`);
      await this.runFfmpeg(videoPath, timestampSeconds, outputPath);
      const { size } = await fs.stat(outputPath);
      this.logger.debug(
        `Frame at ${timestampSeconds}s extracted in ${Date.now() - start}ms (${(size / 1024).toFixed(1)}KB PNG)`,
      );
      return `${baseUrl}/screenshots/${filename}`;
    } catch (err) {
      this.logger.error(
        `Frame extraction failed at ${timestampSeconds}s after ${Date.now() - start}ms: ${err.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to extract screenshot at ${timestampSeconds}s`,
      );
    }
  }

  private runFfmpeg(
    videoPath: string,
    timestampSeconds: number,
    outputPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(timestampSeconds)
        .frames(1)
        .outputOptions('-q:v', '2')
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });
  }
}

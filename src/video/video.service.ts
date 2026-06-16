import {
  BadRequestException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import * as http from 'http';
import * as https from 'https';
import { join, extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from '../common/ffmpeg/ffmpeg-setup';

const WHITELISTED_DOMAINS = [
  'drive.google.com',
  'dropbox.com',
  'dl.dropboxusercontent.com',
  'storage.googleapis.com',
  's3.amazonaws.com',
  'loom.com',
  'www.loom.com',
];

const DIRECT_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.avi'];
const ALLOWED_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo'];
const MAX_DURATION_SECONDS = 240;

@Injectable()
export class VideoService {
  private readonly logger = new Logger(VideoService.name);

  constructor(private readonly configService: ConfigService) {}

  async validateFile(filePath: string, mimeType: string): Promise<number> {
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      this.logger.warn(`MIME type rejected: ${mimeType}`);
      throw new UnprocessableEntityException(
        `Unsupported video type: ${mimeType}. Allowed: mp4, mov, webm, avi`,
      );
    }
    this.logger.log(`MIME type OK: ${mimeType}`);

    const duration = await this.getVideoDuration(filePath);
    if (duration > MAX_DURATION_SECONDS) {
      this.logger.warn(`Duration rejected: ${duration.toFixed(1)}s > ${MAX_DURATION_SECONDS}s limit`);
      throw new UnprocessableEntityException(
        `Video is ${Math.round(duration)}s long. Maximum allowed is ${MAX_DURATION_SECONDS}s.`,
      );
    }
    this.logger.log(`Duration OK: ${duration.toFixed(1)}s (limit: ${MAX_DURATION_SECONDS}s)`);
    return duration;
  }

  async downloadFromUrl(url: string): Promise<{ filePath: string; mimeType: string }> {
    this.validateUrl(url);

    const tempDir = this.configService.getOrThrow<string>('TEMP_DIR');
    const ext = extname(new URL(url).pathname) || '.mp4';
    const filePath = join(tempDir, `${uuidv4()}${ext}`);

    this.logger.log(`Downloading video from URL: ${url}`);
    const downloadStart = Date.now();
    await this.downloadFile(url, filePath);
    const { size } = await fs.stat(filePath);
    this.logger.log(
      `Download complete: ${(size / 1_000_000).toFixed(2)}MB in ${Date.now() - downloadStart}ms → ${filePath}`,
    );

    const mimeType = this.extToMimeType(ext);
    return { filePath, mimeType };
  }

  async computeHash(filePath: string): Promise<string> {
    this.logger.log(`Computing SHA-256 for ${filePath}...`);
    const data = await fs.readFile(filePath);
    return createHash('sha256').update(data).digest('hex');
  }

  private validateUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      this.logger.warn(`URL validation failed — invalid format: ${url}`);
      throw new BadRequestException('Invalid URL format');
    }

    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    const isDomainWhitelisted = WHITELISTED_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
    const isDirectVideoUrl = DIRECT_VIDEO_EXTENSIONS.some((ext) => pathname.endsWith(ext));

    if (!isDomainWhitelisted && !isDirectVideoUrl) {
      this.logger.warn(`URL rejected — domain not whitelisted and no direct video extension: ${hostname}`);
      throw new BadRequestException(
        `URL domain is not whitelisted. Allowed domains: ${WHITELISTED_DOMAINS.join(', ')}. Or provide a direct video URL ending in .mp4, .mov, .webm, or .avi`,
      );
    }

    const reason = isDomainWhitelisted ? `whitelisted domain: ${hostname}` : `direct video extension on ${hostname}`;
    this.logger.log(`URL validation passed — ${reason}`);
  }

  private downloadFile(url: string, destPath: string): Promise<void> {
    const maxBytes = this.configService.getOrThrow<number>('MAX_FILE_SIZE_BYTES');
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      const file = createWriteStream(destPath);
      let downloaded = 0;

      protocol.get(url, (response) => {
        response.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          if (downloaded > maxBytes) {
            file.destroy();
            fs.unlink(destPath).catch(() => {});
            reject(
              new UnprocessableEntityException(
                `File exceeds maximum size of ${Math.round(maxBytes / 1024 / 1024)}MB`,
              ),
            );
          }
        });
        response.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      });
    });
  }

  private getVideoDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err: Error, metadata: any) => {
        if (err) return reject(new UnprocessableEntityException(`Could not read video metadata: ${err.message}`));
        const duration = metadata?.format?.duration;
        if (typeof duration !== 'number') return reject(new UnprocessableEntityException('Could not determine video duration'));
        resolve(duration);
      });
    });
  }

  private extToMimeType(ext: string): string {
    const map: Record<string, string> = {
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.avi': 'video/x-msvideo',
    };
    return map[ext.toLowerCase()] ?? 'video/mp4';
  }
}

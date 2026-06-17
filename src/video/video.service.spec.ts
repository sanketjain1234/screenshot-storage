import { EventEmitter } from 'events';
import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoService } from './video.service';

// --- Module mocks (must be hoisted before imports) ---

jest.mock('../common/ffmpeg/ffmpeg-setup', () => {
  const mock: any = jest.fn(() => mock);
  mock.ffprobe = jest.fn();
  return { __esModule: true, default: mock };
});

/** Shared mock write-stream instance; re-created per test in beforeEach. */
let mockFileStream: EventEmitter & { close: jest.Mock; destroy: jest.Mock };

jest.mock('fs', () => ({
  promises: {
    stat: jest.fn(),
    readFile: jest.fn(),
    unlink: jest.fn().mockResolvedValue(undefined),
  },
  createWriteStream: jest.fn(() => mockFileStream),
}));

jest.mock('https', () => ({
  get: jest.fn((_url: string, cb: (res: any) => void) => {
    const { EventEmitter: EE } = require('events');
    const response = new EE();
    response.pipe = jest.fn((dest: any) => { setImmediate(() => dest.emit('finish')); });
    cb(response);
    return { on: jest.fn() };
  }),
}));

jest.mock('http', () => ({
  get: jest.fn((_url: string, cb: (res: any) => void) => {
    const { EventEmitter: EE } = require('events');
    const response = new EE();
    response.pipe = jest.fn((dest: any) => { setImmediate(() => dest.emit('finish')); });
    cb(response);
    return { on: jest.fn() };
  }),
}));

// --- Imports after mocks ---

import ffmpegSetup from '../common/ffmpeg/ffmpeg-setup';
const ffmpegMock = ffmpegSetup as any;

const mockConfigService = {
  get: jest.fn(),
  getOrThrow: jest.fn((key: string) => {
    const cfg: Record<string, unknown> = { TEMP_DIR: '/tmp', MAX_FILE_SIZE_BYTES: 209_715_200 };
    if (cfg[key] === undefined) throw new Error(`Missing config key: ${key}`);
    return cfg[key];
  }),
} as unknown as ConfigService;

// --- Tests ---

describe('VideoService', () => {
  let service: VideoService;

  beforeEach(() => {
    jest.clearAllMocks();

    // Re-apply implementations cleared by clearAllMocks
    const fsMock = require('fs');
    fsMock.promises.stat.mockResolvedValue({ size: 1_048_576 });
    fsMock.promises.unlink.mockResolvedValue(undefined);

    mockFileStream = Object.assign(new EventEmitter(), {
      close: jest.fn((cb: () => void) => cb()),
      destroy: jest.fn(),
    });

    service = new VideoService(mockConfigService);
  });

  // --- URL validation ---

  describe('downloadFromUrl — URL validation', () => {
    it('throws BadRequestException for a completely invalid URL', async () => {
      await expect(service.downloadFromUrl('not-a-url')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for a non-whitelisted domain with no video extension', async () => {
      await expect(service.downloadFromUrl('https://evil.com/some/page')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException for an http URL on an unknown domain without video ext', async () => {
      await expect(service.downloadFromUrl('http://unknown-host.com/video')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('resolves successfully for a whitelisted domain (drive.google.com)', async () => {
      await expect(
        service.downloadFromUrl('https://drive.google.com/file/d/abc/view'),
      ).resolves.toBeDefined();
    });

    it('resolves successfully for a direct .mp4 URL on any domain', async () => {
      await expect(
        service.downloadFromUrl('https://any-host.com/path/video.mp4'),
      ).resolves.toBeDefined();
    });

    it('resolves successfully for a direct .mov URL on any domain', async () => {
      await expect(
        service.downloadFromUrl('https://any-host.com/recording.mov'),
      ).resolves.toBeDefined();
    });

    it('resolves successfully for s3.amazonaws.com', async () => {
      await expect(
        service.downloadFromUrl('https://s3.amazonaws.com/bucket/video.webm'),
      ).resolves.toBeDefined();
    });

    it('resolves successfully for a subdomain of a whitelisted domain', async () => {
      await expect(
        service.downloadFromUrl('https://dl.dropboxusercontent.com/s/abc/video.mp4'),
      ).resolves.toBeDefined();
    });

    it('returns the correct mimeType inferred from the URL extension', async () => {
      const result = await service.downloadFromUrl('https://any-host.com/video.mov');
      expect(result.mimeType).toBe('video/quicktime');
    });
  });

  // --- validateFile ---

  describe('validateFile', () => {
    const stubFfprobe = (duration: number) =>
      (ffmpegMock.ffprobe as jest.Mock).mockImplementation((_p: string, cb: Function) =>
        cb(null, { format: { duration } }),
      );

    const stubFfprobeError = (msg: string) =>
      (ffmpegMock.ffprobe as jest.Mock).mockImplementation((_p: string, cb: Function) =>
        cb(new Error(msg), null),
      );

    it('accepts a valid MIME type and returns the video duration', async () => {
      stubFfprobe(30.0);
      await expect(service.validateFile('/tmp/video.mp4', 'video/mp4')).resolves.toBe(30.0);
    });

    it('accepts video/quicktime', async () => {
      stubFfprobe(15.0);
      await expect(service.validateFile('/tmp/video.mov', 'video/quicktime')).resolves.toBe(15.0);
    });

    it('accepts video/webm', async () => {
      stubFfprobe(20.0);
      await expect(service.validateFile('/tmp/video.webm', 'video/webm')).resolves.toBe(20.0);
    });

    it('throws UnprocessableEntityException for an unsupported MIME type without calling ffprobe', async () => {
      await expect(
        service.validateFile('/tmp/video.mkv', 'video/x-matroska'),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(ffmpegMock.ffprobe).not.toHaveBeenCalled();
    });

    it('throws UnprocessableEntityException when duration exceeds 240s', async () => {
      stubFfprobe(241);
      await expect(service.validateFile('/tmp/long.mp4', 'video/mp4')).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('accepts a video at exactly the 240s limit', async () => {
      stubFfprobe(240);
      await expect(service.validateFile('/tmp/exact.mp4', 'video/mp4')).resolves.toBe(240);
    });

    it('throws UnprocessableEntityException when ffprobe returns an error', async () => {
      stubFfprobeError('File not found');
      await expect(service.validateFile('/tmp/missing.mp4', 'video/mp4')).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('throws UnprocessableEntityException when format.duration is absent', async () => {
      (ffmpegMock.ffprobe as jest.Mock).mockImplementation((_p: string, cb: Function) =>
        cb(null, { format: {} }),
      );
      await expect(service.validateFile('/tmp/bad.mp4', 'video/mp4')).rejects.toThrow(
        UnprocessableEntityException,
      );
    });
  });
});

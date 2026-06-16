import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { IJobRepository } from '../common/repositories/job.repository.interface';
import { IVideoHashRepository } from '../common/repositories/video-hash.repository.interface';
import { GeminiService } from '../gemini/gemini.service';
import { ScreenshotService } from '../screenshot/screenshot.service';
import { VideoService } from '../video/video.service';
import { ColumnConfigsService } from '../column-configs/column-configs.service';
import { Job, JobStatus } from '../common/types/job.types';
import { Step } from '../common/types/step.types';

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: {
    stat: jest.fn().mockResolvedValue({ size: 1_048_576 }),
    unlink: jest.fn().mockResolvedValue(undefined),
  },
}));

const makeStep = (n: number, ts: number): Step => ({
  stepNumber: n,
  action: `Action ${n}`,
  description: `Description for step ${n}`,
  expectedResult: `Result ${n}`,
  timestampSeconds: ts,
});

const MOCK_FILE = {
  originalname: 'demo.mp4',
  path: '/tmp/demo.mp4',
  mimetype: 'video/mp4',
  size: 1_048_576,
} as Express.Multer.File;

const SCREENSHOT_URL = 'http://localhost:3000/screenshots/abc.png';

/** Polls jobStore until the job reaches a terminal status or 5 s elapses. */
function waitForTerminal(jobStore: Map<string, Job>, jobId: string): Promise<Job> {
  const TERMINAL = [JobStatus.COMPLETED, JobStatus.FAILED];
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const check = () => {
      const job = jobStore.get(jobId);
      if (job && TERMINAL.includes(job.status)) return resolve(job);
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for terminal status. Last: ${job?.status}`));
      setImmediate(check);
    };
    setImmediate(check);
  });
}

describe('JobsService', () => {
  let service: JobsService;
  let jobStore: Map<string, Job>;
  let hashStore: Map<string, string>;
  let mockJobRepo: jest.Mocked<IJobRepository>;
  let mockHashRepo: jest.Mocked<IVideoHashRepository>;
  let mockGemini: jest.Mocked<Pick<GeminiService, 'uploadVideoFile' | 'waitUntilActive' | 'generateSteps'>>;
  let mockScreenshot: jest.Mocked<Pick<ScreenshotService, 'extractFrame'>>;
  let mockVideo: jest.Mocked<Pick<VideoService, 'computeHash' | 'validateFile' | 'downloadFromUrl'>>;
  let mockColumnConfigs: jest.Mocked<Pick<ColumnConfigsService, 'resolveColumnDefs'>>;

  beforeEach(async () => {
    jobStore = new Map();
    hashStore = new Map();

    mockJobRepo = {
      create: jest.fn((job) => { jobStore.set(job.id, { ...job }); }),
      findById: jest.fn((id) => jobStore.get(id)),
      update: jest.fn((id, patch) => {
        const existing = jobStore.get(id);
        if (existing) jobStore.set(id, { ...existing, ...patch });
      }),
    } as any;

    mockHashRepo = {
      get: jest.fn((hash) => hashStore.get(hash)),
      set: jest.fn((hash, jobId) => { hashStore.set(hash, jobId); }),
    } as any;

    mockGemini = {
      uploadVideoFile: jest.fn().mockResolvedValue({ uri: 'gs://bucket/file.mp4', name: 'files/abc123' }),
      waitUntilActive: jest.fn().mockResolvedValue(undefined),
      generateSteps: jest.fn().mockResolvedValue([makeStep(1, 2.5), makeStep(2, 8.0)]),
    } as any;

    mockScreenshot = {
      extractFrame: jest.fn().mockResolvedValue(SCREENSHOT_URL),
    } as any;

    mockVideo = {
      computeHash: jest.fn().mockResolvedValue('deadbeefcafe'),
      validateFile: jest.fn().mockResolvedValue(30.0),
      downloadFromUrl: jest.fn().mockResolvedValue({ filePath: '/tmp/url.mp4', mimeType: 'video/mp4' }),
    } as any;

    mockColumnConfigs = {
      resolveColumnDefs: jest.fn().mockReturnValue({ columnDefs: [], columnKeys: [] }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobsService,
        { provide: IJobRepository, useValue: mockJobRepo },
        { provide: IVideoHashRepository, useValue: mockHashRepo },
        { provide: GeminiService, useValue: mockGemini },
        { provide: ScreenshotService, useValue: mockScreenshot },
        { provide: VideoService, useValue: mockVideo },
        { provide: ColumnConfigsService, useValue: mockColumnConfigs },
      ],
    }).compile();

    service = module.get<JobsService>(JobsService);
  });

  // --- createFromFile ---

  describe('createFromFile', () => {
    it('returns PENDING response immediately without waiting for pipeline', async () => {
      const response = await service.createFromFile(MOCK_FILE);
      expect(response.status).toBe(JobStatus.PENDING);
      expect(response.jobId).toBeDefined();
      expect(response.steps).toBeUndefined();
    });

    it('marks job COMPLETED and attaches steps with screenshotUrls after full pipeline', async () => {
      const { jobId } = await service.createFromFile(MOCK_FILE);
      const job = await waitForTerminal(jobStore, jobId);

      expect(job.status).toBe(JobStatus.COMPLETED);
      expect(job.result).toHaveLength(2);
      expect(job.result![0].screenshotUrl).toBe(SCREENSHOT_URL);
      expect(mockGemini.uploadVideoFile).toHaveBeenCalledTimes(1);
      expect(mockGemini.generateSteps).toHaveBeenCalledTimes(1);
      expect(mockScreenshot.extractFrame).toHaveBeenCalledTimes(2);
    });

    it('passes video duration to generateSteps', async () => {
      mockVideo.validateFile.mockResolvedValue(45.5);
      const { jobId } = await service.createFromFile(MOCK_FILE);
      await waitForTerminal(jobStore, jobId);

      expect(mockGemini.generateSteps).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Array),
        45.5,
      );
    });

    it('passes resolved columnDefs to generateSteps when a configId is provided', async () => {
      const fakeDefs = [{ key: 'priority', label: 'Priority', description: 'Step priority.' }];
      mockColumnConfigs.resolveColumnDefs.mockReturnValue({ columnDefs: fakeDefs, columnKeys: ['priority'] });

      const { jobId } = await service.createFromFile(MOCK_FILE, 'config-abc');
      await waitForTerminal(jobStore, jobId);

      expect(mockColumnConfigs.resolveColumnDefs).toHaveBeenCalledWith('config-abc');
      expect(mockGemini.generateSteps).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        fakeDefs,
        expect.any(Number),
      );
    });

    it('marks job FAILED and stores error message when Gemini throws', async () => {
      mockGemini.generateSteps.mockRejectedValue(new Error('Gemini 503'));

      const { jobId } = await service.createFromFile(MOCK_FILE);
      const job = await waitForTerminal(jobStore, jobId);

      expect(job.status).toBe(JobStatus.FAILED);
      expect(job.error).toBe('Gemini 503');
    });

    it('marks job FAILED when video validation throws UnprocessableEntityException', async () => {
      mockVideo.validateFile.mockRejectedValue(
        new UnprocessableEntityException('Video is 300s long. Maximum allowed is 240s.'),
      );

      const { jobId } = await service.createFromFile(MOCK_FILE);
      const job = await waitForTerminal(jobStore, jobId);

      expect(job.status).toBe(JobStatus.FAILED);
      expect(job.error).toContain('Maximum allowed is 240s');
    });
  });

  // --- Deduplication ---

  describe('deduplication', () => {
    it('reuses result from an existing COMPLETED job with the same video hash', async () => {
      const existingJob: Job = {
        id: 'existing-job-id',
        status: JobStatus.COMPLETED,
        result: [makeStep(1, 1.0), makeStep(2, 3.0), makeStep(3, 6.0)],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      jobStore.set(existingJob.id, existingJob);
      hashStore.set('deadbeefcafe', existingJob.id);

      const { jobId } = await service.createFromFile(MOCK_FILE);
      const job = await waitForTerminal(jobStore, jobId);

      expect(job.status).toBe(JobStatus.COMPLETED);
      expect(job.result).toHaveLength(3);
      expect(mockGemini.uploadVideoFile).not.toHaveBeenCalled();
      expect(mockGemini.generateSteps).not.toHaveBeenCalled();
      expect(mockScreenshot.extractFrame).not.toHaveBeenCalled();
    });

    it('runs full pipeline if duplicate hash exists but the prior job FAILED', async () => {
      const failedJob: Job = {
        id: 'failed-job-id',
        status: JobStatus.FAILED,
        error: 'Previous failure',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      jobStore.set(failedJob.id, failedJob);
      hashStore.set('deadbeefcafe', failedJob.id);

      const { jobId } = await service.createFromFile(MOCK_FILE);
      const job = await waitForTerminal(jobStore, jobId);

      expect(job.status).toBe(JobStatus.COMPLETED);
      expect(mockGemini.uploadVideoFile).toHaveBeenCalledTimes(1);
    });
  });

  // --- Timestamp clamping ---

  describe('timestamp clamping', () => {
    it('clamps step timestamps that exceed videoDuration - 0.5', async () => {
      mockVideo.validateFile.mockResolvedValue(10.0);
      mockGemini.generateSteps.mockResolvedValue([
        makeStep(1, 5.0),   // within bounds → unchanged
        makeStep(2, 10.5),  // beyond 9.5 → should clamp
        makeStep(3, 9.5),   // exactly at limit → unchanged
      ]);

      const { jobId } = await service.createFromFile(MOCK_FILE);
      const job = await waitForTerminal(jobStore, jobId);

      expect(job.result![0].timestampSeconds).toBe(5.0);
      expect(job.result![1].timestampSeconds).toBe(9.5);  // clamped: 10.0 - 0.5
      expect(job.result![2].timestampSeconds).toBe(9.5);
    });

    it('does not modify timestamps within video bounds', async () => {
      mockVideo.validateFile.mockResolvedValue(60.0);
      mockGemini.generateSteps.mockResolvedValue([makeStep(1, 5.0), makeStep(2, 30.0)]);

      const { jobId } = await service.createFromFile(MOCK_FILE);
      const job = await waitForTerminal(jobStore, jobId);

      expect(job.result![0].timestampSeconds).toBe(5.0);
      expect(job.result![1].timestampSeconds).toBe(30.0);
    });
  });

  // --- Screenshot failure isolation ---

  describe('screenshot failure isolation', () => {
    it('still marks job COMPLETED when some screenshots fail', async () => {
      mockScreenshot.extractFrame
        .mockResolvedValueOnce(SCREENSHOT_URL)
        .mockRejectedValueOnce(new Error('ffmpeg extraction failed'));

      const { jobId } = await service.createFromFile(MOCK_FILE);
      const job = await waitForTerminal(jobStore, jobId);

      expect(job.status).toBe(JobStatus.COMPLETED);
      expect(job.result![0].screenshotUrl).toBe(SCREENSHOT_URL);
      expect(job.result![1].screenshotUrl).toBeUndefined();
    });

    it('marks job COMPLETED even when all screenshots fail', async () => {
      mockScreenshot.extractFrame.mockRejectedValue(new Error('ffmpeg not available'));

      const { jobId } = await service.createFromFile(MOCK_FILE);
      const job = await waitForTerminal(jobStore, jobId);

      expect(job.status).toBe(JobStatus.COMPLETED);
      expect(job.result!.every((s) => s.screenshotUrl === undefined)).toBe(true);
    });
  });

  // --- createFromUrl ---

  describe('createFromUrl', () => {
    it('returns PENDING response immediately', async () => {
      const response = await service.createFromUrl('https://storage.googleapis.com/video.mp4');
      expect(response.status).toBe(JobStatus.PENDING);
    });

    it('downloads video then runs the full pipeline', async () => {
      const { jobId } = await service.createFromUrl('https://storage.googleapis.com/video.mp4');
      const job = await waitForTerminal(jobStore, jobId);

      expect(mockVideo.downloadFromUrl).toHaveBeenCalledWith('https://storage.googleapis.com/video.mp4');
      expect(job.status).toBe(JobStatus.COMPLETED);
    });

    it('marks job FAILED when download throws', async () => {
      mockVideo.downloadFromUrl.mockRejectedValue(
        new Error('Domain not whitelisted'),
      );

      const { jobId } = await service.createFromUrl('https://evil.com/video.mp4');
      const job = await waitForTerminal(jobStore, jobId);

      expect(job.status).toBe(JobStatus.FAILED);
      expect(job.error).toBe('Domain not whitelisted');
    });
  });

  // --- findById ---

  describe('findById', () => {
    it('throws NotFoundException for an unknown jobId', () => {
      expect(() => service.findById('does-not-exist')).toThrow(NotFoundException);
    });

    it('returns a DTO with the correct jobId and current status', async () => {
      const { jobId } = await service.createFromFile(MOCK_FILE);
      const found = service.findById(jobId);
      expect(found.jobId).toBe(jobId);
      expect(found.status).toBeDefined();
    });

    it('returns steps on a COMPLETED job', async () => {
      const { jobId } = await service.createFromFile(MOCK_FILE);
      await waitForTerminal(jobStore, jobId);

      const found = service.findById(jobId);
      expect(found.status).toBe(JobStatus.COMPLETED);
      expect(found.steps).toHaveLength(2);
    });
  });
});

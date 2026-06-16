import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';
import { IJobRepository } from '../common/repositories/job.repository.interface';
import { IVideoHashRepository } from '../common/repositories/video-hash.repository.interface';
import { Job, JobStatus } from '../common/types/job.types';
import { Step } from '../common/types/step.types';
import { GeminiService } from '../gemini/gemini.service';
import { ScreenshotService } from '../screenshot/screenshot.service';
import { VideoService } from '../video/video.service';
import { ColumnConfigsService } from '../column-configs/column-configs.service';
import { JobResponseDto } from './dto/job-response.dto';

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly jobRepository: IJobRepository,
    private readonly videoHashRepository: IVideoHashRepository,
    private readonly geminiService: GeminiService,
    private readonly screenshotService: ScreenshotService,
    private readonly videoService: VideoService,
    private readonly columnConfigsService: ColumnConfigsService,
  ) {}

  async createFromFile(
    file: Express.Multer.File,
    configId?: string,
  ): Promise<JobResponseDto> {
    const job = this.createJob();
    this.logger.log(
      `Job ${job.id} created — source: file upload | ` +
      `originalName: ${file.originalname} | size: ${(file.size / 1_000_000).toFixed(2)}MB | ` +
      `mimeType: ${file.mimetype} | configId: ${configId ?? 'default'}`,
    );
    void this.processJob(job.id, file.path, file.mimetype, configId);
    return this.toResponseDto(job);
  }

  async createFromUrl(url: string, configId?: string): Promise<JobResponseDto> {
    const job = this.createJob();
    this.logger.log(
      `Job ${job.id} created — source: URL | url: ${url} | configId: ${configId ?? 'default'}`,
    );
    void this.processJobFromUrl(job.id, url, configId);
    return this.toResponseDto(job);
  }

  findById(jobId: string): JobResponseDto {
    const job = this.jobRepository.findById(jobId);
    if (!job) throw new NotFoundException(`Job not found: ${jobId}`);
    return this.toResponseDto(job);
  }

  private createJob(): Job {
    const job: Job = {
      id: uuidv4(),
      status: JobStatus.PENDING,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.jobRepository.create(job);
    return job;
  }

  private async processJobFromUrl(
    jobId: string,
    url: string,
    configId?: string,
  ): Promise<void> {
    let filePath: string | undefined;
    let mimeType: string | undefined;

    try {
      this.updateStatus(jobId, JobStatus.VALIDATING);
      const downloaded = await this.videoService.downloadFromUrl(url);
      filePath = downloaded.filePath;
      mimeType = downloaded.mimeType;
      await this.processJob(jobId, filePath, mimeType, configId);
    } catch (err) {
      this.logger.error(`Job ${jobId} failed (URL): ${err.message}`);
      this.jobRepository.update(jobId, {
        status: JobStatus.FAILED,
        error: err.message,
      });
      if (filePath) await fs.unlink(filePath).catch(() => {});
    }
  }

  private async processJob(
    jobId: string,
    filePath: string,
    mimeType: string,
    configId?: string,
  ): Promise<void> {
    const pipelineStart = Date.now();

    try {
      this.updateStatus(jobId, JobStatus.VALIDATING);

      // Dedup check
      this.logger.log(`Job ${jobId} → computing SHA-256 hash...`);
      const hashStart = Date.now();
      const hash = await this.videoService.computeHash(filePath);
      this.logger.log(`Job ${jobId} → hash: ${hash.slice(0, 12)}... (took ${Date.now() - hashStart}ms)`);

      const existingJobId = this.videoHashRepository.get(hash);
      if (existingJobId && existingJobId !== jobId) {
        const existingJob = this.jobRepository.findById(existingJobId);
        if (existingJob?.status === JobStatus.COMPLETED) {
          this.logger.log(
            `Job ${jobId} → duplicate detected. Reusing result from job ${existingJobId} ` +
            `(${existingJob.result?.length ?? 0} steps). Skipping pipeline.`,
          );
          this.jobRepository.update(jobId, {
            status: JobStatus.COMPLETED,
            videoHash: hash,
            result: existingJob.result,
          });
          return;
        }
        this.logger.log(
          `Job ${jobId} → duplicate hash found but existing job ${existingJobId} is ${existingJob?.status}. Proceeding with full pipeline.`,
        );
      }

      this.jobRepository.update(jobId, { videoHash: hash });
      this.logger.log(`Job ${jobId} → validating file (mimeType: ${mimeType})...`);
      const videoDuration = await this.videoService.validateFile(filePath, mimeType);
      this.logger.log(`Job ${jobId} → validation passed (duration: ${videoDuration.toFixed(1)}s)`);

      // Upload to Gemini
      this.updateStatus(jobId, JobStatus.UPLOADING_TO_GEMINI);
      const { size: fileSizeBytes } = await fs.stat(filePath);
      this.logger.log(`Job ${jobId} → uploading to Gemini (${(fileSizeBytes / 1_000_000).toFixed(2)}MB, ${mimeType})...`);
      const uploadStart = Date.now();
      const { uri, name } = await this.geminiService.uploadVideoFile(filePath, mimeType);
      this.logger.log(`Job ${jobId} → Gemini upload done in ${Date.now() - uploadStart}ms. File: ${name}`);
      await this.geminiService.waitUntilActive(name, fileSizeBytes);
      this.jobRepository.update(jobId, { geminiFileUri: uri });

      // Generate steps
      this.updateStatus(jobId, JobStatus.PROCESSING);
      const { columnDefs, columnKeys } = this.columnConfigsService.resolveColumnDefs(configId);
      this.logger.log(
        `Job ${jobId} → generating steps. Columns: [${columnKeys.join(', ') || 'default'}]`,
      );
      const generateStart = Date.now();
      const rawSteps = await this.geminiService.generateSteps(uri, mimeType, columnDefs, videoDuration);
      this.logger.log(
        `Job ${jobId} → Gemini returned ${rawSteps.length} steps (took ${Date.now() - generateStart}ms)`,
      );

      // Clamp timestamps Gemini may hallucinate beyond the video's actual end
      const maxTimestamp = Math.max(0, videoDuration - 0.5);
      const clampedSteps = rawSteps.map((step) => {
        if (step.timestampSeconds > maxTimestamp) {
          this.logger.warn(
            `Job ${jobId} → step ${step.stepNumber} timestamp ${step.timestampSeconds}s exceeds video duration ${videoDuration.toFixed(1)}s — clamping to ${maxTimestamp.toFixed(1)}s`,
          );
          return { ...step, timestampSeconds: maxTimestamp };
        }
        return step;
      });

      // Extract screenshots
      this.updateStatus(jobId, JobStatus.EXTRACTING_SCREENSHOTS);
      this.logger.log(`Job ${jobId} → extracting ${clampedSteps.length} screenshots...`);
      const screenshotStart = Date.now();
      const steps: Step[] = await Promise.all(
        clampedSteps.map(async (step, index) => {
          this.logger.debug(
            `Job ${jobId} → screenshot ${index + 1}/${clampedSteps.length} at ${step.timestampSeconds}s`,
          );
          try {
            const screenshotUrl = await this.screenshotService.extractFrame(
              filePath,
              step.timestampSeconds,
            );
            return { ...step, screenshotUrl };
          } catch (err) {
            this.logger.warn(
              `Job ${jobId} → screenshot ${index + 1} at ${step.timestampSeconds}s failed (${err.message}). Continuing without screenshot.`,
            );
            return { ...step, screenshotUrl: undefined };
          }
        }),
      );
      const failedScreenshots = steps.filter((s) => !s.screenshotUrl).length;
      this.logger.log(
        `Job ${jobId} → screenshots done in ${Date.now() - screenshotStart}ms` +
        (failedScreenshots > 0 ? ` (${failedScreenshots}/${steps.length} failed)` : ''),
      );

      this.jobRepository.update(jobId, { status: JobStatus.COMPLETED, result: steps });
      this.videoHashRepository.set(hash, jobId);
      this.logger.log(
        `Job ${jobId} → COMPLETED. Steps: ${steps.length}. Total pipeline: ${Math.round((Date.now() - pipelineStart) / 1000)}s`,
      );
    } catch (err) {
      this.logger.error(
        `Job ${jobId} → FAILED after ${Math.round((Date.now() - pipelineStart) / 1000)}s: ${err.message}`,
        err.stack,
      );
      this.jobRepository.update(jobId, {
        status: JobStatus.FAILED,
        error: err.message,
      });
    } finally {
      await fs.unlink(filePath)
        .then(() => this.logger.debug(`Job ${jobId} → temp file deleted: ${filePath}`))
        .catch(() => this.logger.warn(`Job ${jobId} → could not delete temp file: ${filePath}`));
    }
  }

  private updateStatus(jobId: string, status: JobStatus): void {
    this.jobRepository.update(jobId, { status });
    this.logger.log(`Job ${jobId} → ${status}`);
  }

  private toResponseDto(job: Job): JobResponseDto {
    return {
      jobId: job.id,
      status: job.status,
      steps: job.result as any,
      error: job.error,
    };
  }
}

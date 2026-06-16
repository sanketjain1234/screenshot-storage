import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager, FileState } from '@google/generative-ai/server';
import { ColumnDefinition, Step } from '../common/types/step.types';
import { buildStepSchema } from '../common/validators/gemini-response.schema';
import { readFileSync } from 'fs';
import { join } from 'path';

interface PromptConfig {
  role: string;
  task: string;
  fields: string[];
  timestampConstraints: string[];
  outputConstraints: string[];
  retryWarning: string;
}

const promptConfig: PromptConfig = JSON.parse(
  readFileSync(join(__dirname, 'prompt.config.json'), 'utf-8'),
) as PromptConfig;

const DEFAULT_MODEL = 'gemini-2.5-flash';
const MAX_PARSE_RETRIES = 2;
const MAX_RATE_LIMIT_RETRIES = 3;
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 300_000;         // 5 min max poll window
const MAX_INITIAL_WAIT_MS = 180_000;     // cap initial wait at 3 minutes
const RATE_LIMIT_BASE_DELAY_MS = 30_000;

@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private readonly fileManager: GoogleAIFileManager;
  private readonly genAI: GoogleGenerativeAI;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.getOrThrow<string>('GEMINI_API_KEY');
    this.fileManager = new GoogleAIFileManager(apiKey);
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async uploadVideoFile(
    filePath: string,
    mimeType: string,
  ): Promise<{ uri: string; name: string }> {
    this.logger.log(`Uploading video to Gemini Files API: ${filePath}`);
    const response = await this.fileManager.uploadFile(filePath, {
      mimeType,
      displayName: filePath.split('/').pop(),
    });
    return { uri: response.file.uri, name: response.file.name };
  }

  async waitUntilActive(fileName: string, fileSizeBytes: number): Promise<void> {
    const initialWaitMs = this.computeInitialWait(fileSizeBytes);
    this.logger.log(
      `File size: ${(fileSizeBytes / 1_000_000).toFixed(1)}MB. ` +
      `Waiting ${Math.round(initialWaitMs / 1000)}s before polling (upload estimate + processing buffer)...`,
    );
    await this.sleep(initialWaitMs);

    this.logger.log(`Polling Gemini file state: ${fileName}`);
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const file = await this.fileManager.getFile(fileName);
      if (file.state === FileState.ACTIVE) {
        this.logger.log(`Gemini file active: ${fileName}`);
        return;
      }
      if (file.state === FileState.FAILED) {
        throw new InternalServerErrorException(
          `Gemini file processing failed for: ${fileName}`,
        );
      }
      this.logger.log(`File state: ${file.state}. Polling again in ${POLL_INTERVAL_MS / 1000}s...`);
      await this.sleep(POLL_INTERVAL_MS);
    }

    throw new InternalServerErrorException(
      `Gemini file did not become active within ${POLL_TIMEOUT_MS / 1000}s`,
    );
  }

  async generateSteps(
    fileUri: string,
    mimeType: string,
    columnDefs: ColumnDefinition[],
    videoDuration: number,
  ): Promise<Step[]> {
    const primaryModel = this.configService.get<string>('GEMINI_MODEL') ?? DEFAULT_MODEL;
    const fallbackModel = this.configService.get<string>('GEMINI_FALLBACK_MODEL') ?? null;

    for (let parseAttempt = 1; parseAttempt <= MAX_PARSE_RETRIES + 1; parseAttempt++) {
      try {
        return await this.generateWithRateLimitRetry(fileUri, mimeType, columnDefs, parseAttempt, primaryModel, videoDuration);
      } catch (err) {
        if (this.isRateLimitError(err)) {
          throw new InternalServerErrorException(
            `Gemini rate limit exhausted. Please retry later. (${err.message})`,
          );
        }

        if (this.isServiceUnavailableError(err) && fallbackModel) {
          this.logger.warn(
            `503 from ${primaryModel}. Attempting fallback model: ${fallbackModel}...`,
          );
          try {
            return await this.generateWithRateLimitRetry(fileUri, mimeType, columnDefs, parseAttempt, fallbackModel, videoDuration);
          } catch (fallbackErr) {
            if (this.isRateLimitError(fallbackErr)) {
              throw new InternalServerErrorException(
                `Gemini rate limit exhausted on fallback model ${fallbackModel}. Please retry later.`,
              );
            }
            this.logger.warn(
              `Fallback model ${fallbackModel} also failed: ${fallbackErr.message}`,
            );
          }
        }

        if (parseAttempt > MAX_PARSE_RETRIES) {
          throw new InternalServerErrorException(
            `Gemini returned invalid output after ${parseAttempt} parse attempts: ${err.message}`,
          );
        }
        this.logger.warn(
          `Parse attempt ${parseAttempt} returned invalid JSON. Retrying with stricter prompt in 1s...`,
        );
        await this.sleep(1_000);
      }
    }
    throw new InternalServerErrorException('Gemini step generation failed');
  }

  private async generateWithRateLimitRetry(
    fileUri: string,
    mimeType: string,
    columnDefs: ColumnDefinition[],
    parseAttempt: number,
    modelName: string,
    videoDuration: number,
  ): Promise<Step[]> {
    for (let rlAttempt = 1; rlAttempt <= MAX_RATE_LIMIT_RETRIES + 1; rlAttempt++) {
      try {
        return await this.attemptGenerateSteps(fileUri, mimeType, columnDefs, parseAttempt, modelName, videoDuration);
      } catch (err) {
        if (!this.isRateLimitError(err)) throw err;
        if (rlAttempt > MAX_RATE_LIMIT_RETRIES) throw err;

        const delayMs =
          this.parseRetryDelay(err) ?? this.exponentialBackoffMs(rlAttempt);
        this.logger.warn(
          `Rate limited (rl-attempt ${rlAttempt}/${MAX_RATE_LIMIT_RETRIES}). Waiting ${Math.round(delayMs / 1000)}s...`,
        );
        await this.sleep(delayMs);
      }
    }
    throw new InternalServerErrorException('Rate limit retries exhausted');
  }

  private async attemptGenerateSteps(
    fileUri: string,
    mimeType: string,
    columnDefs: ColumnDefinition[],
    attempt: number,
    modelName: string,
    videoDuration: number,
  ): Promise<Step[]> {
    this.logger.log(`Calling generateContent → model: ${modelName}, parse attempt: ${attempt}, duration: ${videoDuration.toFixed(1)}s`);
    const model = this.genAI.getGenerativeModel({ model: modelName });
    const prompt = this.buildPrompt(columnDefs, attempt, videoDuration);

    const result = await model.generateContent([
      { fileData: { fileUri, mimeType } },
      { text: prompt },
    ]);

    const raw = result.response.text().trim();

    let parsed: unknown;
    try {
      const cleaned = this.stripJsonFences(raw);
      parsed = JSON.parse(cleaned);
    } catch (jsonErr) {
      this.logger.debug(
        `JSON.parse failed on attempt ${attempt}. Raw response (${raw.length} chars):\n` +
        `${raw.length > 3000 ? raw.substring(0, 3000) + '\n...[truncated]' : raw}`,
      );
      throw jsonErr;
    }

    const columnKeys = columnDefs.map((c) => c.key);
    const schema = buildStepSchema(columnKeys);
    try {
      return schema.parse(parsed) as Step[];
    } catch (zodErr) {
      this.logger.debug(
        `Zod schema validation failed on attempt ${attempt}. Parsed object:\n` +
        JSON.stringify(parsed, null, 2).substring(0, 3000),
      );
      throw zodErr;
    }
  }

  private buildPrompt(columnDefs: ColumnDefinition[], attempt: number, videoDuration: number): string {
    const cfg = promptConfig;
    const injectDuration = (s: string) =>
      s.replace(/\{VIDEO_DURATION_SECONDS\}/g, videoDuration.toFixed(1));

    const fieldsBlock = cfg.fields.map((f) => `- ${f}`).join('\n');

    const customBlock =
      columnDefs.length > 0
        ? '\nCustom fields to also include on each step:\n' +
          columnDefs.map((c) => `- ${c.key}: ${c.description}`).join('\n')
        : '';

    const timestampBlock = cfg.timestampConstraints
      .map((c) => injectDuration(c))
      .map((c) => `- ${c}`)
      .join('\n');

    const outputBlock = cfg.outputConstraints.map((c) => `- ${c}`).join('\n');

    const retryBlock = attempt > 1 ? `\n${cfg.retryWarning}` : '';

    return [
      cfg.role,
      '',
      cfg.task,
      '',
      'Required fields for each step:',
      fieldsBlock,
      customBlock,
      '',
      'Timestamp constraints (strictly enforced — violations will be rejected):',
      timestampBlock,
      '',
      'Output format requirements:',
      outputBlock,
      retryBlock,
    ].join('\n');
  }

  private stripJsonFences(raw: string): string {
    return raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
  }

  private computeInitialWait(fileSizeBytes: number): number {
    const speedMbps = this.configService.get<number>('GEMINI_UPLOAD_SPEED_MBPS') ?? 1;
    const bufferSeconds = this.configService.get<number>('GEMINI_PROCESSING_BUFFER_SECONDS') ?? 30;

    // 1 Mbps = 125,000 bytes/sec
    const uploadSpeedBytesPerSec = speedMbps * 125_000;
    const estimatedUploadSeconds = Math.ceil(fileSizeBytes / uploadSpeedBytesPerSec);
    const totalSeconds = estimatedUploadSeconds + bufferSeconds;

    return Math.min(totalSeconds * 1_000, MAX_INITIAL_WAIT_MS);
  }

  private isServiceUnavailableError(err: Error): boolean {
    const msg = err.message;
    return msg.includes('503') || msg.includes('Service Unavailable') || msg.includes('UNAVAILABLE');
  }

  private isRateLimitError(err: Error): boolean {
    const msg = err.message;
    return (
      msg.includes('429') ||
      msg.includes('Too Many Requests') ||
      msg.includes('RESOURCE_EXHAUSTED') ||
      msg.includes('quota exceeded') ||
      msg.includes('Quota exceeded')
    );
  }

  private parseRetryDelay(err: Error): number | null {
    // Try JSON field first: "retryDelay":"24s"
    const jsonMatch = err.message.match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
    if (jsonMatch) return Math.ceil(parseFloat(jsonMatch[1])) * 1000 + 1_000;
    // Try prose: "Please retry in 24.33s"
    const textMatch = err.message.match(/retry in ([\d.]+)s/i);
    if (textMatch) return Math.ceil(parseFloat(textMatch[1])) * 1000 + 1_000;
    return null;
  }

  private exponentialBackoffMs(attempt: number): number {
    return RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt - 1); // 30s, 60s, 120s
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

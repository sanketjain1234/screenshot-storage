import { Step } from './step.types';

export enum JobStatus {
  PENDING = 'PENDING',
  VALIDATING = 'VALIDATING',
  UPLOADING_TO_GEMINI = 'UPLOADING_TO_GEMINI',
  PROCESSING = 'PROCESSING',
  EXTRACTING_SCREENSHOTS = 'EXTRACTING_SCREENSHOTS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export interface Job {
  id: string;
  status: JobStatus;
  videoHash?: string;
  geminiFileUri?: string;
  result?: Step[];
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { JobStatus } from '../../common/types/job.types';
import { StepDto } from './step.dto';

export class JobResponseDto {
  @ApiProperty({ example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' })
  jobId: string;

  @ApiProperty({
    enum: JobStatus,
    example: JobStatus.PENDING,
    description: 'Current processing status of the job',
  })
  status: JobStatus;

  @ApiPropertyOptional({
    type: [StepDto],
    description: 'Populated once status is COMPLETED',
  })
  steps?: StepDto[];

  @ApiPropertyOptional({
    example: 'Gemini returned malformed JSON after 2 retries.',
    description: 'Populated when status is FAILED',
  })
  error?: string;
}

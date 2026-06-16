import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsUUID, IsUrl } from 'class-validator';

export class UrlJobDto {
  @ApiProperty({
    description:
      'Publicly accessible video URL. Must be from a whitelisted domain (Google Drive, Dropbox, S3, Loom) or a direct video file URL ending in .mp4, .mov, .webm, or .avi.',
    example: 'https://storage.googleapis.com/my-bucket/recording.mp4',
  })
  @IsUrl()
  url: string;

  @ApiPropertyOptional({
    description: 'ID of a saved ColumnConfig to apply custom columns to the output.',
    example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  })
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsOptional()
  @IsUUID()
  configId?: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsUUID } from 'class-validator';

export class UploadJobDto {
  @ApiPropertyOptional({
    description: 'ID of a saved ColumnConfig to apply custom columns to the output.',
    example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  })
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsOptional()
  @IsUUID()
  configId?: string;
}

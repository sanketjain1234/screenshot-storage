import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsOptional, IsString, Matches, MinLength, ValidateNested } from 'class-validator';
import {
  ColumnKey,
  ColumnEntry,
  COLUMN_REGISTRY,
  DEFAULT_COLUMN_KEYS,
} from '../../common/columns/column-registry';

export class ColumnEntryDto implements ColumnEntry {
  @ApiProperty({
    enum: ColumnKey,
    description: 'Column key to include in step output.',
    example: ColumnKey.VERIFICATION_METHOD,
  })
  @IsEnum(ColumnKey)
  key: ColumnKey;

  @ApiPropertyOptional({
    description: 'Custom display label for this column. Overrides the default label from the registry.',
    example: 'Verification Through',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  label?: string;
}

export class CustomColumnDefDto {
  @ApiProperty({
    description: 'Unique key for this custom column. Must be camelCase and must not clash with any built-in ColumnKey.',
    example: 'automationHint',
  })
  @IsString()
  @Matches(/^[a-z][a-zA-Z0-9]*$/, { message: 'key must be camelCase (e.g. automationHint)' })
  key: string;

  @ApiProperty({ description: 'Display label for this column.', example: 'Automation Hint' })
  @IsString()
  @MinLength(1)
  label: string;

  @ApiProperty({
    description: 'Instruction sent to Gemini describing what to generate for this column.',
    example: 'Suggest the best locator strategy (e.g. data-testid, ARIA role) for automating this step.',
  })
  @IsString()
  @MinLength(10)
  description: string;
}

export class CreateColumnConfigDto {
  @ApiProperty({
    description: 'Friendly name for this column configuration.',
    example: 'SAP Template',
  })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiProperty({
    description:
      'Ordered list of columns to include in step output. Each entry must specify a valid column key and may optionally override its display label. The order here determines the order in the output.',
    type: [ColumnEntryDto],
    example: [
      { key: ColumnKey.PRECONDITIONS },
      { key: ColumnKey.PRIORITY },
      { key: ColumnKey.VERIFICATION_METHOD, label: 'Verification Through' },
    ],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ColumnEntryDto)
  columns: ColumnEntryDto[];

  @ApiPropertyOptional({
    description: 'Optional user-defined columns Gemini will populate on each step.',
    type: [CustomColumnDefDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomColumnDefDto)
  customColumns?: CustomColumnDefDto[];
}

export class UpdateColumnConfigDto {
  @ApiPropertyOptional({
    description: 'Updated name for this column configuration.',
    example: 'SAP Template v2',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @ApiPropertyOptional({
    description: 'Updated ordered list of column entries. Each entry must specify a valid column key and may optionally override its display label.',
    type: [ColumnEntryDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ColumnEntryDto)
  columns?: ColumnEntryDto[];

  @ApiPropertyOptional({
    description: 'Updated user-defined custom columns.',
    type: [CustomColumnDefDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomColumnDefDto)
  customColumns?: CustomColumnDefDto[];
}

export class ColumnDefinitionInfoDto {
  @ApiProperty({ enum: ColumnKey, example: ColumnKey.PRECONDITIONS })
  key: ColumnKey;

  @ApiProperty({ example: 'Preconditions' })
  label: string;

  @ApiProperty({ example: 'Any setup or conditions required before this step can be performed.' })
  description: string;
}

export class ColumnConfigResponseDto {
  @ApiProperty({ example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' })
  id: string;

  @ApiProperty({ example: 'SAP Template' })
  name: string;

  @ApiProperty({
    type: [ColumnEntryDto],
    example: [
      { key: ColumnKey.PRECONDITIONS },
      { key: ColumnKey.VERIFICATION_METHOD, label: 'Verification Through' },
    ],
  })
  columns: ColumnEntryDto[];

  @ApiProperty({ type: [ColumnDefinitionInfoDto], description: 'Resolved column definitions for this config, with any custom labels applied' })
  resolvedColumns: ColumnDefinitionInfoDto[];

  @ApiPropertyOptional({ type: [CustomColumnDefDto], description: 'User-defined custom columns for this config.' })
  customColumns?: CustomColumnDefDto[];

  @ApiProperty({ example: '2024-01-15T10:30:00.000Z' })
  createdAt: Date;
}

export class AvailableColumnsResponseDto {
  @ApiProperty({
    description: 'All supported column keys with their labels and Gemini instructions',
    type: [ColumnDefinitionInfoDto],
  })
  columns: ColumnDefinitionInfoDto[];

  @ApiProperty({
    description: 'Default column order used when no configId is provided to a job',
    enum: ColumnKey,
    isArray: true,
  })
  defaultColumns: ColumnKey[];
}

export function buildAvailableColumnsResponse(): AvailableColumnsResponseDto {
  return {
    columns: Object.values(COLUMN_REGISTRY).map((def) => ({
      key: def.key as ColumnKey,
      label: def.label,
      description: def.description,
    })),
    defaultColumns: DEFAULT_COLUMN_KEYS,
  };
}

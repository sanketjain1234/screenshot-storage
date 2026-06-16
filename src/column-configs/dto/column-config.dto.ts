import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsOptional, IsString, Matches, MinLength, ValidateNested } from 'class-validator';
import {
  ColumnKey,
  ColumnEntry,
  CustomColumnDef,
  COLUMN_REGISTRY,
  DEFAULT_COLUMN_KEYS,
} from '../../common/columns/column-registry';

export class CustomColumnDefDto implements CustomColumnDef {
  @ApiProperty({
    description: 'Unique identifier for this column. Must start with a letter and contain only letters, digits, or underscores. Must not collide with a built-in ColumnKey.',
    example: 'automationHint',
  })
  @IsString()
  @Matches(/^[a-zA-Z][a-zA-Z0-9_]*$/, {
    message: 'key must start with a letter and contain only letters, digits, or underscores',
  })
  key: string;

  @ApiProperty({
    description: 'Display label shown in the column header.',
    example: 'Automation Hint',
  })
  @IsString()
  @MinLength(1)
  label: string;

  @ApiProperty({
    description: 'Instruction sent to Gemini describing what to generate for this column. Be specific — vague descriptions produce vague output.',
    example: 'Suggest the best locator strategy or automation approach for this step (e.g. data-testid, XPath, accessible role).',
  })
  @IsString()
  @MinLength(10)
  description: string;
}

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
    description: 'Optional list of fully custom columns not in the built-in registry. Each requires a key, label, and a Gemini instruction description.',
    type: [CustomColumnDefDto],
    example: [
      { key: 'automationHint', label: 'Automation Hint', description: 'Suggest the best locator strategy for automating this step.' },
    ],
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
    description: 'Updated list of custom columns.',
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

  @ApiPropertyOptional({ type: [CustomColumnDefDto], description: 'Custom columns defined for this config' })
  customColumns?: CustomColumnDefDto[];

  @ApiProperty({ type: [ColumnDefinitionInfoDto], description: 'Resolved column definitions for this config, with any custom labels applied' })
  resolvedColumns: ColumnDefinitionInfoDto[];

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

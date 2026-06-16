import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class StepDto {
  @ApiProperty({ description: '1-indexed step number', example: 1 })
  stepNumber: number;

  @ApiProperty({
    description: 'Short imperative phrase describing the action',
    example: "Click 'Create Purchase Order' button",
  })
  action: string;

  @ApiProperty({
    description: '1-2 sentence description of what happens in this step',
    example: 'The user navigates to the purchase order creation screen.',
  })
  description: string;

  @ApiProperty({
    description: 'Observable outcome after performing this action',
    example: 'A blank purchase order form is displayed.',
  })
  expectedResult: string;

  @ApiProperty({
    description: 'Time in seconds within the video when this action occurs',
    example: 4.2,
  })
  timestampSeconds: number;

  @ApiPropertyOptional({
    description: 'URL of the PNG screenshot captured at the action timestamp',
    example: 'http://localhost:3000/screenshots/a1b2c3d4-e5f6-7890-abcd-ef1234567890.png',
  })
  screenshotUrl?: string;

  @ApiPropertyOptional({
    description: 'Additional custom columns as defined in the ColumnConfig',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  customColumns?: Record<string, string>;
}

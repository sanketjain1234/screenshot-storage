export interface ColumnDefinition {
  key: string;
  label: string;
  description: string;
}

export interface Step {
  stepNumber: number;
  action: string;
  description: string;
  expectedResult: string;
  timestampSeconds: number;
  screenshotUrl?: string;
  [key: string]: unknown;
}

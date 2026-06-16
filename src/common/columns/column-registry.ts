import { ColumnDefinition } from '../types/step.types';

export interface ColumnEntry {
  key: ColumnKey;
  label?: string;
}

export interface CustomColumnDef {
  key: string;
  label: string;
  description: string;
}

export enum ColumnKey {
  PRECONDITIONS = 'preconditions',
  TEST_DATA = 'testData',
  PRIORITY = 'priority',
  NOTES = 'notes',
  VERIFICATION_METHOD = 'verificationMethod',
}

export const COLUMN_REGISTRY: Record<ColumnKey, ColumnDefinition> = {
  [ColumnKey.PRECONDITIONS]: {
    key: ColumnKey.PRECONDITIONS,
    label: 'Preconditions',
    description:
      'Any system state, data, or setup required before this step can be performed. If none, write "None".',
  },
  [ColumnKey.TEST_DATA]: {
    key: ColumnKey.TEST_DATA,
    label: 'Test Data',
    description:
      'Specific input values, credentials, or sample data used in this step (e.g. field values, file names, IDs). If none, write "N/A".',
  },
  [ColumnKey.PRIORITY]: {
    key: ColumnKey.PRIORITY,
    label: 'Priority',
    description:
      'Criticality of this step for testing. Must be exactly one of: "High", "Medium", or "Low".',
  },
  [ColumnKey.NOTES]: {
    key: ColumnKey.NOTES,
    label: 'Notes',
    description:
      'Additional reviewer notes, warnings, or edge cases a tester should be aware of for this step.',
  },
  [ColumnKey.VERIFICATION_METHOD]: {
    key: ColumnKey.VERIFICATION_METHOD,
    label: 'Verification Method',
    description:
      'How a tester should verify the expected result. Example: "Check toast notification text" or "Confirm URL changes to /dashboard".',
  },
};

export const DEFAULT_COLUMN_KEYS: ColumnKey[] = [
  ColumnKey.PRECONDITIONS,
  ColumnKey.TEST_DATA,
  ColumnKey.PRIORITY,
  ColumnKey.NOTES,
  ColumnKey.VERIFICATION_METHOD,
];

export function resolveColumnDefs(entries: ColumnEntry[]): ColumnDefinition[] {
  return entries
    .map((entry) => {
      const def = COLUMN_REGISTRY[entry.key];
      if (!def) return undefined;
      return entry.label ? { ...def, label: entry.label } : def;
    })
    .filter((d): d is ColumnDefinition => Boolean(d));
}

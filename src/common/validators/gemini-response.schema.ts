import { z } from 'zod';

const BaseStepSchema = z.object({
  stepNumber: z.number().int().positive(),
  action: z.string().min(1),
  description: z.string().min(1),
  expectedResult: z.string().min(1),
  timestampSeconds: z.number().nonnegative(),
});

export function buildStepSchema(columnKeys: string[]) {
  const extraFields = columnKeys.reduce(
    (acc, key) => {
      acc[key] = z.string();
      return acc;
    },
    {} as Record<string, z.ZodString>,
  );

  return BaseStepSchema.extend(extraFields).array();
}

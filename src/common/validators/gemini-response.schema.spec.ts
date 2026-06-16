import { buildStepSchema } from './gemini-response.schema';
import { ZodError } from 'zod';

const makeBaseStep = (overrides: Record<string, unknown> = {}) => ({
  stepNumber: 1,
  action: 'Click the submit button',
  description: 'The user clicks the submit button to proceed.',
  expectedResult: 'Form is submitted and confirmation page is shown.',
  timestampSeconds: 4.5,
  ...overrides,
});

describe('buildStepSchema', () => {
  // --- No custom columns ---

  describe('with no extra column keys', () => {
    const schema = buildStepSchema([]);

    it('accepts a valid step array', () => {
      const result = schema.parse([makeBaseStep()]);
      expect(result).toHaveLength(1);
      expect(result[0].stepNumber).toBe(1);
    });

    it('accepts multiple steps', () => {
      const result = schema.parse([makeBaseStep({ stepNumber: 1 }), makeBaseStep({ stepNumber: 2, timestampSeconds: 10 })]);
      expect(result).toHaveLength(2);
    });

    it('rejects missing action', () => {
      const { action: _, ...noAction } = makeBaseStep();
      expect(() => schema.parse([noAction])).toThrow(ZodError);
    });

    it('rejects missing description', () => {
      const { description: _, ...noDescription } = makeBaseStep();
      expect(() => schema.parse([noDescription])).toThrow(ZodError);
    });

    it('rejects missing expectedResult', () => {
      const { expectedResult: _, ...noExpected } = makeBaseStep();
      expect(() => schema.parse([noExpected])).toThrow(ZodError);
    });

    it('rejects missing timestampSeconds', () => {
      const { timestampSeconds: _, ...noTimestamp } = makeBaseStep();
      expect(() => schema.parse([noTimestamp])).toThrow(ZodError);
    });

    it('rejects missing stepNumber', () => {
      const { stepNumber: _, ...noStepNum } = makeBaseStep();
      expect(() => schema.parse([noStepNum])).toThrow(ZodError);
    });

    it('rejects non-integer stepNumber', () => {
      expect(() => schema.parse([makeBaseStep({ stepNumber: 1.5 })])).toThrow(ZodError);
    });

    it('rejects zero stepNumber (must be positive)', () => {
      expect(() => schema.parse([makeBaseStep({ stepNumber: 0 })])).toThrow(ZodError);
    });

    it('rejects negative stepNumber', () => {
      expect(() => schema.parse([makeBaseStep({ stepNumber: -1 })])).toThrow(ZodError);
    });

    it('rejects negative timestampSeconds', () => {
      expect(() => schema.parse([makeBaseStep({ timestampSeconds: -1 })])).toThrow(ZodError);
    });

    it('accepts zero timestampSeconds', () => {
      const result = schema.parse([makeBaseStep({ timestampSeconds: 0 })]);
      expect(result[0].timestampSeconds).toBe(0);
    });

    it('rejects empty string for action', () => {
      expect(() => schema.parse([makeBaseStep({ action: '' })])).toThrow(ZodError);
    });

    it('rejects a non-array input (object instead of array)', () => {
      expect(() => schema.parse(makeBaseStep())).toThrow(ZodError);
    });

    it('accepts an empty array', () => {
      const result = schema.parse([]);
      expect(result).toHaveLength(0);
    });
  });

  // --- With extra column keys (predefined custom columns) ---

  describe('with extra column keys', () => {
    const schema = buildStepSchema(['priority', 'preconditions']);

    it('accepts a step that includes all required extra keys', () => {
      const step = makeBaseStep({ priority: 'High', preconditions: 'User must be logged in' });
      const result = schema.parse([step]);
      expect(result[0]['priority']).toBe('High');
      expect(result[0]['preconditions']).toBe('User must be logged in');
    });

    it('rejects a step missing a required extra key', () => {
      const step = makeBaseStep({ priority: 'High' }); // missing preconditions
      expect(() => schema.parse([step])).toThrow(ZodError);
    });

    it('rejects a step where an extra key has a non-string value', () => {
      const step = makeBaseStep({ priority: 42, preconditions: 'Some text' });
      expect(() => schema.parse([step])).toThrow(ZodError);
    });

    it('rejects a step where an extra key has a null value', () => {
      const step = makeBaseStep({ priority: null, preconditions: 'Some text' });
      expect(() => schema.parse([step])).toThrow(ZodError);
    });
  });

  // --- With many custom column keys ---

  describe('with user-defined custom column keys', () => {
    const customKeys = ['automationHint', 'riskLevel', 'testData'];
    const schema = buildStepSchema(customKeys);

    it('accepts a step with all custom columns populated', () => {
      const step = makeBaseStep({
        automationHint: 'Use data-testid="submit-btn"',
        riskLevel: 'High',
        testData: 'username=admin, password=test123',
      });
      const result = schema.parse([step]);
      expect(result[0]['automationHint']).toBe('Use data-testid="submit-btn"');
      expect(result[0]['riskLevel']).toBe('High');
      expect(result[0]['testData']).toBe('username=admin, password=test123');
    });

    it('rejects a step missing one of the custom columns', () => {
      const step = makeBaseStep({
        automationHint: 'Use data-testid="submit-btn"',
        riskLevel: 'High',
        // testData intentionally omitted
      });
      expect(() => schema.parse([step])).toThrow(ZodError);
    });

    it('each custom column must be a string', () => {
      const step = makeBaseStep({
        automationHint: 'Use data-testid',
        riskLevel: 'High',
        testData: 123, // not a string
      });
      expect(() => schema.parse([step])).toThrow(ZodError);
    });
  });

  // --- Schema freshness per call ---

  describe('schema independence per call', () => {
    it('two schemas built with different keys are independent', () => {
      const schemaA = buildStepSchema(['priority']);
      const schemaB = buildStepSchema(['notes']);

      const stepWithPriority = makeBaseStep({ priority: 'Low' });
      const stepWithNotes = makeBaseStep({ notes: 'Check the modal closes' });

      // A accepts priority, rejects notes-only step
      expect(() => schemaA.parse([stepWithNotes])).toThrow(ZodError);
      expect(schemaA.parse([stepWithPriority])).toHaveLength(1);

      // B accepts notes, rejects priority-only step
      expect(() => schemaB.parse([stepWithPriority])).toThrow(ZodError);
      expect(schemaB.parse([stepWithNotes])).toHaveLength(1);
    });
  });
});

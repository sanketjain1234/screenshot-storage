import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ColumnConfigsService } from './column-configs.service';
import { InMemoryColumnConfigRepository } from '../common/repositories/column-config.repository';
import { ColumnKey } from '../common/columns/column-registry';
import { CreateColumnConfigDto, CustomColumnDefDto } from './dto/column-config.dto';

const makeDto = (overrides: Partial<CreateColumnConfigDto> = {}): CreateColumnConfigDto => ({
  name: 'Test Config',
  columns: [{ key: ColumnKey.PRIORITY }, { key: ColumnKey.NOTES }],
  ...overrides,
});

const makeCustomCol = (key: string, overrides: Partial<CustomColumnDefDto> = {}): CustomColumnDefDto => ({
  key,
  label: 'My Custom Field',
  description: 'A detailed description of what Gemini should generate here.',
  ...overrides,
});

describe('ColumnConfigsService', () => {
  let service: ColumnConfigsService;

  beforeEach(() => {
    service = new ColumnConfigsService(new InMemoryColumnConfigRepository());
  });

  // --- create ---

  describe('create', () => {
    it('creates a config and returns an id', () => {
      const result = service.create(makeDto());
      expect(result.id).toBeDefined();
      expect(result.name).toBe('Test Config');
    });

    it('returns resolvedColumns with default labels from the registry', () => {
      const result = service.create(makeDto({ columns: [{ key: ColumnKey.PRIORITY }] }));
      const resolved = result.resolvedColumns.find((c) => c.key === ColumnKey.PRIORITY);
      expect(resolved?.label).toBe('Priority');
    });

    it('applies custom label override in resolvedColumns', () => {
      const result = service.create(
        makeDto({ columns: [{ key: ColumnKey.VERIFICATION_METHOD, label: 'Verification Through' }] }),
      );
      const resolved = result.resolvedColumns.find((c) => c.key === ColumnKey.VERIFICATION_METHOD);
      expect(resolved?.label).toBe('Verification Through');
    });

    it('creates a config with custom columns and includes them in resolvedColumns', () => {
      const result = service.create(
        makeDto({ customColumns: [makeCustomCol('automationHint', { label: 'Automation Hint' })] }),
      );
      expect(result.customColumns).toHaveLength(1);
      expect(result.customColumns![0].key).toBe('automationHint');
      expect(result.customColumns![0].label).toBe('Automation Hint');
    });

    it('throws BadRequestException for duplicate keys within columns array', () => {
      expect(() =>
        service.create(makeDto({ columns: [{ key: ColumnKey.PRIORITY }, { key: ColumnKey.PRIORITY }] })),
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException when custom key matches a built-in ColumnKey value', () => {
      expect(() =>
        service.create(makeDto({ customColumns: [makeCustomCol('priority')] })),
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException when custom key matches another built-in key (verificationMethod)', () => {
      expect(() =>
        service.create(makeDto({ customColumns: [makeCustomCol('verificationMethod')] })),
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException for duplicate keys within customColumns array', () => {
      expect(() =>
        service.create(
          makeDto({
            customColumns: [makeCustomCol('myField'), makeCustomCol('myField')],
          }),
        ),
      ).toThrow(BadRequestException);
    });

    it('allows multiple distinct custom columns', () => {
      const result = service.create(
        makeDto({
          customColumns: [
            makeCustomCol('automationHint'),
            makeCustomCol('riskLevel', { label: 'Risk Level' }),
          ],
        }),
      );
      expect(result.customColumns).toHaveLength(2);
    });
  });

  // --- findById ---

  describe('findById', () => {
    it('throws NotFoundException for an unknown id', () => {
      expect(() => service.findById('no-such-id')).toThrow(NotFoundException);
    });

    it('returns the config for a known id', () => {
      const created = service.create(makeDto());
      const found = service.findById(created.id);
      expect(found.id).toBe(created.id);
      expect(found.name).toBe('Test Config');
    });
  });

  // --- findAll ---

  describe('findAll', () => {
    it('returns empty list when no configs exist', () => {
      expect(service.findAll()).toEqual([]);
    });

    it('returns all created configs', () => {
      service.create(makeDto({ name: 'Config A' }));
      service.create(makeDto({ name: 'Config B' }));
      expect(service.findAll()).toHaveLength(2);
    });
  });

  // --- update ---

  describe('update', () => {
    it('throws NotFoundException for an unknown id', () => {
      expect(() => service.update('unknown', { name: 'x' })).toThrow(NotFoundException);
    });

    it('patches only the name without touching columns', () => {
      const created = service.create(makeDto());
      const updated = service.update(created.id, { name: 'Renamed' });
      expect(updated.name).toBe('Renamed');
      expect(updated.columns).toHaveLength(2);
    });

    it('replaces columns when columns is provided', () => {
      const created = service.create(makeDto());
      const updated = service.update(created.id, { columns: [{ key: ColumnKey.PRECONDITIONS }] });
      expect(updated.columns).toHaveLength(1);
      expect(updated.columns[0].key).toBe(ColumnKey.PRECONDITIONS);
    });

    it('adds custom columns via update', () => {
      const created = service.create(makeDto());
      const updated = service.update(created.id, {
        customColumns: [makeCustomCol('newField', { label: 'New Field' })],
      });
      expect(updated.customColumns).toHaveLength(1);
    });

    it('clears custom columns when empty array is provided', () => {
      const created = service.create(makeDto({ customColumns: [makeCustomCol('fieldA')] }));
      const updated = service.update(created.id, { customColumns: [] });
      expect(updated.customColumns ?? []).toHaveLength(0);
    });

    it('throws BadRequestException on custom key collision during update', () => {
      const created = service.create(makeDto());
      expect(() =>
        service.update(created.id, { customColumns: [makeCustomCol('notes')] }),
      ).toThrow(BadRequestException);
    });

    it('throws BadRequestException on duplicate predefined key during update', () => {
      const created = service.create(makeDto());
      expect(() =>
        service.update(created.id, { columns: [{ key: ColumnKey.NOTES }, { key: ColumnKey.NOTES }] }),
      ).toThrow(BadRequestException);
    });
  });

  // --- delete ---

  describe('delete', () => {
    it('throws NotFoundException for an unknown id', () => {
      expect(() => service.delete('unknown')).toThrow(NotFoundException);
    });

    it('deletes a config so it can no longer be found', () => {
      const created = service.create(makeDto());
      service.delete(created.id);
      expect(() => service.findById(created.id)).toThrow(NotFoundException);
    });

    it('removes deleted config from findAll', () => {
      const a = service.create(makeDto({ name: 'A' }));
      service.create(makeDto({ name: 'B' }));
      service.delete(a.id);
      expect(service.findAll()).toHaveLength(1);
      expect(service.findAll()[0].name).toBe('B');
    });
  });

  // --- resolveColumnDefs ---

  describe('resolveColumnDefs', () => {
    it('returns all DEFAULT_COLUMN_KEYS when no configId is provided', () => {
      const { columnDefs, columnKeys } = service.resolveColumnDefs();
      expect(columnDefs.length).toBeGreaterThan(0);
      expect(columnKeys).toContain(ColumnKey.PRIORITY);
      expect(columnKeys).toContain(ColumnKey.PRECONDITIONS);
    });

    it('falls back to defaults when configId is not found in the repository', () => {
      const { columnDefs } = service.resolveColumnDefs('nonexistent-id');
      expect(columnDefs.length).toBeGreaterThan(0);
    });

    it('returns only the selected predefined columns for a given configId', () => {
      const created = service.create(makeDto({ columns: [{ key: ColumnKey.PRIORITY }] }));
      const { columnDefs, columnKeys } = service.resolveColumnDefs(created.id);
      expect(columnKeys).toEqual([ColumnKey.PRIORITY]);
      expect(columnDefs).toHaveLength(1);
      expect(columnDefs[0].key).toBe(ColumnKey.PRIORITY);
    });

    it('applies custom label override in resolved defs (used in Gemini prompt)', () => {
      const created = service.create(
        makeDto({ columns: [{ key: ColumnKey.VERIFICATION_METHOD, label: 'Verification Through' }] }),
      );
      const { columnDefs } = service.resolveColumnDefs(created.id);
      expect(columnDefs.find((d) => d.key === ColumnKey.VERIFICATION_METHOD)?.label).toBe(
        'Verification Through',
      );
    });

    it('merges predefined and custom column defs', () => {
      const created = service.create(
        makeDto({
          columns: [{ key: ColumnKey.PRIORITY }],
          customColumns: [makeCustomCol('automationHint', { label: 'Automation Hint', description: 'Locator strategy for this step in automation.' })],
        }),
      );
      const { columnDefs, columnKeys } = service.resolveColumnDefs(created.id);

      expect(columnKeys).toEqual([ColumnKey.PRIORITY, 'automationHint']);
      expect(columnDefs).toHaveLength(2);
      const custom = columnDefs.find((d) => d.key === 'automationHint');
      expect(custom?.label).toBe('Automation Hint');
      expect(custom?.description).toBe('Locator strategy for this step in automation.');
    });

    it('custom column description is preserved as-is for Gemini prompt injection', () => {
      const desc = 'Risk level for this step: High, Medium, or Low.';
      const created = service.create(
        makeDto({ customColumns: [makeCustomCol('riskLevel', { description: desc })] }),
      );
      const { columnDefs } = service.resolveColumnDefs(created.id);
      expect(columnDefs.find((d) => d.key === 'riskLevel')?.description).toBe(desc);
    });
  });
});

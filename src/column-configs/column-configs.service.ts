import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { IColumnConfigRepository } from '../common/repositories/column-config.repository.interface';
import { ColumnConfig } from '../common/types/column-config.types';
import { ColumnDefinition } from '../common/types/step.types';
import {
  ColumnKey,
  ColumnEntry,
  CustomColumnDef,
  DEFAULT_COLUMN_KEYS,
  resolveColumnDefs,
} from '../common/columns/column-registry';
import {
  ColumnConfigResponseDto,
  CreateColumnConfigDto,
  UpdateColumnConfigDto,
} from './dto/column-config.dto';

@Injectable()
export class ColumnConfigsService {
  constructor(private readonly repository: IColumnConfigRepository) {}

  create(dto: CreateColumnConfigDto): ColumnConfigResponseDto {
    this.validatePredefinedEntryUniqueness(dto.columns);
    this.validateCustomColumnKeys(dto.customColumns);
    const config: ColumnConfig = {
      id: uuidv4(),
      name: dto.name,
      columns: dto.columns,
      customColumns: dto.customColumns,
      createdAt: new Date(),
    };
    this.repository.create(config);
    return this.toResponseDto(config);
  }

  findById(id: string): ColumnConfigResponseDto {
    const config = this.repository.findById(id);
    if (!config) throw new NotFoundException(`Column config not found: ${id}`);
    return this.toResponseDto(config);
  }

  findAll(): ColumnConfigResponseDto[] {
    return this.repository.findAll().map((c) => this.toResponseDto(c));
  }

  update(id: string, dto: UpdateColumnConfigDto): ColumnConfigResponseDto {
    const existing = this.repository.findById(id);
    if (!existing) throw new NotFoundException(`Column config not found: ${id}`);
    const patch: Partial<ColumnConfig> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.columns !== undefined) {
      this.validatePredefinedEntryUniqueness(dto.columns);
      patch.columns = dto.columns;
    }
    if (dto.customColumns !== undefined) {
      this.validateCustomColumnKeys(dto.customColumns);
      patch.customColumns = dto.customColumns;
    }
    this.repository.update(id, patch);
    return this.toResponseDto(this.repository.findById(id)!);
  }

  delete(id: string): void {
    if (!this.repository.findById(id)) {
      throw new NotFoundException(`Column config not found: ${id}`);
    }
    this.repository.delete(id);
  }

  resolveColumnDefs(configId?: string): { columnDefs: ColumnDefinition[]; columnKeys: string[] } {
    const defaultEntries: ColumnEntry[] = DEFAULT_COLUMN_KEYS.map((k) => ({ key: k }));
    const config = configId ? this.repository.findById(configId) : undefined;
    const entries: ColumnEntry[] = config?.columns ?? defaultEntries;

    const predefinedDefs = resolveColumnDefs(entries);
    const customDefs: ColumnDefinition[] = (config?.customColumns ?? []).map((c) => ({
      key: c.key,
      label: c.label,
      description: c.description,
    }));

    const columnDefs = [...predefinedDefs, ...customDefs];
    const columnKeys = [...entries.map((e) => e.key), ...(config?.customColumns ?? []).map((c) => c.key)];
    return { columnDefs, columnKeys };
  }

  private toResponseDto(config: ColumnConfig): ColumnConfigResponseDto {
    const customDefs: ColumnDefinition[] = (config.customColumns ?? []).map((c) => ({
      key: c.key,
      label: c.label,
      description: c.description,
    }));
    return {
      id: config.id,
      name: config.name,
      columns: config.columns,
      customColumns: config.customColumns,
      resolvedColumns: [...resolveColumnDefs(config.columns), ...customDefs] as ColumnConfigResponseDto['resolvedColumns'],
      createdAt: config.createdAt,
    };
  }

  private validateCustomColumnKeys(customColumns?: CustomColumnDef[]): void {
    if (!customColumns?.length) return;
    const builtInKeys = new Set<string>(Object.values(ColumnKey));
    const seen = new Set<string>();
    for (const col of customColumns) {
      if (builtInKeys.has(col.key)) {
        throw new BadRequestException(`Custom column key "${col.key}" collides with a built-in ColumnKey. Use a different key name.`);
      }
      if (seen.has(col.key)) {
        throw new BadRequestException(`Duplicate custom column key "${col.key}" in the same config.`);
      }
      seen.add(col.key);
    }
  }

  private validatePredefinedEntryUniqueness(entries: ColumnEntry[]): void {
    const seen = new Set<string>();
    for (const e of entries) {
      const key = String(e.key);
      if (seen.has(key)) {
        throw new BadRequestException(`Duplicate predefined column key "${key}" in the same config.`);
      }
      seen.add(key);
    }
  }
}

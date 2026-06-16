import { ColumnConfig } from '../types/column-config.types';

export abstract class IColumnConfigRepository {
  abstract create(config: ColumnConfig): string;
  abstract findById(id: string): ColumnConfig | undefined;
  abstract update(id: string, patch: Partial<ColumnConfig>): void;
  abstract delete(id: string): void;
  abstract findAll(): ColumnConfig[];
}

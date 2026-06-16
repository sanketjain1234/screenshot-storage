import { Injectable } from '@nestjs/common';
import { ColumnConfig } from '../types/column-config.types';
import { IColumnConfigRepository } from './column-config.repository.interface';

@Injectable()
export class InMemoryColumnConfigRepository extends IColumnConfigRepository {
  private readonly store = new Map<string, ColumnConfig>();

  create(config: ColumnConfig): string {
    this.store.set(config.id, { ...config });
    return config.id;
  }

  findById(id: string): ColumnConfig | undefined {
    return this.store.get(id);
  }

  update(id: string, patch: Partial<ColumnConfig>): void {
    const existing = this.store.get(id);
    if (!existing) return;
    this.store.set(id, { ...existing, ...patch });
  }

  delete(id: string): void {
    this.store.delete(id);
  }

  findAll(): ColumnConfig[] {
    return Array.from(this.store.values());
  }
}

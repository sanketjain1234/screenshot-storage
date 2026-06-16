import { Injectable } from '@nestjs/common';
import { Job } from '../types/job.types';
import { IJobRepository } from './job.repository.interface';

@Injectable()
export class InMemoryJobRepository extends IJobRepository {
  private readonly store = new Map<string, Job>();

  create(job: Job): void {
    this.store.set(job.id, { ...job });
  }

  findById(id: string): Job | undefined {
    return this.store.get(id);
  }

  update(id: string, patch: Partial<Job>): void {
    const existing = this.store.get(id);
    if (!existing) return;
    this.store.set(id, { ...existing, ...patch, updatedAt: new Date() });
  }
}

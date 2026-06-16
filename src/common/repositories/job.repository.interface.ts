import { Job } from '../types/job.types';

export abstract class IJobRepository {
  abstract create(job: Job): void;
  abstract findById(id: string): Job | undefined;
  abstract update(id: string, patch: Partial<Job>): void;
}

import { Injectable } from '@nestjs/common';
import { IVideoHashRepository } from './video-hash.repository.interface';

@Injectable()
export class InMemoryVideoHashRepository extends IVideoHashRepository {
  private readonly store = new Map<string, string>();

  set(sha256: string, jobId: string): void {
    this.store.set(sha256, jobId);
  }

  get(sha256: string): string | undefined {
    return this.store.get(sha256);
  }
}

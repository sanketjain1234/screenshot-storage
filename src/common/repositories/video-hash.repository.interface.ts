export abstract class IVideoHashRepository {
  abstract set(sha256: string, jobId: string): void;
  abstract get(sha256: string): string | undefined;
}

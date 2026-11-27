import { BOARD_KINDS, fetchBoard, type BoardKind, type FetchOptions, type NormalizedJob } from './adapters';

export interface JobDiscoveryProvider {
  readonly id: BoardKind;
  fetch(target: string, options: FetchOptions): Promise<NormalizedJob[]>;
}

export const boardProviders = new Map<BoardKind, JobDiscoveryProvider>(
  BOARD_KINDS.map((id) => [id, { id, fetch: (target, options) => fetchBoard(id, target, options) }]),
);

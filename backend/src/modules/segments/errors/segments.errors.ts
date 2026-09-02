import { NotFoundError, ConflictError } from '../../../shared/errors/domain.error';

export class SegmentNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('Segment', id);
  }
}

export class SegmentNameConflictError extends ConflictError {
  constructor(name: string) {
    super(
      `A segment named "${name}" already exists`,
      'segment.name_conflict',
    );
  }
}

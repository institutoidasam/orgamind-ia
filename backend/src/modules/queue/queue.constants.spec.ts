import { describe, expect, it } from 'vitest';
import { REPEATABLE_JOB_CLEANUP_OPTS } from './queue.constants';

// Prod incident (2026-07-07): the connection-reconciler repeatable definition
// was registered in Redis WITHOUT cleanup options; BullMQ snapshots the opts
// inside the stored repeat definition, so the queue's later defaultJobOptions
// never applied and 76k completed-tick records accumulated. Every repeatable
// add() must carry these opts EXPLICITLY.
describe('REPEATABLE_JOB_CLEANUP_OPTS', () => {
  it('caps completed-tick retention (small count + short age)', () => {
    expect(REPEATABLE_JOB_CLEANUP_OPTS.removeOnComplete).toEqual({
      age: 3600,
      count: 10,
    });
  });

  it('caps failed-tick retention', () => {
    expect(REPEATABLE_JOB_CLEANUP_OPTS.removeOnFail).toEqual({
      age: 86400,
      count: 50,
    });
  });
});

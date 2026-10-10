import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as db from './db';

vi.mock('./supabase', () => ({
  createClient: () => ({
    from: vi.fn(() => ({
      upsert: vi.fn().mockResolvedValue({ error: null, count: 0 }),
      insert: vi.fn().mockResolvedValue({ error: null, count: 0 }),
      select: vi.fn().mockResolvedValue({ data: null, error: null }),
      update: vi.fn().mockResolvedValue({ error: null, count: 0 }),
      delete: vi.fn().mockResolvedValue({ error: null, count: 0 }),
      match: vi.fn().mockResolvedValue({ error: null }),
    })),
  }),
}));

describe('db batching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('upsertEvents chunks into batches', async () => {
    const events = Array.from({ length: 1200 }, (_, i) => ({
      ledger_index: 1,
      transaction_index: i,
      type: 'offer_created',
    }));

    await db.upsertEvents(events, 500);

    // Should be called 3 times: 500 + 500 + 200
    const fromMock = vi.mocked(
      require('./supabase').createClient().from
    );
    expect(fromMock).toHaveBeenCalledTimes(3);
  });

  it('upsertEvents empty array does nothing', async () => {
    await db.upsertEvents([], 500);
    expect(vi.mocked(require('./supabase').createClient().from)).not.toHaveBeenCalled();
  });

  it('persistPlan chunks into batches', async () => {
    const plans = Array.from({ length: 750 }, (_, i) => ({
      ledger_index: 1,
      transaction_index: i,
      type: 'payment',
    }));

    await db.persistPlan(plans, 500);
    const fromMock = vi.mocked(
      require('./supabase').createClient().from
    );
    expect(fromMock).toHaveBeenCalledTimes(2);
  });

  it('upsertGroups chunks into batches', async () => {
    const groups = Array.from({ length: 100 }, (_, i) => ({
      ledger_index: 1,
      transaction_index: i,
      type: 'group',
      key: 'k',
      value: 'v',
    }));

    await db.upsertGroups(groups, 500);
    const fromMock = vi.mocked(
      require('./supabase').createClient().from
    );
    expect(fromMock).toHaveBeenCalledTimes(1);
  });

  it('batches preserve order and cover all rows', async () => {
    const events = Array.from({ length: 1500 }, (_, i) => ({
      ledger_index: 100,
      transaction_index: i,
      type: 'offer_created',
    }));

    const upsertMock = vi.fn().mockResolvedValue({ error: null });
    vi.doMock('./supabase', () => ({
      createClient: () => ({
        from: vi.fn(() => ({ upsert: upsertMock })),
      }),
    }));

    await db.upsertEvents(events, 500);
    expect(upsertMock).toHaveBeenCalledTimes(3);

    // Verify each call received correct chunk
    const calls = upsertMock.mock.calls;
    expect(calls[0][0]).toHaveLength(500);
    expect(calls[1][0]).toHaveLength(500);
    expect(calls[2][0]).toHaveLength(500);
  });
});

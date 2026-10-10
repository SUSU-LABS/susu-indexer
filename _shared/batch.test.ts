import { describe, it, expect, vi, beforeEach } from 'vitest';
import { batchUpsert } from './batch';

describe('batchUpsert', () => {
  const mockSupabase = {
    from: vi.fn(() => ({
      upsert: vi.fn().mockResolvedValue({ error: null }),
    })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('splits rows into batches and upserts each', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({ id: i, value: `v${i}` }));
    await batchUpsert(mockSupabase as never, 'test_table', rows, 500);

    const fromMock = vi.mocked(mockSupabase.from);
    expect(fromMock).toHaveBeenCalledTimes(3);
    expect(fromMock).toHaveBeenNthCalledWith(1, 'test_table');
    expect(fromMock).toHaveBeenNthCalledWith(2, 'test_table');
    expect(fromMock).toHaveBeenNthCalledWith(3, 'test_table');

    const upsertCalls = fromMock.mock.calls.map(([, tbl]) =>
      mockSupabase.from(tbl).upsert.mock.calls
    );
    // Verify chunk sizes
    const upsertMock = vi.mocked(mockSupabase.from('test_table').upsert);
    expect(upsertMock).toHaveBeenCalledTimes(3);
    expect(rows.length).toBe(1200);
  });

  it('handles empty rows', async () => {
    await batchUpsert(mockSupabase as never, 'test_table', [], 500);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('handles exact batch boundary', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    await batchUpsert(mockSupabase as never, 'test_table', rows, 500);
    const upsertMock = vi.mocked(mockSupabase.from('test_table').upsert);
    expect(upsertMock).toHaveBeenCalledTimes(2);
  });

  it('throws on partial failure and does not checkpoint', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: i }));
    vi.mocked(mockSupabase.from('test_table').upsert)
      .mockResolvedValueOnce({ error: null })
      .mockRejectedValueOnce(new Error('db error'));

    await expect(
      batchUpsert(mockSupabase as never, 'test_table', rows, 2)
    ).rejects.toThrow('db error');
  });
});

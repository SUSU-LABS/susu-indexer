import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computeLedgerRange } from '../checkpoint'
import * as checkpointsModule from '../../ledger_checkpoints/record'
import * as horizonModule from '../../stellar/horizon'

vi.mock('../../stellar/horizon', () => ({
  getContract: vi.fn(),
}))

describe('computeLedgerRange', () => {
  const mockContract = {
    latest: { sequence: vi.fn() },
    contractSource: { readData: vi.fn() },
    recordCheckpoint: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.INDEXER_START_LEDGER
    vi.mocked(horizonModule.getContract).mockResolvedValue(
      mockContract as unknown as ReturnType<typeof horizonModule.getContract>
    )
    mockContract.latest.sequence.mockResolvedValue(1000)
    mockContract.contractSource.readData.mockResolvedValue('1')
  })

  it('uses startLedger when no checkpoint exists', async () => {
    vi.spyOn(checkpointsModule, 'getCheckpoints').mockResolvedValue([])
    const result = await computeLedgerRange()
    expect(result.from).toBe(1)
    expect(result.to).toBe(1000)
    expect(result.isInitialized).toBe(false)
  })

  it('resumes from lastProcessedLedger + 1 when checkpoint exists and startLedger matches', async () => {
    vi.spyOn(checkpointsModule, 'getCheckpoints').mockResolvedValue([
      { ledger: 500, hash: 'abc', type: 'full' as const },
    ])
    const result = await computeLedgerRange()
    expect(result.from).toBe(501)
    expect(result.to).toBe(1000)
    expect(result.isInitialized).toBe(true)
  })

  it('warns and ignores raised startLedger instead of silently skipping ledgers', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(checkpointsModule, 'getCheckpoints').mockResolvedValue([
      { ledger: 500, hash: 'abc', type: 'full' as const },
    ])
    process.env.INDEXER_START_LEDGER = '800'
    const result = await computeLedgerRange()
    expect(result.from).toBe(501)
    expect(result.to).toBe(1000)
    expect(result.isInitialized).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('INDEXER_START_LEDGER (800)')
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Silent skip would leave a permanent gap')
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring raised startLedger')
    )
    warnSpy.mockRestore()
  })

  it('does not warn when startLedger is within one of lastProcessedLedger', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(checkpointsModule, 'getCheckpoints').mockResolvedValue([
      { ledger: 500, hash: 'abc', type: 'full' as const },
    ])
    process.env.INDEXER_START_LEDGER = '501'
    const result = await computeLedgerRange()
    expect(result.from).toBe(501)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('allows startLedger below lastProcessedLedger for rebuilds', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(checkpointsModule, 'getCheckpoints').mockResolvedValue([
      { ledger: 500, hash: 'abc', type: 'full' as const },
    ])
    process.env.INDEXER_START_LEDGER = '100'
    const result = await computeLedgerRange()
    expect(result.from).toBe(100)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

import { describe, expect, it, vi } from 'vitest';
import {
  ExitInfeasibilityReasonWalletUnderfunded,
  ExitJobStatusCompleted,
  ExitJobStatusMaterializing,
  ExitJobStatusUnspecified,
  FORCE_UNROLL_ACK,
  type ExitInfeasibilityReason,
  type ExitPlanEntry,
  type ExitStatusResult,
  type GetExitPlanResult,
  type WavelengthClient,
} from './sdk/index.js';
import {
  describeExitJobStatus,
  MissingUnrollAckError,
  planUnilateralExit,
  startUnilateralExit,
  summarizeExitReadiness,
} from './exit.js';

function planEntry(overrides: Partial<ExitPlanEntry> = {}): ExitPlanEntry {
  return {
    outpoint: 'abc:0',
    fundingAddress: 'bcrt1qfund',
    requiredConfirmations: 1,
    requiredFeeUTXOCount: 1,
    usableFeeUTXOCount: 1,
    recommendedUTXOAmountSat: 1_000,
    recommendedTotalFundingSat: 1_000,
    fundingShortfallSat: 0,
    canStart: true,
    infeasibilityReason: 'unspecified',
    exitJobFound: false,
    exitStatus: ExitJobStatusUnspecified,
    sweepTxid: '',
    lastError: '',
    roundCommitment: '',
    err: '',
    ...overrides,
  };
}

function planResult(overrides: Partial<GetExitPlanResult> = {}): GetExitPlanResult {
  return {
    canStart: true,
    feeRateSatPerVByte: 12,
    totalFundingShortfallSat: 0,
    totalRecommendedFundingSat: 0,
    plans: [planEntry()],
    ...overrides,
  };
}

function client(overrides: Partial<WavelengthClient> = {}): WavelengthClient {
  return {
    getExitPlan: vi.fn().mockResolvedValue(planResult()),
    exit: vi.fn().mockResolvedValue({ path: 'unilateral' }),
    ...overrides,
  } as unknown as WavelengthClient;
}

describe('summarizeExitReadiness', () => {
  it('passes a startable plan through with big-int sums', () => {
    const r = summarizeExitReadiness(planResult());
    expect(r.canStart).toBe(true);
    expect(r.fundingShortfallSat).toBe(0n);
    expect(r.recommendedFundingSat).toBe(0n);
    expect(r.fundingAddress).toBe('bcrt1qfund');
  });

  it('surfaces the blocking plan when the exit cannot start for funding reasons', () => {
    const r = summarizeExitReadiness(
      planResult({
        canStart: false,
        totalFundingShortfallSat: 2_500,
        totalRecommendedFundingSat: 6_000,
        plans: [
          planEntry({
            canStart: false,
            fundingAddress: 'bcrt1qshort',
            fundingShortfallSat: 2_500,
            infeasibilityReason: ExitInfeasibilityReasonWalletUnderfunded,
          }),
        ],
      }),
    );
    expect(r.canStart).toBe(false);
    expect(r.fundingShortfallSat).toBe(2_500n);
    expect(r.recommendedFundingSat).toBe(6_000n);
    expect(r.fundingAddress).toBe('bcrt1qshort');
    // wallet_underfunded is fixable by funding the backing wallet.
    expect(r.infeasibilityFundable).toBe(true);
  });

  it('marks cooperative-round commitments as not fundable', () => {
    const r = summarizeExitReadiness(
      planResult({
        canStart: false,
        plans: [
          planEntry({
            canStart: false,
            fundingAddress: '',
            infeasibilityReason: 'round_committed' as ExitInfeasibilityReason,
          }),
        ],
      }),
    );
    expect(r.infeasibilityFundable).toBe(false);
  });
});

describe('planUnilateralExit', () => {
  it('forwards outpoints and an optional conf target to the daemon plan', async () => {
    const c = client();
    await planUnilateralExit(c, ['abc:0', 'def:1']);
    expect(c.getExitPlan).toHaveBeenCalledWith({
      outpoints: ['abc:0', 'def:1'],
      confTarget: undefined,
    });
  });
});

describe('startUnilateralExit — explicit-acknowledgement gate', () => {
  it('starts the batch when the exact acknowledgement is passed', async () => {
    const c = client();
    const result = await startUnilateralExit(c, ['abc:0'], { forceUnrollAck: FORCE_UNROLL_ACK });
    expect(result.started).toHaveLength(1);
    expect(result.started[0]?.outpoint).toBe('abc:0');
    expect(result.skipped).toEqual([]);
    expect(result.remaining).toEqual([]);
    // The ack is forwarded verbatim to the daemon call — the irreversible
    // unilateral path only ever runs behind the exact text.
    expect(c.exit).toHaveBeenCalledWith({
      outpoint: 'abc:0',
      forceUnrollAck: 'I_KNOW_WHAT_I_AM_DOING',
    });
  });

  it('refuses any other acknowledgement — no exit without the exact user text', async () => {
    const c = client();
    await expect(
      startUnilateralExit(c, ['abc:0'], { forceUnrollAck: 'yes, exit my funds' }),
    ).rejects.toBeInstanceOf(MissingUnrollAckError);
    expect(c.getExitPlan).not.toHaveBeenCalled();
    expect(c.exit).not.toHaveBeenCalled();
  });

  it('skips outpoints already running an exit and never re-calls exit for them', async () => {
    const c = client({
      getExitPlan: vi.fn().mockResolvedValue(
        planResult({
          plans: [planEntry({ exitJobFound: true, exitStatus: ExitJobStatusMaterializing })],
        }),
      ),
    });
    const result = await startUnilateralExit(c, ['abc:0'], { forceUnrollAck: FORCE_UNROLL_ACK });
    expect(result.started).toEqual([]);
    expect(result.skipped).toEqual(['abc:0']);
    expect(c.exit).not.toHaveBeenCalled();
  });

  it('stops before any start when the plan is infeasible', async () => {
    const c = client({
      getExitPlan: vi.fn().mockResolvedValue(
        planResult({
          canStart: false,
          plans: [
            planEntry({
              canStart: false,
              infeasibilityReason: ExitInfeasibilityReasonWalletUnderfunded,
            }),
          ],
        }),
      ),
    });
    const result = await startUnilateralExit(c, ['abc:0'], { forceUnrollAck: FORCE_UNROLL_ACK });
    expect(result.started).toEqual([]);
    expect(result.stoppedBy?.reason).toBe('infeasible');
    expect(c.exit).not.toHaveBeenCalled();
  });
});

describe('describeExitJobStatus — phase copy for the UI', () => {
  it('labels the in-flight phases and warns on irreversibility at start', () => {
    expect(describeExitJobStatus('pending')).toContain('Exit starting');
    expect(describeExitJobStatus('materializing')).toContain('confirming');
    expect(describeExitJobStatus('csv_pending')).toContain('timelock');
    expect(describeExitJobStatus('sweeping')).toContain('sweeping funds to your on-chain address');
  });

  it('distinguishes terminal phases', () => {
    expect(describeExitJobStatus('completed')).toContain('funds are on-chain');
    expect(describeExitJobStatus('failed')).toContain('Retry');
  });
});

describe('exit status mapping (typed surface smoke)', () => {
  it('reads a completed exit job from the typed result', () => {
    const status: ExitStatusResult = {
      found: true,
      status: ExitJobStatusCompleted,
      sweepTxid: 'sweeptx-1',
      lastError: '',
      phaseDetail: 'done',
      bestCaseBlocksRemaining: 0,
      currentHeight: 8_000,
    };
    expect(status.found).toBe(true);
    expect(status.status).toBe(ExitJobStatusCompleted);
    expect(describeExitJobStatus(ExitJobStatusMaterializing)).toContain('Exit in progress');
  });
});

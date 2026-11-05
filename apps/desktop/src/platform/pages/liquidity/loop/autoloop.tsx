import { useState } from 'react';
import type { AutoLoopView } from '../../../api.js';
import { usePlatform, usePoll } from '../../../context.js';
import { Amount, Badge, Empty, Field, Notice, Panel, Skeleton } from '../../../ui.js';
import { LoopUnavailableNotice, parseSats, useLoopStatus, type LoopStatus } from './shared.js';

/** The bridge's policy shape (packages/liquidity budgets.ts AutoLoopBudgetPolicy). */
export interface BudgetPolicy {
  readonly perActionCapSat: number;
  readonly dailyBudgetSat: number;
  readonly monthlyBudgetSat: number;
}

/** Narrow the bridge's `policy: unknown` to the documented shape. */
export function readPolicy(p: unknown): BudgetPolicy | null {
  if (typeof p !== 'object' || p === null) return null;
  const r = p as Record<string, unknown>;
  const a = r['perActionCapSat'];
  const d = r['dailyBudgetSat'];
  const m = r['monthlyBudgetSat'];
  return typeof a === 'number' && typeof d === 'number' && typeof m === 'number' ? { perActionCapSat: a, dailyBudgetSat: d, monthlyBudgetSat: m } : null;
}

/** Mirrors validateAutoLoopBudgetPolicy (the bridge enforces it again). */
export function policyErrors(per: string, day: string, month: string): { per?: string; day?: string; month?: string } {
  const e: { per?: string; day?: string; month?: string } = {};
  const p = parseSats(per);
  const d = parseSats(day);
  const m = parseSats(month);
  if (per !== '' && p === null) e.per = 'Enter a positive whole number of sats.';
  if (day !== '' && d === null) e.day = 'Enter a positive whole number of sats.';
  if (month !== '' && m === null) e.month = 'Enter a positive whole number of sats.';
  if (p !== null && d !== null && p > d) e.per = 'A single swap can’t be allowed to cost more than the daily budget.';
  if (d !== null && m !== null && m < d) e.month = 'The monthly budget must be at least the daily budget.';
  return e;
}

const secs = (s: number): string => (s >= 86_400 ? `${Math.round(s / 86_400)} d` : s >= 3600 ? `${Math.round(s / 3600)} h` : `${s} s`);

export function useAutoLoop() {
  const { api, refreshKey } = usePlatform();
  return usePoll(() => api.autoloop(), 20_000, [api, refreshKey]);
}

export function AutoLoopView({ status: given }: { status?: LoopStatus }) {
  const own = useLoopStatus();
  const status = given ?? own;
  const { api, toast, bumpRefresh } = usePlatform();
  const al = useAutoLoop();
  const [per, setPer] = useState('');
  const [day, setDay] = useState('');
  const [month, setMonth] = useState('');
  const [sweepRate, setSweepRate] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dry, setDry] = useState<{ loopOut: number[]; loopIn: number[]; disqualified: { channelId: string; reason: string }[] } | null>(null);
  const [dryErr, setDryErr] = useState<string | null>(null);
  const [dryBusy, setDryBusy] = useState(false);

  const errors = policyErrors(per, day, month);
  const p = parseSats(per);
  const d = parseSats(day);
  const m = parseSats(month);
  const rate = sweepRate.trim() === '' ? undefined : Number(sweepRate);
  const rateErr = rate !== undefined && (!Number.isFinite(rate) || rate <= 0) ? 'Enter a positive fee rate.' : null;
  const valid = p !== null && d !== null && m !== null && Object.keys(errors).length === 0 && rateErr === null;

  const enable = async () => {
    if (p === null || d === null || m === null) return;
    setBusy(true);
    setErr(null);
    try {
      await api.setAutoloop({ enabled: true, policy: { perActionCapSat: p, dailyBudgetSat: d, monthlyBudgetSat: m }, ...(rate !== undefined ? { sweepFeeRateSatPerVbyte: rate } : {}) });
      toast({ title: 'AutoLoop enabled', tone: 'positive' });
      setConfirm(false);
      setAgree(false);
      bumpRefresh();
      await al.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.setAutoloop({ enabled: false });
      toast({ title: 'AutoLoop disabled', tone: 'info' });
      bumpRefresh();
      await al.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const dryRun = async () => {
    setDryBusy(true);
    setDryErr(null);
    setDry(null);
    try {
      setDry(await api.suggestions());
    } catch (e) {
      setDryErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDryBusy(false);
    }
  };

  const v: AutoLoopView | undefined = al.data;
  const params = v?.params ?? null;
  const policy = readPolicy(v?.policy);
  const on = params?.autoloopEnabled === true;

  return (
    <div className="p-grid">
      <div className="p-span-12">
        <LoopUnavailableNotice status={status} />
      </div>
      <div className="p-span-7">
        <Panel
          title="AutoLoop"
          note="loopd watches your channels and dispatches swaps on its own, inside a fee budget you set. Off by default."
          actions={v ? <Badge tone={on ? 'positive' : 'neutral'}>{on ? 'On' : 'Off'}</Badge> : null}
        >
          {v === undefined ? (
            al.error ? (
              <Notice tone="danger" title="Could not read AutoLoop settings" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void al.reload()}>Retry</button>}>
                {al.error}
              </Notice>
            ) : (
              <Skeleton height={160} />
            )
          ) : on ? (
            <div className="p-stack">
              {v.enabledByThisApp && policy ? (
                <>
                  <Notice tone="positive" title="AutoLoop is on under your budget">
                    This app checks every automated swap against the limits below and turns AutoLoop off if one would exceed them.
                  </Notice>
                  <dl className="p-dl">
                    <dt>Per swap</dt>
                    <dd>
                      <Amount sats={policy.perActionCapSat} />
                    </dd>
                    <dt>Per day (UTC)</dt>
                    <dd>
                      <Amount sats={policy.dailyBudgetSat} />
                    </dd>
                    <dt>Per month</dt>
                    <dd>
                      <Amount sats={policy.monthlyBudgetSat} />
                    </dd>
                  </dl>
                  <p className="p-hint">The budget is held by the bridge for this session. If the bridge restarts, loopd keeps AutoLoop on with its own monthly budget, but this app’s per-swap and daily checks stop until you enable it again here.</p>
                  <div className="lp-form-actions">
                    <button type="button" className="p-btn p-btn-danger" disabled={busy} onClick={() => void disable()}>
                      {busy ? 'Disabling…' : 'Disable AutoLoop'}
                    </button>
                  </div>
                </>
              ) : (
                <Notice tone="warning" title="AutoLoop was turned on outside this session">
                  loopd reports AutoLoop on, but not under a budget set by this app (it was enabled elsewhere, or before the bridge restarted). This app can only disable a policy it enabled, so turn it off with <span className="p-mono">loop setparams --autoloop=false</span>, then set a budget here.
                </Notice>
              )}
            </div>
          ) : confirm && p !== null && d !== null && m !== null ? (
            <div className="p-stack">
              <h3 className="lp-section-title">Review the budget</h3>
              <dl className="p-dl">
                <dt>Maximum fees for one swap</dt>
                <dd>
                  <Amount sats={p} />
                </dd>
                <dt>Maximum fees per UTC day</dt>
                <dd>
                  <Amount sats={d} />
                </dd>
                <dt>Maximum fees per month</dt>
                <dd>
                  <Amount sats={m} />
                </dd>
              </dl>
              <h3 className="lp-section-title">Written to loopd</h3>
              <dl className="lp-kv">
                <dt>Budget (refreshes every 30 days)</dt>
                <dd>
                  <Amount sats={m} />
                </dd>
                <dt>Max swap fee rate</dt>
                <dd>2,500 ppm</dd>
                <dt>Sweep fee rate</dt>
                <dd>{rate ?? 30} sat/vB</dd>
                <dt>Max miner fee per swap</dt>
                <dd>
                  <Amount sats={p} />
                </dd>
                <dt>Max prepayment per swap</dt>
                <dd>
                  <Amount sats={Math.min(p, 5000)} />
                </dd>
                <dt>Sweep target · retry backoff</dt>
                <dd>6 blocks · 1 h</dd>
              </dl>
              <label className="p-check">
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                <span>
                  I allow loopd to start swaps without asking me, spending at most <Amount sats={p} /> per swap, <Amount sats={d} /> per day and <Amount sats={m} /> per month in fees.
                </span>
              </label>
              {err ? (
                <Notice tone="danger" title="AutoLoop was not enabled">
                  <p className="lp-notice-p">loopd refused: {err}</p>
                  {status.phase !== 'ready' ? <p className="lp-notice-p p-faint">loopd saves AutoLoop settings only when it can reach the swap server. {status.fix}</p> : null}
                </Notice>
              ) : null}
              <div className="lp-form-actions">
                <button type="button" className="p-btn p-btn-ghost" disabled={busy} onClick={() => setConfirm(false)}>
                  Back
                </button>
                <button type="button" className="p-btn p-btn-primary" disabled={!agree || busy} onClick={() => void enable()}>
                  {busy ? 'Enabling…' : 'Enable AutoLoop'}
                </button>
              </div>
            </div>
          ) : (
            <div className="lp-form">
              <div className="p-grid" style={{ gap: 'var(--sovl-space-4)' }}>
                <div className="p-span-4">
                  <Field label="Per swap" error={errors.per} hint="Fees one automated swap may cost">
                    {(id) => (
                      <div className="p-input-affix">
                        <input id={id} className="p-input" inputMode="numeric" placeholder="e.g. 5000" value={per} onChange={(e) => setPer(e.target.value)} aria-invalid={errors.per !== undefined} />
                        <span>sats</span>
                      </div>
                    )}
                  </Field>
                </div>
                <div className="p-span-4">
                  <Field label="Per day" error={errors.day} hint="Resets 00:00 UTC">
                    {(id) => (
                      <div className="p-input-affix">
                        <input id={id} className="p-input" inputMode="numeric" placeholder="e.g. 10000" value={day} onChange={(e) => setDay(e.target.value)} aria-invalid={errors.day !== undefined} />
                        <span>sats</span>
                      </div>
                    )}
                  </Field>
                </div>
                <div className="p-span-4">
                  <Field label="Per month" error={errors.month} hint="Also loopd’s own budget">
                    {(id) => (
                      <div className="p-input-affix">
                        <input id={id} className="p-input" inputMode="numeric" placeholder="e.g. 50000" value={month} onChange={(e) => setMonth(e.target.value)} aria-invalid={errors.month !== undefined} />
                        <span>sats</span>
                      </div>
                    )}
                  </Field>
                </div>
              </div>
              <Field label="Sweep fee rate" error={rateErr} hint="Optional. Highest on-chain fee rate for automated sweeps; 30 sat/vB if empty.">
                {(id) => (
                  <div className="p-input-affix" style={{ maxWidth: 240 }}>
                    <input id={id} className="p-input" inputMode="decimal" placeholder="30" value={sweepRate} onChange={(e) => setSweepRate(e.target.value)} />
                    <span>sat/vB</span>
                  </div>
                )}
              </Field>
              <div className="lp-form-actions">
                <button type="button" className="p-btn p-btn-primary" disabled={!valid} onClick={() => setConfirm(true)}>
                  Review budget
                </button>
              </div>
              {!valid && per === '' && day === '' && month === '' ? <p className="p-hint" style={{ textAlign: 'right' }}>Set all three limits to continue.</p> : null}
            </div>
          )}
        </Panel>
      </div>

      <div className="p-span-5">
        <div className="p-stack">
          <Panel title="Direction" note="One direction at a time">
            <div className="lp-aside">
              <p>loopd runs AutoLoop in a single direction: Loop Out (free up receiving capacity) or Loop In (refill spendable balance), never both at once.</p>
              <p>
                The direction comes from loopd’s liquidity rules: which channels or peers to watch and at what thresholds. This app can’t set those rules yet, so loopd uses whatever rules it already has. With no rules, AutoLoop never dispatches a swap, even when it is on.
              </p>
              <p className="p-faint">Use the dry run to see what loopd would do with its current rules.</p>
            </div>
          </Panel>
          <Panel title="Current loopd parameters">
            {params === null ? (
              v === undefined ? <Skeleton height={120} /> : <Empty title="No parameters">loopd returned no AutoLoop parameters.</Empty>
            ) : (
              <dl className="lp-kv">
                <dt>AutoLoop</dt>
                <dd>{params.autoloopEnabled ? 'On' : 'Off'}</dd>
                <dt>Budget</dt>
                <dd>
                  <Amount sats={params.budgetSat} />
                </dd>
                <dt>Max swap fee rate</dt>
                <dd>{params.maxSwapFeePpm.toLocaleString('en-US')} ppm</dd>
                <dt>Sweep fee rate</dt>
                <dd>{params.sweepFeeRateSatPerVbyte} sat/vB</dd>
                <dt>Max miner fee</dt>
                <dd>
                  <Amount sats={params.maxMinerFeeSat} />
                </dd>
                <dt>Max prepayment</dt>
                <dd>
                  <Amount sats={params.maxPrepaySat} />
                </dd>
                <dt>Sweep target</dt>
                <dd>{params.sweepConfTarget} blocks</dd>
                <dt>Failure backoff</dt>
                <dd>{secs(params.failureBackoffSec)}</dd>
              </dl>
            )}
          </Panel>
        </div>
      </div>

      <div className="p-span-12">
        <Panel
          title="Dry run"
          note="Asks loopd which swaps it would start right now (SuggestSwaps). Nothing is sent."
          actions={
            <button type="button" className="p-btn p-btn-sm" disabled={dryBusy} onClick={() => void dryRun()}>
              {dryBusy ? 'Running…' : 'Run dry run'}
            </button>
          }
        >
          {dryErr ? (
            <Notice tone="warning" title="loopd could not suggest swaps">
              <p className="lp-notice-p">
                loopd said: <span className="p-mono">{dryErr}</span>
              </p>
              {/no rules/i.test(dryErr) ? (
                <p className="lp-notice-p p-faint">loopd has no liquidity rules, so it has nothing to evaluate. Rules can’t be set from this app yet (see Direction).</p>
              ) : status.phase !== 'ready' ? (
                <p className="lp-notice-p p-faint">{status.reason}</p>
              ) : null}
            </Notice>
          ) : dry ? (
            dry.loopOut.length === 0 && dry.loopIn.length === 0 && dry.disqualified.length === 0 ? (
              <Empty title="No swaps suggested">loopd’s rules are satisfied; AutoLoop would do nothing right now.</Empty>
            ) : (
              <div className="p-grid">
                <div className="p-span-6">
                  <h3 className="lp-section-title">Would start</h3>
                  {dry.loopOut.length + dry.loopIn.length === 0 ? (
                    <p className="p-hint">No swaps.</p>
                  ) : (
                    <dl className="lp-kv">
                      {dry.loopOut.map((a, i) => (
                        <div key={`o${i}`} style={{ display: 'contents' }}>
                          <dt>Loop Out</dt>
                          <dd>
                            <Amount sats={a} />
                          </dd>
                        </div>
                      ))}
                      {dry.loopIn.map((a, i) => (
                        <div key={`i${i}`} style={{ display: 'contents' }}>
                          <dt>Loop In</dt>
                          <dd>
                            <Amount sats={a} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
                <div className="p-span-6">
                  <h3 className="lp-section-title">Skipped channels</h3>
                  {dry.disqualified.length === 0 ? (
                    <p className="p-hint">None.</p>
                  ) : (
                    <dl className="lp-kv">
                      {dry.disqualified.map((x) => (
                        <div key={x.channelId} style={{ display: 'contents' }}>
                          <dt className="p-mono">{x.channelId}</dt>
                          <dd>{x.reason.replace(/^auto_reason_/, '').replace(/_/g, ' ')}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              </div>
            )
          ) : (
            <p className="p-hint">Run it before enabling AutoLoop to see what loopd would do with its current rules.</p>
          )}
        </Panel>
      </div>
    </div>
  );
}

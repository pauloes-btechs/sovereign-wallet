import type { ReactNode } from 'react';
import { Link } from '../../router.js';
import { Amount, Badge, Notice, PageHeader, Panel, Skeleton, type Tone } from '../../ui.js';
import { readPolicy, useAutoLoop } from './loop/autoloop.js';
import { LoopUnavailableNotice, OperatorBadge, useLoopStatus } from './loop/shared.js';
import './loop/loop.css';

interface Capability {
  readonly name: string;
  readonly what: ReactNode;
  readonly status: { readonly tone: Tone; readonly label: string };
  readonly link?: { readonly to: string; readonly label: string };
}

export default function AutomationPage() {
  const loop = useLoopStatus();
  const al = useAutoLoop();
  const params = al.data?.params ?? null;
  const policy = readPolicy(al.data?.policy);
  const on = params?.autoloopEnabled === true;

  const caps: Capability[] = [
    {
      name: 'AutoLoop',
      what: 'loopd starts Loop Out or Loop In swaps on its own when channel balances cross its rules, within a fee budget. One direction at a time.',
      status: loop.phase === 'ready' ? { tone: 'positive', label: 'Available' } : { tone: 'warning', label: 'Needs swap server' },
      link: { to: '/loop/autoloop', label: 'Configure' },
    },
    {
      name: 'Fee budget guardrails',
      what: 'This app’s per-swap, daily and monthly fee limits. The bridge checks each automated swap against them and turns AutoLoop off when one would be exceeded. Held for the bridge session.',
      status: { tone: 'positive', label: 'Available' },
      link: { to: '/loop/autoloop', label: 'Set budget' },
    },
    {
      name: 'Dry run',
      what: 'Ask loopd which swaps it would start right now (SuggestSwaps), without sending anything.',
      status: { tone: 'positive', label: 'Available' },
      link: { to: '/loop/autoloop', label: 'Run' },
    },
    {
      name: 'Liquidity rules',
      what: 'Which channels or peers AutoLoop watches, the direction, and the thresholds. They decide whether AutoLoop ever acts. The bridge does not expose them yet; set them with loop setrule on the node.',
      status: { tone: 'neutral', label: 'Not in this app yet' },
    },
    {
      name: 'Static-address AutoLoop',
      what: 'Automatically looping in deposits to the static address. Experimental in loopd (behind --experimental), so it stays off.',
      status: { tone: 'neutral', label: 'Off by design' },
    },
    {
      name: 'Automatic channel opening',
      what: 'LND’s autopilot can open channels on its own. It is not exposed by the bridge and not enabled.',
      status: { tone: 'neutral', label: 'Not offered' },
      link: { to: '/channels', label: 'Open manually' },
    },
    {
      name: 'Automatic routing fees',
      what: 'Adjusting channel fee policies on a schedule. Fees are only changed when you set them.',
      status: { tone: 'neutral', label: 'Not offered' },
      link: { to: '/routing', label: 'Fee policies' },
    },
    {
      name: 'Scheduled or recurring payments',
      what: 'There is no payment scheduler; every payment is started by you.',
      status: { tone: 'neutral', label: 'Not offered' },
    },
  ];

  return (
    <>
      <PageHeader title="Automation" sub="What this node does on its own, under which limits, and what it never does without you." actions={<OperatorBadge status={loop} />} />
      <div className="p-grid">
        <div className="p-span-12">
          <LoopUnavailableNotice status={loop} />
        </div>
        <div className="p-span-7">
          <Panel
            className="lp-fill"
            title="AutoLoop"
            actions={
              <Link to="/loop/autoloop" className="p-btn p-btn-sm">
                {on ? 'Manage AutoLoop' : 'Set up AutoLoop'}
              </Link>
            }
          >
            {al.data === undefined ? (
              al.error ? (
                <Notice tone="danger" title="Could not read AutoLoop settings" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void al.reload()}>Retry</button>}>
                  {al.error}
                </Notice>
              ) : (
                <Skeleton height={100} />
              )
            ) : (
              <div className="p-stack">
                <div className="p-row">
                  <Badge tone={on ? 'positive' : 'neutral'}>{on ? 'On' : 'Off'}</Badge>
                  <span className="p-muted" style={{ fontSize: 'var(--sovl-text-sm)' }}>
                    {on
                      ? al.data.enabledByThisApp
                        ? 'Running under the budget you set in this app.'
                        : 'loopd reports it on, but not under a budget set in this app session.'
                      : 'No swaps start without you. Turning it on requires a fee budget and an explicit confirmation.'}
                  </span>
                </div>
                <dl className="lp-kv">
                  <dt>loopd budget</dt>
                  <dd>{params ? <Amount sats={params.budgetSat} /> : '—'}</dd>
                  <dt>Max swap fee rate</dt>
                  <dd>{params ? `${params.maxSwapFeePpm.toLocaleString('en-US')} ppm` : '—'}</dd>
                  <dt>Sweep fee rate</dt>
                  <dd>{params ? `${params.sweepFeeRateSatPerVbyte} sat/vB` : '—'}</dd>
                  <dt>Direction</dt>
                  <dd>Set by loopd’s liquidity rules</dd>
                </dl>
              </div>
            )}
          </Panel>
        </div>
        <div className="p-span-5">
          <Panel className="lp-fill" title="Your budget in this app">
            {al.data === undefined ? (
              <Skeleton height={100} />
            ) : policy ? (
              <dl className="p-dl">
                <dt>Per swap</dt>
                <dd>
                  <Amount sats={policy.perActionCapSat} />
                </dd>
                <dt>Per UTC day</dt>
                <dd>
                  <Amount sats={policy.dailyBudgetSat} />
                </dd>
                <dt>Per month</dt>
                <dd>
                  <Amount sats={policy.monthlyBudgetSat} />
                </dd>
              </dl>
            ) : (
              <p className="p-muted" style={{ margin: 0, fontSize: 'var(--sovl-text-sm)' }}>
                No budget is set. Without one this app won’t enable AutoLoop, and loopd’s own parameters (left) are all that limit it.
              </p>
            )}
          </Panel>
        </div>
        <div className="p-span-12">
          <Panel flush title="What can run on its own" note="An honest inventory. Items marked not offered have no switch anywhere in the app.">
            <div className="lp-caps" style={{ marginTop: 'var(--sovl-space-2)' }}>
              {caps.map((c) => (
                <div className="lp-cap" key={c.name}>
                  <div className="lp-cap-name">{c.name}</div>
                  <div className="p-muted">{c.what}</div>
                  <div className="p-row" style={{ justifyContent: 'flex-end' }}>
                    <Badge tone={c.status.tone}>{c.status.label}</Badge>
                    {c.link ? (
                      <Link to={c.link.to} className="p-btn p-btn-ghost p-btn-sm">
                        {c.link.label}
                      </Link>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

/**
 * `routerflip test [name]` — the four-step connection checklist of spec §8.
 *
 * The steps are rendered live while they run, and the whole thing is a *report*
 * rather than an exception: a gateway that refuses the key still prints four rows
 * so the user can see how far it got. The endpoint is configurable (`--path`,
 * `router.testPath`, then the config default) because nothing here should assume
 * a particular API surface.
 */
import type { AppContext } from '../context.ts';
import type { Account, Router } from '../core/schema.ts';
import { json, blank, failure, line, note, success, warning } from '../ui/output.ts';
import { StepList, type StepState } from '../ui/spinner.ts';
import { theme } from '../ui/theme.ts';
import { endpointFor, testRouter, type FetchLike, type StepStatus, type TestReport } from '../services/tester.ts';
import { accountArg, pickRouter, type CommandResult } from './shared.ts';

const STEP_ORDER = ['url', 'reachable', 'endpoint', 'auth'] as const;
const STEP_LABELS = ['URL format', 'Network reachable', 'Endpoint responding', 'Authentication accepted'] as const;

function stateFor(status: StepStatus): StepState {
  if (status === 'pass') return 'ok';
  if (status === 'warn') return 'warn';
  if (status === 'fail') return 'fail';
  return 'pending';
}

export interface RunTestOptions {
  /** Injected transport, so tests never touch the network. */
  readonly fetchImpl?: FetchLike;
  /** Suppress the printed summary; the caller renders its own. */
  readonly silent?: boolean;
  /** Which credential to test with. Defaults to the router's selected account. */
  readonly account?: Account;
}

/** Runs the checklist for one router and prints it. Returns the report. */
export async function runTest(ctx: AppContext, router: Router, options: RunTestOptions = {}): Promise<TestReport> {
  const apiKey = await ctx.service.apiKey(router, options.account);
  const live = ctx.json || options.silent ? undefined : new StepList([...STEP_LABELS]);

  if (live) {
    line(`  ${theme().muted('Testing')} ${theme().bold(router.name)} ${theme().dim(endpointFor(router, pathOptions(ctx)))}`);
    blank();
    live.start();
    live.set(0, 'running');
  }

  let settled = 0;
  const report = await testRouter(router, {
    apiKey,
    ...pathOptions(ctx),
    ...timeoutOptions(ctx),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(live
      ? {
          onStep: (step) => {
            const index = STEP_ORDER.indexOf(step.key);
            const detail = step.latencyMs === undefined ? step.detail : `${step.detail ?? ''}${step.detail ? '  ' : ''}${step.latencyMs}ms`;
            live.set(index, stateFor(step.status), detail ?? (step.status === 'skip' ? 'skipped' : undefined));
            settled = index + 1;
            if (settled < STEP_LABELS.length) live.set(settled, 'running');
          },
        }
      : {}),
  });
  live?.finish();

  if (ctx.json) return report;
  if (!options.silent) printSummary(report);
  return report;
}

function pathOptions(ctx: AppContext): { path?: string; defaultPath?: string } {
  const path = ctx.flags.str('path');
  return { ...(path ? { path } : {}), defaultPath: ctx.config.settings.testPath };
}

function timeoutOptions(ctx: AppContext): { timeoutMs?: number } {
  const timeout = ctx.flags.int('timeout');
  return timeout === undefined ? {} : { timeoutMs: timeout };
}

/** One closing line: what happened, and what to do about it. */
function printSummary(report: TestReport): void {
  const t = theme();
  blank();
  const latency = report.latencyMs === undefined ? '' : ` ${t.dim(`(${report.latencyMs}ms)`)}`;
  if (report.ok) {
    const warned = report.steps.some((step) => step.status === 'warn');
    if (warned) warning(`${report.routerName} works, with warnings.${latency}`);
    else success(`${report.routerName} is ready to use.${latency}`);
  } else {
    failure(`${report.routerName} is not usable yet.`);
    const failed = report.steps.find((step) => step.status === 'fail' || step.status === 'warn');
    if (failed?.detail) note(`  ${failed.detail}`);
  }
  blank();
}

function reportJson(report: TestReport): Record<string, unknown> {
  return {
    router: report.routerName,
    baseUrl: report.baseUrl,
    endpoint: report.endpoint,
    ok: report.ok,
    ...(report.status === undefined ? {} : { status: report.status }),
    ...(report.latencyMs === undefined ? {} : { latencyMs: report.latencyMs }),
    steps: report.steps.map((step) => ({
      key: step.key,
      label: step.label,
      status: step.status,
      ...(step.detail === undefined ? {} : { detail: step.detail }),
      ...(step.latencyMs === undefined ? {} : { latencyMs: step.latencyMs }),
    })),
  };
}

export async function testCommand(ctx: AppContext): Promise<CommandResult> {
  const targets: readonly Router[] = ctx.flags.bool('all') ? ctx.service.list() : [await pickRouter(ctx, 'Test which router?')];
  // `--account` only makes sense for a single router; across `--all` each router
  // is tested with its own selected account.
  const named = ctx.flags.bool('all') ? undefined : accountArg(ctx);

  const reports: TestReport[] = [];
  for (const router of targets) {
    if (!ctx.json && reports.length > 0) blank();
    const account = named === undefined ? undefined : ctx.service.resolveAccount(router, named);
    reports.push(await runTest(ctx, router, account ? { account } : {}));
  }

  if (ctx.json) {
    json({ ok: reports.every((report) => report.ok), reports: reports.map(reportJson) });
  }
  return reports.every((report) => report.ok) ? 0 : 1;
}

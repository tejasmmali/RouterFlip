/**
 * `routerflip doctor` — render the read-only diagnosis from `services/doctor`.
 *
 * This command only formats; every fact comes from `runDoctor`, which never
 * writes, never dials the network, and reports credential *presence* only.
 */
import type { AppContext } from '../context.ts';
import { runDoctor, type Check } from '../services/doctor.ts';
import { blank, json, line } from '../ui/output.ts';
import { rule } from '../ui/box.ts';
import { iconFail } from '../ui/icons.ts';
import { theme } from '../ui/theme.ts';
import { terminalWidth, wrapText } from '../ui/width.ts';
import { checkIcon } from '../ui/views.ts';
import type { CommandResult } from './shared.ts';

function checkLines(check: Check, width: number): string[] {
  const t = theme();
  const out = [`  ${checkIcon(check.status)} ${t.text(check.label)}${check.detail ? `  ${t.dim(check.detail)}` : ''}`];
  if (check.hint) {
    for (const row of wrapText(check.hint, Math.max(20, width - 8))) out.push(`      ${t.muted(row)}`);
  }
  return out;
}

export async function doctorCommand(ctx: AppContext): Promise<CommandResult> {
  const report = await runDoctor({ service: ctx.service, credentials: ctx.credentials, provider: ctx.provider });

  if (ctx.json) {
    json({
      ok: report.healthy,
      counts: report.counts,
      routerCount: report.routerCount,
      ...(report.activeRouter ? { activeRouter: report.activeRouter } : {}),
      sections: report.sections.map((section) => ({
        title: section.title,
        checks: section.checks.map((check) => ({
          label: check.label,
          status: check.status,
          ...(check.detail === undefined ? {} : { detail: check.detail }),
          ...(check.hint === undefined ? {} : { hint: check.hint }),
        })),
      })),
    });
    return report.healthy ? 0 : 1;
  }

  const t = theme();
  const width = terminalWidth();

  blank();
  line(t.bold(t.accent('  RouterFlip doctor')));

  for (const section of report.sections) {
    blank();
    line(`  ${t.bold(section.title)}`);
    line(rule(width));
    for (const check of section.checks) {
      for (const row of checkLines(check, width)) line(row);
    }
  }

  blank();
  line(rule(width));
  const { ok, warn, fail } = report.counts;
  const summary = [
    `${t.success(`${ok} ok`)}`,
    warn > 0 ? t.warning(`${warn} warning${warn === 1 ? '' : 's'}`) : t.dim('0 warnings'),
    fail > 0 ? t.error(`${fail} problem${fail === 1 ? '' : 's'}`) : t.dim('0 problems'),
  ].join(t.muted('  ·  '));
  line(`  ${summary}`);
  blank();
  if (!report.healthy) {
    line(`  ${t.muted('Fix the items marked')} ${iconFail()} ${t.muted('and run doctor again.')}`);
    blank();
  }
  return report.healthy ? 0 : 1;
}

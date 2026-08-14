/**
 * Spinner / task list.
 *
 * Animates only on a TTY. When output is piped or colour is off, each step
 * prints one static line — so CI logs stay readable and `routerflip test |
 * tee` produces something sensible.
 */
import { CLEAR_LINE, CURSOR_HIDE, CURSOR_SHOW, CSI } from './ansi.ts';
import { glyphs, iconFail, iconOk, iconWarn } from './icons.ts';
import { theme } from './theme.ts';

const FRAME_MS = 80;

export class Spinner {
  #text: string;
  #frame = 0;
  #timer: NodeJS.Timeout | undefined;
  #active = false;
  readonly #interactive: boolean;

  constructor(text: string) {
    this.#text = text;
    this.#interactive = Boolean(process.stderr.isTTY) && theme().depth > 0;
  }

  start(): this {
    if (this.#active) return this;
    this.#active = true;
    if (!this.#interactive) {
      process.stderr.write(`  ${this.#text}\n`);
      return this;
    }
    process.stderr.write(CURSOR_HIDE);
    this.#render();
    this.#timer = setInterval(() => {
      this.#frame += 1;
      this.#render();
    }, FRAME_MS);
    this.#timer.unref?.();
    return this;
  }

  update(text: string): void {
    this.#text = text;
    if (this.#interactive && this.#active) this.#render();
  }

  succeed(text = this.#text): void {
    this.#finish(`${iconOk()} ${text}`);
  }

  fail(text = this.#text): void {
    this.#finish(`${iconFail()} ${theme().error(text)}`);
  }

  warn(text = this.#text): void {
    this.#finish(`${iconWarn()} ${theme().warning(text)}`);
  }

  /** Clears the spinner without printing a result line. */
  stop(): void {
    this.#finish(undefined);
  }

  #render(): void {
    const frames = glyphs().spinner;
    const glyph = frames[this.#frame % frames.length] ?? '-';
    process.stderr.write(`${CLEAR_LINE}${CSI}G  ${theme().accent(glyph)} ${this.#text}`);
  }

  #finish(resultLine: string | undefined): void {
    if (!this.#active) return;
    this.#active = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#interactive) {
      process.stderr.write(`${CLEAR_LINE}${CSI}G${CURSOR_SHOW}`);
      if (resultLine !== undefined) process.stderr.write(`  ${resultLine}\n`);
    } else if (resultLine !== undefined) {
      process.stderr.write(`  ${resultLine}\n`);
    }
  }
}

/** Runs `work` with a spinner, resolving to its value. Always clears the line. */
export async function withSpinner<T>(text: string, work: () => Promise<T>): Promise<T> {
  const spinner = new Spinner(text).start();
  try {
    const value = await work();
    spinner.stop();
    return value;
  } catch (error) {
    spinner.stop();
    throw error;
  }
}

export type StepState = 'pending' | 'running' | 'ok' | 'fail' | 'warn';

export interface Step {
  readonly label: string;
  state: StepState;
  detail?: string;
}

/**
 * A live checklist, used by `routerflip test`. Redraws in place on a TTY and
 * appends completed lines otherwise.
 */
export class StepList {
  readonly #steps: Step[];
  #frame = 0;
  #timer: NodeJS.Timeout | undefined;
  #printed = 0;
  readonly #interactive: boolean;

  constructor(labels: readonly string[]) {
    this.#steps = labels.map((label) => ({ label, state: 'pending' as StepState }));
    this.#interactive = Boolean(process.stderr.isTTY) && theme().depth > 0;
  }

  start(): void {
    if (!this.#interactive) return;
    process.stderr.write(CURSOR_HIDE);
    this.#draw();
    this.#timer = setInterval(() => {
      this.#frame += 1;
      this.#draw();
    }, FRAME_MS);
    this.#timer.unref?.();
  }

  set(index: number, state: StepState, detail?: string): void {
    const step = this.#steps[index];
    if (!step) return;
    step.state = state;
    if (detail !== undefined) step.detail = detail;
    if (this.#interactive) this.#draw();
    else if (state !== 'pending' && state !== 'running') process.stderr.write(`  ${this.#renderStep(step)}\n`);
  }

  finish(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    if (!this.#interactive) return;
    this.#draw();
    process.stderr.write(CURSOR_SHOW);
  }

  #renderStep(step: Step): string {
    const t = theme();
    const frames = glyphs().spinner;
    const marker =
      step.state === 'ok'
        ? iconOk()
        : step.state === 'fail'
          ? iconFail()
          : step.state === 'warn'
            ? iconWarn()
            : step.state === 'running'
              ? t.accent(frames[this.#frame % frames.length] ?? '-')
              : t.dim(glyphs().bullet);
    const label = step.state === 'pending' ? t.dim(step.label) : step.label;
    return step.detail ? `${marker} ${label} ${t.dim(step.detail)}` : `${marker} ${label}`;
  }

  #draw(): void {
    if (this.#printed > 0) process.stderr.write(`${CSI}${this.#printed}A`);
    const body = this.#steps.map((step) => `${CLEAR_LINE}  ${this.#renderStep(step)}`).join('\n');
    process.stderr.write(`${body}\n`);
    this.#printed = this.#steps.length;
  }
}

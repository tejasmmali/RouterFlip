/**
 * A very small virtual terminal, so a test can assert what the *user* would see.
 *
 * Counting escape sequences in captured output proves almost nothing about a
 * rendering bug: the interesting question is always "is that frame still on the
 * screen?". So this applies the bytes RouterFlip writes to two grids — the normal
 * buffer and the alternate one — and hands back the visible text.
 *
 * Only what RouterFlip actually emits is modelled: absolute and relative cursor
 * moves, erase-display, erase-line, and the `?1049` buffer switch with its
 * save/restore of the cursor (which is the mechanism the stacked-frames bug was
 * built on). Styling is skipped, since SGR never moves the cursor.
 *
 * `\n` is treated as CRLF: libuv keeps `ONLCR` set even in raw mode, and the
 * Windows console does the same, so a bare LF really does return to column 0.
 */
const ESC = String.fromCharCode(27);
const CSI_PATTERN = /^\[([0-9;?]*)([A-Za-z])/;

interface Cursor {
  row: number;
  col: number;
}

export class Vt {
  readonly width: number;
  readonly height: number;

  /** Buffer 0 is the normal screen, buffer 1 the alternate one. */
  #grids: string[][][];
  #alt = false;
  #cursor: Cursor = { row: 0, col: 0 };
  #saved: Cursor = { row: 0, col: 0 };

  /** How many times the alternate buffer has been entered and left. */
  enters = 0;
  exits = 0;

  constructor(width = 100, height = 30) {
    this.width = width;
    this.height = height;
    this.#grids = [this.#blankGrid(), this.#blankGrid()];
  }

  #blankGrid(): string[][] {
    return Array.from({ length: this.height }, () => Array.from({ length: this.width }, () => ' '));
  }

  #grid(): string[][] {
    return this.#grids[this.#alt ? 1 : 0] as string[][];
  }

  /** True while the alternate buffer is the one on screen. */
  get isAlternate(): boolean {
    return this.#alt;
  }

  /** Visible rows of the buffer currently on screen, trailing blanks removed. */
  get lines(): string[] {
    const rows = this.#grid().map((row) => row.join('').replace(/\s+$/u, ''));
    while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    return rows;
  }

  get text(): string {
    return this.lines.join('\n');
  }

  /** Text of the user's real screen, whichever buffer is on top right now. */
  get normalText(): string {
    const rows = (this.#grids[0] as string[][]).map((row) => row.join('').replace(/\s+$/u, ''));
    while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    return rows.join('\n');
  }

  /** Occurrences of `needle` on the visible screen. */
  count(needle: string): number {
    if (needle.length === 0) return 0;
    let found = 0;
    let at = this.text.indexOf(needle);
    while (at >= 0) {
      found += 1;
      at = this.text.indexOf(needle, at + needle.length);
    }
    return found;
  }

  write(chunk: string): void {
    let index = 0;
    while (index < chunk.length) {
      const char = chunk[index] as string;
      if (char === ESC) {
        const match = CSI_PATTERN.exec(chunk.slice(index + 1));
        if (match) {
          this.#csi(match[1] as string, match[2] as string);
          index += 1 + (match[0] as string).length;
          continue;
        }
        index += 1;
        continue;
      }
      if (char === '\n') {
        this.#newline();
      } else if (char === '\r') {
        this.#cursor.col = 0;
      } else if (char >= ' ') {
        this.#put(char);
      }
      index += 1;
    }
  }

  #put(char: string): void {
    // Deferred wrap, as a real terminal does it: the column is allowed to rest at
    // `width` and only spills over when the next character arrives.
    if (this.#cursor.col >= this.width) this.#newline();
    (this.#grid()[this.#cursor.row] as string[])[this.#cursor.col] = char;
    this.#cursor.col += 1;
  }

  #newline(): void {
    this.#cursor.col = 0;
    this.#cursor.row += 1;
    if (this.#cursor.row < this.height) return;
    this.#cursor.row = this.height - 1;
    const grid = this.#grid();
    grid.shift();
    grid.push(Array.from({ length: this.width }, () => ' '));
  }

  #csi(params: string, final: string): void {
    const priv = params.startsWith('?');
    const parts = (priv ? params.slice(1) : params).split(';');
    const at = (index: number, fallback: number): number => {
      const value = Number.parseInt(parts[index] ?? '', 10);
      return Number.isNaN(value) ? fallback : value;
    };
    const clampRow = (row: number): number => Math.max(0, Math.min(this.height - 1, row));
    const clampCol = (col: number): number => Math.max(0, Math.min(this.width, col));

    switch (final) {
      case 'H':
      case 'f':
        this.#cursor.row = clampRow(at(0, 1) - 1);
        this.#cursor.col = clampCol(at(1, 1) - 1);
        return;
      case 'A':
        this.#cursor.row = clampRow(this.#cursor.row - at(0, 1));
        return;
      case 'B':
        this.#cursor.row = clampRow(this.#cursor.row + at(0, 1));
        return;
      case 'C':
        this.#cursor.col = clampCol(this.#cursor.col + at(0, 1));
        return;
      case 'D':
        this.#cursor.col = clampCol(this.#cursor.col - at(0, 1));
        return;
      case 'G':
        this.#cursor.col = clampCol(at(0, 1) - 1);
        return;
      case 'J':
        this.#eraseDisplay(at(0, 0));
        return;
      case 'K':
        this.#eraseLine(at(0, 0));
        return;
      case 'h':
        if (priv && at(0, 0) === 1049) this.#switchBuffer(true);
        return;
      case 'l':
        if (priv && at(0, 0) === 1049) this.#switchBuffer(false);
        return;
      default:
        // SGR, cursor visibility, synchronized output: nothing that moves the cursor.
        return;
    }
  }

  /** `?1049h` saves the cursor and clears the alternate buffer; `?1049l` restores it. */
  #switchBuffer(toAlternate: boolean): void {
    if (toAlternate === this.#alt) return;
    if (toAlternate) {
      this.#saved = { ...this.#cursor };
      this.#alt = true;
      this.#grids[1] = this.#blankGrid();
      this.enters += 1;
      return;
    }
    this.#alt = false;
    this.#cursor = { ...this.#saved };
    this.exits += 1;
  }

  #eraseDisplay(mode: number): void {
    const grid = this.#grid();
    const blankRow = (row: number, from = 0, to = this.width): void => {
      for (let col = from; col < to; col += 1) (grid[row] as string[])[col] = ' ';
    };
    if (mode === 2 || mode === 3) {
      for (let row = 0; row < this.height; row += 1) blankRow(row);
      return;
    }
    if (mode === 1) {
      for (let row = 0; row < this.#cursor.row; row += 1) blankRow(row);
      blankRow(this.#cursor.row, 0, Math.min(this.width, this.#cursor.col + 1));
      return;
    }
    blankRow(this.#cursor.row, this.#cursor.col);
    for (let row = this.#cursor.row + 1; row < this.height; row += 1) blankRow(row);
  }

  #eraseLine(mode: number): void {
    const row = this.#grid()[this.#cursor.row] as string[];
    const from = mode === 1 ? 0 : mode === 2 ? 0 : this.#cursor.col;
    const to = mode === 1 ? Math.min(this.width, this.#cursor.col + 1) : this.width;
    for (let col = from; col < to; col += 1) row[col] = ' ';
  }
}

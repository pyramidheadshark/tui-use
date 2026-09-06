/**
 * termlink/src/session.ts
 *
 * Wraps a node-pty IPty instance.
 * Uses @xterm/headless as a VT renderer — all PTY output is written into
 * the terminal emulator, and `snapshot()` reads back the rendered screen.
 * This makes ANSI escape sequences, colors, and cursor movement transparent.
 */
import * as pty from "node-pty";
import { Terminal } from "@xterm/headless";
import { SessionInfo } from "./protocol";
import { adjustCursor } from "./cursor";
import { extractHighlights, Highlight } from "./highlights";
import {
  acceptsMouse,
  encodeClick,
  encodeMouseEvent,
  MouseButton,
  MouseModifiers,
  MouseTrackingMode,
  toViewportRow,
  trackSgrMode,
} from "./mouse";

// ---- ANSI re-encoding helpers ----

interface CellStyle {
  fg: number; fgMode: "default" | "palette" | "rgb";
  bg: number; bgMode: "default" | "palette" | "rgb";
  bold: boolean; dim: boolean; italic: boolean;
  underline: boolean; blink: boolean; inverse: boolean; strikethrough: boolean;
}

function getCellStyle(cell: { getFgColor(): number; getBgColor(): number; isFgDefault(): boolean; isFgPalette(): boolean; isFgRGB(): boolean; isBgDefault(): boolean; isBgPalette(): boolean; isBgRGB(): boolean; isBold(): number; isDim(): number; isItalic(): number; isUnderline(): number; isBlink(): number; isInverse(): number; isStrikethrough(): number }): CellStyle {
  return {
    fg: cell.getFgColor(),
    fgMode: cell.isFgDefault() ? "default" : cell.isFgPalette() ? "palette" : "rgb",
    bg: cell.getBgColor(),
    bgMode: cell.isBgDefault() ? "default" : cell.isBgPalette() ? "palette" : "rgb",
    bold: cell.isBold() !== 0,
    dim: cell.isDim() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    blink: cell.isBlink() !== 0,
    inverse: cell.isInverse() !== 0,
    strikethrough: cell.isStrikethrough() !== 0,
  };
}

function stylesEqual(a: CellStyle, b: CellStyle): boolean {
  return a.fg === b.fg && a.fgMode === b.fgMode &&
    a.bg === b.bg && a.bgMode === b.bgMode &&
    a.bold === b.bold && a.dim === b.dim && a.italic === b.italic &&
    a.underline === b.underline && a.blink === b.blink &&
    a.inverse === b.inverse && a.strikethrough === b.strikethrough;
}

function isDefaultStyle(s: CellStyle): boolean {
  return s.fgMode === "default" && s.bgMode === "default" &&
    !s.bold && !s.dim && !s.italic && !s.underline && !s.blink && !s.inverse && !s.strikethrough;
}

function styleToAnsi(s: CellStyle): string {
  const codes: string[] = [];
  if (s.bold) codes.push("1");
  if (s.dim) codes.push("2");
  if (s.italic) codes.push("3");
  if (s.underline) codes.push("4");
  if (s.blink) codes.push("5");
  if (s.inverse) codes.push("7");
  if (s.strikethrough) codes.push("9");
  if (s.fgMode === "palette") {
    if (s.fg < 8) codes.push(String(30 + s.fg));
    else if (s.fg < 16) codes.push(String(90 + s.fg - 8));
    else codes.push(`38;5;${s.fg}`);
  } else if (s.fgMode === "rgb") {
    codes.push(`38;2;${(s.fg >> 16) & 0xff};${(s.fg >> 8) & 0xff};${s.fg & 0xff}`);
  }
  if (s.bgMode === "palette") {
    if (s.bg < 8) codes.push(String(40 + s.bg));
    else if (s.bg < 16) codes.push(String(100 + s.bg - 8));
    else codes.push(`48;5;${s.bg}`);
  } else if (s.bgMode === "rgb") {
    codes.push(`48;2;${(s.bg >> 16) & 0xff};${(s.bg >> 8) & 0xff};${s.bg & 0xff}`);
  }
  if (codes.length === 0) return "";
  return `\x1b[${codes.join(";")}m`;
}

/** Minimal interface for an xterm buffer line (avoids importing concrete types). */
interface ColorBufferLine {
  getCell(x: number): { getChars(): string; getWidth(): number; getFgColor(): number; getBgColor(): number; isFgDefault(): boolean; isFgPalette(): boolean; isFgRGB(): boolean; isBgDefault(): boolean; isBgPalette(): boolean; isBgRGB(): boolean; isBold(): number; isDim(): number; isItalic(): number; isUnderline(): number; isBlink(): number; isInverse(): number; isStrikethrough(): number } | undefined;
  length: number;
}

/** Render a buffer line with ANSI escape sequences preserved. */
function renderLineWithColor(line: ColorBufferLine): string {
  // First pass: find the rightmost cell with non-default style or non-space content.
  // This lets us trim trailing default-styled whitespace without breaking styled spans.
  let lastStyledOrContent = -1;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars();
    if (!isDefaultStyle(getCellStyle(cell)) || (chars !== "" && chars !== " ")) {
      lastStyledOrContent = x;
    }
  }

  if (lastStyledOrContent < 0) return ""; // entirely empty/default line

  let result = "";
  let currentStyle: CellStyle | null = null;

  for (let x = 0; x <= lastStyledOrContent; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    if (cell.getWidth() === 0) continue; // wide char continuation cell

    const chars = cell.getChars();
    const style = getCellStyle(cell);

    if (!currentStyle || !stylesEqual(currentStyle, style)) {
      // Style changed — always reset before switching
      if (currentStyle !== null && !isDefaultStyle(currentStyle)) {
        result += "\x1b[0m";
      }
      if (!isDefaultStyle(style)) {
        result += styleToAnsi(style);
      }
      currentStyle = style;
    }

    // Empty cells (width=1, no chars) are spaces — preserve them for background color
    result += chars || " ";
  }

  // Reset at end of line if we had styling
  if (currentStyle && !isDefaultStyle(currentStyle)) {
    result += "\x1b[0m";
  }

  return result;
}

// ---- Pure helper functions (exported for testing) ----

/** Extract title from a raw title string (or undefined). */
export function extractTitle(raw: string | undefined): string {
  return raw ?? "";
}

/** Extract fullscreen status from the xterm IBufferNamespace. */
export function extractIsFullscreen(bufferNamespace: { active: { type: string } }): boolean {
  return bufferNamespace.active.type === "alternate";
}

/** Check if any observable state has changed between two snapshots. */
export function hasChanged(
  before: { screen: string; title: string; is_fullscreen: boolean },
  current: { screen: string; title: string; is_fullscreen: boolean }
): boolean {
  return (
    current.screen !== before.screen ||
    current.title !== before.title ||
    current.is_fullscreen !== before.is_fullscreen
  );
}

// Special key name → escape sequence mapping
const KEY_MAP: Record<string, string> = {
  "ctrl+a": "\x01", "ctrl+b": "\x02", "ctrl+c": "\x03", "ctrl+d": "\x04",
  "ctrl+e": "\x05", "ctrl+f": "\x06", "ctrl+g": "\x07", "ctrl+h": "\x08",
  "ctrl+i": "\x09", "ctrl+j": "\x0a", "ctrl+k": "\x0b", "ctrl+l": "\x0c",
  "ctrl+m": "\x0d", "ctrl+n": "\x0e", "ctrl+o": "\x0f", "ctrl+p": "\x10",
  "ctrl+q": "\x11", "ctrl+r": "\x12", "ctrl+s": "\x13", "ctrl+t": "\x14",
  "ctrl+u": "\x15", "ctrl+v": "\x16", "ctrl+w": "\x17", "ctrl+x": "\x18",
  "ctrl+y": "\x19", "ctrl+z": "\x1a",
  "arrow_up": "\x1b[A", "arrow_down": "\x1b[B",
  "arrow_right": "\x1b[C", "arrow_left": "\x1b[D",
  "page_up": "\x1b[5~", "page_down": "\x1b[6~",
  "home": "\x1b[H", "end": "\x1b[F",
  "enter": "\r", "tab": "\t", "escape": "\x1b",
  "backspace": "\x7f", "delete": "\x1b[3~",
  "f1": "\x1bOP", "f2": "\x1bOQ", "f3": "\x1bOR", "f4": "\x1bOS",
  "f5": "\x1b[15~", "f6": "\x1b[17~", "f7": "\x1b[18~", "f8": "\x1b[19~",
  "f9": "\x1b[20~", "f10": "\x1b[21~",
};

/** List of all supported key names for use with `press`. */
export const SUPPORTED_KEYS: string[] = Object.keys(KEY_MAP);

export class Session {
  readonly id: string;
  label: string;
  readonly command: string;
  readonly startTime: number;

  private ptyProcess: pty.IPty;
  private terminal: Terminal;
  private _sgrMouse = false;
  private _status: "running" | "exited" = "running";
  private _exitCode: number | null = null;
  private lastSnapshot: string = "";
  private _title: string = "";
  private _isFullscreen: boolean;

  // Listeners notified on any PTY data or exit
  private changeListeners: Array<() => void> = [];

  constructor(
    id: string,
    command: string,
    options: { cwd?: string; label?: string; cols?: number; rows?: number }
  ) {
    this.id = id;
    this.command = command;
    this.label = options.label ?? command.slice(0, 40);
    this.startTime = Date.now();

    const cols = options.cols ?? 120;
    const rows = options.rows ?? 30;

    this.terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 10000 });

    // Initialize fullscreen status immediately (onBufferChange only fires on changes)
    this._isFullscreen = extractIsFullscreen(this.terminal.buffer);

    this.terminal.onTitleChange((title: string) => {
      this._title = extractTitle(title);
      this.notifyListeners();
    });

    this.terminal.buffer.onBufferChange(() => {
      this._isFullscreen = extractIsFullscreen(this.terminal.buffer);
      this.notifyListeners();
    });

    const shell = process.env.SHELL ?? "/bin/sh";
    this.ptyProcess = pty.spawn(shell, ["-c", command], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: options.cwd ?? process.cwd(),
      env: process.env as { [key: string]: string },
    });

    this.ptyProcess.onData((data: string) => {
      // Кодировку мыши отслеживаем САМИ: `@xterm/headless` отдаёт `modes.mouseTrackingMode`,
      // но не отдаёт выбор между SGR (`CSI ? 1006 h`) и устаревшей X10. Разница не
      // косметическая — X10 не выражает колонку больше 223 и молча промахивается.
      this._sgrMouse = trackSgrMode(data, this._sgrMouse);
      this.terminal.write(data);
      this.notifyListeners();
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      this._status = "exited";
      this._exitCode = exitCode ?? null;
      this.notifyListeners();
    });
  }

  get status(): "running" | "exited" {
    return this._status;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get cols(): number {
    return this.terminal.cols;
  }

  get rows(): number {
    return this.terminal.rows;
  }

  /** Send literal text to the PTY. Supports \n \r \t escape sequences. */
  send(input: string): void {
    if (this._status === "exited") {
      throw new Error(`Session ${this.id} has already exited`);
    }
    const interpreted = input
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t");
    this.ptyProcess.write(interpreted);
  }

  /** Press a named key. Throws a descriptive error if the key name is unknown. */
  press(key: string): void {
    if (this._status === "exited") {
      throw new Error(`Session ${this.id} has already exited`);
    }
    const mapped = KEY_MAP[key.toLowerCase()];
    if (mapped === undefined) {
      const supported = Object.keys(KEY_MAP).join(", ");
      throw new Error(
        `Unknown key: "${key}". Run \`tui-use keys\` to see all supported key names.\nSupported keys: ${supported}`
      );
    }
    this.ptyProcess.write(mapped);
  }

  /** Режим отслеживания мыши, объявленный приложением (DECSET 9/1000/1002/1003). */
  get mouseTrackingMode(): MouseTrackingMode {
    return this.terminal.modes.mouseTrackingMode;
  }

  /** Включил ли приложение SGR-кодировку (`CSI ? 1006 h`). */
  get sgrMouse(): boolean {
    return this._sgrMouse;
  }

  private assertMouseAccepted(action: "press" | "release" | "move"): void {
    if (this._status === "exited") {
      throw new Error(`Session ${this.id} has already exited`);
    }
    const mode = this.mouseTrackingMode;
    if (acceptsMouse(mode, action)) return;
    // Отказ, а не молчание: приложение, не включавшее мышь, получит эти байты как обычный
    // ввод — в оболочке они окажутся текстом в командной строке. Молчаливая отправка
    // выглядела бы как «клик не сработал», а на деле портила бы состояние.
    throw new Error(
      mode === "none"
        ? `Приложение не включало отслеживание мыши (mouseTrackingMode=none). ` +
          `Отправка события мыши ушла бы в stdin как мусорный ввод. ` +
          `Если интерфейс кликабельный, дай ему дорисоваться и повтори: режим объявляется при старте.`
        : `Режим мыши "${mode}" не принимает событие "${action}" (x10 подписан только на нажатие).`
    );
  }

  /**
   * Клик по координатам СНАПШОТА (той же системе, что `lines[]`, `cursor` и `find`).
   *
   * Перевод в сырую систему вьюпорта делает `toViewportRow`, а не вызывающий: обрезанных
   * сверху строк он не видит, и держать поправку в голове — источник промаха ровно на
   * `leading_trimmed`. `raw: true` отключает поправку для тех, кто уже считает в сырой.
   */
  click(
    col: number,
    row: number,
    options?: { button?: MouseButton; raw?: boolean; modifiers?: MouseModifiers }
  ): { col: number; row: number; encoding: "sgr" | "x10" } {
    this.assertMouseAccepted("press");
    const viewportRow = options?.raw ? row : toViewportRow(row, this.snapshot().leading_trimmed);
    this.ptyProcess.write(
      encodeClick({
        button: options?.button ?? "left",
        col,
        row: viewportRow,
        sgr: this._sgrMouse,
        mode: this.mouseTrackingMode,
        modifiers: options?.modifiers,
      })
    );
    return { col, row: viewportRow, encoding: this._sgrMouse ? "sgr" : "x10" };
  }

  /** Перемещение курсора мыши без нажатия — принимается только в режимах drag/any. */
  mouseMove(col: number, row: number, options?: { raw?: boolean }): { col: number; row: number } {
    this.assertMouseAccepted("move");
    const viewportRow = options?.raw ? row : toViewportRow(row, this.snapshot().leading_trimmed);
    this.ptyProcess.write(
      encodeMouseEvent({ action: "move", button: "left", col, row: viewportRow, sgr: this._sgrMouse })
    );
    return { col, row: viewportRow };
  }

  /** Прокрутка колесом. Кодируется как нажатие кнопки 64/65 — так его ждёт приложение. */
  wheel(
    direction: "up" | "down",
    col: number,
    row: number,
    options?: { raw?: boolean; count?: number }
  ): { col: number; row: number; count: number } {
    this.assertMouseAccepted("press");
    const viewportRow = options?.raw ? row : toViewportRow(row, this.snapshot().leading_trimmed);
    const count = Math.max(1, options?.count ?? 1);
    for (let i = 0; i < count; i += 1) {
      this.ptyProcess.write(
        encodeMouseEvent({
          action: "press",
          button: direction === "up" ? "wheel-up" : "wheel-down",
          col,
          row: viewportRow,
          sgr: this._sgrMouse,
        })
      );
    }
    return { col, row: viewportRow, count };
  }

  /**
   * Return the current rendered screen as raw lines + cursor.
   * Trailing empty lines and per-line trailing spaces are removed.
   * Updates lastSnapshot for change detection.
   */
  snapshot(options?: { color?: boolean }): { lines: string[]; cursor: { x: number; y: number }; changed: boolean; highlights: Highlight[]; title: string; is_fullscreen: boolean; leading_trimmed: number; trailing_trimmed: number } {
    const buf = this.terminal.buffer.active;
    const useColor = options?.color ?? false;
    const plainLines: string[] = [];
    const startY = buf.viewportY;
    for (let i = 0; i < this.terminal.rows; i++) {
      plainLines.push((buf.getLine(startY + i)?.translateToString(true) ?? "").trimEnd());
    }
    // Remove trailing empty lines
    let plainTrailingTrimmed = 0;
    while (plainLines.length > 0 && plainLines[plainLines.length - 1] === "") {
      plainLines.pop();
      plainTrailingTrimmed++;
    }
    // Remove leading empty lines (TUI apps like fzf render from bottom)
    let plainLeadingTrimmed = 0;
    while (plainLines.length > 0 && plainLines[0] === "") {
      plainLines.shift();
      plainLeadingTrimmed++;
    }
    // Change detection always uses plain text
    const plainScreen = plainLines.join("\n");
    const changed = plainScreen !== this.lastSnapshot;
    this.lastSnapshot = plainScreen;

    // Build color lines if requested
    let lines: string[];
    let colorLeadingTrimmed = 0;
    let colorTrailingTrimmed = 0;
    if (useColor) {
      lines = [];
      for (let i = 0; i < this.terminal.rows; i++) {
        const bufLine = buf.getLine(startY + i);
        lines.push(bufLine ? renderLineWithColor(bufLine) : "");
      }
      // Trim trailing empty lines (match plain text trimming)
      while (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
        colorTrailingTrimmed++;
      }
      while (lines.length > 0 && lines[0] === "") {
        lines.shift();
        colorLeadingTrimmed++;
      }
    } else {
      lines = plainLines;
    }

    // Coordinates are reported in the SAME frame as `lines`.
    //
    // Before this, three frames coexisted: `lines` was trimmed, while `cursor` and
    // `highlights` kept raw viewport rows, so any caller indexing `lines[cursor.y]`
    // was off by exactly the number of trimmed leading rows. Worse, the colour branch
    // trims independently — `renderLineWithColor` returns a non-empty string for a
    // visually blank line that carries a background colour (panels, status bars,
    // selected rows), so plain and colour modes could trim different amounts.
    //
    // `leading_trimmed`/`trailing_trimmed` are reported for the mode actually
    // returned, so a caller can always map back to raw buffer rows if it needs to.
    const leadingTrimmed = useColor ? colorLeadingTrimmed : plainLeadingTrimmed;
    const trailingTrimmed = useColor ? colorTrailingTrimmed : plainTrailingTrimmed;

    const highlights = extractHighlights(buf, this.terminal.rows, startY)
      .map((h) => ({ ...h, line: h.line - leadingTrimmed }))
      .filter((h) => h.line >= 0 && h.line < lines.length);

    return {
      lines,
      cursor: adjustCursor({ x: buf.cursorX, y: buf.cursorY }, leadingTrimmed, trailingTrimmed, this.terminal.rows),
      changed,
      highlights,
      title: this._title,
      is_fullscreen: this._isFullscreen,
      leading_trimmed: leadingTrimmed,
      trailing_trimmed: trailingTrimmed,
    };
  }

  /**
   * Wait until the screen changes (or until pattern matches), then return snapshot.
   * If process exits, returns immediately.
   */
  async wait(
    timeoutMs: number = 3000,
    text?: string,
    debounceMs: number = 100,
    options?: { color?: boolean }
  ): Promise<{ lines: string[]; cursor: { x: number; y: number }; changed: boolean; highlights: ReturnType<typeof extractHighlights>; title: string; is_fullscreen: boolean }> {
    const beforeScreen = this.lastSnapshot;
    const beforeTitle = this._title;
    const beforeFullscreen = this._isFullscreen;

    if (this._status === "exited") {
      return this.snapshot();
    }

    await new Promise<void>((resolve) => {
      let resolved = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;

      const done = () => {
        if (!resolved) {
          resolved = true;
          if (idleTimer) clearTimeout(idleTimer);
          clearTimeout(deadlineTimer);
          resolve();
        }
      };

      const deadlineTimer = setTimeout(done, timeoutMs);

      const check = () => {
        if (resolved) return;
        if (this._status === "exited") { done(); return; }

        // Get current rendered screen (don't update lastSnapshot yet)
        const buf = this.terminal.buffer.active;
        const lines: string[] = [];
        const startY = buf.viewportY;
        for (let i = 0; i < this.terminal.rows; i++) {
          lines.push((buf.getLine(startY + i)?.translateToString(true) ?? "").trimEnd());
        }
        while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        while (lines.length > 0 && lines[0] === "") lines.shift();
        const currentScreen = lines.join("\n");

        if (text) {
          // Pattern mode: resolve when pattern appears in screen
          if (new RegExp(text).test(currentScreen)) { done(); return; }
        } else {
          // Change mode: resolve when any observable state differs from before AND has been idle
          if (hasChanged(
            { screen: beforeScreen, title: beforeTitle, is_fullscreen: beforeFullscreen },
            { screen: currentScreen, title: this._title, is_fullscreen: this._isFullscreen }
          )) {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(done, debounceMs);
          }
        }
      };

      this.changeListeners.push(check);
      check(); // check immediately in case already changed
    });

    return this.snapshot(options);
  }

  kill(): void {
    if (this._status === "running") {
      this.ptyProcess.kill();
    }
  }

  toInfo(): SessionInfo {
    return {
      session_id: this.id,
      label: this.label,
      command: this.command,
      status: this._status,
      exit_code: this._exitCode,
      start_time: this.startTime,
    };
  }

  /** Find text pattern in the current screen */
  find(pattern: string): Array<{ line: number; col_start: number; col_end: number; text: string }> {
    const matches: Array<{ line: number; col_start: number; col_end: number; text: string }> = [];
    const buf = this.terminal.buffer.active;
    let regex: RegExp;
    try {
      // The `g` flag is what makes the loop below find EVERY occurrence. Without it
      // a single exec() returned at most one match per line, silently hiding the rest.
      regex = new RegExp(pattern, "g");
    } catch {
      return matches;
    }

    const startY = buf.viewportY;
    // Report rows in the same frame as snapshot().lines — see the note in snapshot().
    const { leading_trimmed: leadingTrimmed, lines } = this.snapshot();

    for (let i = 0; i < this.terminal.rows; i++) {
      const line = buf.getLine(startY + i);
      if (!line) continue;
      const lineText = line.translateToString(true);
      regex.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = regex.exec(lineText)) !== null) {
        const row = i - leadingTrimmed;
        if (row >= 0 && row < lines.length) {
          matches.push({
            line: row,
            col_start: match.index,
            // INCLUSIVE, matching Highlight.col_end ("index of the last character").
            // It used to be exclusive here while inclusive there — the same number
            // meant two different columns depending on which call produced it.
            col_end: match.index + match[0].length - 1,
            text: match[0],
          });
        }
        // A zero-length match would never advance lastIndex — step over it manually,
        // otherwise the loop spins forever on patterns like `a*` or `^`.
        if (match[0].length === 0) regex.lastIndex++;
      }
    }
    return matches;
  }

  /** Scroll the terminal buffer (for non-fullscreen apps like less/cat) */
  scroll(lines: number): boolean {
    // Scroll the viewport to view buffer history
    // positive lines = scroll down (view newer content)
    // negative lines = scroll up (view older content)
    try {
      this.terminal.scrollLines(lines);
      return true;
    } catch {
      return false;
    }
  }

  /** Rename the session */
  rename(newLabel: string): void {
    this.label = newLabel;
  }

  private notifyListeners(): void {
    const listeners = [...this.changeListeners];
    this.changeListeners = [];
    for (const l of listeners) l();
  }
}

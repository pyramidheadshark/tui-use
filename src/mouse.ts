/**
 * mouse.ts — синтез событий мыши для PTY-сессии.
 *
 * Зачем это здесь, а не «эмулируется клавиатурой». Интерфейс ядра Scaffold построен на
 * кликабельных контролах `@opentui/core` (`ui/press.ts`: hover/armed/click). Часть
 * состояний этих контролов клавиатурой недостижима по построению, поэтому «отладка
 * визуального интерфейса» без мыши — это отладка половины интерфейса.
 *
 * Три вещи, которые здесь важнее самого кодирования байтов:
 *
 * 1. СИСТЕМА ОТСЧЁТА. `snapshot()` срезает пустые строки сверху и возвращает
 *    `leading_trimmed`; `cursor`, `find` и `highlights` уже приведены к этой же,
 *    обрезанной системе. Клик обязан быть в НЕЙ ЖЕ, иначе вызывающий, нашедший кнопку в
 *    `lines[3]`, промахнётся ровно на число срезанных строк. Терминалу при этом уходит
 *    сырая координата вьюпорта — перевод делает `toViewportRow`, а не человек в голове.
 *
 * 2. ОТКАЗ ВМЕСТО МОЛЧАНИЯ. Если приложение не включало отслеживание мыши, его stdin
 *    ждёт обычных байтов, и mouse-последовательность уедет туда как мусорный ввод
 *    (в оболочке — как текст в командной строке). Молчаливая отправка выглядела бы как
 *    «клик не сработал», а на деле портила бы состояние. Поэтому — явная ошибка,
 *    называющая режим.
 *
 * 3. КОДИРОВКУ ОТСЛЕЖИВАЕМ САМИ. `@xterm/headless` отдаёт `modes.mouseTrackingMode`, но
 *    НЕ отдаёт выбранную кодировку: SGR (`CSI ? 1006 h`) против устаревшей X10. Разница
 *    не косметическая — X10 кодирует координату одним байтом `32 + n` и физически не
 *    выражает колонку больше 223, то есть на широком терминале молча промахивается.
 *    Поэтому режим 1006 читаем из потока вывода сами.
 */

export type MouseButton = "left" | "middle" | "right";
export type MouseAction = "press" | "release" | "move";
export type MouseTrackingMode = "none" | "x10" | "vt200" | "drag" | "any";

export interface MouseModifiers {
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

const BUTTON_CODE: Record<MouseButton, number> = { left: 0, middle: 1, right: 2 };
/**
 * «Кнопка не нажата» — младшие два бита `3`. Движение БЕЗ нажатия это `32 + 3 = 35`;
 * `32 + 0 = 32` означает перетаскивание с зажатой левой.
 *
 * ⚠ Разница не формальная: hover-состояние `@opentui/core` (`ui/press.ts`) достигается
 * только первым, а команда `mousemove` описана как «без нажатия». Первая версия слала 32,
 * то есть ровно то состояние, ради которого мышь заводилась, оставалось недостижимым.
 */
const NO_BUTTON = 3;
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
const MOTION_FLAG = 32;
const MOD_SHIFT = 4;
const MOD_ALT = 8;
const MOD_CTRL = 16;

/**
 * Предел координаты в устаревшей кодировке X10.
 *
 * X10 пишет координату ОДНИМ байтом `32 + n`. Формально это даёт 223 (255 − 32), и первая
 * версия так и считала — но на проводе байт не один. `node-pty` по умолчанию кодирует
 * запись в UTF-8 (`unixTerminal.js`: `encoding = opt.encoding === undefined ? "utf8"`),
 * поэтому всё выше 127 уезжает ДВУМЯ байтами: колонка 222 даёт `0xC3 0xBE` вместо `0xFE`,
 * приложение читает 162 и получает лишний байт в stdin.
 *
 * То есть порча начинается на колонке 95 (`32 + 95 = 127`), а отказ стоял на 224 — защита
 * была на 130 колонок правее места поломки. Предел приведён к тому, что реально проходит
 * по проводу без искажения.
 *
 * Терминалы шире 95 колонок — норма, поэтому единственное настоящее лечение — SGR; отказ
 * здесь честно говорит, что клик в эту точку невозможен, вместо тихого промаха.
 */
export const X10_MAX_COORD = 95;

export function modifierBits(mods: MouseModifiers | undefined): number {
  if (!mods) return 0;
  return (mods.shift ? MOD_SHIFT : 0) | (mods.alt ? MOD_ALT : 0) | (mods.ctrl ? MOD_CTRL : 0);
}

/**
 * Принимает ли приложение события мыши прямо сейчас.
 *
 * `x10` намеренно НЕ считается принимающим движение и отпускание: в этом режиме
 * приложение подписано только на нажатие, и всё остальное для него — мусор.
 */
export function acceptsMouse(mode: MouseTrackingMode, action: MouseAction): boolean {
  if (mode === "none") return false;
  if (mode === "x10") return action === "press";
  if (action === "move") return mode === "drag" || mode === "any";
  return true;
}

/**
 * Строка снапшота → строка вьюпорта.
 *
 * Вызывающий видит обрезанный экран; терминал живёт в сыром. Обратный перевод —
 * единственное место, где эти две системы встречаются.
 */
export function toViewportRow(snapshotRow: number, leadingTrimmed: number): number {
  return snapshotRow + leadingTrimmed;
}

/**
 * Кодирует одно событие. Координаты — НУЛЕВЫЕ (как в `lines[]`), в протокол уходят
 * единичные: терминал считает с единицы, а вызывающий — с нуля, и смешение этих двух
 * отсчётов даёт промах ровно на клетку, который в снапшоте не виден.
 */
export function encodeMouseEvent(input: {
  action: MouseAction;
  button: MouseButton | "wheel-up" | "wheel-down";
  col: number;
  row: number;
  sgr: boolean;
  modifiers?: MouseModifiers;
  /** Для `move`: какая кнопка зажата. `undefined` — ни одной (hover). */
  heldButton?: MouseButton;
}): string {
  const { action, button, col, row, sgr } = input;
  if (col < 0 || row < 0) throw new Error(`Отрицательная координата: col=${col}, row=${row}`);

  let code: number;
  if (button === "wheel-up") code = WHEEL_UP;
  else if (button === "wheel-down") code = WHEEL_DOWN;
  else code = BUTTON_CODE[button];
  if (action === "move") code = (input.heldButton === undefined ? NO_BUTTON : BUTTON_CODE[input.heldButton]) | MOTION_FLAG;
  code |= modifierBits(input.modifiers);

  const c = col + 1;
  const r = row + 1;

  if (sgr) {
    // Отпускание кнопки в SGR отличается финальным символом, а НЕ кодом 3 — благодаря
    // этому приложение знает, какая именно кнопка отпущена.
    return `\x1b[<${code};${c};${r}${action === "release" ? "m" : "M"}`;
  }
  if (c > X10_MAX_COORD || r > X10_MAX_COORD) {
    throw new Error(
      `Координата (${c},${r}) не проходит по проводу в устаревшей кодировке X10 (предел ${X10_MAX_COORD}): ` +
        "PTY кодирует запись в UTF-8, и байт выше 127 уезжает двумя, смещая координату у приложения. " +
        "Приложение не включило SGR-режим мыши (CSI ? 1006 h) — клик в эту точку невозможен без промаха."
    );
  }
  // X10 не различает кнопки при отпускании: код 3 означает «какая-то отпущена».
  const legacy = action === "release" ? 3 | modifierBits(input.modifiers) : code;
  return `\x1b[M${String.fromCharCode(32 + legacy)}${String.fromCharCode(32 + c)}${String.fromCharCode(32 + r)}`;
}

/** Нажатие + отпускание одной кнопки. В x10 отпускания нет — приложение его не ждёт. */
export function encodeClick(input: {
  button: MouseButton;
  col: number;
  row: number;
  sgr: boolean;
  mode: MouseTrackingMode;
  modifiers?: MouseModifiers;
}): string {
  const press = encodeMouseEvent({ ...input, action: "press" });
  if (!acceptsMouse(input.mode, "release")) return press;
  return press + encodeMouseEvent({ ...input, action: "release" });
}

/**
 * Обновляет флаг SGR по куску вывода PTY.
 *
 * Последний переключатель в куске побеждает — приложение могло включить и выключить
 * режим в одной записи, и порядок здесь важнее факта наличия.
 *
 * ⚠ Разбирается МНОГОПАРАМЕТРИЧЕСКАЯ форма: `CSI ? 1000;1006 h` — законная и
 * распространённая запись, которой приложение включает отслеживание и SGR одним
 * управляющим кодом. Первая версия искала `\x1b[?1006` вплотную и такую форму не видела:
 * `@xterm/headless` разбирал её верно (`tracking=vt200`), а мы считали приложение
 * устаревшим и слали ему X10 — то есть мусорный ввод ровно тому интерфейсу, ради которого
 * мышь и писалась.
 */
export function trackSgrMode(chunk: string, current: boolean): boolean {
  let last = current;
  const re = /\x1b\[\?([0-9;]+)([hl])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    if (m[1].split(";").includes("1006")) last = m[2] === "h";
  }
  return last;
}

import { describe, it, expect } from "vitest";
import {
  acceptsMouse,
  encodeClick,
  encodeMouseEvent,
  modifierBits,
  toViewportRow,
  trackSgrMode,
  X10_MAX_COORD,
} from "./mouse";

describe("encodeMouseEvent — SGR", () => {
  it("нажатие левой кнопки: координаты единичные, финальный символ M", () => {
    expect(encodeMouseEvent({ action: "press", button: "left", col: 4, row: 7, sgr: true })).toBe("\x1b[<0;5;8M");
  });

  it("отпускание отличается финальным символом m, а не кодом — приложение знает КАКУЮ отпустили", () => {
    expect(encodeMouseEvent({ action: "release", button: "right", col: 0, row: 0, sgr: true })).toBe("\x1b[<2;1;1m");
  });

  // ⚠ Движение БЕЗ нажатия — это 35 (`32 + 3`, «кнопка не нажата»), а не 32: 32 означает
  // перетаскивание с зажатой левой. Разница не формальная — hover-состояние достигается
  // только первым, а именно ради него мышь и заводилась.
  it("движение без кнопки — 35, а не 32", () => {
    expect(encodeMouseEvent({ action: "move", button: "left", col: 0, row: 0, sgr: true })).toBe("\x1b[<35;1;1M");
  });

  it("движение с зажатой кнопкой — перетаскивание, 32 для левой", () => {
    expect(
      encodeMouseEvent({ action: "move", button: "left", heldButton: "left", col: 0, row: 0, sgr: true })
    ).toBe("\x1b[<32;1;1M");
    expect(
      encodeMouseEvent({ action: "move", button: "left", heldButton: "right", col: 0, row: 0, sgr: true })
    ).toBe("\x1b[<34;1;1M");
  });

  it("колесо вверх — 64, вниз — 65", () => {
    expect(encodeMouseEvent({ action: "press", button: "wheel-up", col: 0, row: 0, sgr: true })).toBe("\x1b[<64;1;1M");
    expect(encodeMouseEvent({ action: "press", button: "wheel-down", col: 0, row: 0, sgr: true })).toBe(
      "\x1b[<65;1;1M"
    );
  });

  it("модификаторы складываются: shift 4 + alt 8 + ctrl 16", () => {
    expect(modifierBits({ shift: true, alt: true, ctrl: true })).toBe(28);
    expect(
      encodeMouseEvent({ action: "press", button: "left", col: 0, row: 0, sgr: true, modifiers: { ctrl: true } })
    ).toBe("\x1b[<16;1;1M");
  });

  it("НЕГАТИВНЫЙ: отрицательная координата — ошибка, а не молчаливый ноль", () => {
    expect(() => encodeMouseEvent({ action: "press", button: "left", col: -1, row: 0, sgr: true })).toThrow(
      /Отрицательная координата/
    );
  });
});

describe("encodeMouseEvent — устаревшая X10", () => {
  it("кодирует координату как 32+n одним байтом", () => {
    const out = encodeMouseEvent({ action: "press", button: "left", col: 4, row: 7, sgr: false });
    expect(out).toBe(`\x1b[M${String.fromCharCode(32)}${String.fromCharCode(37)}${String.fromCharCode(40)}`);
  });

  it("отпускание в X10 не различает кнопку — код 3", () => {
    const out = encodeMouseEvent({ action: "release", button: "right", col: 0, row: 0, sgr: false });
    expect(out.charCodeAt(3)).toBe(32 + 3);
  });

  // ⚠ Предел — 95, а не 223: PTY кодирует запись в UTF-8, и байт `32 + n` выше 127
  // уезжает ДВУМЯ байтами, смещая координату у приложения. Первая версия ставила отказ
  // на 224, то есть на 130 колонок правее места поломки.
  //
  // Границу проверяем ОБЕ соседние ячейки: тест «на границе» на 222 при пределе 223
  // не проверял саму границу вовсе, и правильная починка проходила незамеченной.
  it("НЕГАТИВНЫЙ: за пределом — внятный отказ, а не тихий промах", () => {
    expect(() =>
      encodeMouseEvent({ action: "press", button: "left", col: X10_MAX_COORD, row: 0, sgr: false })
    ).toThrow(/X10/);
  });

  it("ровно на границе — ещё можно, на единицу дальше — уже нет", () => {
    expect(() =>
      encodeMouseEvent({ action: "press", button: "left", col: X10_MAX_COORD - 1, row: 0, sgr: false })
    ).not.toThrow();
    expect(() =>
      encodeMouseEvent({ action: "press", button: "left", col: X10_MAX_COORD, row: 0, sgr: false })
    ).toThrow();
  });

  it("НЕГАТИВНЫЙ: каждый байт X10 умещается в один — иначе UTF-8 удвоит его на проводе", () => {
    for (let c = 0; c < X10_MAX_COORD; c += 1) {
      const out = encodeMouseEvent({ action: "press", button: "left", col: c, row: c, sgr: false });
      for (const ch of out) expect(ch.charCodeAt(0)).toBeLessThan(128);
      expect(Buffer.byteLength(out, "utf8")).toBe(out.length);
    }
  });
});

describe("acceptsMouse", () => {
  it("none не принимает ничего", () => {
    for (const a of ["press", "release", "move"] as const) expect(acceptsMouse("none", a)).toBe(false);
  });

  it("x10 подписан только на нажатие", () => {
    expect(acceptsMouse("x10", "press")).toBe(true);
    expect(acceptsMouse("x10", "release")).toBe(false);
    expect(acceptsMouse("x10", "move")).toBe(false);
  });

  it("vt200 принимает нажатие и отпускание, но не движение", () => {
    expect(acceptsMouse("vt200", "release")).toBe(true);
    expect(acceptsMouse("vt200", "move")).toBe(false);
  });

  it("drag и any принимают движение", () => {
    expect(acceptsMouse("drag", "move")).toBe(true);
    expect(acceptsMouse("any", "move")).toBe(true);
  });
});

describe("encodeClick", () => {
  it("в vt200 шлёт нажатие И отпускание", () => {
    expect(encodeClick({ button: "left", col: 0, row: 0, sgr: true, mode: "vt200" })).toBe("\x1b[<0;1;1M\x1b[<0;1;1m");
  });

  it("в x10 отпускания нет — приложение его не ждёт", () => {
    const out = encodeClick({ button: "left", col: 0, row: 0, sgr: true, mode: "x10" });
    expect(out).toBe("\x1b[<0;1;1M");
  });
});

describe("toViewportRow", () => {
  // Обратная сторона фикса системы отсчёта: `cursor`/`find` переводят сырое в обрезанное,
  // клик обязан переводить обрезанное обратно в сырое, иначе промах ровно на leading_trimmed.
  it("возвращает срезанные сверху строки обратно", () => {
    expect(toViewportRow(3, 5)).toBe(8);
  });

  it("без обрезки — тождество", () => {
    expect(toViewportRow(3, 0)).toBe(3);
  });
});

describe("trackSgrMode", () => {
  it("включение и выключение читаются из потока", () => {
    expect(trackSgrMode("\x1b[?1006h", false)).toBe(true);
    expect(trackSgrMode("\x1b[?1006l", true)).toBe(false);
  });

  // ⚠ Самая частая живая форма: приложение включает отслеживание и SGR ОДНИМ кодом.
  // Первая версия искала `\x1b[?1006` вплотную и такую запись не видела — то есть считала
  // SGR-приложение устаревшим и слала ему X10.
  it("комбинированный DECSET распознаётся в любом порядке параметров", () => {
    expect(trackSgrMode("\x1b[?1000;1006h", false)).toBe(true);
    expect(trackSgrMode("\x1b[?1000;1002;1006h", false)).toBe(true);
    expect(trackSgrMode("\x1b[?1006;1002h", false)).toBe(true);
    expect(trackSgrMode("\x1b[?1000;1006l", true)).toBe(false);
  });

  it("НЕГАТИВНЫЙ: 1006 как ЧАСТЬ другого числа не считается", () => {
    expect(trackSgrMode("\x1b[?11006h", false)).toBe(false);
    expect(trackSgrMode("\x1b[?10061h", false)).toBe(false);
  });

  it("последний переключатель в куске побеждает", () => {
    expect(trackSgrMode("\x1b[?1006h текст \x1b[?1006l", false)).toBe(false);
    expect(trackSgrMode("\x1b[?1006l текст \x1b[?1006h", false)).toBe(true);
  });

  it("НЕГАТИВНЫЙ: кусок без переключателей не меняет состояние", () => {
    expect(trackSgrMode("обычный вывод", true)).toBe(true);
    expect(trackSgrMode("обычный вывод", false)).toBe(false);
  });

  it("НЕГАТИВНЫЙ: соседний режим 1000 за 1006 не принимается", () => {
    expect(trackSgrMode("\x1b[?1000h", false)).toBe(false);
  });
});

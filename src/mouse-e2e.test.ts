import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Session } from "./session";

/**
 * Мышь против НАСТОЯЩЕГО приложения в PTY, а не против кодировщика.
 *
 * Юнит-тесты `mouse.test.ts` доказывают, что байты сложены правильно. Они не доказывают,
 * что байты доходят и что координата в них та, которую видел вызывающий. Здесь приложение
 * само разбирает событие и печатает координату — расхождение видно на экране.
 *
 * Главный случай — второй: экран с пустыми строками сверху. `snapshot()` их срезает, и
 * вызывающий, нашедший кнопку в `lines[0]`, кликает «в нулевую строку». Без обратного
 * перевода клик уйдёт на четыре строки выше кнопки, а внешне это будет выглядеть как
 * «приложение не отреагировало».
 */
const APP = `import sys, re, tty, termios
fd = sys.stdin.fileno(); old = termios.tcgetattr(fd); tty.setraw(fd)
sys.stdout.write("\\x1b[?1000h\\x1b[?1006h")
sys.stdout.write("\\x1b[2J\\x1b[H")
sys.stdout.write("\\r\\n\\r\\n\\r\\n\\r\\n")
sys.stdout.write("КНОПКА\\r\\n")
sys.stdout.flush()
buf = ""
try:
    while True:
        ch = sys.stdin.read(1)
        if not ch or ch == "q": break
        buf += ch
        m = re.search(r"\\x1b\\[<(\\d+);(\\d+);(\\d+)M", buf)
        if m:
            sys.stdout.write("ПОПАЛ col=%s row=%s\\r\\n" % (m.group(2), m.group(3)))
            sys.stdout.flush(); buf = ""
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
`;

const settle = (ms = 900) => new Promise(r => setTimeout(r, ms));

describe("мышь против живого приложения", () => {
  let session: Session | undefined;
  let dir: string | undefined;

  afterEach(() => {
    try {
      session?.kill();
    } catch {
      /* уже вышло */
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    session = undefined;
    dir = undefined;
  });

  async function startApp(): Promise<Session> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-use-mouse-"));
    const file = path.join(dir, "app.py");
    fs.writeFileSync(file, APP);
    const s = new Session("mouse-e2e", `python3 -u ${file}`, { cols: 80, rows: 24 });
    await settle();
    return s;
  }

  it("приложение объявляет режим мыши, и мы его видим", async () => {
    session = await startApp();
    expect(session.mouseTrackingMode).toBe("vt200");
    expect(session.sgrMouse).toBe(true);
  });

  // Ядро R4: клик по координате СНАПШОТА попадает в ту строку, которую видел вызывающий.
  it("клик по строке снапшота попадает в неё, а не на leading_trimmed выше", async () => {
    session = await startApp();
    const snap = session.snapshot();
    const buttonRow = snap.lines.findIndex(l => l.includes("КНОПКА"));
    expect(buttonRow).toBeGreaterThanOrEqual(0);
    expect(snap.leading_trimmed).toBeGreaterThan(0); // иначе случай не воспроизведён

    const out = session.click(0, buttonRow);
    expect(out.row).toBe(buttonRow + snap.leading_trimmed);
    await settle();

    const after = session.snapshot();
    const hit = after.lines.find(l => l.startsWith("ПОПАЛ"));
    expect(hit).toBeDefined();
    // Приложение считает строки с единицы — сравниваем с сырой строкой вьюпорта + 1.
    expect(hit).toContain(`row=${buttonRow + snap.leading_trimmed + 1}`);
  });

  it("НЕГАТИВНЫЙ: приложение без мыши получает отказ, а не мусор в stdin", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-use-nomouse-"));
    session = new Session("nomouse-e2e", "cat", { cols: 80, rows: 24 });
    await settle(400);
    expect(session.mouseTrackingMode).toBe("none");
    expect(() => session?.click(1, 1)).toThrow(/не включало отслеживание мыши/);
  });

  it("НЕГАТИВНЫЙ: движение в режиме vt200 отвергается — приложение его не ждёт", async () => {
    session = await startApp();
    expect(() => session?.mouseMove(1, 1)).toThrow(/не принимает событие "move"/);
  });
});

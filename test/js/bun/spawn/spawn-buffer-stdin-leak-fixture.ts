// Driven by spawn-buffer-stdin-leak.test.ts. Measures RSS growth across a
// warmed-up round of `Bun.spawn` with an ArrayBuffer stdin and prints a
// single JSON line. Runs in its own process so the test runner's heap does
// not drown the leak signal.
//
// Two modes (argv[2]):
//   "drain": 64 bytes into `sort` (reads stdin to EOF). The uv_write fits
//            the pipe buffer and completes successfully before the child
//            exits, so `StaticPipeWriter::on_write` runs the close path.
//   "reject": 256 KB into `cmd /c exit` (never reads stdin). The write
//            overflows the pipe buffer and the child closes the read end,
//            so `WindowsBufferedWriter::on_write_complete` takes its error
//            arm (`close()` then `on_error()` with no `Parent::on_write`).

const mode = process.argv[2] === "reject" ? "reject" : "drain";
const stdinBuf = mode === "drain" ? Buffer.alloc(64, "x") : Buffer.alloc(256 * 1024, "x");
const childCmd = mode === "drain" ? ["sort"] : ["cmd", "/c", "exit"];

const BATCH = 40;
const N = 3000;

async function spawnBatch(count: number) {
  for (let i = 0; i < count; i += BATCH) {
    const procs: Promise<number>[] = [];
    for (let j = 0; j < BATCH && i + j < count; j++) {
      const proc = Bun.spawn({
        cmd: [...childCmd],
        stdin: stdinBuf,
        stdout: "ignore",
        stderr: "ignore",
      });
      procs.push(proc.exited);
    }
    await Promise.all(procs);
  }
}

function settle() {
  Bun.gc(true);
  return Bun.sleep(50).then(() => Bun.gc(true));
}

// Warm past the heap's first growth step so the measured round sees
// steady-state allocator behaviour.
await spawnBatch(N);
await settle();
const before = process.memoryUsage.rss();

await spawnBatch(N);
await settle();
const after = process.memoryUsage.rss();

const deltaKB = (after - before) / 1024;
process.stdout.write(JSON.stringify({ mode, N, deltaKB: Math.round(deltaKB) }) + "\n");

// Driven by spawn-buffer-stdin-leak.test.ts. Measures RSS growth across a
// warmed-up round of `Bun.spawn` with a small ArrayBuffer stdin and prints a
// single JSON line. Runs in its own process so the test runner's heap does
// not drown the ~2 MB leak signal.

// 64 bytes fits the pipe buffer so the parent's uv_write completes before the
// child exits, putting `StaticPipeWriter::on_write` on the close path.
const stdinBuf = Buffer.alloc(64, "x");

const BATCH = 40;
const N = 3000;

async function spawnBatch(count: number) {
  for (let i = 0; i < count; i += BATCH) {
    const procs: Promise<number>[] = [];
    for (let j = 0; j < BATCH && i + j < count; j++) {
      const proc = Bun.spawn({
        // `sort` is a built-in Windows binary that reads stdin to EOF; it
        // starts far faster than another bun, which matters for a
        // 6000-iteration RSS probe under a debug build.
        cmd: ["sort"],
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
process.stdout.write(JSON.stringify({ N, deltaKB: Math.round(deltaKB) }) + "\n");

/**
 * `Bun.spawn({ stdin: <ArrayBuffer/Uint8Array> })` wires the bytes through a
 * native `StaticPipeWriter` on Windows and macOS (Linux uses a memfd).
 * `start()` takes a +1 on the writer that is released when the buffer drains;
 * on Windows the release in `on_write` was gated behind `cfg(not(windows))`,
 * so the common ordering (uv_write completes before the child exits, then
 * `on_close_io` flips `stdin` to `Ignore`) stranded that +1 and leaked the
 * writer struct on every spawn.
 *
 * Windows-only: macOS runs the same release site (POSIX path) and Linux routes
 * buffer stdin through a memfd, so the writer is never created there.
 *
 * The measurement runs in a subprocess so the test runner's own heap does not
 * drown the ~2 MB leak signal.
 */
import { expect, test } from "bun:test";
import { bunEnv, bunExe, isASAN, isDebug, isWindows } from "harness";
import { join } from "path";

test.skipIf(!isWindows)(
  "Bun.spawn with an ArrayBuffer stdin does not leak the stdin pipe writer",
  async () => {
    await using proc = Bun.spawn({
      cmd: [bunExe(), join(import.meta.dir, "spawn-buffer-stdin-leak-fixture.ts")],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");

    const { N, deltaKB } = JSON.parse(stdout.trim()) as { N: number; deltaKB: number };
    console.log(`RSS delta over ${N} buffer-stdin spawns after warmup: ${deltaKB} KB`);
    expect(exitCode).toBe(0);

    // Unfixed: one `StaticPipeWriter` (with its embedded `uv_write_t`) per
    // spawn, ~800 B each, so ~2.4 MB over 3000 spawns in release and more
    // under debug/ASAN redzones. Fixed: the same workload is within a few
    // hundred KB of the `stdin: "ignore"` baseline. The bound sits roughly a
    // third of the way to the unfixed figure.
    const boundKB = isASAN || isDebug ? 1200 : 800;
    expect(deltaKB).toBeLessThan(boundKB);
  },
  120_000,
);

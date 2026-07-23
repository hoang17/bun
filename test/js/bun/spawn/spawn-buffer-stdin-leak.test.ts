/**
 * `Bun.spawn({ stdin: <ArrayBuffer/Uint8Array> })` wires the bytes through a
 * native `StaticPipeWriter` on Windows and macOS (Linux uses a memfd).
 * `start()` takes a +1 on the writer that is released when the buffer drains;
 * on Windows the release in `on_write` was gated behind `cfg(not(windows))`,
 * so the common ordering (uv_write completes before the child exits, then
 * `on_close_io` flips `stdin` to `Ignore`) stranded that +1 and leaked the
 * writer struct on every spawn. The error arm of `on_write_complete` (child
 * closes stdin without reading) never calls `Parent::on_write` at all, so
 * `on_close` is the release site for that path.
 *
 * Windows-only: macOS runs the same release site (POSIX path) and Linux routes
 * buffer stdin through a memfd, so the writer is never created there.
 *
 * The measurement runs in a subprocess so the test runner's own heap does not
 * drown the leak signal.
 */
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isASAN, isDebug, isWindows } from "harness";
import { join } from "path";

async function measure(mode: "drain" | "reject") {
  await using proc = Bun.spawn({
    cmd: [bunExe(), join(import.meta.dir, "spawn-buffer-stdin-leak-fixture.ts"), mode],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect(stderr).toBe("");
  const parsed = JSON.parse(stdout.trim()) as { mode: string; N: number; deltaKB: number };
  console.log(`[${parsed.mode}] RSS delta over ${parsed.N} buffer-stdin spawns after warmup: ${parsed.deltaKB} KB`);
  expect(exitCode).toBe(0);
  return parsed.deltaKB;
}

describe.skipIf(!isWindows)("Bun.spawn with an ArrayBuffer stdin does not leak the stdin pipe writer", () => {
  test(
    "when the child drains stdin (on_write release)",
    async () => {
      const deltaKB = await measure("drain");
      // Unfixed: one `StaticPipeWriter` (with its embedded `uv_write_t`) per
      // spawn, ~800 B each, so ~2.4 MB over 3000 spawns in release and more
      // under debug/ASAN redzones. Fixed: the same workload is within a few
      // hundred KB of the `stdin: "ignore"` baseline.
      const boundKB = isASAN || isDebug ? 1200 : 800;
      expect(deltaKB).toBeLessThan(boundKB);
    },
    120_000,
  );

  test(
    "when the child rejects stdin (on_close release)",
    async () => {
      const deltaKB = await measure("reject");
      // Unfixed: the error arm of `on_write_complete` strands start()'s +1 the
      // same way; with a 256 KB buffer the leaked write request is larger and
      // 3000 spawns grew RSS by ~28 MB in release. Fixed: a few hundred KB.
      const boundKB = isASAN || isDebug ? 2000 : 1500;
      expect(deltaKB).toBeLessThan(boundKB);
    },
    120_000,
  );
});

// safe-trip-write.ts — shared safety boundary for every generated-trip writer.
//
// Writers must reject symlinked shipped paths before their first read/modify/write,
// serialize against other cooperating CLIs with one trip-wide lock, and replace
// JSON/SW files via a same-directory atomic rename so a final-path symlink can
// never redirect bytes outside the trip.

import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHIPPED_DIRS = ['data', 'css', 'js', 'assets'];
const SHIPPED_FILES = ['index.html', 'day.html', 'manifest.json', 'sw.js'];

async function pathStat(path: string) {
  try { return await lstat(path); }
  catch (error: any) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function assertRealTree(path: string, label: string): Promise<void> {
  const st = await pathStat(path);
  if (!st) return;
  if (st.isSymbolicLink()) throw new Error(`unsafe trip tree: symlinked shipped path is not allowed: ${label}`);
  if (!st.isDirectory()) return;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    await assertRealTree(join(path, entry.name), `${label}/${entry.name}`);
  }
}

export async function assertSafeTripTree(tripDir: string): Promise<void> {
  const root = await pathStat(tripDir);
  if (!root || root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error('trip dir must be a real directory, not a symlink');
  }
  const data = await pathStat(join(tripDir, 'data'));
  if (!data || data.isSymbolicLink() || !data.isDirectory()) {
    throw new Error('trip data/ must be a real directory, not a symlink');
  }
  for (const name of SHIPPED_DIRS) await assertRealTree(join(tripDir, name), `./${name}`);
  for (const name of SHIPPED_FILES) await assertRealTree(join(tripDir, name), `./${name}`);
}

export const ATOMIC_WRITE_HELPER_FLAG = '--trip-pwa-anchored-atomic-write';
const ATOMIC_READY = 'TRIP_PWA_ATOMIC_READY\n';

function safeAtomicBasename(value: string): boolean {
  return !!value && value !== '.' && value !== '..' && basename(value) === value;
}

// This helper starts with cwd already bound to one directory inode by the OS.
// It verifies that inode before accepting file contents, then uses relative
// write/rename/remove calls only. Renaming the original directory or replacing
// its old pathname with a symlink cannot redirect any of those operations.
async function anchoredAtomicWriteHelper(argv: string[]): Promise<void> {
  const [expectedDev, expectedIno, tempName, targetName] = argv;
  if (!expectedDev || !expectedIno || !safeAtomicBasename(tempName) || !safeAtomicBasename(targetName)) {
    throw new Error('invalid anchored atomic-write helper arguments');
  }
  const cwd = await lstat('.');
  if (cwd.isSymbolicLink() || !cwd.isDirectory()
    || String(cwd.dev) !== expectedDev || String(cwd.ino) !== expectedIno) {
    throw new Error('unsafe atomic write parent changed before helper anchor');
  }

  // Do not let authored bytes enter the helper until cwd identity is proven.
  process.stdout.write(ATOMIC_READY);
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  try {
    await writeFile(tempName, body, { flag: 'wx' });
    await rename(tempName, targetName);
  } catch (error) {
    await rm(tempName, { force: true }).catch(() => {});
    throw error;
  }
}

async function runAnchoredAtomicWrite(
  parent: string,
  expectedDev: number,
  expectedIno: number,
  tempName: string,
  targetName: string,
  contents: string | Uint8Array,
): Promise<void> {
  const helperFile = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [
    helperFile,
    ATOMIC_WRITE_HELPER_FLAG,
    String(expectedDev),
    String(expectedIno),
    tempName,
    targetName,
  ], {
    cwd: parent,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  await new Promise<void>((resolveWrite, rejectWrite) => {
    let settled = false;
    let ready = false;
    let stdout = '';
    let stderr = '';
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) rejectWrite(error); else resolveWrite();
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (ready || !stdout.includes('\n')) return;
      if (stdout !== ATOMIC_READY) {
        child.kill();
        finish(new Error(`unsafe atomic write helper handshake: ${stdout.trim() || '(empty)'}`));
        return;
      }
      ready = true;
      child.stdin.end(contents);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {}); // exit-before-ready is reported by close
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (code === 0 && ready) finish();
      else finish(new Error(
        `anchored atomic write failed (code=${code ?? 'null'}, signal=${signal ?? 'none'}): ${stderr.trim() || 'helper exited before commit'}`,
      ));
    });
  });
}

export async function atomicWriteFile(path: string, contents: string | Uint8Array): Promise<void> {
  const parent = dirname(path);
  const targetName = basename(path);
  if (!safeAtomicBasename(targetName)) throw new Error(`unsafe atomic write target (${path})`);
  const before = await pathStat(parent);
  if (!before || before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`unsafe atomic write parent: expected a real directory (${parent})`);
  }
  const tempName = `.${targetName}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await runAnchoredAtomicWrite(parent, before.dev, before.ino, tempName, targetName, contents);

  // The commit itself is anchored and cannot escape. This last path check is a
  // correctness signal: if the original directory was moved away, callers must
  // not mistake a safe commit into that inode for a visible update at `parent`.
  const after = await pathStat(parent);
  if (!after || after.isSymbolicLink() || !after.isDirectory()
    || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error(`unsafe atomic write parent changed during commit (${parent}); original directory retained the committed bytes`);
  }
}

export interface LockOwner {
  pid: number;
  nonce?: string;
}

export interface LockSnapshot {
  raw: string;
  owner: LockOwner;
}

function parseLockOwner(raw: string): LockOwner | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) return null;
    if (parsed.nonce !== undefined && (typeof parsed.nonce !== 'string' || !parsed.nonce.trim())) return null;
    return parsed as LockOwner;
  } catch {
    return null;
  }
}

async function lockSnapshot(lockPath: string): Promise<LockSnapshot | null> {
  const st = await pathStat(lockPath);
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`unsafe trip write lock: expected a real directory (${lockPath})`);
  }
  let raw: string;
  try { raw = await readFile(join(lockPath, 'owner.json'), 'utf8'); }
  catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const owner = parseLockOwner(raw);
  return owner ? { raw, owner } : null;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM still proves that a process owns the PID; ESRCH means it is gone.
    return error?.code === 'EPERM';
  }
}

async function removeOwnedLock(lockPath: string, nonce: string): Promise<void> {
  let raw: string;
  try { raw = await readFile(join(lockPath, 'owner.json'), 'utf8'); }
  catch (error: any) { if (error?.code === 'ENOENT') return; throw error; }
  if (parseLockOwner(raw)?.nonce !== nonce) return;
  await rm(lockPath, { recursive: true, force: true });
}

function removeOwnedLockSync(lockPath: string, nonce: string): void {
  try {
    const owner = parseLockOwner(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
    if (owner?.nonce === nonce) rmSync(lockPath, { recursive: true, force: true });
  } catch {}
}

async function claimLock(lockPath: string, owner: LockOwner): Promise<boolean> {
  try {
    // mkdir is the no-replace commit point. rename(claimPath, lockPath) is not
    // suitable here: POSIX permits replacing an existing *empty* directory,
    // which could steal an unverifiable lock left between mkdir and owner.json.
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error: any) {
    if (['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(error?.code)) return false;
    throw error;
  }
  try {
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify(owner) + '\n', { flag: 'wx' });
    return true;
  } catch (error) {
    // Keep the directory as explicit evidence. Removing it recursively after a
    // partial owner write would make an unverifiable failure look unlocked.
    throw new Error(`trip write lock owner could not be recorded (${lockPath}); inspect the lock before retrying`, { cause: error });
  }
}

async function restoreMovedLock(stalePath: string, lockPath: string): Promise<void> {
  // Reserve the canonical name with mkdir so a concurrent claimant can never be
  // overwritten by directory rename. Once reserved, move every evidence entry
  // back; on any failure preserve both locations for manual recovery.
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error: any) {
    if (error?.code === 'EEXIST') {
      throw new Error(`trip write lock changed while checking its owner (${lockPath}); stale evidence preserved at ${stalePath}`);
    }
    throw error;
  }
  try {
    for (const entry of await readdir(stalePath)) {
      await rename(join(stalePath, entry), join(lockPath, entry));
    }
    await rm(stalePath, { recursive: true });
  } catch (error) {
    throw new Error(`trip write lock could not be restored safely (${lockPath}); evidence preserved at ${stalePath}`, { cause: error });
  }
}

export async function reclaimDeadLock(lockPath: string, expected: LockSnapshot): Promise<boolean> {
  const stalePath = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }

  try {
    const movedRaw = await readFile(join(stalePath, 'owner.json'), 'utf8');
    if (movedRaw !== expected.raw) {
      // The lock changed between inspection and rename. Restore without ever
      // replacing a concurrent claimant, and never delete an owner we did not vet.
      await restoreMovedLock(stalePath, lockPath);
      throw new Error(`trip write lock changed while checking its owner (${lockPath}); retry`);
    }
    await rm(stalePath, { recursive: true, force: true });
    return true;
  } catch (error) {
    const stillThere = await pathStat(stalePath);
    if (stillThere && !(await pathStat(lockPath))) {
      await restoreMovedLock(stalePath, lockPath).catch(() => {});
    }
    throw error;
  }
}

export async function acquireTripWriteLock(tripDir: string): Promise<() => Promise<void>> {
  await assertSafeTripTree(tripDir);
  const lockPath = join(tripDir, '.trip-pwa-write.lock');
  const nonce = crypto.randomUUID();
  const owner: LockOwner = { pid: process.pid, nonce };

  for (let attempt = 0; attempt < 3; attempt++) {
    if (await claimLock(lockPath, owner)) break;

    const snapshot = await lockSnapshot(lockPath);
    if (!snapshot) {
      // A legacy writer could have been killed between mkdir and owner.json.
      // Never guess or steal an unverifiable lock; report it for manual recovery.
      throw new Error(`trip write lock has no valid owner (${lockPath}); remove it only if no writer is running`);
    }
    if (pidIsAlive(snapshot.owner.pid)) {
      throw new Error(`another trip write is in progress (${lockPath}); retry after it finishes`);
    }
    await reclaimDeadLock(lockPath, snapshot);
    if (attempt === 2) throw new Error(`could not safely reclaim stale trip write lock (${lockPath}); retry`);
  }

  const claimed = await lockSnapshot(lockPath);
  if (claimed?.owner.nonce !== nonce) {
    throw new Error(`could not acquire trip write lock (${lockPath}); retry`);
  }

  // Explicit exits skip surrounding async finally blocks. Signals get their own
  // synchronous handlers; SIGKILL is recovered on the next acquisition by the
  // dead-PID path above. Every cleanup verifies the nonce before removing bytes.
  const cleanupOnExit = () => removeOwnedLockSync(lockPath, nonce);
  const cleanupOnSigint = () => { cleanupOnExit(); process.exit(130); };
  const cleanupOnSigterm = () => { cleanupOnExit(); process.exit(143); };
  process.once('exit', cleanupOnExit);
  process.once('SIGINT', cleanupOnSigint);
  process.once('SIGTERM', cleanupOnSigterm);

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try { await removeOwnedLock(lockPath, nonce); }
    finally {
      process.off('exit', cleanupOnExit);
      process.off('SIGINT', cleanupOnSigint);
      process.off('SIGTERM', cleanupOnSigterm);
    }
  };
}

if (import.meta.main && process.argv[2] === ATOMIC_WRITE_HELPER_FLAG) {
  anchoredAtomicWriteHelper(process.argv.slice(3)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

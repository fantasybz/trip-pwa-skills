import { expect, test } from 'bun:test';
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireTripWriteLock,
  assertSafeTripTree,
  ATOMIC_WRITE_HELPER_FLAG,
  atomicWriteFile,
  reclaimDeadLock,
} from './safe-trip-write';

const safeWriterModule = fileURLToPath(new URL('./safe-trip-write.ts', import.meta.url));

async function tripDir() {
  const out = await mkdtemp(join(tmpdir(), 'safe-trip-write-'));
  await mkdir(join(out, 'data'));
  return out;
}

async function spawnLockedChild(out: string) {
  const program = [
    `import { acquireTripWriteLock } from ${JSON.stringify(safeWriterModule)};`,
    `await acquireTripWriteLock(${JSON.stringify(out)});`,
    `console.log('LOCKED');`,
    `await new Promise(() => {});`,
  ].join('\n');
  const child = spawn('bun', ['-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child did not acquire lock: ${stderr}`));
    }, 5000);
    child.stdout.on('data', (chunk) => {
      if (!String(chunk).includes('LOCKED')) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`child exited before lock: code=${code} signal=${signal} ${stderr}`));
    });
  });
  return child;
}

async function waitForExit(child: ReturnType<typeof spawn>) {
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('child did not exit after signal'));
    }, 5000);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

test('trip-wide writer lock makes a concurrent writer fail explicitly', async () => {
  const out = await tripDir();
  try {
    const release = await acquireTripWriteLock(out);
    await expect(acquireTripWriteLock(out)).rejects.toThrow(/another trip write is in progress/);
    await release();
    await release(); // release is deliberately idempotent for finally/exit cleanup races
    const releaseAgain = await acquireTripWriteLock(out);
    await releaseAgain();
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('SIGTERM removes an owned lock before the writer exits', async () => {
  const out = await tripDir();
  const lockPath = join(out, '.trip-pwa-write.lock');
  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = await spawnLockedChild(out);
    expect(existsSync(lockPath)).toBe(true);
    expect(child.kill('SIGTERM')).toBe(true);
    const exited = await waitForExit(child);
    expect(exited.code).toBe(143);
    expect(exited.signal).toBe(null);
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(out, { recursive: true, force: true });
  }
});

test('the next writer reclaims a lock whose owner was SIGKILLed', async () => {
  const out = await tripDir();
  const lockPath = join(out, '.trip-pwa-write.lock');
  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = await spawnLockedChild(out);
    expect(existsSync(lockPath)).toBe(true);
    expect(child.kill('SIGKILL')).toBe(true);
    const exited = await waitForExit(child);
    expect(exited.signal).toBe('SIGKILL');
    expect(existsSync(lockPath)).toBe(true);

    const release = await acquireTripWriteLock(out);
    expect(existsSync(lockPath)).toBe(true);
    await release();
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(out, { recursive: true, force: true });
  }
});

test('writer lock rejects symlink and non-directory lock paths without touching their victims', async () => {
  const out = await tripDir();
  const victim = join(out, 'lock-victim');
  const lockPath = join(out, '.trip-pwa-write.lock');
  try {
    await mkdir(victim);
    await writeFile(join(victim, 'keep.txt'), 'keep\n');
    await symlink(victim, lockPath);
    await expect(acquireTripWriteLock(out)).rejects.toThrow(/expected a real directory/);
    expect(await readFile(join(victim, 'keep.txt'), 'utf8')).toBe('keep\n');

    await rm(lockPath, { force: true });
    await writeFile(lockPath, 'not a directory\n');
    await expect(acquireTripWriteLock(out)).rejects.toThrow(/expected a real directory/);
    expect(await readFile(lockPath, 'utf8')).toBe('not a directory\n');
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('writer lock refuses missing or malformed owner metadata and preserves evidence', async () => {
  for (const owner of [null, '{ malformed']) {
    const out = await tripDir();
    const lockPath = join(out, '.trip-pwa-write.lock');
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, 'evidence.txt'), 'do not delete\n');
      if (owner !== null) await writeFile(join(lockPath, 'owner.json'), owner);
      await expect(acquireTripWriteLock(out)).rejects.toThrow(/no valid owner/);
      expect(await readFile(join(lockPath, 'evidence.txt'), 'utf8')).toBe('do not delete\n');
      if (owner !== null) expect(await readFile(join(lockPath, 'owner.json'), 'utf8')).toBe(owner);
    } finally { await rm(out, { recursive: true, force: true }); }
  }
});

test('writer lock never replaces a truly empty unverifiable lock directory', async () => {
  const out = await tripDir();
  const lockPath = join(out, '.trip-pwa-write.lock');
  try {
    await mkdir(lockPath);
    await expect(acquireTripWriteLock(out)).rejects.toThrow(/no valid owner/);
    expect(existsSync(lockPath)).toBe(true);
    expect(await readdir(lockPath)).toEqual([]);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('dead-lock reclaim detects TOCTOU owner changes and restores the new owner intact', async () => {
  const out = await tripDir();
  const lockPath = join(out, '.trip-pwa-write.lock');
  const ownerA = { pid: 999_991, nonce: 'owner-a' };
  const ownerB = { pid: 999_992, nonce: 'owner-b' };
  const rawA = JSON.stringify(ownerA) + '\n';
  const rawB = JSON.stringify(ownerB) + '\n';
  try {
    await mkdir(lockPath);
    await writeFile(join(lockPath, 'owner.json'), rawB);
    await expect(reclaimDeadLock(lockPath, { raw: rawA, owner: ownerA }))
      .rejects.toThrow(/changed while checking its owner/);
    expect(await readFile(join(lockPath, 'owner.json'), 'utf8')).toBe(rawB);
    expect((await readdir(out)).filter((name) => name.includes('.stale-'))).toEqual([]);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('safe tree rejects symlinked trip roots and shipped data files', async () => {
  const real = await tripDir();
  const parent = await mkdtemp(join(tmpdir(), 'safe-trip-link-'));
  const linkedRoot = join(parent, 'trip');
  try {
    await symlink(real, linkedRoot);
    await expect(assertSafeTripTree(linkedRoot)).rejects.toThrow(/real directory/);

    const victim = join(parent, 'victim.json');
    await writeFile(victim, 'outside\n');
    await symlink(victim, join(real, 'data', 'food.json'));
    await expect(assertSafeTripTree(real)).rejects.toThrow(/symlinked shipped path/);
    expect(await readFile(victim, 'utf8')).toBe('outside\n');
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(real, { recursive: true, force: true });
  }
});

test('atomic writer replaces a final-path symlink without touching its victim', async () => {
  const out = await tripDir();
  const victim = join(out, 'victim.json');
  const target = join(out, 'data', 'food.json');
  try {
    await writeFile(victim, 'outside\n');
    await symlink(victim, target);
    await atomicWriteFile(target, '[]\n');
    expect(await readFile(victim, 'utf8')).toBe('outside\n');
    expect(await readFile(target, 'utf8')).toBe('[]\n');
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('atomic writer refuses a symlinked parent directory without creating external temp files', async () => {
  const base = await mkdtemp(join(tmpdir(), 'safe-parent-link-'));
  const victimDir = join(base, 'victim');
  const linkedParent = join(base, 'linked-data');
  try {
    await mkdir(victimDir);
    await symlink(victimDir, linkedParent);
    await expect(atomicWriteFile(join(linkedParent, 'food.json'), '[]\n'))
      .rejects.toThrow(/unsafe atomic write parent/);
    expect(await readdir(victimDir)).toEqual([]);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('anchored atomic helper cannot be redirected by a parent ABA after verification', async () => {
  const base = await mkdtemp(join(tmpdir(), 'safe-parent-aba-'));
  const parent = join(base, 'data');
  const movedParent = join(base, 'data-original');
  const outside = join(base, 'outside');
  let child: ReturnType<typeof spawn> | null = null;
  try {
    await mkdir(parent);
    await mkdir(outside);
    const expected = await lstat(parent);
    child = spawn('bun', [
      safeWriterModule,
      ATOMIC_WRITE_HELPER_FLAG,
      String(expected.dev),
      String(expected.ino),
      '.food.json.tmp-test',
      'food.json',
    ], { cwd: parent, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const exited = waitForExit(child);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child?.kill('SIGKILL');
        reject(new Error(`atomic helper did not anchor: ${stderr}`));
      }, 5000);
      child?.stdout.on('data', (chunk) => {
        if (!String(chunk).includes('TRIP_PWA_ATOMIC_READY')) return;
        clearTimeout(timeout);
        resolve();
      });
    });

    // Replace the original pathname only AFTER the helper has verified cwd.
    // Relative writes must stay on the original inode, never follow this link.
    await rename(parent, movedParent);
    await symlink(outside, parent);
    child.stdin.end('[]\n');
    const status = await exited;
    expect(status).toEqual({ code: 0, signal: null });
    expect(await readFile(join(movedParent, 'food.json'), 'utf8')).toBe('[]\n');
    expect(await readdir(outside)).toEqual([]);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(base, { recursive: true, force: true });
  }
});

test('atomic writer removes its temporary file when the final rename fails', async () => {
  const out = await tripDir();
  const target = join(out, 'data', 'food.json');
  try {
    await mkdir(target); // a non-empty destination directory cannot be replaced by a file rename
    await writeFile(join(target, 'keep.txt'), 'keep\n');
    await expect(atomicWriteFile(target, '[]\n')).rejects.toThrow();
    const siblings = await readdir(join(out, 'data'));
    expect(siblings.filter((name) => name.startsWith('.food.json.tmp-'))).toEqual([]);
    expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('keep\n');
  } finally { await rm(out, { recursive: true, force: true }); }
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { rotateAttachments } from './rotation.js';

describe('rotateAttachments', () => {
  let tmp: string;
  let dir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rot-'));
    dir = path.join(tmp, 'groups', 'main', 'attachments');
    fs.mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeFiles(n: number): void {
    for (let i = 0; i < n; i++) {
      const name = `img-${i}.jpg`;
      const p = path.join(dir, name);
      fs.writeFileSync(p, 'x');
      const t = Date.now() - (n - i) * 1000; // oldest first
      fs.utimesSync(p, t / 1000, t / 1000);
    }
  }

  it('does nothing below hysteresis threshold (120)', () => {
    makeFiles(100);
    rotateAttachments({ projectRoot: tmp, groupFolder: 'main', retainTarget: 100, hysteresisTop: 120, maxFiles: 500, referenceFloorMs: 0, referencedPaths: new Set() });
    expect(fs.readdirSync(dir).length).toBe(100);
  });

  it('prunes to retainTarget when above hysteresisTop', () => {
    makeFiles(130);
    rotateAttachments({ projectRoot: tmp, groupFolder: 'main', retainTarget: 100, hysteresisTop: 120, maxFiles: 500, referenceFloorMs: 0, referencedPaths: new Set() });
    expect(fs.readdirSync(dir).length).toBe(100);
  });

  it('preserves referenced files within the reference floor', () => {
    makeFiles(130);
    const refs = new Set(['attachments/img-0.jpg', 'attachments/img-1.jpg']);
    rotateAttachments({
      projectRoot: tmp, groupFolder: 'main',
      retainTarget: 100, hysteresisTop: 120, maxFiles: 500,
      referenceFloorMs: Date.now() - 10_000,
      referencedPaths: refs,
    });
    const remaining = fs.readdirSync(dir);
    expect(remaining).toContain('img-0.jpg');
    expect(remaining).toContain('img-1.jpg');
  });

  it('hard ceiling (maxFiles) overrides the reference floor', () => {
    makeFiles(600);
    const refs = new Set<string>(Array.from({ length: 600 }, (_, i) => `attachments/img-${i}.jpg`));
    rotateAttachments({
      projectRoot: tmp, groupFolder: 'main',
      retainTarget: 100, hysteresisTop: 120, maxFiles: 500,
      referenceFloorMs: Date.now() - 10_000,
      referencedPaths: refs,
    });
    expect(fs.readdirSync(dir).length).toBe(500);
  });
});

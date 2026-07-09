import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { ScopeManager } from './scope-manager';

describe('ScopeManager', () => {
  it('normalize applies defaults to empty manifest', () => {
    const sm = new ScopeManager('/tmp/test');
    const resolved = sm.normalize({
      filesToModify: ['src/test.ts'],
      filesToCreate: [],
      directories: ['src'],
    });

    expect(resolved.maxFiles).toBe(10);
    expect(resolved.requiresApprovalBeyondScope).toBe(true);
    expect(resolved.maxLinesPerFile).toBe(400);
    expect(resolved.filesToModify).toEqual(['src/test.ts']);
    expect(resolved.filesToCreate).toEqual([]);
    expect(resolved.directories).toEqual(['src']);
  });

  it('normalize preserves explicit values', () => {
    const sm = new ScopeManager('/tmp/test');
    const resolved = sm.normalize({
      filesToModify: [],
      filesToCreate: [],
      directories: [],
      maxFiles: 5,
      requiresApprovalBeyondScope: false,
      maxLinesPerFile: 200,
      changeType: 'single-file',
      gateMode: 'strict',
    });

    expect(resolved.maxFiles).toBe(5);
    expect(resolved.requiresApprovalBeyondScope).toBe(false);
    expect(resolved.maxLinesPerFile).toBe(200);
    expect(resolved.changeType).toBe('single-file');
    expect(resolved.gateMode).toBe('strict');
  });

  describe('gateMode', () => {
    it('single-file defaults to relaxed', () => {
      const sm = new ScopeManager('/tmp/test');
      const resolved = sm.normalize({
        filesToModify: ['a.ts'],
        filesToCreate: [],
        directories: [],
        changeType: 'single-file',
      });
      expect(resolved.gateMode).toBe('relaxed');
    });

    it('multi-file defaults to strict', () => {
      const sm = new ScopeManager('/tmp/test');
      const resolved = sm.normalize({
        filesToModify: ['a.ts', 'b.ts'],
        filesToCreate: [],
        directories: [],
        changeType: 'multi-file',
      });
      expect(resolved.gateMode).toBe('strict');
    });

    it('default changeType is multi-file -> strict', () => {
      const sm = new ScopeManager('/tmp/test');
      const resolved = sm.normalize({
        filesToModify: ['a.ts'],
        filesToCreate: [],
        directories: [],
      });
      expect(resolved.changeType).toBe('multi-file');
      expect(resolved.gateMode).toBe('strict');
    });

    it('explicit gateMode overrides derivation', () => {
      const sm = new ScopeManager('/tmp/test');

      const singleWithStrict = sm.normalize({
        filesToModify: ['a.ts'],
        filesToCreate: [],
        directories: [],
        changeType: 'single-file',
        gateMode: 'strict',
      });
      expect(singleWithStrict.gateMode).toBe('strict');

      const multiWithRelaxed = sm.normalize({
        filesToModify: ['a.ts', 'b.ts'],
        filesToCreate: [],
        directories: [],
        changeType: 'multi-file',
        gateMode: 'relaxed',
      });
      expect(multiWithRelaxed.gateMode).toBe('relaxed');
    });
  });

  describe('file I/O', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'scope-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writeScope creates .pi/scope.json with contract shape', () => {
      const sm = new ScopeManager(tmpDir);

      sm.writeScope({
        filesToModify: ['src/test.ts'],
        filesToCreate: [],
        directories: ['src'],
      });

      const scopePath = join(tmpDir, '.pi', 'scope.json');
      expect(existsSync(scopePath)).toBe(true);

      const raw = JSON.parse(readFileSync(scopePath, 'utf-8'));
      expect(raw.version).toBe(1);
      expect(raw.schema).toBe('scope-file-contract-v1');
      expect(raw.scope).toBeDefined();
      expect(raw.scope.maxFiles).toBe(10);
    });

    it('readScope reads back written scope', () => {
      const sm = new ScopeManager(tmpDir);

      sm.writeScope({
        filesToModify: ['a.ts', 'b.ts'],
        filesToCreate: ['c.ts'],
        directories: ['src'],
        maxFiles: 3,
      });
      const readBack = sm.readScope();

      expect(readBack).not.toBeNull();
      expect(readBack!.filesToModify).toEqual([resolve('a.ts'), resolve('b.ts')]);
      expect(readBack!.filesToCreate).toEqual([resolve('c.ts')]);
      expect(readBack!.maxFiles).toBe(3);
    });

    it('readScope returns null when no scope file', () => {
      const sm = new ScopeManager(tmpDir);
      expect(sm.readScope()).toBeNull();
    });

    it('readScope returns null for corrupt scope file', () => {
      const sm = new ScopeManager(tmpDir);
      mkdirSync(join(tmpDir, '.pi'), { recursive: true });
      writeFileSync(join(tmpDir, '.pi', 'scope.json'), 'not-json');
      expect(sm.readScope()).toBeNull();
    });

    it('readScope returns null for incomplete contract', () => {
      const sm = new ScopeManager(tmpDir);
      mkdirSync(join(tmpDir, '.pi'), { recursive: true });
      writeFileSync(join(tmpDir, '.pi', 'scope.json'), JSON.stringify({ foo: 'bar' }));
      expect(sm.readScope()).toBeNull();
    });

    it('clearScope removes the scope file', () => {
      const sm = new ScopeManager(tmpDir);

      sm.writeScope({
        filesToModify: ['a.ts'],
        filesToCreate: [],
        directories: [],
      });
      expect(existsSync(join(tmpDir, '.pi', 'scope.json'))).toBe(true);

      sm.clearScope();
      expect(existsSync(join(tmpDir, '.pi', 'scope.json'))).toBe(false);
    });

    it('clearScope does not throw when no scope file', () => {
      const sm = new ScopeManager(tmpDir);
      expect(() => sm.clearScope()).not.toThrow();
    });
  });
});

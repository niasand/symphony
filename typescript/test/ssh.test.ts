import { describe, it, expect } from 'vitest';
import { parseSshHost, buildSshArgs } from '../src/ssh/worker.js';

describe('ssh/worker — parseSshHost', () => {
  it('parses simple host', () => {
    const result = parseSshHost('example.com');
    expect(result).toEqual({ host: 'example.com', port: null, user: null });
  });

  it('parses user@host', () => {
    const result = parseSshHost('deploy@example.com');
    expect(result).toEqual({ host: 'example.com', port: null, user: 'deploy' });
  });

  it('parses host:port', () => {
    const result = parseSshHost('example.com:2222');
    expect(result).toEqual({ host: 'example.com', port: 2222, user: null });
  });

  it('parses user@host:port', () => {
    const result = parseSshHost('deploy@example.com:2222');
    expect(result).toEqual({ host: 'example.com', port: 2222, user: 'deploy' });
  });

  it('parses IPv6 [::1]:22', () => {
    const result = parseSshHost('[::1]:22');
    expect(result).toEqual({ host: '::1', port: 22, user: null });
  });

  it('parses IPv6 without port', () => {
    const result = parseSshHost('[::1]');
    expect(result).toEqual({ host: '::1', port: null, user: null });
  });

  it('parses user@IPv6:port', () => {
    const result = parseSshHost('root@[::1]:22');
    expect(result).toEqual({ host: '::1', port: 22, user: 'root' });
  });

  it('handles plain IP address', () => {
    const result = parseSshHost('192.168.1.1');
    expect(result).toEqual({ host: '192.168.1.1', port: null, user: null });
  });

  it('handles IP with port', () => {
    const result = parseSshHost('192.168.1.1:22');
    expect(result).toEqual({ host: '192.168.1.1', port: 22, user: null });
  });
});

describe('ssh/worker — buildSshArgs', () => {
  it('includes port flag when port is set', () => {
    const target = { host: 'example.com', port: 2222, user: null };
    const args = buildSshArgs(target, 'ls -la');

    expect(args).toContain('-p');
    expect(args).toContain('2222');
  });

  it('omits port flag when port is null', () => {
    const target = { host: 'example.com', port: null, user: null };
    const args = buildSshArgs(target, 'ls -la');

    expect(args).not.toContain('-p');
  });

  it('includes ssh config with -F flag', () => {
    const target = { host: 'example.com', port: null, user: null };
    const args = buildSshArgs(target, 'ls -la', '/etc/ssh/config');

    expect(args).toContain('-F');
    expect(args).toContain('/etc/ssh/config');
  });

  it('omits config flag when sshConfig is empty', () => {
    const target = { host: 'example.com', port: null, user: null };
    const args = buildSshArgs(target, 'ls -la', '');

    expect(args).not.toContain('-F');
  });

  it('constructs user@host destination', () => {
    const target = { host: 'example.com', port: null, user: 'deploy' };
    const args = buildSshArgs(target, 'ls -la');

    expect(args).toContain('deploy@example.com');
  });

  it('uses plain host when no user', () => {
    const target = { host: 'example.com', port: null, user: null };
    const args = buildSshArgs(target, 'ls -la');

    expect(args).toContain('example.com');
  });

  it('appends command as last argument', () => {
    const target = { host: 'example.com', port: null, user: null };
    const args = buildSshArgs(target, 'ls -la');

    expect(args[args.length - 1]).toBe('ls -la');
  });

  it('builds full args in correct order: config, port, destination, command', () => {
    const target = { host: 'example.com', port: 2222, user: 'deploy' };
    const args = buildSshArgs(target, 'ls', '/path/config');

    expect(args).toEqual([
      '-F', '/path/config',
      '-p', '2222',
      'deploy@example.com',
      'ls',
    ]);
  });
});

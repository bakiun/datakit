import { createServer, type AddressInfo, type Server } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Secrets, SshSettings } from '@datakit/core';
import { Client, type ConnectConfig } from 'ssh2';
import { readUserFile } from './files';

/** An SSH connection that forwards TCP streams to hosts reachable from the SSH server. */
export interface SshTunnel {
  forward(host: string, port: number): Promise<Duplex>;
  /**
   * Opens a port on 127.0.0.1 that forwards each connection to `host:port`, for clients that open their own
   * sockets. Returns the port; it closes with the tunnel.
   */
  listen(host: string, port: number): Promise<number>;
  close(): void;
  /** Called once when the SSH connection ends, with the error if it failed. */
  onDidClose(listener: (error?: Error) => void): void;
}

const READY_TIMEOUT_MS = 20_000;

function agentSocket(): string {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent';
  throw new Error('No SSH agent found: SSH_AUTH_SOCK is not set.');
}

async function connectConfig(ssh: SshSettings, secrets: Secrets): Promise<ConnectConfig> {
  const config: ConnectConfig = {
    host: ssh.host.trim(),
    port: Number(ssh.port),
    username: ssh.user.trim(),
    readyTimeout: READY_TIMEOUT_MS,
    keepaliveInterval: 30_000,
  };
  switch (ssh.auth) {
    case 'key':
      config.privateKey = await readUserFile(ssh.privateKeyPath, 'SSH private key');
      if (secrets.sshPassphrase) config.passphrase = secrets.sshPassphrase;
      break;
    case 'password':
      config.password = secrets.sshPassword ?? '';
      break;
    case 'agent':
      config.agent = agentSocket();
      break;
  }
  return config;
}

export async function openSshTunnel(ssh: SshSettings, secrets: Secrets): Promise<SshTunnel> {
  const config = await connectConfig(ssh, secrets);
  const client = new Client();
  const listeners: ((error?: Error) => void)[] = [];
  let closed = false;
  let lastError: Error | undefined;
  const servers: Server[] = [];

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      client.off('ready', onReady);
      reject(new Error(`SSH connection to ${config.host}:${config.port} failed: ${error.message}`));
    };
    const onReady = () => {
      client.off('error', onError);
      resolve();
    };
    client.once('ready', onReady).once('error', onError).connect(config);
  });

  client.on('error', (error) => {
    lastError = error;
  });
  client.on('close', () => {
    for (const server of servers) server.close();
    if (closed) return;
    closed = true;
    for (const listener of listeners) listener(lastError);
  });

  return {
    forward(host, port) {
      return new Promise((resolve, reject) => {
        client.forwardOut('127.0.0.1', 0, host, port, (error, channel) => {
          if (error) reject(new Error(`SSH tunnel could not reach ${host}:${port}: ${error.message}`));
          else resolve(channel);
        });
      });
    },
    listen(host, port) {
      const server = createServer((socket) => {
        client.forwardOut('127.0.0.1', socket.remotePort ?? 0, host, port, (error, channel) => {
          if (error) {
            socket.destroy();
            return;
          }
          socket.pipe(channel).pipe(socket);
          channel.on('close', () => socket.destroy());
          socket.on('close', () => channel.close());
        });
      });
      servers.push(server);
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      });
    },
    close() {
      for (const server of servers) server.close();
      client.end();
    },
    onDidClose(listener) {
      listeners.push(listener);
    },
  };
}

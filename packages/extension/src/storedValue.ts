import type * as vscode from 'vscode';

/**
 * A value in global state that VS Code's echo of its own writes cannot roll back.
 *
 * The extension host replaces its whole copy of global state whenever the main process echoes a write back. When
 * two writes follow each other closely, the echo of the first can arrive after the second and bring old values back
 * for a moment; a read-modify-write in that moment loses data. So the value is kept here, with a write counter beside
 * it in global state: what global state holds is taken over only when its counter is ahead, i.e. another window wrote.
 */
export class StoredValue<T> {
  private value: T;
  private version: number;
  private readonly versionKey: string;

  constructor(
    private readonly state: vscode.Memento,
    private readonly key: string,
    private readonly fallback: T,
  ) {
    this.versionKey = `${key}.version`;
    this.version = state.get<number>(this.versionKey, 0);
    this.value = state.get<T>(key, fallback);
  }

  get(): T {
    const version = this.state.get<number>(this.versionKey, 0);
    if (version > this.version) {
      this.version = version;
      this.value = this.state.get<T>(this.key, this.fallback);
    }
    return this.value;
  }

  async set(value: T): Promise<void> {
    this.get();
    this.version++;
    this.value = value;
    // Both keys land in the same write of the extension's global state.
    await Promise.all([this.state.update(this.key, value), this.state.update(this.versionKey, this.version)]);
  }
}

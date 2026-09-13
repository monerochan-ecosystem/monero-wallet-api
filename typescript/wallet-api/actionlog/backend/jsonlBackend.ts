import { atomicWrite } from "../../io/atomicWrite";
import {
  ActiveInvocations,
  type ActionLogBackend,
  type ActionLogEvent,
  type InvocationState,
} from "../actionLogTypes";
import type { ToolId } from "../../tools/monero-tools";

export class ActionLogJsonlBackend implements ActionLogBackend {
  private events: ActionLogEvent[] = [];
  private active = new ActiveInvocations();

  constructor(private readonly path: string) {}

  static async open(path: string): Promise<ActionLogJsonlBackend> {
    const backend = new ActionLogJsonlBackend(path);
    await backend.rebuildActive();
    return backend;
  }

  private async rebuildActive() {
    const text = await Bun.file(this.path)
      .text()
      .catch(() => "");
    this.events = [];
    if (text.trim()) {
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          this.events.push(JSON.parse(t) as ActionLogEvent);
        } catch {
          // skip bad line
        }
      }
    }
    this.active.clear();
    for (const event of this.events) this.active.apply(event);
  }

  private async persist() {
    const body =
      this.events.map((e) => JSON.stringify(e)).join("\n") +
      (this.events.length ? "\n" : "");
    await atomicWrite(this.path, body);
  }

  async append(event: ActionLogEvent): Promise<void> {
    this.events.push(event);
    this.active.apply(event);
    await this.persist();
  }

  async getBranch(invocationId: string): Promise<ActionLogEvent[]> {
    return this.events.filter((e) => e.invocationId === invocationId);
  }

  async getTip(invocationId: string): Promise<ActionLogEvent | null> {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]!.invocationId === invocationId) return this.events[i]!;
    }
    return null;
  }

  async getActiveByToolId(toolId: ToolId): Promise<InvocationState | null> {
    return this.active.getActiveByToolId(toolId);
  }

  async getActiveInvocations(): Promise<InvocationState[]> {
    return this.active.getActiveInvocations();
  }

  async feed(events: ActionLogEvent[]): Promise<void> {
    for (const event of events) {
      if (this.events.some((e) => e.id === event.id)) continue;
      this.events.push(event);
      this.active.apply(event);
    }
    await this.persist();
  }

  async reload(): Promise<void> {
    await this.rebuildActive();
  }
}

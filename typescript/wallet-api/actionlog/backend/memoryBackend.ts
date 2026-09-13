import {
  ActiveInvocations,
  type ActionLogBackend,
  type ActionLogEvent,
  type InvocationState,
} from "../actionLogTypes";
import type { ToolId } from "../../tools/monero-tools";

export class ActionLogMemoryBackend implements ActionLogBackend {
  private events: ActionLogEvent[] = [];
  private active = new ActiveInvocations();

  async append(event: ActionLogEvent): Promise<void> {
    this.events.push(event);
    this.active.apply(event);
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
  }

  private async rebuildActive() {
    this.active.clear();
    for (const event of this.events) this.active.apply(event);
  }

  async reload(): Promise<void> {
    await this.rebuildActive();
  }
}

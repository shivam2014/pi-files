export type SubagentEventType =
  | 'tool_call_start'
  | 'tool_call_end'
  | 'finding'
  | 'ask_orchestrator'
  | 'error'
  | 'progress';

export interface SubagentEvent {
  type: SubagentEventType;
  specialist: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export type SubagentEventHandler = (event: SubagentEvent) => void;

export class SubagentEventRouter {
	private handlers: Map<SubagentEventType, Set<SubagentEventHandler>> = new Map();

	on(type: SubagentEventType, handler: SubagentEventHandler): () => void {
		const set = this.handlers.get(type) ?? new Set<SubagentEventHandler>();
		this.handlers.set(type, set);
		set.add(handler);
		return () => this.off(type, handler);
	}

	off(type: SubagentEventType, handler: SubagentEventHandler): void {
		this.handlers.get(type)?.delete(handler);
	}

	emit(event: SubagentEvent): void {
		const handlers = this.handlers.get(event.type);
		if (handlers) {
			for (const handler of handlers) {
				handler(event);
			}
		}
	}

	clear(): void {
		this.handlers.clear();
	}
}

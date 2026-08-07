import type { SoremaEvent } from '@sorema/domain-model';

export type Unsubscribe = () => void;

export type EventHandler<TEvent extends SoremaEvent> = (event: TEvent) => void | Promise<void>;

export interface EventBus {
  publish<TEvent extends SoremaEvent>(event: TEvent): Promise<void>;
  subscribe<TType extends SoremaEvent['type']>(
    type: TType,
    handler: EventHandler<Extract<SoremaEvent, { type: TType }>>,
  ): Unsubscribe;
  subscribeToAll(handler: EventHandler<SoremaEvent>): Unsubscribe;
}

type AnyHandler = EventHandler<never>;

export class InMemoryEventBus implements EventBus {
  private readonly handlersByType = new Map<string, Set<AnyHandler>>();
  private readonly wildcardHandlers = new Set<EventHandler<SoremaEvent>>();
  private readonly onHandlerError: (error: unknown, event: SoremaEvent) => void;

  constructor(onHandlerError?: (error: unknown, event: SoremaEvent) => void) {
    this.onHandlerError = onHandlerError ?? (() => undefined);
  }

  async publish<TEvent extends SoremaEvent>(event: TEvent): Promise<void> {
    const typed = [...(this.handlersByType.get(event.type) ?? [])];
    const wildcard = [...this.wildcardHandlers];
    for (const handler of [...typed, ...wildcard]) {
      try {
        await (handler as EventHandler<SoremaEvent>)(event);
      } catch (error) {
        this.onHandlerError(error, event);
      }
    }
  }

  subscribe<TType extends SoremaEvent['type']>(
    type: TType,
    handler: EventHandler<Extract<SoremaEvent, { type: TType }>>,
  ): Unsubscribe {
    const handlers = this.handlersByType.get(type) ?? new Set<AnyHandler>();
    handlers.add(handler as AnyHandler);
    this.handlersByType.set(type, handlers);
    return () => {
      handlers.delete(handler as AnyHandler);
    };
  }

  subscribeToAll(handler: EventHandler<SoremaEvent>): Unsubscribe {
    this.wildcardHandlers.add(handler);
    return () => {
      this.wildcardHandlers.delete(handler);
    };
  }
}

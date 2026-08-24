import type { Capability, JobStatus } from '@sorema/domain-model';
import type { DeviceCommand } from '@sorema/protocol';
import { SoremaError } from '@sorema/domain-model';
import type { DomainAdapter, DomainCommand, DomainCommandResult } from '../domains/domain-adapter.js';
import type { MachineMemory } from './machine-memory.js';

const HANDLED: ReadonlySet<string> = new Set(['memory.remember', 'memory.recall']);

/**
 * Answers the note tools from this machine, so the hosted service never holds what somebody asked
 * to be remembered.
 *
 * It carries no job and no session: remembering is a write that either happened or did not, and a
 * question about the past is answered from a file rather than by starting work. Everything the
 * `DomainAdapter` contract asks for beyond that is therefore honestly empty rather than pretended.
 */
export class MemoryDomainAdapter implements DomainAdapter {
  readonly domain = 'memory';

  private readonly memory: MachineMemory;

  constructor(memory: MachineMemory) {
    this.memory = memory;
  }

  async detectCapabilities(): Promise<Capability[]> {
    return [
      {
        id: 'memory.machine',
        domain: this.domain,
        providerId: 'machine',
        available: true,
        status: 'ready',
        details: { storedAt: this.memory.path },
      },
    ];
  }

  handles(commandName: DeviceCommand['name'], domain?: string): boolean {
    if (domain !== undefined && domain !== this.domain) return false;
    return HANDLED.has(commandName);
  }

  async execute(command: DomainCommand): Promise<DomainCommandResult> {
    switch (command.command.name) {
      case 'memory.remember':
        return await this.memory.remember(
          command.command.payload.subject,
          command.command.payload.text,
        );
      case 'memory.recall':
        return await this.memory.recall(command.command.payload.query);
      default:
        throw SoremaError.of(
          'COMMAND_REJECTED',
          `the memory domain does not handle ${command.command.name}`,
        );
    }
  }

  /** Nothing here runs long enough to be cancelled, and there is no job id to cancel by. */
  async cancel(): Promise<void> {
    return;
  }

  async getStatus(jobId: string): Promise<JobStatus> {
    throw SoremaError.of('JOB_NOT_FOUND', `the memory domain starts no jobs, so ${jobId} is not one`);
  }
}

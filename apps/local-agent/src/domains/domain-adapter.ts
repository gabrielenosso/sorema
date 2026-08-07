import type { Capability, JobStatus } from '@sorema/domain-model';
import type { DeviceCommand } from '@sorema/protocol';

export type DomainCommand = {
  command: DeviceCommand;
  userId: string;
  deviceId: string;
  correlationId: string;
  idempotencyKey: string;
};

export type DomainCommandResult = unknown;

export interface DomainAdapter {
  readonly domain: string;
  detectCapabilities(): Promise<Capability[]>;
  /**
   * Whether this adapter can serve the command. A command carrying an explicit `domain` is only
   * ever offered to the adapter that owns that domain; everything else is offered to each adapter
   * in registration order, so a new domain plugs in without touching the router.
   */
  handles(commandName: DeviceCommand['name'], domain?: string): boolean;
  execute(command: DomainCommand): Promise<DomainCommandResult>;
  cancel(jobId: string): Promise<void>;
  getStatus(jobId: string): Promise<JobStatus>;
}

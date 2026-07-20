import { ServiceBusClient } from "@azure/service-bus";

export interface JobQueue {
  send(body: Record<string, unknown>): Promise<void>; // full 4-gate run
  sendPreflight(body: Record<string, unknown>): Promise<void>; // fast 3-gate wizard lane
}

// Single-lane sender for notes-jobs. Message body is {jobId, reqId} only —
// the note_jobs row is the source of truth (idempotent redelivery).
export interface NotesQueue {
  send(body: Record<string, unknown>): Promise<void>;
}

export function createServiceBusNotesQueue(
  connectionString: string,
  queueName: string,
): NotesQueue {
  const client = new ServiceBusClient(connectionString);
  const sender = client.createSender(queueName);
  return {
    async send(body) {
      await sender.sendMessages({ body, contentType: "application/json" });
    },
  };
}

export function createServiceBusQueue(
  connectionString: string,
  queueName: string,
  preflightQueueName: string,
): JobQueue {
  const client = new ServiceBusClient(connectionString);
  const sender = client.createSender(queueName);
  const preflightSender = client.createSender(preflightQueueName);
  return {
    async send(body) {
      await sender.sendMessages({ body, contentType: "application/json" });
    },
    async sendPreflight(body) {
      await preflightSender.sendMessages({ body, contentType: "application/json" });
    },
  };
}

import { ServiceBusClient } from "@azure/service-bus";

export interface JobQueue {
  send(body: Record<string, unknown>): Promise<void>; // full 4-gate run
  sendPreflight(body: Record<string, unknown>): Promise<void>; // fast 3-gate wizard lane
}

// Two lanes, mirroring JobQueue. send() is notes-jobs — body {jobId, reqId} only, the
// note_jobs row is the source of truth (idempotent redelivery). sendNarration() is the
// dedicated notes-narration lane: a synthesis run is minutes long and must neither wait
// behind an ASR job nor hold one's lock. Body {noteId, voices[], reqId}, pinned in
// worker/notes/narration_parity.json.
export interface NotesQueue {
  send(body: Record<string, unknown>): Promise<void>;
  sendNarration(body: Record<string, unknown>): Promise<void>;
}

export function createServiceBusNotesQueue(
  connectionString: string,
  queueName: string,
  narrationQueueName: string,
): NotesQueue {
  const client = new ServiceBusClient(connectionString);
  const sender = client.createSender(queueName);
  const narrationSender = client.createSender(narrationQueueName);
  return {
    async send(body) {
      await sender.sendMessages({ body, contentType: "application/json" });
    },
    async sendNarration(body) {
      await narrationSender.sendMessages({ body, contentType: "application/json" });
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

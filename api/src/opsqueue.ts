import { ServiceBusClient, ServiceBusAdministrationClient } from "@azure/service-bus";

// Queue health for the Ops tab: runtime counters + a peek at dead-lettered
// messages. Peek is non-destructive — DLQ triage stays a human decision.

export interface OpsQueueCounts {
  name: string;
  active: number;
  deadLettered: number;
  scheduled: number;
}

export interface OpsDlqMessage {
  queue: string;
  sequenceNumber: number;
  enqueuedAt: string;
  reason: string | null;
  jobId: string | null;
  body: unknown;
}

export interface OpsQueueStore {
  counts(): Promise<OpsQueueCounts[]>;
  peekDeadLetters(): Promise<OpsDlqMessage[]>;
}

export function createServiceBusOpsStore(connectionString: string, queueNames: string[]): OpsQueueStore {
  const admin = new ServiceBusAdministrationClient(connectionString);
  const client = new ServiceBusClient(connectionString);

  return {
    async counts() {
      return Promise.all(
        queueNames.map(async (name) => {
          const p = await admin.getQueueRuntimeProperties(name);
          return {
            name,
            active: p.activeMessageCount,
            deadLettered: p.deadLetterMessageCount,
            scheduled: p.scheduledMessageCount,
          };
        }),
      );
    },
    async peekDeadLetters() {
      const out: OpsDlqMessage[] = [];
      for (const name of queueNames) {
        const receiver = client.createReceiver(name, { subQueueType: "deadLetter" });
        try {
          const msgs = await receiver.peekMessages(10);
          for (const m of msgs) {
            const body = m.body as Record<string, unknown> | undefined;
            out.push({
              queue: name,
              sequenceNumber: Number(m.sequenceNumber ?? 0),
              enqueuedAt: m.enqueuedTimeUtc?.toISOString() ?? "",
              reason: (m.deadLetterReason as string | undefined) ?? null,
              jobId: typeof body?.jobId === "string" ? body.jobId : null,
              body: body ?? null,
            });
          }
        } finally {
          await receiver.close();
        }
      }
      return out.sort((a, b) => b.enqueuedAt.localeCompare(a.enqueuedAt));
    },
  };
}

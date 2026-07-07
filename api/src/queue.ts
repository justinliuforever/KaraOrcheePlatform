import { ServiceBusClient } from "@azure/service-bus";

export interface JobQueue {
  send(body: Record<string, unknown>): Promise<void>;
}

export function createServiceBusQueue(connectionString: string, queueName: string): JobQueue {
  const client = new ServiceBusClient(connectionString);
  const sender = client.createSender(queueName);
  return {
    async send(body) {
      await sender.sendMessages({ body, contentType: "application/json" });
    },
  };
}

// The rows are deleted before the blobs, so when the retries exhaust this line is the only thing left that names the bytes.
export function purgeRunner(ctx: { op: string; userId: string; reqId: string | null }) {
  return async (label: string, key: string, act: () => Promise<unknown>): Promise<void> => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await act();
        return;
      } catch (err) {
        if (attempt === 3) {
          console.log(JSON.stringify({
            kind: "purge_failed", op: ctx.op, label, key,
            userId: ctx.userId, reqId: ctx.reqId,
            error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
          }));
          return;
        }
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
  };
}

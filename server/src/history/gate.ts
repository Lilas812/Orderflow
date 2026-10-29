/**
 * One FIFO for both instruments, including response-body consumption. Retry and
 * maturity sleeps do not hold it. No change to the independent live receive path.
 */
export function historyGate(request: typeof fetch = fetch): typeof fetch {
  let tail: Promise<void> = Promise.resolve();
  return async (input, init) => {
    const before = tail;
    let release!: () => void;
    tail = new Promise<void>(r => { release = r; });
    const signal = init?.signal;
    await before;
    try {
      signal?.throwIfAborted();
      const response = await request(input, init);
      if (!response.body) { release(); return response; }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const row = await reader.read();
            if (row.done) { release(); controller.close(); }
            else controller.enqueue(row.value);
          } catch (e) { release(); controller.error(e); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { release(); } },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (e) { release(); throw e; }
  };
}

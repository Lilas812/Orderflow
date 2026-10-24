import { createMockAnalysisSession, type MockSessionOptions } from "../../lib/mockAnalysisSession";

/** Diagnostic-only empty session, never the workload session or its recorder.
 * Uses the real public lifecycle; readFrame is illegal on an IDLE session.
 */
export function emptyLayout(options: MockSessionOptions) {
  const session = createMockAnalysisSession({ ...options, inputs: [], diagnostics: undefined });
  try {
    session.setNotificationsEnabled(false);
    session.start();
    const frame = session.readFrame(options.query), status = session.getStatus();
    if (status.processedInputs !== 0 || status.timers !== 0 || frame.revision !== 0)
      throw Error("EMPTY_LAYOUT_NOT_EMPTY");
    return { frame, status };
  } finally { session.dispose(); }
}

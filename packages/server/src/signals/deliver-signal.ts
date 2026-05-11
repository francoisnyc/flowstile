import type { FastifyBaseLogger } from 'fastify';
import { WorkflowNotFoundError } from '@temporalio/client';

interface DeliverSignalOptions {
  temporal: {
    workflow: {
      getHandle: (workflowId: string) => {
        signal: (signalName: string, payload?: unknown) => Promise<void>;
      };
    };
  };
  workflowId: string;
  signalName: string;
  payload?: unknown;
  logger: FastifyBaseLogger;
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

export async function deliverSignal(
  options: DeliverSignalOptions,
): Promise<boolean> {
  const { temporal, workflowId, signalName, payload, logger } = options;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const handle = temporal.workflow.getHandle(workflowId);
      await handle.signal(signalName, payload);
      logger.info({ signalName, workflowId, attempt }, 'Signal delivered');
      return true;
    } catch (err) {
      // Don't retry if the workflow no longer exists
      if (err instanceof WorkflowNotFoundError) {
        logger.warn(
          { signalName, workflowId },
          'Target workflow not found — may have already completed or been terminated',
        );
        return false;
      }

      if (attempt < MAX_ATTEMPTS) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn(
          { err, signalName, workflowId, attempt, nextRetryMs: delay },
          'Signal delivery failed, retrying',
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        logger.error(
          { err, signalName, workflowId, attempts: MAX_ATTEMPTS },
          'Signal delivery failed after all retries',
        );
      }
    }
  }
  return false;
}

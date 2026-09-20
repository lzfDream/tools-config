export const EXTERNAL_OPERATION_TIMEOUT_MS = 3000;
export const COMPOSE_OPERATION_TIMEOUT_MS = 30000;

export class ExternalOperationTimeoutError extends Error {
  constructor(readonly operation: string, readonly timeoutMs: number) {
    const duration = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000} 秒` : `${timeoutMs} 毫秒`;
    super(`${operation}超时（超过 ${duration}）`);
    this.name = "ExternalOperationTimeoutError";
  }
}

export function isExternalOperationTimeout(error: unknown): error is ExternalOperationTimeoutError {
  return error instanceof ExternalOperationTimeoutError;
}

export async function withExternalOperationTimeout<T>(
  operationName: string,
  operation: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs?: number; parentSignal?: AbortSignal | null } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? EXTERNAL_OPERATION_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeParentListener: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    const abort = (reason: unknown) => {
      reject(reason);
      if (!controller.signal.aborted) controller.abort(reason);
    };
    timer = setTimeout(() => abort(new ExternalOperationTimeoutError(operationName, timeoutMs)), timeoutMs);
    if (options.parentSignal) {
      const parentSignal = options.parentSignal;
      const onAbort = () => abort(parentSignal.reason || new Error(`${operationName}已取消`));
      if (parentSignal.aborted) onAbort();
      else {
        parentSignal.addEventListener("abort", onAbort, { once: true });
        removeParentListener = () => parentSignal.removeEventListener("abort", onAbort);
      }
    }
  });
  try {
    const operationResult = controller.signal.aborted
      ? Promise.reject(controller.signal.reason)
      : operation(controller.signal);
    return await Promise.race([operationResult, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    removeParentListener?.();
  }
}

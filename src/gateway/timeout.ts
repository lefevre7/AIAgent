import { createGatewayError } from "@/gateway/errors";

export async function withGatewayTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(createGatewayError("timed_out", `The gateway request timed out after ${timeoutMs}ms.`, { timeoutMs }, true));
    }, timeoutMs);

    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

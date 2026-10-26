/** Non-2xx response from EMS. Kept free of env imports so it is cheap to share. */
export class EmsHttpError extends Error {
  constructor(public readonly status: number, body: string) {
    super(`EMS ${status}: ${body.slice(0, 200)}`);
    this.name = "EmsHttpError";
  }
}

/** A 4xx is a permanent rejection (retrying the same payload won't help) except timeout and rate limit. */
export function isRetryableEmsError(err: unknown): boolean {
  if (!(err instanceof EmsHttpError)) return true;
  return !(err.status >= 400 && err.status < 500) || err.status === 408 || err.status === 429;
}

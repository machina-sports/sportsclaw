/**
 * sportsclaw — rules every keyed inference endpoint shares (model roles, speech).
 * A key is named in config by its environment variable and travels over HTTPS, or to this machine.
 */

/** An environment variable name, as opposed to a key pasted where a name belongs. */
export const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
/** A bearer key: printable characters with no whitespace. */
export const USABLE_KEY = /^[!-~]+$/;
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Transport factory — same HttpSseTransport as the client used.
 */

import { createHttpSseTransport } from '@tired-agent/protocol';
import type { Transport } from '@tired-agent/protocol';

export const transport: Transport = createHttpSseTransport();

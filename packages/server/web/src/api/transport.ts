/**
 * Transport factory — same HttpSseTransport as the client used.
 */

import { createHttpSseTransport } from '@tired-pc/protocol';
import type { Transport } from '@tired-pc/protocol';

export const transport: Transport = createHttpSseTransport();

// Use a monotonic ULID factory so IDs minted within the same millisecond
// remain lexically ordered. All repos should import `ulid` from here.

import { monotonicFactory } from "ulid";

export const ulid = monotonicFactory();

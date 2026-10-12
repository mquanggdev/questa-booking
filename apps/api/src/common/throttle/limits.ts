// Stricter limits on the two sensitive routes (spec, "Giới hạn tốc độ").
// The general per-IP and per-user limits come from the environment.

/** Login attempts per IP per minute: slows down password guessing. */
export const LOGIN_PER_MINUTE_PER_IP = 10;

/** Hold requests per account per minute; one purchase rarely needs more than a few. */
export const HOLDS_PER_MINUTE_PER_USER = 20;

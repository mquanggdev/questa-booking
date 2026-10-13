// Topic and consumer names (spec, "Kafka"). Names are part of the data
// kept by Kafka (committed offsets per group): renaming one restarts it.

export interface TopicNames {
  orders: string;
  deadLetter: string;
}

/** e2e tests use their own prefix and never touch the development topics. */
export const topicNames = (prefix: string): TopicNames => ({
  orders: `${prefix}orders.events`,
  deadLetter: `${prefix}orders.events.dlq`,
});

export const ConsumerName = {
  NOTIFICATIONS: 'notifications',
  ANALYTICS: 'analytics',
  AUDIT: 'audit',
} as const;
export type ConsumerName = (typeof ConsumerName)[keyof typeof ConsumerName];

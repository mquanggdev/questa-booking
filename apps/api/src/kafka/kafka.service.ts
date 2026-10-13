import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import kafkaJavascript from '@confluentinc/kafka-javascript';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { hostname } from 'node:os';
import { AppConfigService } from '../config/app-config.service.js';
import { topicNames, type TopicNames } from './kafka.constants.js';

const { Kafka, logLevel } = kafkaJavascript.KafkaJS;

export interface OutgoingMessage {
  key: string;
  value: string;
  headers?: Record<string, string>;
}

/**
 * The worker's connection to Kafka (phase 8): one idempotent producer, the
 * topics, and consumers on demand. The API process never uses it; it writes
 * events to the outbox table instead.
 */
@Injectable()
export class KafkaService implements OnApplicationShutdown {
  private readonly logger = new Logger(KafkaService.name);
  private readonly kafka: KafkaJS.Kafka;
  private producer: Promise<KafkaJS.Producer> | null = null;
  private readonly consumers: KafkaJS.Consumer[] = [];
  readonly topics: TopicNames;

  constructor(private readonly config: AppConfigService) {
    this.topics = topicNames(config.get('KAFKA_TOPIC_PREFIX'));
    this.kafka = new Kafka({
      kafkaJS: {
        brokers: config.get('KAFKA_BROKERS').split(','),
        clientId: `questa-${hostname()}`,
        // librdkafka logs to the console itself; only real problems.
        logLevel: logLevel.ERROR,
      },
    });
  }

  /** Consumer group name for a consumer (prefixed like the topics). */
  groupId(consumer: string): string {
    return `${this.config.get('KAFKA_TOPIC_PREFIX')}${consumer}`;
  }

  /**
   * Creates the topics if they do not exist. Auto-creation is off on the
   * broker, so a misspelled topic fails loudly instead of appearing.
   * orders.events: 3 partitions, keyed by orderId (one order's events stay
   * in order on one partition). One node: replication factor 1.
   */
  async ensureTopics(): Promise<void> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      await admin.createTopics({
        topics: [
          { topic: this.topics.orders, numPartitions: 3, replicationFactor: 1 },
          {
            topic: this.topics.deadLetter,
            numPartitions: 1,
            replicationFactor: 1,
          },
        ],
      });
    } finally {
      await admin.disconnect();
    }
  }

  /**
   * Sends and waits for the broker's acknowledgement of every message
   * (acks=all). Idempotent producer: librdkafka's own retries never write a
   * message twice. Rejects after KAFKA_SEND_TIMEOUT_MS if Kafka is down.
   */
  async send(topic: string, messages: OutgoingMessage[]): Promise<void> {
    const producer = await this.getProducer();
    await producer.send({ topic, messages });
  }

  /** A consumer in group groupId(name), committing offsets every second. */
  consumer(name: string): KafkaJS.Consumer {
    const consumer = this.kafka.consumer({
      kafkaJS: {
        groupId: this.groupId(name),
        // A new group starts from the oldest event, not only new ones.
        fromBeginning: true,
        autoCommit: true,
        autoCommitInterval: 1000,
      },
    });
    this.consumers.push(consumer);
    return consumer;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.consumers.map((c) => c.disconnect()));
    if (this.producer) {
      await this.producer.then((p) => p.disconnect()).catch(() => undefined);
    }
  }

  private getProducer(): Promise<KafkaJS.Producer> {
    this.producer ??= (async () => {
      const producer = this.kafka.producer({
        kafkaJS: { idempotent: true, acks: -1 },
        'message.timeout.ms': this.config.get('KAFKA_SEND_TIMEOUT_MS'),
        'linger.ms': 5,
      });
      await producer.connect();
      return producer;
    })().catch((error: unknown) => {
      this.producer = null; // try again next time
      throw error;
    });
    return this.producer;
  }
}

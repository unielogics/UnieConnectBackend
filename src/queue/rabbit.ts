import amqp from 'amqplib';
import { config } from '../config/env';

export async function createRabbitChannel() {
  if (!config.rabbitUrl) throw new Error('RABBITMQ_URL not set');
  const conn = await amqp.connect(config.rabbitUrl);
  const channel = await conn.createChannel();
  return { conn, channel };
}

export async function publishJson(
  channel: amqp.Channel,
  exchange: string,
  routingKey: string,
  message: unknown,
) {
  await channel.assertExchange(exchange, 'topic', { durable: true });
  const payload = Buffer.from(JSON.stringify(message));
  channel.publish(exchange, routingKey, payload, { contentType: 'application/json' });
}


import { Queue, Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { sendToGA4 } from './ga4';

export const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });

export const ga4Queue = new Queue('ga4-events', { connection: redis as any });

export const ga4Worker = new Worker('ga4-events', async (job: Job) => {
  const { eventType, payload } = job.data;
  
  try {
    await sendToGA4(eventType, payload);

    if (eventType === 'lead' || eventType === 'purchase') {
       await redis.set(`ga4_success:${payload.transaction_id}`, 'true', 'EX', 60 * 60 * 24 * 30);
    }
  } catch (error: any) {
    if (error.response?.status >= 400 && error.response?.status < 500) {
      console.error(`[GA4 Error 4xx] Job ID ${job.id}:`, error.response.data);
      throw new Error(`Client Error 4xx: Do not retry. ${error.message}`);
    }
    throw error;
  }
}, {
  connection: redis as any,
  settings: {
    backoffStrategies: {
      customInterval: (attemptsMade: number, err: Error, job: Job) => {
        const delays = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000]; 
        return delays[attemptsMade - 1] || -1; 
      }
    }
  }
} as any);

import 'dotenv/config';
import express from 'express';
import { ga4Queue, redis } from './queue';

const app = express();
app.use(express.json());

function extractCustomField(data: any, fieldName: string) {
    const field = data.custom_fields?.find((f: any) => f.name === fieldName || f.uuid === fieldName);
    return field ? field.value : null;
}

app.post('/webhooks/keycrm', async (req, res) => {
  res.status(200).send('OK');

  const data = req.body;
  console.log('[Webhook Received]', JSON.stringify(data));

  // KeyCRM often wraps order data in 'context' for status changes
  const orderData = data.context || data;
  const orderStatus = orderData.status_id;
  const transactionId = orderData.id || orderData.order_id || orderData.source_uuid;
  const eventName = data.event || data.context?.event || 'order.created';
  
  const clientId = extractCustomField(orderData, 'ga_client_id') || 'unknown-client'; 

  console.log(`[Order Processing] ID: ${transactionId}, Status: ${orderStatus}, Event: ${eventName}, Client: ${clientId}`);

  // --- LEAD ---
  if (eventName === 'order.created' || eventName === 'lead.created') {
    await ga4Queue.add('send-ga4', {
      eventType: 'lead',
      payload: { ...orderData, client_id: clientId, transaction_id: transactionId }
    }, { 
      attempts: 4, backoff: { type: 'customInterval' } 
    });
  }

  // --- PURCHASE ---
  // Добавляем проверку на успешный статус (например, 23 или 24)
  if (orderStatus === 23 || orderStatus === 24) {
    const isNew = await redis.set(`dedup:purchase:${transactionId}`, 'locked', 'EX', 86400 * 30, 'NX');
    if (isNew) {
      await ga4Queue.add('send-ga4', {
        eventType: 'purchase',
        payload: { ...orderData, client_id: clientId, transaction_id: transactionId }
      }, { 
        attempts: 4, backoff: { type: 'customInterval' } 
      });
    } else {
      console.log(`[Deduplication] Purchase for ${transactionId} skipped.`);
    }
  }

  // --- REFUND ---
  if (orderStatus === 19) {
    const wasSent = await redis.get(`ga4_success:${transactionId}`);
    if (wasSent) {
      await ga4Queue.add('send-ga4', {
        eventType: 'refund',
        payload: { ...orderData, client_id: clientId, transaction_id: transactionId }
      }, { 
        attempts: 4, backoff: { type: 'customInterval' } 
      });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Middleware started on port ${PORT}`));

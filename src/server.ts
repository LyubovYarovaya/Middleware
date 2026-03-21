import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { ga4Queue, redis } from './queue';
import { logToSheet } from './logger';

const app = express();
app.use(express.json());

const KEYCRM_API_KEY = process.env.KEYCRM_API_KEY;

async function fetchFullOrder(orderId: number) {
  if (!KEYCRM_API_KEY) {
    console.error('[Error] KEYCRM_API_KEY is missing in .env');
    return null;
  }
  
  try {
    const response = await axios.get(`https://api.keycrm.app/v1/order/${orderId}`, {
      headers: {
        'Authorization': `Bearer ${KEYCRM_API_KEY}`,
        'Accept': 'application/json'
      }
    });
    return response.data;
  } catch (error: any) {
    console.error(`[Error] Failed to fetch order ${orderId} from KeyCRM:`, error.message);
    return null;
  }
}

function extractCustomField(data: any, fieldName: string) {
    const field = data.custom_fields?.find((f: any) => f.name === fieldName || f.uuid === fieldName);
    return field ? field.value : null;
}

app.post('/webhooks/keycrm', async (req, res) => {
  res.status(200).send('OK');

  const data = req.body;
  console.log('[Webhook Received]', JSON.stringify(data));

  // Extract core identifiers
  const initialData = data.context || data;
  const transactionId = initialData.id || initialData.order_id || initialData.source_uuid;
  const eventName = data.event || data.context?.event || 'order.created';

  // Fetch full data from KeyCRM API (Option B)
  // This ensures we always have products, buyer info, and custom fields
  const fullOrderData = await fetchFullOrder(transactionId);
  
  if (!fullOrderData) {
    console.log(`[Abort] Could not fetch full data for order ${transactionId}. Skipping GA4...`);
    return;
  }

  const orderStatus = fullOrderData.status_id;
  const clientId = extractCustomField(fullOrderData, 'ga_client_id') || 'unknown-client'; 

  console.log(`[Order Processing] ID: ${transactionId}, Status: ${orderStatus}, Event: ${eventName}, Client: ${clientId}`);

  // Пишем каждое событие в Google Таблицу (Лист 1)
  await logToSheet('Webhooks', {
    id: transactionId,
    status: orderStatus,
    event: eventName,
    value: parseFloat(fullOrderData.grand_total || 0),
    client_id: clientId
  });

  // --- LEAD ---
  if (eventName === 'order.created' || eventName === 'lead.created') {
    await ga4Queue.add('send-ga4', {
      eventType: 'lead',
      payload: { ...fullOrderData, client_id: clientId, transaction_id: transactionId }
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
        payload: { ...fullOrderData, client_id: clientId, transaction_id: transactionId }
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
        payload: { ...fullOrderData, client_id: clientId, transaction_id: transactionId }
      }, { 
        attempts: 4, backoff: { type: 'customInterval' } 
      });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Middleware started on port ${PORT}`));

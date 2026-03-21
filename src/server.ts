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
    const response = await axios.get(`https://openapi.keycrm.app/v1/order/${orderId}`, {
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
  // OR_1004 - системне ім'я поля ga_client_id
  const clientId = extractCustomField(fullOrderData, 'OR_1004') || extractCustomField(fullOrderData, 'ga_client_id') || 'unknown-client'; 

  console.log(`[Order Processing] ID: ${transactionId}, Status: ${orderStatus}, Event: ${eventName}, Client: ${clientId}`);

  // Пишем каждое событие в Google Таблицу (Лист 1)
  await logToSheet('Webhooks', {
    event_time: fullOrderData.updated_at || fullOrderData.created_at || new Date().toISOString(),
    id: transactionId,
    status: orderStatus,
    event: eventName,
    value: parseFloat(fullOrderData.grand_total || 0),
    client_id: clientId,
    full_json: fullOrderData // Відправляємо як об'єкт, щоб Google Apps Script його красиво відформатував
  });

  let evType = null;
  if (orderStatus === 1 || eventName === 'lead.created') {
    evType = 'lead';
  } else if (orderStatus === 23 || orderStatus === 24) {
    evType = 'purchase';
  } else if (orderStatus === 19) {
    evType = 'refund';
  }

  if (evType) {
    // Дедуплікація: забороняємо відправку того ж типу події більше 1 разу на 30 днів
    const setRes = await redis.set(`dedup:${evType}:${transactionId}`, 'locked', 'EX', 86400 * 30, 'NX');
    let canSend: boolean = (setRes === 'OK');
    
    // Якщо це refund, додатково перевіряємо, чи був purchase
    if (evType === 'refund' && canSend) {
      const wasPurchaseSent = await redis.get(`ga4_success:${transactionId}`);
      if (!wasPurchaseSent) canSend = false; // не можна скасувати те, що не передавалось
    }

    if (canSend) {
      console.log(`[Queue] Adding ${evType} for ${transactionId} to GA4 Queue.`);
      await ga4Queue.add('send-ga4', {
        eventType: evType,
        payload: { ...fullOrderData, client_id: clientId, transaction_id: transactionId }
      }, { 
        attempts: 4, backoff: { type: 'customInterval' } 
      });
    } else {
      console.log(`[Deduplication] Event ${evType} for ${transactionId} skipped (already sent or invalid state).`);
      await logToSheet('GA4_Measurement', {
        id: transactionId,
        eventType: evType,
        client_id: clientId,
        status: 'Skipped (Deduplicated or Invalid Setup)'
      });
    }
  } else {
    console.log(`[Skip] Status ${orderStatus} is not mapped to any GA4 event.`);
    await logToSheet('GA4_Measurement', {
      id: transactionId,
      eventType: `Ignored_Status_${orderStatus}`,
      client_id: clientId,
      status: `Skipped (No GA4 mapping for status ${orderStatus})`
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Middleware started on port ${PORT}`));
